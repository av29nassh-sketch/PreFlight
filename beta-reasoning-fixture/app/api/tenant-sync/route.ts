import { NextResponse } from "next/server";
import { enqueueTenantReplicaSync } from "../../../lib/tenant/proxy";

type SyncState = "idle" | "priming" | "streaming" | "committing";

const VALID_STATES = new Set<string>(["idle", "priming", "streaming", "committing"]);
const inFlight = new Map<string, Promise<unknown>>();

export async function POST(request: Request) {
  const payload = await request.json();

  const tenantId = String(payload.tenantId ?? "").trim();
  const actorUserId = String(payload.userId ?? "").trim();
  const replicaUrl = String(payload.replicaUrl ?? "").trim();
  const rawState = String(payload.state ?? "idle").trim();

  if (!tenantId || !actorUserId || !replicaUrl) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (!VALID_STATES.has(rawState)) {
    return NextResponse.json({ error: "Invalid state value" }, { status: 400 });
  }

  const state = rawState as SyncState;

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
    inFlight.set(
      lockKey,
      enqueueTenantReplicaSync({
        tenantId,
        actorUserId,
        replicaUrl: parsedUrl.toString(),
        state,
        request
      })
    );
  }

  try {
    const result = await inFlight.get(lockKey);
    return NextResponse.json(result);
  } finally {
    inFlight.delete(lockKey);
  }
}
