import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeHttpServer } from "../src/bridge-http.js";
import { BridgeStore } from "../src/bridge-store.js";
import { createTalkToFigmaTestServer } from "./helpers/talk-to-figma-server.js";

async function createHarness(token?: string) {
  const dir = await mkdtemp(join(tmpdir(), "figma-control-http-"));
  const store = new BridgeStore(join(dir, "bridge-state.json"));
  await store.init();

  const server = new BridgeHttpServer(store, { port: 0, token });
  const address = await server.start();
  const baseUrl = `http://${address.host}:${address.port}`;

  return { store, server, baseUrl };
}

const startedServers: BridgeHttpServer[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.close()));
});

describe("BridgeHttpServer", () => {
  it("serves health and bridge status", async () => {
    const harness = await createHarness();
    startedServers.push(harness.server);

    const health = await fetch(`${harness.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const status = await fetch(`${harness.baseUrl}/bridge/status`);
    const body = (await status.json()) as { sessions: unknown[]; operations: unknown[] };

    expect(status.status).toBe(200);
    expect(body.sessions).toHaveLength(0);
    expect(body.operations).toHaveLength(0);
  });

  it("registers sessions and pulls queued operations through REST", async () => {
    const harness = await createHarness();
    startedServers.push(harness.server);

    await fetch(`${harness.baseUrl}/bridge/register-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "plugin-session",
        fileName: "Design"
      })
    });

    await harness.store.enqueueOperations({
      sessionId: "plugin-session",
      operations: [
        {
          type: "set_selection",
          selectionIds: ["1:1"]
        }
      ]
    });

    const response = await fetch(`${harness.baseUrl}/bridge/pull-operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "plugin-session",
        limit: 10
      })
    });

    const payload = (await response.json()) as { count: number; operations: Array<{ status: string }> };

    expect(response.status).toBe(200);
    expect(payload.count).toBe(1);
    expect(payload.operations[0]?.status).toBe("dispatched");
  });

  it("enforces bearer auth when configured", async () => {
    const harness = await createHarness("secret-token");
    startedServers.push(harness.server);

    const forbidden = await fetch(`${harness.baseUrl}/bridge/status`);
    expect(forbidden.status).toBe(401);

    const allowed = await fetch(`${harness.baseUrl}/bridge/status`, {
      headers: {
        authorization: "Bearer secret-token"
      }
    });

    expect(allowed.status).toBe(200);
  });

  it("instantiates a live component into a target session through REST", async () => {
    const harness = await createHarness();
    startedServers.push(harness.server);

    await harness.store.registerSession({
      sessionId: "target-session",
      fileName: "Landing File"
    });
    await harness.store.registerSession({
      sessionId: "kit-session",
      fileName: "Travel Kit"
    });
    await harness.store.upsertSnapshot({
      sessionId: "kit-session",
      fileName: "Travel Kit",
      nodes: [],
      variables: [],
      components: [
        {
          id: "component-1",
          key: "component-key-1",
          name: "Button / Primary",
          pageName: "Buttons"
        }
      ]
    });

    const response = await fetch(`${harness.baseUrl}/bridge/instantiate-component`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetSessionId: "target-session",
        sourceSessionId: "kit-session",
        query: "Button"
      })
    });

    const payload = (await response.json()) as {
      chosen?: { component?: { key?: string } };
      queued?: Array<{ operation?: { type?: string; componentKey?: string } }>;
    };

    expect(response.status).toBe(200);
    expect(payload.chosen?.component?.key).toBe("component-key-1");
    expect(payload.queued?.[0]?.operation?.type).toBe("create_instance");
    expect(payload.queued?.[0]?.operation?.componentKey).toBe("component-key-1");
  });

  it("executes talk-to-figma commands through REST", async () => {
    const harness = await createHarness();
    const talkServer = await createTalkToFigmaTestServer();
    startedServers.push(harness.server);

    const response = await fetch(`${harness.baseUrl}/bridge/talk-to-figma/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "canvas-room",
        command: "get_document_info",
        params: {
          includeSelection: true
        },
        wsUrl: talkServer.wsUrl
      })
    });

    const payload = (await response.json()) as {
      ok: boolean;
      command: string;
      progressUpdates: unknown[];
      result: { ok: boolean; command: string };
    };

    await talkServer.close();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("get_document_info");
    expect(payload.progressUpdates).toHaveLength(1);
    expect(payload.result.ok).toBe(true);
  });

  it("syncs a talk-to-figma channel into bridge session state through REST", async () => {
    const harness = await createHarness();
    startedServers.push(harness.server);

    const talkServer = await createTalkToFigmaTestServer({
      commandResults: {
        execute_code: {
          fileKey: "LP9m1zXAqP3nqblwvAW4lz",
          fileName: "GlobeGlider",
          pageId: "0:1",
          pageName: "Page 1",
          selectionIds: ["1314:2"],
          nodes: [
            {
              id: "1314:2",
              name: "Codex Hybrid Test Frame",
              type: "FRAME",
              parentId: "0:1",
              childIds: [],
              bounds: { x: 120, y: 120, width: 260, height: 140 }
            }
          ],
          components: [
            {
              id: "comp-1",
              key: "comp-key-1",
              name: "Button / Primary",
              nodeId: "200:1",
              pageId: "0:1",
              pageName: "Page 1"
            }
          ]
        },
        get_local_components: {
          count: 2,
          components: [
            {
              id: "comp-1",
              key: "comp-key-1",
              name: "Button / Primary"
            },
            {
              id: "comp-2",
              key: "comp-key-2",
              name: "Card / Result"
            }
          ]
        },
        get_variables: [
          {
            id: "var-1",
            name: "color/primary",
            collectionId: "collection-1",
            resolvedType: "COLOR",
            value: "#123456"
          }
        ]
      }
    });

    const response = await fetch(`${harness.baseUrl}/bridge/talk-to-figma/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "canvas-room",
        wsUrl: talkServer.wsUrl
      })
    });

    const payload = (await response.json()) as {
      session: { sessionId: string; fileName?: string; metadata?: { channel?: string } };
      snapshot: { sessionId: string; nodes: Array<{ id: string }>; variables: Array<{ id: string }>; components: Array<{ key?: string }> };
    };

    await talkServer.close();

    expect(response.status).toBe(200);
    expect(payload.session.sessionId).toBe("talk-to-figma:canvas-room");
    expect(payload.session.fileName).toBe("GlobeGlider");
    expect(payload.session.metadata?.channel).toBe("canvas-room");
    expect(payload.snapshot.sessionId).toBe("talk-to-figma:canvas-room");
    expect(payload.snapshot.nodes[0]?.id).toBe("1314:2");
    expect(payload.snapshot.variables[0]?.id).toBe("var-1");
    expect(payload.snapshot.components[0]?.key).toBe("comp-key-1");
    expect(payload.snapshot.components[1]?.key).toBe("comp-key-2");
  });

  it("ensures an existing talk-to-figma session through REST", async () => {
    const harness = await createHarness();
    startedServers.push(harness.server);

    const talkServer = await createTalkToFigmaTestServer({
      commandResults: {
        execute_code: {
          fileKey: "LP9m1zXAqP3nqblwvAW4lz",
          fileName: "GlobeGlider",
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

    await harness.store.registerSession({
      sessionId: "talk-to-figma:canvas-room",
      metadata: {
        source: "talk-to-figma",
        channel: "canvas-room",
        wsUrl: talkServer.wsUrl
      }
    });

    const response = await fetch(`${harness.baseUrl}/bridge/talk-to-figma/ensure-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "talk-to-figma:canvas-room",
        timeoutMs: 4000
      })
    });

    const payload = (await response.json()) as {
      strategy: string;
      channel: string;
      session: { sessionId: string };
      snapshot: { fileName?: string };
      attempts: Array<{ strategy: string; ok: boolean }>;
    };

    await talkServer.close();

    expect(response.status).toBe(200);
    expect(payload.strategy).toBe("existing-session");
    expect(payload.channel).toBe("canvas-room");
    expect(payload.session.sessionId).toBe("talk-to-figma:canvas-room");
    expect(payload.snapshot.fileName).toBe("GlobeGlider");
    expect(payload.attempts[0]).toMatchObject({
      strategy: "existing-session",
      ok: true
    });
  });

  it("executes a talk-to-figma-backed queue through REST", async () => {
    const harness = await createHarness();
    startedServers.push(harness.server);

    await harness.store.registerSession({
      sessionId: "talk-to-figma:canvas-room",
      fileName: "GlobeGlider",
      metadata: {
        source: "talk-to-figma",
        channel: "canvas-room"
      }
    });

    await harness.store.enqueueOperations({
      sessionId: "talk-to-figma:canvas-room",
      operations: [
        {
          type: "create_node",
          node: {
            type: "FRAME",
            name: "Queued frame"
          },
          position: {
            x: 180,
            y: 180,
            width: 220,
            height: 96
          }
        }
      ]
    });

    const talkServer = await createTalkToFigmaTestServer({
      commandHandler: (command, params) => {
        if (command === "get_variables") {
          return [];
        }

        const code = typeof params.code === "string" ? params.code : "";
        if (code.includes("figma.commitUndo()")) {
          return { success: true, result: { ok: true } };
        }
        if (code.includes('const input = {"type":"create_node"')) {
          return {
            success: true,
            result: {
              touchedNodeIds: ["node-created"],
              result: {
                createdNodeId: "node-created"
              }
            }
          };
        }
        return {
          success: true,
          result: {
            fileKey: "file-key-1",
            fileName: "GlobeGlider",
            pageId: "0:1",
            pageName: "Page 1",
            selectionIds: [],
            nodes: [
              {
                id: "node-created",
                name: "Queued frame",
                type: "FRAME",
                parentId: "0:1",
                childIds: []
              }
            ],
            components: []
          }
        };
      }
    });

    const response = await fetch(`${harness.baseUrl}/bridge/talk-to-figma/run-queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "talk-to-figma:canvas-room",
        wsUrl: talkServer.wsUrl
      })
    });

    const payload = (await response.json()) as {
      processedCount: number;
      snapshotSynced: boolean;
      acknowledged: Array<{ status: string; result?: { createdNodeId?: string } }>;
    };

    await talkServer.close();

    expect(response.status).toBe(200);
    expect(payload.processedCount).toBe(1);
    expect(payload.snapshotSynced).toBe(true);
    expect(payload.acknowledged[0]?.status).toBe("succeeded");
    expect(payload.acknowledged[0]?.result?.createdNodeId).toBe("node-created");
  });
});
