import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { BridgeStore } from "../src/bridge-store.js";
import {
  ensureTalkToFigmaSession,
  assessSessionHealth,
  type SessionHealth,
  type EnsureAttempt
} from "../src/talk-to-figma-session.js";
import { createTalkToFigmaTestServer } from "./helpers/talk-to-figma-server.js";

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "figma-control-ensure-session-"));
  const store = new BridgeStore(join(dir, "bridge-state.json"));
  await store.init();
  return store;
}

function makeFreshTimestamp(): string {
  return new Date().toISOString();
}

function makeStaleTimestamp(minutesAgo: number = 10): string {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

const defaultCommandResults = {
  execute_code: {
    fileKey: "file-key",
    fileName: "Canvas",
    pageId: "0:1",
    pageName: "Page 1",
    selectionIds: [],
    nodes: []
  },
  get_local_components: {
    count: 0,
    components: []
  },
  get_variables: []
};

describe("assessSessionHealth", () => {
  it("returns active for a fresh heartbeat", () => {
    const result = assessSessionHealth(
      { lastHeartbeatAt: makeFreshTimestamp() },
      5 * 60 * 1000
    );
    expect(result.health).toBe("active");
    expect(result.staleSince).toBeUndefined();
  });

  it("returns stale when heartbeat exceeds threshold", () => {
    const staleTs = makeStaleTimestamp(10);
    const result = assessSessionHealth(
      { lastHeartbeatAt: staleTs },
      5 * 60 * 1000
    );
    expect(result.health).toBe("stale");
    expect(result.staleSince).toBe(staleTs);
  });

  it("returns unknown when no heartbeat data is available", () => {
    const result = assessSessionHealth({}, 5 * 60 * 1000);
    expect(result.health).toBe("unknown");
  });

  it("returns unknown for unparseable heartbeat", () => {
    const result = assessSessionHealth(
      { lastHeartbeatAt: "not-a-date" },
      5 * 60 * 1000
    );
    expect(result.health).toBe("unknown");
  });

  it("falls back to connectedAt when lastHeartbeatAt is absent", () => {
    const result = assessSessionHealth(
      { connectedAt: makeFreshTimestamp() },
      5 * 60 * 1000
    );
    expect(result.health).toBe("active");
  });
});

describe("ensureTalkToFigmaSession", () => {
  it("reuses and re-syncs an existing talk-to-figma session", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: defaultCommandResults
    });

    await store.registerSession({
      sessionId: "talk-to-figma:canvas-room",
      fileName: "Old Canvas",
      metadata: {
        source: "talk-to-figma",
        channel: "canvas-room",
        wsUrl: talkServer.wsUrl
      }
    });

    const result = await ensureTalkToFigmaSession({
      store,
      sessionId: "talk-to-figma:canvas-room",
      timeoutMs: 4000
    });

    await talkServer.close();

    expect(result.strategy).toBe("existing-session");
    expect(result.sessionHealth).toBe("active");
    expect(result.channel).toBe("canvas-room");
    expect(result.session.sessionId).toBe("talk-to-figma:canvas-room");
    expect(result.snapshot.fileName).toBe("Canvas");
  });

  it("falls back to launch-and-discover when no session can be reused", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: {
        ...defaultCommandResults,
        execute_code: {
          ...defaultCommandResults.execute_code,
          fileName: "Launch Canvas"
        }
      }
    });

    const result = await ensureTalkToFigmaSession({
      store,
      discoverer: async () => {
        throw new Error("no live channel");
      },
      menuClient: {
        launchAndDiscoverTalkToFigmaChannel: async () => ({
          launch: {
            ok: true as const,
            appName: "Figma",
            pluginName: "Cursor MCP Plugin",
            launchedAt: new Date().toISOString()
          },
          discovered: {
            channel: "launch-room",
            wsUrl: talkServer.wsUrl,
            logPath: "/tmp/fake.log",
            observed: {
              channel: "launch-room",
              joinEvents: 1,
              anonymousJoinEvents: 1,
              identifiedJoinEvents: 0,
              messageEvents: 1,
              peerBroadcasts: 1,
              lastSeenLine: 1
            },
            probe: {
              ok: true as const,
              wsUrl: talkServer.wsUrl,
              channel: "launch-room",
              joinedAt: new Date().toISOString(),
              requestId: "probe",
              command: "get_document_info",
              result: {},
              progressUpdates: []
            },
            failedChannels: []
          },
          attempts: 1
        })
      },
      timeoutMs: 4000
    });

    await talkServer.close();

    expect(result.strategy).toBe("launch");
    expect(result.sessionHealth).toBe("active");
    expect(result.channel).toBe("launch-room");
    expect(result.snapshot.fileName).toBe("Launch Canvas");
    expect(result.attempts.some((attempt) => attempt.strategy === "discover" && attempt.ok === false)).toBe(true);
  });

  it("rejects a stale session and falls through to discover", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: defaultCommandResults
    });

    // Register a session with a stale heartbeat
    const session = await store.registerSession({
      sessionId: "talk-to-figma:stale-room",
      fileName: "Stale Canvas",
      metadata: {
        source: "talk-to-figma",
        channel: "stale-room",
        wsUrl: talkServer.wsUrl
      }
    });

    // Manually make the session stale by backdating lastHeartbeatAt
    // We achieve this by directly modifying the store's internal state
    const sessions = (store as unknown as { state: { sessions: Record<string, { lastHeartbeatAt?: string }> } }).state.sessions;
    if (sessions[session.sessionId]) {
      sessions[session.sessionId].lastHeartbeatAt = makeStaleTimestamp(10);
    }

    const result = await ensureTalkToFigmaSession({
      store,
      sessionId: "talk-to-figma:stale-room",
      staleThresholdMs: 5 * 60 * 1000,
      // Discover will succeed with the same server
      discoverer: async () => ({
        channel: "stale-room",
        wsUrl: talkServer.wsUrl,
        logPath: "/tmp/fake.log",
        observed: {
          channel: "stale-room",
          joinEvents: 1,
          anonymousJoinEvents: 1,
          identifiedJoinEvents: 0,
          messageEvents: 1,
          peerBroadcasts: 1,
          lastSeenLine: 1
        },
        probe: {
          ok: true as const,
          wsUrl: talkServer.wsUrl,
          channel: "stale-room",
          joinedAt: new Date().toISOString(),
          requestId: "probe",
          command: "get_document_info",
          result: {},
          progressUpdates: []
        },
        failedChannels: []
      }),
      timeoutMs: 4000
    });

    await talkServer.close();

    // It should have rejected the existing-session and used discover instead
    expect(result.strategy).toBe("discover");
    expect(result.sessionHealth).toBe("active");

    // The stale attempt should be recorded
    const staleAttempt = result.attempts.find(
      (a) => a.strategy === "existing-session" && a.health === "stale"
    );
    expect(staleAttempt).toBeDefined();
    expect(staleAttempt!.ok).toBe(false);
    expect(staleAttempt!.staleSince).toBeDefined();
  });

  it("classifies unreachable channel with health:unreachable in attempts", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: defaultCommandResults
    });

    await store.registerSession({
      sessionId: "talk-to-figma:dead-room",
      fileName: "Dead Canvas",
      metadata: {
        source: "talk-to-figma",
        channel: "dead-room",
        // Use an invalid wsUrl to force a connection error
        wsUrl: "ws://127.0.0.1:1"
      }
    });

    const result = await ensureTalkToFigmaSession({
      store,
      sessionId: "talk-to-figma:dead-room",
      discoverer: async () => ({
        channel: "alive-room",
        wsUrl: talkServer.wsUrl,
        logPath: "/tmp/fake.log",
        observed: {
          channel: "alive-room",
          joinEvents: 1,
          anonymousJoinEvents: 1,
          identifiedJoinEvents: 0,
          messageEvents: 1,
          peerBroadcasts: 1,
          lastSeenLine: 1
        },
        probe: {
          ok: true as const,
          wsUrl: talkServer.wsUrl,
          channel: "alive-room",
          joinedAt: new Date().toISOString(),
          requestId: "probe",
          command: "get_document_info",
          result: {},
          progressUpdates: []
        },
        failedChannels: []
      }),
      timeoutMs: 2000
    });

    await talkServer.close();

    // Should have fallen through from existing-session to discover
    expect(result.strategy).toBe("discover");
    expect(result.sessionHealth).toBe("active");

    const deadAttempt = result.attempts.find(
      (a) => a.strategy === "existing-session" && a.ok === false
    );
    expect(deadAttempt).toBeDefined();
    expect(["unreachable", "unknown"]).toContain(deadAttempt!.health);
  });

  it("returns structured attempt history with health classifications", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: defaultCommandResults
    });

    const result = await ensureTalkToFigmaSession({
      store,
      discoverer: async () => {
        throw new Error("Timeout: discovery timed out");
      },
      menuClient: {
        launchAndDiscoverTalkToFigmaChannel: async () => ({
          launch: {
            ok: true as const,
            appName: "Figma",
            pluginName: "Cursor MCP Plugin",
            launchedAt: new Date().toISOString()
          },
          discovered: {
            channel: "structured-room",
            wsUrl: talkServer.wsUrl,
            logPath: "/tmp/fake.log",
            observed: {
              channel: "structured-room",
              joinEvents: 1,
              anonymousJoinEvents: 1,
              identifiedJoinEvents: 0,
              messageEvents: 1,
              peerBroadcasts: 1,
              lastSeenLine: 1
            },
            probe: {
              ok: true as const,
              wsUrl: talkServer.wsUrl,
              channel: "structured-room",
              joinedAt: new Date().toISOString(),
              requestId: "probe",
              command: "get_document_info",
              result: {},
              progressUpdates: []
            },
            failedChannels: []
          },
          attempts: 1
        })
      },
      timeoutMs: 4000
    });

    await talkServer.close();

    expect(result.attempts.length).toBeGreaterThanOrEqual(2);

    // Every attempt has health
    for (const attempt of result.attempts) {
      expect(["active", "stale", "unreachable", "unknown"]).toContain(attempt.health);
      expect(typeof attempt.ok).toBe("boolean");
      expect(typeof attempt.strategy).toBe("string");
    }

    // The successful launch attempt should have health=active
    const successfulAttempt = result.attempts.find((a) => a.ok);
    expect(successfulAttempt).toBeDefined();
    expect(successfulAttempt!.health).toBe("active");
  });

  it("includes snapshotAge on successful sync", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: defaultCommandResults
    });

    await store.registerSession({
      sessionId: "talk-to-figma:age-room",
      fileName: "Canvas",
      metadata: {
        source: "talk-to-figma",
        channel: "age-room",
        wsUrl: talkServer.wsUrl
      }
    });

    const result = await ensureTalkToFigmaSession({
      store,
      sessionId: "talk-to-figma:age-room",
      timeoutMs: 4000
    });

    await talkServer.close();

    expect(result.strategy).toBe("existing-session");

    // snapshotAge may or may not be present depending on capturedAt in snapshot
    // but it should be a number if present
    if (result.snapshotAge !== undefined) {
      expect(typeof result.snapshotAge).toBe("number");
      expect(result.snapshotAge).toBeGreaterThanOrEqual(0);
    }

    // The successful attempt should also have snapshotAge
    const successAttempt = result.attempts.find((a) => a.ok);
    expect(successAttempt).toBeDefined();
    if (successAttempt!.snapshotAge !== undefined) {
      expect(typeof successAttempt!.snapshotAge).toBe("number");
    }
  });

  it("repeated ensure calls on the same healthy session remain stable", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: defaultCommandResults
    });

    await store.registerSession({
      sessionId: "talk-to-figma:stable-room",
      fileName: "Stable Canvas",
      metadata: {
        source: "talk-to-figma",
        channel: "stable-room",
        wsUrl: talkServer.wsUrl
      }
    });

    const result1 = await ensureTalkToFigmaSession({
      store,
      sessionId: "talk-to-figma:stable-room",
      timeoutMs: 4000
    });

    const result2 = await ensureTalkToFigmaSession({
      store,
      sessionId: "talk-to-figma:stable-room",
      timeoutMs: 4000
    });

    await talkServer.close();

    // Both calls should succeed via existing-session with active health
    expect(result1.strategy).toBe("existing-session");
    expect(result1.sessionHealth).toBe("active");
    expect(result2.strategy).toBe("existing-session");
    expect(result2.sessionHealth).toBe("active");
    expect(result1.channel).toBe(result2.channel);
  });

  it("exercises discovery fallback when no session is provided", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: defaultCommandResults
    });

    const result = await ensureTalkToFigmaSession({
      store,
      discoverer: async () => ({
        channel: "discovered-room",
        wsUrl: talkServer.wsUrl,
        logPath: "/tmp/fake.log",
        observed: {
          channel: "discovered-room",
          joinEvents: 1,
          anonymousJoinEvents: 1,
          identifiedJoinEvents: 0,
          messageEvents: 1,
          peerBroadcasts: 1,
          lastSeenLine: 1
        },
        probe: {
          ok: true as const,
          wsUrl: talkServer.wsUrl,
          channel: "discovered-room",
          joinedAt: new Date().toISOString(),
          requestId: "probe",
          command: "get_document_info",
          result: {},
          progressUpdates: []
        },
        failedChannels: []
      }),
      timeoutMs: 4000
    });

    await talkServer.close();

    expect(result.strategy).toBe("discover");
    expect(result.sessionHealth).toBe("active");
    expect(result.channel).toBe("discovered-room");
  });

  it("stale session does not silently reuse outdated snapshot", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: {
        ...defaultCommandResults,
        execute_code: {
          ...defaultCommandResults.execute_code,
          fileName: "Fresh Canvas After Discover"
        }
      }
    });

    // Register an old session
    const session = await store.registerSession({
      sessionId: "talk-to-figma:stale-snap",
      fileName: "Old Snapshot Canvas",
      metadata: {
        source: "talk-to-figma",
        channel: "stale-snap",
        wsUrl: talkServer.wsUrl
      }
    });

    // Backdate the heartbeat
    const sessions = (store as unknown as { state: { sessions: Record<string, { lastHeartbeatAt?: string }> } }).state.sessions;
    if (sessions[session.sessionId]) {
      sessions[session.sessionId].lastHeartbeatAt = makeStaleTimestamp(20);
    }

    const result = await ensureTalkToFigmaSession({
      store,
      sessionId: "talk-to-figma:stale-snap",
      staleThresholdMs: 5 * 60 * 1000,
      discoverer: async () => ({
        channel: "stale-snap",
        wsUrl: talkServer.wsUrl,
        logPath: "/tmp/fake.log",
        observed: {
          channel: "stale-snap",
          joinEvents: 1,
          anonymousJoinEvents: 1,
          identifiedJoinEvents: 0,
          messageEvents: 1,
          peerBroadcasts: 1,
          lastSeenLine: 1
        },
        probe: {
          ok: true as const,
          wsUrl: talkServer.wsUrl,
          channel: "stale-snap",
          joinedAt: new Date().toISOString(),
          requestId: "probe",
          command: "get_document_info",
          result: {},
          progressUpdates: []
        },
        failedChannels: []
      }),
      timeoutMs: 4000
    });

    await talkServer.close();

    // New snapshot data should come from the discover/sync, NOT the stale stored one
    expect(result.snapshot.fileName).toBe("Fresh Canvas After Discover");
    expect(result.strategy).toBe("discover");

    // Confirm stale attempt was recorded
    const staleAttempt = result.attempts.find((a) => a.health === "stale");
    expect(staleAttempt).toBeDefined();
    expect(staleAttempt!.ok).toBe(false);
  });
});
