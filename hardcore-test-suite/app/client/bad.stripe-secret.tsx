"use client";

export function CheckoutButton() {
  const stripeSecret = "sk_live_PREFLIGHT_DUMMY_KEY_12345";
  return <button data-token={stripeSecret}>Checkout</button>;
}
