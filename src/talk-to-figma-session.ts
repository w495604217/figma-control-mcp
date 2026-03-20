import { BridgeStore } from "./bridge-store.js";
import { FigmaPluginMenuClient, type LaunchAndDiscoverInput } from "./figma-plugin-menu.js";
import { discoverResponsiveTalkToFigmaChannel, type DiscoveredTalkToFigmaChannel } from "./talk-to-figma-log.js";
import { syncTalkToFigmaChannel } from "./talk-to-figma-sync.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";
import { createTraceContext, recordTrace, type TraceContext } from "./trace-store.js";
import type { TraceStore } from "./trace-store.js";

type TalkToFigmaExecutor = Pick<TalkToFigmaClient, "executeCommand">;

/**
 * Describes the assessed health of a session or channel at the time of an attempt.
 *
 * - `active` — the channel responded to a sync command and the session metadata is recent
 * - `stale` — the stored session metadata exists but `lastHeartbeatAt` exceeds the threshold
 * - `unreachable` — the channel could not be contacted (timeout, connection refused, etc.)
 * - `unknown` — insufficient metadata to assess health (e.g. no `lastHeartbeatAt`)
 */
export type SessionHealth = "active" | "stale" | "unreachable" | "unknown";

const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export type EnsureAttempt = {
  strategy: "existing-session" | "explicit-channel" | "discover" | "launch";
  ok: boolean;
  health: SessionHealth;
  sessionId?: string;
  channel?: string;
  error?: string;
  /** ISO timestamp of `lastHeartbeatAt` when the session was classified as stale */
  staleSince?: string;
  /** Milliseconds since the snapshot's `capturedAt` — only present on successful sync */
  snapshotAge?: number;
};

type EnsureTalkToFigmaSessionInput = {
  store: BridgeStore;
  sessionId?: string;
  channel?: string;
  wsUrl?: string;
  logPath?: string;
  timeoutMs?: number;
  limit?: number;
  pluginName?: string;
  appName?: string;
  attempts?: number;
  delayMs?: number;
  forceLaunch?: boolean;
  /**
   * Milliseconds after which a stored session is considered stale.
   * Default: 300 000 (5 minutes). Set to `Infinity` to disable stale detection.
   */
  staleThresholdMs?: number;
  menuClient?: Pick<FigmaPluginMenuClient, "launchAndDiscoverTalkToFigmaChannel">;
  discoverer?: (input: {
    client?: TalkToFigmaClient;
    wsUrl?: string;
    logPath?: string;
    limit?: number;
    timeoutMs?: number;
    afterLine?: number;
  }) => Promise<DiscoveredTalkToFigmaChannel>;
  client?: TalkToFigmaExecutor;
  /** Trace store for observability. When provided, a trace record is emitted. */
  traceStore?: TraceStore;
  /** Parent trace id for linking sub-operations. */
  parentTraceId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function deriveWsUrl(metadata: Record<string, unknown> | null, override?: string): string | undefined {
  if (override) {
    return override;
  }
  return typeof metadata?.wsUrl === "string" ? metadata.wsUrl : undefined;
}

function deriveChannel(sessionId: string | undefined, metadata: Record<string, unknown> | null, explicitChannel?: string): string | undefined {
  if (explicitChannel) {
    return explicitChannel;
  }
  if (typeof metadata?.channel === "string" && metadata.channel) {
    return metadata.channel;
  }
  if (sessionId?.startsWith("talk-to-figma:")) {
    return sessionId.slice("talk-to-figma:".length) || undefined;
  }
  return undefined;
}

/**
 * Assess session health from stored metadata.
 * Returns `stale` if `lastHeartbeatAt` is older than `staleThresholdMs`,
 * `unknown` if there is no heartbeat data, and `active` otherwise.
 *
 * Note: this is a metadata-only check. The channel may still be unreachable
 * even when the metadata says "active". The `unreachable` state is only
 * assigned after an actual sync attempt fails.
 */
export function assessSessionHealth(session: {
  lastHeartbeatAt?: string;
  connectedAt?: string;
}, staleThresholdMs: number): { health: SessionHealth; staleSince?: string } {
  const heartbeat = session.lastHeartbeatAt ?? session.connectedAt;
  if (!heartbeat) {
    return { health: "unknown" };
  }

  const heartbeatTime = new Date(heartbeat).getTime();
  if (Number.isNaN(heartbeatTime)) {
    return { health: "unknown" };
  }

  const ageMs = Date.now() - heartbeatTime;
  if (ageMs > staleThresholdMs) {
    return { health: "stale", staleSince: heartbeat };
  }

  return { health: "active" };
}

/**
 * Classify an error into a SessionHealth value.
 * Timeout and connection errors → unreachable; everything else → unknown.
 */
function classifyError(error: unknown): SessionHealth {
  const message = String(error).toLowerCase();
  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("connection") ||
    message.includes("unreachable") ||
    message.includes("websocket")
  ) {
    return "unreachable";
  }
  return "unknown";
}

