import { BridgeStore } from "./bridge-store.js";
import { FigmaPluginMenuClient, type LaunchAndDiscoverInput } from "./figma-plugin-menu.js";
import { discoverResponsiveTalkToFigmaChannel, type DiscoveredTalkToFigmaChannel } from "./talk-to-figma-log.js";
import { syncTalkToFigmaChannel } from "./talk-to-figma-sync.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";

type TalkToFigmaExecutor = Pick<TalkToFigmaClient, "executeCommand">;

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
};

type EnsureAttempt = {
  strategy: "existing-session" | "explicit-channel" | "discover" | "launch";
  ok: boolean;
  sessionId?: string;
  channel?: string;
  error?: string;
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

export async function ensureTalkToFigmaSession(input: EnsureTalkToFigmaSessionInput): Promise<{
  strategy: EnsureAttempt["strategy"];
  session: Awaited<ReturnType<typeof syncTalkToFigmaChannel>>["session"];
  snapshot: Awaited<ReturnType<typeof syncTalkToFigmaChannel>>["snapshot"];
  channel: string;
  wsUrl?: string;
  launch?: Awaited<ReturnType<FigmaPluginMenuClient["launchAndDiscoverTalkToFigmaChannel"]>>["launch"];
  discovered?: DiscoveredTalkToFigmaChannel;
  attempts: EnsureAttempt[];
}> {
  const timeoutMs = input.timeoutMs ?? 15000;
  const limit = input.limit ?? 12;
  const attempts: EnsureAttempt[] = [];
  const menuClient = input.menuClient ?? new FigmaPluginMenuClient();
  const discoverer = input.discoverer ?? discoverResponsiveTalkToFigmaChannel;

  if (!input.forceLaunch && input.sessionId) {
    const session = await input.store.getSession(input.sessionId);
    const metadata = asRecord(session?.metadata);
    const source = typeof metadata?.source === "string" ? metadata.source : undefined;
    const channel = source === "talk-to-figma"
      ? deriveChannel(session?.sessionId, metadata, input.channel)
      : undefined;
    const wsUrl = deriveWsUrl(metadata, input.wsUrl);

    if (channel) {
      try {
        const synced = await syncChannel({
          store: input.store,
          sessionId: input.sessionId,
          channel,
          wsUrl,
          timeoutMs,
          client: input.client
        });
        attempts.push({
          strategy: "existing-session",
          ok: true,
          sessionId: synced.session.sessionId,
          channel: synced.channel
        });
        return {
          strategy: "existing-session",
          session: synced.session,
          snapshot: synced.snapshot,
          channel: synced.channel,
          wsUrl: synced.wsUrl,
          attempts
        };
      } catch (error) {
        attempts.push({
          strategy: "existing-session",
          ok: false,
          sessionId: input.sessionId,
          channel,
          error: String(error)
        });
      }
    }
  }

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
      attempts.push({
        strategy: "explicit-channel",
        ok: true,
        sessionId: synced.session.sessionId,
        channel: synced.channel
      });
      return {
        strategy: "explicit-channel",
        session: synced.session,
        snapshot: synced.snapshot,
        channel: synced.channel,
        wsUrl: synced.wsUrl,
        attempts
      };
    } catch (error) {
      attempts.push({
        strategy: "explicit-channel",
        ok: false,
        sessionId: input.sessionId,
        channel: input.channel,
        error: String(error)
      });
    }
  }

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
      attempts.push({
        strategy: "discover",
        ok: true,
        sessionId: synced.session.sessionId,
        channel: synced.channel
      });
      return {
        strategy: "discover",
        session: synced.session,
        snapshot: synced.snapshot,
        channel: synced.channel,
        wsUrl: synced.wsUrl,
        discovered,
        attempts
      };
    } catch (error) {
      attempts.push({
        strategy: "discover",
        ok: false,
        sessionId: input.sessionId,
        error: String(error)
      });
    }
  }

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
    attempts.push({
      strategy: "launch",
      ok: true,
      sessionId: synced.session.sessionId,
      channel: synced.channel
    });
    return {
      strategy: "launch",
      session: synced.session,
      snapshot: synced.snapshot,
      channel: synced.channel,
      wsUrl: synced.wsUrl,
      launch: launched.launch,
      discovered: launched.discovered,
      attempts
    };
  } catch (error) {
    attempts.push({
      strategy: "launch",
      ok: false,
      sessionId: input.sessionId,
      error: String(error)
    });
    throw new Error(`Could not ensure a responsive talk-to-figma session: ${String(error)}`);
  }
}
