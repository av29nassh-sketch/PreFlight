import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const auditRequestSchema = z.object({
  inputType: z.enum(["github", "website", "code"]),
  target: z.string().trim().min(8).max(12000),
  email: z.string().trim().email().max(320)
});

declare global {
  // eslint-disable-next-line no-var
  var __preflightAuditPool: Pool | undefined;
}

function getAuditPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!globalThis.__preflightAuditPool) {
    globalThis.__preflightAuditPool = new Pool({
      connectionString,
      ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false }
    });
  }

  return globalThis.__preflightAuditPool;
}

const auditTypeLabels = {
  github: "GitHub Repo URL",
  website: "Live Website URL",
  code: "Pasted Code Block"
} as const;

function formatAuditTargetForDiscord(inputType: keyof typeof auditTypeLabels, target: string) {
  if (inputType === "code") {
    return `Code block submitted (${target.length.toLocaleString()} characters). Stored in AuditRequest.`;
  }

  return target.length > 1000 ? `${target.slice(0, 997)}...` : target;
}

function formatAuditTargetForTelegram(inputType: keyof typeof auditTypeLabels, target: string) {
  if (inputType === "code") {
    return `Code block submitted (${target.length.toLocaleString()} characters). Stored in AuditRequest.`;
  }

  return target.length > 2500 ? `${target.slice(0, 2497)}...` : target;
}

function formatAuditTargetForEmail(inputType: keyof typeof auditTypeLabels, target: string) {
  if (inputType === "code") {
    return `Code block submitted (${target.length.toLocaleString()} characters). Stored in AuditRequest.`;
  }

  return target;
}

async function notifyDiscordAuditRequest({
  id,
  inputType,
  target,
  email
}: {
  id: string;
  inputType: keyof typeof auditTypeLabels;
  target: string;
  email: string;
}) {
  const webhookUrl = process.env.AUDIT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return false;
  }

  const mentionUserId = process.env.DISCORD_MENTION_USER_ID?.trim();
  const mentionPrefix = mentionUserId ? `<@${mentionUserId}> ` : "";
  const content = `${mentionPrefix}New PreFlight audit request received: ${auditTypeLabels[inputType]} from ${email}`;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content,
      allowed_mentions: mentionUserId
        ? { users: [mentionUserId] }
        : { parse: [] },
      embeds: [
        {
          title: "New PreFlight Audit Request",
          color: 3447003,
          fields: [
            {
              name: "Type",
              value: auditTypeLabels[inputType],
              inline: true
            },
            {
              name: "Email",
              value: email,
              inline: true
            },
            {
              name: "Audit ID",
              value: id,
              inline: false
            },
            {
              name: "Target",
              value: formatAuditTargetForDiscord(inputType, target),
              inline: false
            }
          ],
          timestamp: new Date().toISOString()
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed with status ${response.status}`);
  }

  return true;
}

async function notifyEmailAuditRequest({
  id,
  inputType,
  target,
  email
}: {
  id: string;
  inputType: keyof typeof auditTypeLabels;
  target: string;
  email: string;
}) {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const notificationEmail = process.env.AUDIT_NOTIFICATION_EMAIL?.trim();
  const fromEmail = process.env.AUDIT_EMAIL_FROM?.trim() || "PreFlight <onboarding@resend.dev>";
  if (!resendApiKey || !notificationEmail) {
    return false;
  }

  const lines = [
    "New PreFlight Audit Request",
    "",
    `Type: ${auditTypeLabels[inputType]}`,
    `Submitted email: ${email}`,
    `Audit ID: ${id}`,
    "",
    "Target:",
    formatAuditTargetForEmail(inputType, target)
  ];

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [notificationEmail],
      subject: `New PreFlight audit request: ${auditTypeLabels[inputType]}`,
      text: lines.join("\n")
    })
  });

  if (!response.ok) {
    throw new Error(`Email notification failed with status ${response.status}`);
  }

  return true;
}

async function notifyTelegramAuditRequest({
  id,
  inputType,
  target,
  email
}: {
  id: string;
  inputType: keyof typeof auditTypeLabels;
  target: string;
  email: string;
}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) {
    return false;
  }

  const text = [
    "New PreFlight Audit Request",
    "",
    `Type: ${auditTypeLabels[inputType]}`,
    `Email: ${email}`,
    `Audit ID: ${id}`,
    "",
    `Target: ${formatAuditTargetForTelegram(inputType, target)}`
  ].join("\n");

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram notification failed with status ${response.status}`);
  }

  return true;
}

async function ensureAuditRequestTable() {
  await getAuditPool().query(`
    CREATE TABLE IF NOT EXISTS "AuditRequest" (
      "id" TEXT PRIMARY KEY,
      "inputType" TEXT NOT NULL,
      "target" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'new',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
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

  const auditId = randomUUID();

  try {
    await ensureAuditRequestTable();

    await getAuditPool().query(
      `
      INSERT INTO "AuditRequest" ("id", "inputType", "target", "email")
      VALUES ($1, $2, $3, $4)
      `,
      [auditId, parsed.data.inputType, parsed.data.target, parsed.data.email]
    );
  } catch (error) {
    console.error("Audit request database insert failed", {
      auditId,
      error: error instanceof Error ? error.message : "Unknown error"
    });

    return NextResponse.json(
      { error: "Could not save audit request. Please try again in a minute." },
      { status: 500 }
    );
  }

  let discordNotificationSent = false;
  try {
    discordNotificationSent = await notifyDiscordAuditRequest({
      id: auditId,
      inputType: parsed.data.inputType,
      target: parsed.data.target,
      email: parsed.data.email
    });
  } catch (error) {
    console.error("Audit request Discord notification failed", {
      auditId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }

  let telegramNotificationSent = false;
  try {
    telegramNotificationSent = await notifyTelegramAuditRequest({
      id: auditId,
      inputType: parsed.data.inputType,
      target: parsed.data.target,
      email: parsed.data.email
    });
  } catch (error) {
    console.error("Audit request Telegram notification failed", {
      auditId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }

  let emailNotificationSent = false;
  try {
    emailNotificationSent = await notifyEmailAuditRequest({
      id: auditId,
      inputType: parsed.data.inputType,
      target: parsed.data.target,
      email: parsed.data.email
    });
  } catch (error) {
    console.error("Audit request email notification failed", {
      auditId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }

  return NextResponse.json({
    ok: true,
    notificationSent: discordNotificationSent || telegramNotificationSent || emailNotificationSent,
    discordNotificationSent,
    telegramNotificationSent,
    emailNotificationSent
  });
}