/**
 * Compute the snapshot age in milliseconds from `capturedAt`.
 */
function computeSnapshotAge(capturedAt: string | undefined): number | undefined {
  if (!capturedAt) {
    return undefined;
  }
  const time = new Date(capturedAt).getTime();
  if (Number.isNaN(time)) {
    return undefined;
  }
  return Math.max(0, Date.now() - time);
}

async function syncChannel(input: {
  store: BridgeStore;
  channel: string;
  sessionId?: string;
  wsUrl?: string;
  timeoutMs: number;
  client?: TalkToFigmaExecutor;
}) {
  const result = await syncTalkToFigmaChannel({
    store: input.store,
    channel: input.channel,
    sessionId: input.sessionId,
    wsUrl: input.wsUrl,
    timeoutMs: input.timeoutMs,
    client: input.client
  });

  return {
    channel: input.channel,
    wsUrl: input.wsUrl,
    ...result
  };
}

export type EnsureTalkToFigmaSessionResult = {
  strategy: EnsureAttempt["strategy"];
  sessionHealth: SessionHealth;
  session: Awaited<ReturnType<typeof syncTalkToFigmaChannel>>["session"];
  snapshot: Awaited<ReturnType<typeof syncTalkToFigmaChannel>>["snapshot"];
  channel: string;
  wsUrl?: string;
  snapshotAge?: number;
  launch?: Awaited<ReturnType<FigmaPluginMenuClient["launchAndDiscoverTalkToFigmaChannel"]>>["launch"];
  discovered?: DiscoveredTalkToFigmaChannel;
  attempts: EnsureAttempt[];
};

