import Stripe from "stripe";

const STRIPE_API_VERSION = "2026-05-27.dahlia";

export function getStripe() {
  const apiKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_RESTRICTED_KEY;

  if (!apiKey) {
    throw new Error("Stripe API key is not configured.");
  }

  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION
  });
}

export function getStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error("Stripe webhook signing secret is not configured.");
  }

  return secret;
}
