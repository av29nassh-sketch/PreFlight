import { NextResponse } from "next/server";
import { enqueueTenantReplicaSync } from "../../../lib/tenant/proxy";
import { headers } from "next/headers";

type SyncState = "idle" | "priming" | "streaming" | "committing";

const VALID_STATES = new Set<SyncState>(["idle", "priming", "streaming", "committing"]);
const inFlight = new Map<string, Promise<unknown>>();

function sanitizeString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  return String(value).trim();
}

function validateSyncState(raw: string): raw is SyncState {
  return VALID_STATES.has(raw as SyncState);
}

export async function POST(request: Request) {
  const headersList = headers();
  const authenticatedTenantId = headersList.get("x-authenticated-tenant-id");
  const authenticatedUserId = headersList.get("x-authenticated-user-id");

  if (!authenticatedTenantId || !authenticatedUserId) {
    return NextResponse.json({ error: "Unauthorized: missing tenant or user authentication" }, { status: 401 });
  }

  const payload = await request.json();

  const tenantId = sanitizeString(payload.tenantId);
  const actorUserId = sanitizeString(payload.userId);
  const replicaUrl = sanitizeString(payload.replicaUrl);
  const rawState = sanitizeString(payload.state || "idle");

  if (!tenantId || !actorUserId || !replicaUrl) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (tenantId !== authenticatedTenantId) {
    return NextResponse.json({ error: "Forbidden: tenant mismatch" }, { status: 403 });
  }

  if (actorUserId !== authenticatedUserId) {
    return NextResponse.json({ error: "Forbidden: user mismatch" }, { status: 403 });
  }

  if (!validateSyncState(rawState)) {
    return NextResponse.json({ error: "Invalid state value" }, { status: 400 });
  }

  const state: SyncState = rawState;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(replicaUrl);
    if (!parsedUrl.protocol.startsWith("http")) {
      throw new Error("Invalid protocol");
    }
  } catch {
    return NextResponse.json({ error: "Invalid replicaUrl" }, { status: 400 });
  }

  const lockKey = `${tenantId}:${state}`;

  if (!inFlight.has(lockKey)) {
    const syncPromise = enqueueTenantReplicaSync({
      tenantId,
      actorUserId,
      replicaUrl: parsedUrl.toString(),
      state,
      request
    });
    inFlight.set(lockKey, syncPromise);
  }

  try {
    const result = await inFlight.get(lockKey);
    return NextResponse.json(result);
  } finally {
    inFlight.delete(lockKey);
  }
}
