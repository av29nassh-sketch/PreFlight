import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  const body = await request.json();
  const domain = body.domain;

  if (typeof domain !== "string" || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
    return NextResponse.json({ error: "Invalid domain" }, { status: 400 });
  }

  const result = await execFileAsync("nslookup", [domain]);

  return NextResponse.json({
    stdout: result.stdout
  });
}
