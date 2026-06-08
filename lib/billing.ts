import { randomBytes, createHash } from "node:crypto";
import type Stripe from "stripe";
import { LicenseStatus, LicenseTier } from "@prisma/client";
import { prisma } from "./prisma";

export type BillingPlan = "solo" | "teams";

export function resolveBillingPlan(value: string | null): BillingPlan {
  if (value === "solo" || value === "teams") {
    return value;
  }

  throw new Error("Invalid billing plan. Expected 'solo' or 'teams'.");
}

export function priceIdForPlan(plan: BillingPlan) {
  const priceId = plan === "teams" ? process.env.STRIPE_TEAMS_PRICE_ID : process.env.STRIPE_SOLO_PRICE_ID;

  if (!priceId) {
    throw new Error(`Stripe price ID is not configured for ${plan}.`);
  }

  return priceId;
}

export function tierForPlan(plan: BillingPlan) {
  return plan === "teams" ? LicenseTier.TEAMS : LicenseTier.SOLO;
}

export function generateLicenseToken() {
  return `pfl_${randomBytes(32).toString("base64url")}`;
}

export function hashLicenseToken(token: string) {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function normalizeQuantity(value: string | number | null | undefined, plan: BillingPlan) {
  if (plan === "solo") {
    return 1;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return Math.min(Math.floor(parsed), 500);
}

export async function resolveCheckoutOrganization({
  organizationId,
  userEmail
}: {
  organizationId?: string | null;
  userEmail?: string | null;
}) {
  if (userEmail) {
    const user = await prisma.user.findUnique({
      where: { email: userEmail },
      include: { organization: true }
    });

    if (user?.organization) {
      return user.organization;
    }
  }

  if (!organizationId) {
    return null;
  }

  return prisma.organization.findUnique({
    where: { id: organizationId }
  });
}

export function getObjectId(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }

  return null;
}

export function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice) {
  const rawInvoice = invoice as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
    parent?: {
      subscription_details?: {
        subscription?: string | Stripe.Subscription | null;
      } | null;
    } | null;
  };

  return (
    getObjectId(rawInvoice.subscription) ||
    getObjectId(rawInvoice.parent?.subscription_details?.subscription)
  );
}

export function getOrganizationIdFromMetadata(source: { metadata?: Stripe.Metadata | null } | null | undefined) {
  return source?.metadata?.organizationId || source?.metadata?.organization_id || null;
}

export async function upsertActiveLicenseForSubscription({
  organizationId,
  tier,
  seats,
  stripeCustomerId,
  stripeSubscriptionId,
  stripePriceId,
  label
}: {
  organizationId: string;
  tier: LicenseTier;
  seats: number;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripePriceId?: string | null;
  label?: string;
}) {
  const existing = stripeSubscriptionId
    ? await prisma.licenseKey.findFirst({
        where: { stripeSubscriptionId }
      })
    : null;

  if (existing) {
    return prisma.licenseKey.update({
      where: { id: existing.id },
      data: {
        tier,
        status: LicenseStatus.ACTIVE,
        seats,
        stripeCustomerId,
        stripePriceId,
        organizationId,
        label,
        lastUsedAt: new Date()
      }
    });
  }

  const token = generateLicenseToken();

  return prisma.licenseKey.create({
    data: {
      tokenHash: hashLicenseToken(token),
      tier,
      status: LicenseStatus.ACTIVE,
      seats,
      stripeCustomerId,
      stripeSubscriptionId,
      stripePriceId,
      organizationId,
      label
    }
  });
}

export async function revokeLicensesForSubscription(stripeSubscriptionId: string) {
  return prisma.licenseKey.updateMany({
    where: { stripeSubscriptionId },
    data: {
      status: LicenseStatus.REVOKED
    }
  });
}
