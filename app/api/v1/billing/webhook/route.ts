import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { LicenseStatus } from "@prisma/client";
import {
  getObjectId,
  getOrganizationIdFromMetadata,
  getSubscriptionIdFromInvoice,
  normalizeQuantity,
  resolveBillingPlan,
  revokeLicensesForSubscription,
  tierForPlan,
  upsertActiveLicenseForSubscription
} from "../../../../../lib/billing";
import { prisma } from "../../../../../lib/prisma";
import { getStripe, getStripeWebhookSecret } from "../../../../../lib/stripe";

export const runtime = "nodejs";

function isPrismaUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function hasWebhookEventBeenProcessed(event: Stripe.Event) {
  const existing = await prisma.stripeWebhookEvent.findUnique({
    where: { stripeEventId: event.id },
    select: { id: true }
  });

  return Boolean(existing);
}

async function markWebhookEventProcessed(event: Stripe.Event) {
  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type
      }
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      return;
    }

    throw error;
  }
}

async function retrieveSubscription(stripe: Stripe, subscriptionId: string) {
  return stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"]
  });
}

function firstSubscriptionPrice(subscription: Stripe.Subscription) {
  return subscription.items.data[0]?.price?.id || null;
}

function subscriptionSeatCount(subscription: Stripe.Subscription) {
  return normalizeQuantity(subscription.items.data[0]?.quantity || subscription.metadata?.seats || 1, "teams");
}

async function syncActiveLicenseFromSubscription({
  stripe,
  subscription,
  organizationId,
  fallbackPlan
}: {
  stripe: Stripe;
  subscription: string | Stripe.Subscription | null;
  organizationId?: string | null;
  fallbackPlan?: string | null;
}) {
  const subscriptionId = getObjectId(subscription);
  if (!subscriptionId) {
    return;
  }

  const hydratedSubscription =
    typeof subscription === "string" ? await retrieveSubscription(stripe, subscriptionId) : subscription;
  const resolvedOrganizationId =
    organizationId || getOrganizationIdFromMetadata(hydratedSubscription);

  if (!resolvedOrganizationId) {
    return;
  }

  const plan = resolveBillingPlan(hydratedSubscription.metadata?.plan || fallbackPlan || "solo");
  const tier = tierForPlan(plan);
  const stripeCustomerId = getObjectId(hydratedSubscription.customer);
  const stripePriceId = firstSubscriptionPrice(hydratedSubscription);
  const seats = plan === "teams" ? subscriptionSeatCount(hydratedSubscription) : 1;

  if (stripeCustomerId) {
    await prisma.organization.update({
      where: { id: resolvedOrganizationId },
      data: { stripeCustomerId }
    });
  }

  await upsertActiveLicenseForSubscription({
    organizationId: resolvedOrganizationId,
    tier,
    seats,
    stripeCustomerId,
    stripeSubscriptionId: subscriptionId,
    stripePriceId,
    label: `Stripe ${plan} subscription`
  });
}

async function handleCheckoutCompleted(stripe: Stripe, session: Stripe.Checkout.Session) {
  const organizationId = session.client_reference_id || session.metadata?.organizationId || null;
  await syncActiveLicenseFromSubscription({
    stripe,
    subscription: session.subscription,
    organizationId,
    fallbackPlan: session.metadata?.plan
  });
}

async function handleInvoicePaymentSucceeded(stripe: Stripe, invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) {
    return;
  }

  await syncActiveLicenseFromSubscription({
    stripe,
    subscription: subscriptionId,
    organizationId: getOrganizationIdFromMetadata(invoice),
    fallbackPlan: invoice.metadata?.plan
  });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  await revokeLicensesForSubscription(subscription.id);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const invoiceWithRetry = invoice as Stripe.Invoice & { next_payment_attempt?: number | null };
  if (!("next_payment_attempt" in invoiceWithRetry) || invoiceWithRetry.next_payment_attempt) {
    return;
  }

  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) {
    return;
  }

  await prisma.licenseKey.updateMany({
    where: { stripeSubscriptionId: subscriptionId },
    data: { status: LicenseStatus.REVOKED }
  });
}

async function handleStripeEvent(event: Stripe.Event) {
  const stripe = getStripe();

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(stripe, event.data.object as Stripe.Checkout.Session);
      break;
    case "invoice.payment_succeeded":
      await handleInvoicePaymentSucceeded(stripe, event.data.object as Stripe.Invoice);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;
    case "invoice.payment_failed":
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      break;
    default:
      break;
  }
}

export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
  }

  const rawBody = await req.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, getStripeWebhookSecret());
  } catch {
    return NextResponse.json({ error: "Invalid Stripe webhook signature." }, { status: 400 });
  }

  if (await hasWebhookEventBeenProcessed(event)) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  await handleStripeEvent(event);
  await markWebhookEventProcessed(event);

  return NextResponse.json({ received: true });
}
