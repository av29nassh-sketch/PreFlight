import { validateOutboundUrl } from "@/lib/security/url";

export async function preview(formData: FormData) {
  "use server";
  const target = formData.get("url");
  const safeTarget = validateOutboundUrl(target);
  return fetch(safeTarget);
}
