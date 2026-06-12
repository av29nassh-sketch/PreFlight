const ALLOWED_PREVIEW_PROTOCOLS = new Set(["https:"]);
const ALLOWED_PREVIEW_HOSTS = new Set([
  "preflight-vibe.vercel.app",
  "api.preflight-vibe.vercel.app"
]);

function getSafePreviewUrl(rawValue: FormDataEntryValue | null) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    throw new Error("A preview URL is required.");
  }

  const parsedUrl = new URL(rawValue.trim());

  if (!ALLOWED_PREVIEW_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error("Unsupported preview URL protocol.");
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("Preview URLs cannot contain embedded credentials.");
  }

  if (!ALLOWED_PREVIEW_HOSTS.has(parsedUrl.hostname)) {
    throw new Error("Preview URL host is not allowed.");
  }

  return parsedUrl;
}

export async function preview(formData: FormData) {
  "use server";
  // preflight-ignore: ambiguous-ast
  const target = getSafePreviewUrl(formData.get("url"));

  return fetch(target.toString(), {
    method: "GET",
    redirect: "error"
  });
}
