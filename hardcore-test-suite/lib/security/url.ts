export function validateOutboundUrl(value: FormDataEntryValue | null) {
  const parsed = new URL(String(value));
  if (!["https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported outbound protocol");
  }
  if (!["api.stripe.com", "example.com"].includes(parsed.hostname)) {
    throw new Error("Outbound host is not allowlisted");
  }
  return parsed.toString();
}
