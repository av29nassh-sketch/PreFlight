import { NextResponse } from "next/server";
import { WebhookVerificationError, validateEvent } from "@polar-sh/sdk/webhooks";
import { LicenseStatus, LicenseTier, Prisma } from "@prisma/client";
import { hashLicenseToken } from "../../../../lib/control-plane";
import { prisma } from "../../../../lib/prisma";

export const runtime = "nodejs";

type PolarSubscriptionEventName = "subscription.created" | "subscription.updated";
type PolarTier = "solo" | "teams";

type PolarMetadataValue = string | number | boolean | Date | null | undefined;
type PolarMetadata = Record<string, PolarMetadataValue>;

type PolarBenefitLike = {
  id?: string;
  benefitId?: string;
  benefit_id?: string;
};

type PolarProductLike = {
  id?: string;
  benefits?: PolarBenefitLike[];
};

type PolarCustomerLike = {
  email?: string | null;
  externalId?: string | null;
  external_id?: string | null;
};

type PolarSubscriptionData = {
  id: string;
  status: string;
  productId?: string | null;
  product_id?: string | null;
  seats?: number | null;
  quantity?: number | null;
  metadata?: PolarMetadata;
  customFieldData?: PolarMetadata;
  custom_field_data?: PolarMetadata;
  product?: PolarProductLike | null;
  customer?: PolarCustomerLike | null;
};

type VerifiedPolarSubscriptionEvent = {
  type: PolarSubscriptionEventName;
  data: PolarSubscriptionData;
};

type PolarIdentity = {
  userId: string | null;
  email: string | null;
};

type SubscriptionEntitlement = {
  tier: PolarTier;
  licenseTier: LicenseTier;
  seats: number;
  status: LicenseStatus;
  trialCredits: number;
};

const TEAM_DEFAULT_SEATS = 1;
const SOLO_CREDITS = 9999;
const TEAMS_CREDITS = 9999;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function requirePolarSecret() {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("POLAR_WEBHOOK_SECRET is not configured.");
  }

  return secret;
}

function asHeaderRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function isSubscriptionEvent(event: unknown): event is VerifiedPolarSubscriptionEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const candidate = event as { type?: unknown; data?: unknown };
  return (
    (candidate.type === "subscription.created" || candidate.type === "subscription.updated") &&
    Boolean(candidate.data) &&
    typeof candidate.data === "object"
  );
}

