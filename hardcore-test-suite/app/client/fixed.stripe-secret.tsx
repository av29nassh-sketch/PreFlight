"use client";

export function CheckoutButton() {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  return <button data-token={publishableKey}>Checkout</button>;
}
