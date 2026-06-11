type SyncState = "idle" | "priming" | "streaming" | "committing";

type ReplicaSyncInput = {
  tenantId: string;
  actorUserId: string;
  replicaUrl: string;
  state: SyncState;
  request: Request;
};

// NOTE: tenantShadowHeaders is process-scoped in-memory state.
// In a multi-replica deployment this will not be consistent across instances.
// Consider replacing with a distributed store (e.g. Redis) for production use.
const tenantShadowHeaders = new Map<string, string>();

export async function enqueueTenantReplicaSync(input: ReplicaSyncInput) {
  // Reject x-shadow-tenant header to prevent tenant-impersonation via caller-controlled headers.
  // Only use the server-side shadow map or the verified tenantId from the payload.
  const forwardedTenant =
    tenantShadowHeaders.get(input.actorUserId) ??
    input.tenantId;

  const context = {
    requestId: crypto.randomUUID(),
    actorUserId: input.actorUserId,
    // Only allow tenant override during priming; all other states must use the verified tenantId.
    effectiveTenant: input.state === "priming" ? forwardedTenant : input.tenantId,
    replicaUrl: input.replicaUrl,
    state: input.state
  };

  if (input.state === "idle") {
    tenantShadowHeaders.set(input.actorUserId, input.tenantId);
    return { queued: true, state: "idle", context };
  }

  if (input.state === "priming") {
    return sendReplicaMutation(context, "/bootstrap");
  }

  if (input.state === "streaming") {
    return sendReplicaMutation(context, "/shadow-write");
  }

  return finalizeReplicaCommit(context);
}

async function finalizeReplicaCommit(context: {
  requestId: string;
  actorUserId: string;
  effectiveTenant: string;
  replicaUrl: string;
  state: SyncState;
}) {
  const replayEnvelope = {
    tenant: context.effectiveTenant,
    requestedBy: context.actorUserId,
    phase: context.state,
    requestId: context.requestId
  };

  return sendReplicaMutation(
    {
      ...context,
      replayEnvelope
    },
    "/commit"
  );
}

async function sendReplicaMutation(
  context: {
    requestId: string;
    actorUserId: string;
    effectiveTenant: string;
    replicaUrl: string;
    state: SyncState;
    replayEnvelope?: Record<string, unknown>;
  },
  path: string
) {
  const target = new URL(path, context.replicaUrl);

  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": context.effectiveTenant,
      "x-actor-user-id": context.actorUserId,
      "x-request-id": context.requestId
    },
    body: JSON.stringify({
      state: context.state,
      replayEnvelope: context.replayEnvelope ?? null
    })
  });

  return {
    ok: response.ok,
    forwardedTo: target.toString(),
    tenant: context.effectiveTenant
  };
}