function stringifyField(value: PolarMetadataValue): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function readMetadataString(fields: Array<PolarMetadata | undefined>, keys: string[]) {
  for (const field of fields) {
    if (!field) {
      continue;
    }

    for (const key of keys) {
      const value = stringifyField(field[key]);
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function extractIdentity(subscription: PolarSubscriptionData): PolarIdentity {
  const customFields = subscription.customFieldData || subscription.custom_field_data;
  const metadataFields = [subscription.metadata, customFields];

  return {
    userId:
      readMetadataString(metadataFields, ["userId", "user_id", "dbUserId", "db_user_id"]) ||
      subscription.customer?.externalId ||
      subscription.customer?.external_id ||
      null,
    email: readMetadataString(metadataFields, ["email", "userEmail", "user_email"]) || subscription.customer?.email || null
  };
}

function collectEntitlementIds(subscription: PolarSubscriptionData) {
  const ids = new Set<string>();

  for (const value of [subscription.productId, subscription.product_id, subscription.product?.id]) {
    if (value) {
      ids.add(value);
    }
  }

  for (const benefit of subscription.product?.benefits || []) {
    for (const value of [benefit.id, benefit.benefitId, benefit.benefit_id]) {
      if (value) {
        ids.add(value);
      }
    }
  }

  return ids;
}

function resolveTier(subscription: PolarSubscriptionData): PolarTier | null {
  const ids = collectEntitlementIds(subscription);
  const soloBenefitId = process.env.POLAR_SOLO_BENEFIT_ID;
  const teamsBenefitId = process.env.POLAR_TEAMS_BENEFIT_ID;

  if (teamsBenefitId && ids.has(teamsBenefitId)) {
    return "teams";
  }

  if (soloBenefitId && ids.has(soloBenefitId)) {
    return "solo";
  }

  const metadataTier = readMetadataString(
    [subscription.metadata, subscription.customFieldData, subscription.custom_field_data],
    ["tier", "plan", "productTier", "product_tier"]
  )?.toLowerCase();

  if (metadataTier === "teams" || metadataTier === "team") {
    return "teams";
  }

  if (metadataTier === "solo" || metadataTier === "pro") {
    return "solo";
  }

  return null;
}

function seatCountFor(subscription: PolarSubscriptionData, tier: PolarTier) {
  if (tier === "solo") {
    return 1;
  }

  const seats = subscription.seats ?? subscription.quantity ?? TEAM_DEFAULT_SEATS;
  return Number.isInteger(seats) && seats > 0 ? seats : TEAM_DEFAULT_SEATS;
}

function statusFor(subscription: PolarSubscriptionData) {
  const activeStatuses = new Set(["active", "trialing", "incomplete"]);
  return activeStatuses.has(subscription.status) ? LicenseStatus.ACTIVE : LicenseStatus.REVOKED;
}

function entitlementFor(subscription: PolarSubscriptionData, tier: PolarTier): SubscriptionEntitlement {
  return {
    tier,
    licenseTier: tier === "teams" ? LicenseTier.TEAMS : LicenseTier.SOLO,
    seats: seatCountFor(subscription, tier),
    status: statusFor(subscription),
    trialCredits: tier === "teams" ? TEAMS_CREDITS : SOLO_CREDITS
  };
}

async function upsertUserForSubscription(
  tx: Prisma.TransactionClient,
  identity: PolarIdentity,
  entitlement: SubscriptionEntitlement
) {
  if (identity.userId) {
    const existing = await tx.user.findUnique({
      where: { id: identity.userId },
      select: { id: true }
    });

    if (existing) {
      return tx.user.update({
        where: { id: identity.userId },
        data: { trialCredits: entitlement.trialCredits }
      });
    }

    if (identity.email) {
      return tx.user.create({
        data: {
          id: identity.userId,
          email: identity.email,
          trialCredits: entitlement.trialCredits
        }
      });
    }
  }

  if (identity.email) {
    return tx.user.upsert({
      where: { email: identity.email },
      update: { trialCredits: entitlement.trialCredits },
      create: {
        email: identity.email,
        trialCredits: entitlement.trialCredits
      }
    });
  }

  throw new Error("Polar subscription metadata must include metadata.userId, custom_field userId, or customer email.");
}

async function upsertSubscriptionEntitlement({
  tx,
  subscription,
  userId,
  entitlement
}: {
  tx: Prisma.TransactionClient;
  subscription: PolarSubscriptionData;
  userId: string;
  entitlement: SubscriptionEntitlement;
}) {
  const tokenHash = hashLicenseToken(`polar:subscription:${subscription.id}`);

  await tx.licenseKey.upsert({
    where: { tokenHash },
    update: {
      label: `Polar ${entitlement.tier} subscription`,
      seats: entitlement.seats,
      status: entitlement.status,
      tier: entitlement.licenseTier,
      userId
    },
    create: {
      label: `Polar ${entitlement.tier} subscription`,
      seats: entitlement.seats,
      status: entitlement.status,
      tier: entitlement.licenseTier,
      tokenHash,
      userId
    }
  });
}

async function processSubscriptionEvent({
  event,
  webhookId
}: {
  event: VerifiedPolarSubscriptionEvent;
  webhookId: string;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.polarWebhookEvent.create({
      data: {
        polarEventId: webhookId,
        type: event.type
      }
    });

    const tier = resolveTier(event.data);
    if (!tier) {
      throw new Error("Unable to map Polar subscription to Solo or Teams tier.");
    }

    const entitlement = entitlementFor(event.data, tier);
    const user = await upsertUserForSubscription(tx, extractIdentity(event.data), entitlement);

    await upsertSubscriptionEntitlement({
      tx,
      subscription: event.data,
      userId: user.id,
      entitlement
    });
  });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const webhookId = req.headers.get("webhook-id");

  let event: unknown;
  try {
    event = validateEvent(rawBody, asHeaderRecord(req.headers), requirePolarSecret());
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return jsonError("Invalid Polar webhook signature.", 401);
    }

    return jsonError("Invalid Polar webhook payload.", 400);
  }

  if (!webhookId) {
    return jsonError("Missing Polar webhook-id header.", 400);
  }

  if (!isSubscriptionEvent(event)) {
    return NextResponse.json({ received: true, ignored: true });
  }

  try {
    await processSubscriptionEvent({ event, webhookId });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ received: true, duplicate: true });
    }

    const message = error instanceof Error ? error.message : "Unable to process Polar subscription webhook.";
    return jsonError(message, 400);
  }

  return NextResponse.json({ received: true });
}
