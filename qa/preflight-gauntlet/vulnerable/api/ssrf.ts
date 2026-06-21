import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const previewUrl = body.previewUrl;

  const response = await fetch(previewUrl);
  const html = await response.text();

  return NextResponse.json({
    html
  });
}
