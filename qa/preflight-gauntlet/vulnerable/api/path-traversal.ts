import path from "node:path";
import fs from "node:fs/promises";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const fileName = request.nextUrl.searchParams.get("file") || "readme.txt";
  const filePath = path.join(process.cwd(), "uploads", fileName);
  const contents = await fs.readFile(filePath, "utf8");

  return NextResponse.json({ contents });
}
