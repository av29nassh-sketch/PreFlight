import { NextResponse } from "next/server";

export async function GET() {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const secretKeyIsConfigured = Boolean(process.env.STRIPE_SECRET_KEY);

  return NextResponse.json({
    publishableKey,
    secretKeyIsConfigured
  });
}
