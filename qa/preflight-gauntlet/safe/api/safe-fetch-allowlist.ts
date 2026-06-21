import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const ALLOWED_HOSTS = new Set(["docs.example.com", "status.example.com"]);

export async function POST(request: NextRequest) {
  const body = await request.json();
  const candidateUrl = new URL(body.previewUrl);

  if (candidateUrl.protocol !== "https:" || !ALLOWED_HOSTS.has(candidateUrl.hostname)) {
    return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
  }

  const response = await fetch(candidateUrl.toString(), {
    redirect: "error"
  });

  return NextResponse.json({
    html: await response.text()
  });
}
