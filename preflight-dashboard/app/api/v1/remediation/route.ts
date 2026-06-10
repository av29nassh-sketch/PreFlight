import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isActiveLicense, resolveActiveLicenseKey } from "../../../../lib/control-plane";
import { prisma } from "../../../../lib/prisma";

export const runtime = "nodejs";

const CLAUDE_REMEDIATION_MODEL =
  process.env.PREFLIGHT_ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

const PREFLIGHT_SYSTEM_PROMPT =
  "You are the automated remediation engine for 'PreFlight', a local-first developer security CLI. Your sole purpose is to receive vulnerable code snippets and return the exact, fully patched, production-ready secure code. CRITICAL INSTRUCTIONS: 1. NO CONVERSATIONAL TEXT. 2. NO MARKDOWN (do not use ```javascript). Output ONLY the raw text. 3. PRESERVE LOGIC & FORMATTING exactly. Modify only the lines required for the fix. 4. If the fix is too ambiguous or risky, output exactly and only: MANUAL_REVIEW_REQUIRED.";

const RemediationRequestSchema = z.object({
  userId: z.string().trim().min(1).max(160).optional(),
  authToken: z.string().trim().min(1).max(512).optional(),
  vulnerabilityType: z.string().trim().min(1).max(120),
  filePath: z.string().trim().min(1).max(600),
  codeSnippet: z.string().min(1).max(120000)
}).refine((value) => Boolean(value.userId || value.authToken), {
  message: "Either userId or authToken is required."
});

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

function buildUserMessage({
  vulnerabilityType,
  filePath,
  codeSnippet
}: {
  vulnerabilityType: string;
  filePath: string;
  codeSnippet: string;
}) {
  return [
    `Vulnerability Type: ${vulnerabilityType}`,
    `File Path: ${filePath}`,
    "",
    "Code Snippet:",
    codeSnippet
  ].join("\n");
}

function extractTextResponse(message: { content: Array<{ type: string; text?: string }> }) {
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text || "")
    .join("");
}

function stripMarkdownFence(value: string) {
  const text = value.trim();
  const fenced = text.match(/^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  return (fenced ? fenced[1] : text).trim();
}

async function resolveUserIdFromPayload(payload: z.infer<typeof RemediationRequestSchema>) {
  if (payload.userId) {
    return payload.userId;
  }

  if (!payload.authToken) {
    return null;
  }

  const license = await resolveActiveLicenseKey(payload.authToken);
  return isActiveLicense(license) ? license?.userId || null : null;
}

async function debitTrialCredit(userId: string) {
  const debited = await prisma.user.updateMany({
    where: {
      id: userId,
      trialCredits: { gt: 0 }
    },
    data: {
      trialCredits: { decrement: 1 }
    }
  });

  if (debited.count > 0) {
    return { debited: true, user: null };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      trialCredits: true
    }
  });

  return { debited: false, user };
}

async function refundTrialCredit(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      trialCredits: { increment: 1 }
    }
  });
}

export async function POST(req: NextRequest) {
  let rawBody: unknown;
  let userId: string | null = null;
  let creditDebited = false;

  try {
    rawBody = await req.json();
  } catch {
    return json(400, {
      ok: false,
      reason: "Invalid JSON request body."
    });
  }

  const parsed = RemediationRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return json(400, {
      ok: false,
      reason: "Invalid remediation payload."
    });
  }

  try {
    userId = await resolveUserIdFromPayload(parsed.data);
    if (!userId) {
      return json(401, {
        ok: false,
        reason: "A valid authenticated user is required."
      });
    }

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      return json(500, {
        ok: false,
        reason: "Anthropic API key is not configured."
      });
    }

    const credit = await debitTrialCredit(userId);
    if (!credit.debited) {
      if (!credit.user) {
        return json(404, {
          ok: false,
          reason: "User not found."
        });
      }

      return json(402, {
        ok: false,
        reason: "Trial credits exhausted. Please upgrade to continue using cloud remediation."
      });
    }
    creditDebited = true;

    const anthropic = new Anthropic({
      apiKey: anthropicApiKey
    });
    const message = await anthropic.messages.create({
      model: CLAUDE_REMEDIATION_MODEL,
      max_tokens: 8192,
      system: PREFLIGHT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserMessage(parsed.data)
        }
      ]
    });
    const patchedCode = stripMarkdownFence(extractTextResponse(message));

    return NextResponse.json({
      ok: true,
      patchedCode
    });
  } catch (error) {
    if (creditDebited && userId) {
      await refundTrialCredit(userId).catch(() => {});
    }

    return json(500, {
      ok: false,
      reason: "Cloud remediation failed. No trial credit was consumed.",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
