import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { BridgeStore } from "../src/bridge-store.js";
import { ensureTalkToFigmaSession } from "../src/talk-to-figma-session.js";
import { createTalkToFigmaTestServer } from "./helpers/talk-to-figma-server.js";

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "figma-control-ensure-session-"));
  const store = new BridgeStore(join(dir, "bridge-state.json"));
  await store.init();
  return store;
}

describe("ensureTalkToFigmaSession", () => {
  it("reuses and re-syncs an existing talk-to-figma session", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: {
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
      }
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
    expect(result.channel).toBe("canvas-room");
    expect(result.session.sessionId).toBe("talk-to-figma:canvas-room");
    expect(result.snapshot.fileName).toBe("Canvas");
  });

  it("falls back to launch-and-discover when no session can be reused", async () => {
    const store = await createStore();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: {
        execute_code: {
          fileKey: "file-key",
          fileName: "Launch Canvas",
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
    expect(result.channel).toBe("launch-room");
    expect(result.snapshot.fileName).toBe("Launch Canvas");
    expect(result.attempts.some((attempt) => attempt.strategy === "discover" && attempt.ok === false)).toBe(true);
  });
});
