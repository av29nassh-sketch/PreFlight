import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "../../../../lib/prisma";

const auditRequestSchema = z.object({
  inputType: z.enum(["github", "website", "code"]),
  target: z.string().trim().min(8).max(12000),
  email: z.string().trim().email().max(320)
});

async function ensureAuditRequestTable() {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "AuditRequest" (
      "id" TEXT PRIMARY KEY,
      "inputType" TEXT NOT NULL,
      "target" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'new',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = auditRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please provide a valid audit target and email address." },
      { status: 400 }
    );
  }

  await ensureAuditRequestTable();

  await prisma.$executeRaw`
    INSERT INTO "AuditRequest" ("id", "inputType", "target", "email")
    VALUES (${randomUUID()}, ${parsed.data.inputType}, ${parsed.data.target}, ${parsed.data.email})
  `;

  return NextResponse.json({ ok: true });
}
