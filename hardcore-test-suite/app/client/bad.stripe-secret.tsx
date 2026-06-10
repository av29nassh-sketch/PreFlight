"use client";

export function CheckoutButton() {
  const stripeSecret = "sk_live_DEMO_PLACEHOLDER_1234567890abcdef";
  return <button data-token={stripeSecret}>Checkout</button>;
}
