import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  normalizeQuantity,
  priceIdForPlan,
  resolveBillingPlan,
  resolveCheckoutOrganization,
  tierForPlan
} from "../../../../../lib/billing";
import { prisma } from "../../../../../lib/prisma";
import { getStripe } from "../../../../../lib/stripe";

export const runtime = "nodejs";

const CheckoutRequestSchema = z.object({
  organizationId: z.string().trim().min(1).optional(),
  seats: z.number().int().positive().max(500).optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional()
}).default({});

function getUserEmail(req: NextRequest) {
  return (
    req.headers.get("x-preflight-user-email") ||
    req.headers.get("x-user-email") ||
    req.cookies.get("preflight_user_email")?.value ||
    null
  );
}

export async function POST(req: NextRequest) {
  let plan;
  try {
    plan = resolveBillingPlan(req.nextUrl.searchParams.get("plan"));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid billing plan." }, { status: 400 });
  }

  const fallbackSeats = req.nextUrl.searchParams.get("seats");
  let body: z.infer<typeof CheckoutRequestSchema> = {};

  try {
    body = CheckoutRequestSchema.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json({ error: "Invalid checkout payload." }, { status: 400 });
  }

  const userEmail = getUserEmail(req);
  const organization = await resolveCheckoutOrganization({
    organizationId: body.organizationId || req.headers.get("x-preflight-org-id") || req.cookies.get("preflight_org_id")?.value,
    userEmail
  });

  if (!organization) {
    return NextResponse.json({ error: "Organization context is required for checkout." }, { status: 401 });
  }

  const stripe = getStripe();
  const priceId = priceIdForPlan(plan);
  const seats = normalizeQuantity(body.seats ?? fallbackSeats, plan);
  const dashboardUrl = process.env.PREFLIGHT_DASHBOARD_URL || req.nextUrl.origin;
  const successUrl = body.successUrl || `${dashboardUrl}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body.cancelUrl || `${dashboardUrl}/dashboard/billing?canceled=true`;
  const tier = tierForPlan(plan);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    client_reference_id: organization.id,
    customer: organization.stripeCustomerId || undefined,
    customer_email: organization.stripeCustomerId ? undefined : userEmail || undefined,
    line_items: [
      {
        price: priceId,
        quantity: seats
      }
    ],
    allow_promotion_codes: true,
    metadata: {
      organizationId: organization.id,
      plan,
      tier
    },
    subscription_data: {
      metadata: {
        organizationId: organization.id,
        plan,
        tier,
        seats: String(seats)
      }
    },
    success_url: successUrl,
    cancel_url: cancelUrl
  });

  if (session.customer && !organization.stripeCustomerId) {
    await prisma.organization.update({
      where: { id: organization.id },
      data: { stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer.id }
    });
  }

  return NextResponse.json({
    id: session.id,
    url: session.url
  });
}