export async function ensureTalkToFigmaSession(input: EnsureTalkToFigmaSessionInput): Promise<EnsureTalkToFigmaSessionResult> {
  const timeoutMs = input.timeoutMs ?? 15000;
  const limit = input.limit ?? 12;
  const staleThresholdMs = input.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const attempts: EnsureAttempt[] = [];
  const menuClient = input.menuClient ?? new FigmaPluginMenuClient();
  const discoverer = input.discoverer ?? discoverResponsiveTalkToFigmaChannel;
  const traceCtx = createTraceContext(input.traceStore, input.parentTraceId);
  const traceStartedAt = new Date().toISOString();

  // ── Strategy 1: Reuse existing session ──────────────────────────────
  if (!input.forceLaunch && input.sessionId) {
    const session = await input.store.getSession(input.sessionId);
    const metadata = asRecord(session?.metadata);
    const source = typeof metadata?.source === "string" ? metadata.source : undefined;
    const channel = source === "talk-to-figma"
      ? deriveChannel(session?.sessionId, metadata, input.channel)
      : undefined;
    const wsUrl = deriveWsUrl(metadata, input.wsUrl);

    if (channel && session) {
      // Assess health from stored metadata before attempting sync
      const preHealth = assessSessionHealth(session, staleThresholdMs);

      if (preHealth.health === "stale") {
        // Skip sync — recorded as a stale-rejection attempt
        attempts.push({
          strategy: "existing-session",
          ok: false,
          health: "stale",
          sessionId: input.sessionId,
          channel,
          staleSince: preHealth.staleSince,
          error: `Session metadata is stale (last heartbeat: ${preHealth.staleSince ?? "unknown"})`
        });
        // Fall through to next strategy
      } else {
        try {
          const synced = await syncChannel({
            store: input.store,
            sessionId: input.sessionId,
            channel,
            wsUrl,
            timeoutMs,
            client: input.client
          });
          const snapshotAge = computeSnapshotAge(synced.snapshot.capturedAt);
          attempts.push({
            strategy: "existing-session",
            ok: true,
            health: "active",
            sessionId: synced.session.sessionId,
            channel: synced.channel,
            snapshotAge
          });
          const result = {
            strategy: "existing-session" as const,
            sessionHealth: "active" as const,
            session: synced.session,
            snapshot: synced.snapshot,
            channel: synced.channel,
            wsUrl: synced.wsUrl,
            snapshotAge,
            attempts
          };
          emitEnsureSessionTrace(traceCtx, traceStartedAt, result);
          return result;
        } catch (error) {
          const health = classifyError(error);
          attempts.push({
            strategy: "existing-session",
            ok: false,
            health,
            sessionId: input.sessionId,
            channel,
            error: String(error)
          });
        }
      }
    }
  }

  // ── Strategy 2: Use explicit channel ────────────────────────────────
  if (!input.forceLaunch && input.channel) {
    try {
      const synced = await syncChannel({
        store: input.store,
        sessionId: input.sessionId,
        channel: input.channel,
        wsUrl: input.wsUrl,
        timeoutMs,
        client: input.client
      });
      const snapshotAge = computeSnapshotAge(synced.snapshot.capturedAt);
      attempts.push({
        strategy: "explicit-channel",
        ok: true,
        health: "active",
        sessionId: synced.session.sessionId,
        channel: synced.channel,
        snapshotAge
      });
      const result = {
        strategy: "explicit-channel" as const,
        sessionHealth: "active" as const,
        session: synced.session,
        snapshot: synced.snapshot,
        channel: synced.channel,
        wsUrl: synced.wsUrl,
        snapshotAge,
        attempts
      };
      emitEnsureSessionTrace(traceCtx, traceStartedAt, result);
      return result;
    } catch (error) {
      const health = classifyError(error);
      attempts.push({
        strategy: "explicit-channel",
        ok: false,
        health,
        sessionId: input.sessionId,
        channel: input.channel,
        error: String(error)
      });
    }
  }

  // ── Strategy 3: Discover a responsive channel ───────────────────────
  if (!input.forceLaunch) {
    try {
      const discovered = await discoverer({
        wsUrl: input.wsUrl,
        logPath: input.logPath,
        limit,
        timeoutMs
      });
      const synced = await syncChannel({
        store: input.store,
        sessionId: input.sessionId,
        channel: discovered.channel,
        wsUrl: discovered.wsUrl,
        timeoutMs,
        client: input.client
      });
      const snapshotAge = computeSnapshotAge(synced.snapshot.capturedAt);
      attempts.push({
        strategy: "discover",
        ok: true,
        health: "active",
        sessionId: synced.session.sessionId,
        channel: synced.channel,
        snapshotAge
      });
      const result = {
        strategy: "discover" as const,
        sessionHealth: "active" as const,
        session: synced.session,
        snapshot: synced.snapshot,
        channel: synced.channel,
        wsUrl: synced.wsUrl,
        snapshotAge,
        discovered,
        attempts
      };
      emitEnsureSessionTrace(traceCtx, traceStartedAt, result);
      return result;
    } catch (error) {
      const health = classifyError(error);
      attempts.push({
        strategy: "discover",
        ok: false,
        health,
        sessionId: input.sessionId,
        error: String(error)
      });
    }
  }

  // ── Strategy 4: Launch plugin and discover ──────────────────────────
  const launchInput: LaunchAndDiscoverInput = {
    pluginName: input.pluginName ?? "Cursor MCP Plugin",
    appName: input.appName,
    wsUrl: input.wsUrl,
    logPath: input.logPath,
    limit,
    timeoutMs,
    attempts: input.attempts,
    delayMs: input.delayMs
  };

  try {
    const launched = await menuClient.launchAndDiscoverTalkToFigmaChannel(launchInput);
    const synced = await syncChannel({
      store: input.store,
      sessionId: input.sessionId,
      channel: launched.discovered.channel,
      wsUrl: launched.discovered.wsUrl,
      timeoutMs,
      client: input.client
    });
    const snapshotAge = computeSnapshotAge(synced.snapshot.capturedAt);
    attempts.push({
      strategy: "launch",
      ok: true,
      health: "active",
      sessionId: synced.session.sessionId,
      channel: synced.channel,
      snapshotAge
    });
    const result = {
      strategy: "launch" as const,
      sessionHealth: "active" as const,
      session: synced.session,
      snapshot: synced.snapshot,
      channel: synced.channel,
      wsUrl: synced.wsUrl,
      snapshotAge,
      launch: launched.launch,
      discovered: launched.discovered,
      attempts
    };
    emitEnsureSessionTrace(traceCtx, traceStartedAt, result);
    return result;
  } catch (error) {
    const health = classifyError(error);
    attempts.push({
      strategy: "launch",
      ok: false,
      health,
      sessionId: input.sessionId,
      error: String(error)
    });
    emitEnsureSessionTrace(traceCtx, traceStartedAt, null, String(error));
    throw new Error(`Could not ensure a responsive talk-to-figma session: ${String(error)}`);
  }
}

/**
 * Emit a trace record for the ensure-session flow if tracing is active.
 * Called internally by ensureTalkToFigmaSession before returning.
 */
function emitEnsureSessionTrace(
  traceCtx: TraceContext | undefined,
  startedAt: string,
  result: EnsureTalkToFigmaSessionResult | null,
  errorMsg?: string
): void {
  if (!traceCtx) return;

  const warnings = result?.attempts
    .filter((a) => !a.ok && a.health === "stale")
    .map((a) => `Strategy ${a.strategy} skipped: stale since ${a.staleSince ?? "unknown"}`) ?? [];

  const errors = result?.attempts
    .filter((a) => !a.ok && a.error)
    .map((a) => `Strategy ${a.strategy}: ${a.error!}`) ?? [];

  if (errorMsg) {
    errors.push(errorMsg);
  }

  recordTrace(traceCtx, {
    flowType: "ensure-session",
    startedAt,
    status: result ? "succeeded" : "failed",
    sessionId: result?.session?.sessionId,
    channel: result?.channel,
    input: {
      sessionId: result?.attempts?.[0]?.sessionId,
      strategy: result?.strategy,
    },
    output: {
      strategy: result?.strategy ?? "none",
      sessionHealth: result?.sessionHealth ?? "unknown",
      snapshotAge: result?.snapshotAge,
      attemptCount: result?.attempts?.length ?? 0,
    },
    warnings,
    errors,
  });
}
