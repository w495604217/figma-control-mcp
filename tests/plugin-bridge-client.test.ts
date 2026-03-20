import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeHttpServer } from "../src/bridge-http.js";
import { BridgeStore } from "../src/bridge-store.js";
import { PluginBridgeClient } from "../src/plugin-bridge-client.js";
import { createTalkToFigmaTestServer } from "./helpers/talk-to-figma-server.js";

const servers: BridgeHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createClientHarness() {
  const dir = await mkdtemp(join(tmpdir(), "figma-control-client-"));
  const store = new BridgeStore(join(dir, "bridge-state.json"));
  await store.init();
  const server = new BridgeHttpServer(store, { port: 0 });
  const address = await server.start();
  servers.push(server);

  const client = new PluginBridgeClient({
    baseUrl: `http://${address.host}:${address.port}`
  });

  return { client, store };
}

describe("PluginBridgeClient", () => {
  it("registers sessions and publishes snapshots", async () => {
    const { client } = await createClientHarness();

    const session = await client.registerSession({
      sessionId: "plugin-client-session",
      fileName: "Landing"
    });

    expect(session.sessionId).toBe("plugin-client-session");

    const snapshot = await client.publishSnapshot({
      sessionId: "plugin-client-session",
      fileName: "Landing",
      selectionIds: ["1:1"],
      nodes: [
        {
          id: "1:1",
          name: "Hero",
          type: "FRAME",
          childIds: []
        }
      ]
    });

    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.selectionIds).toEqual(["1:1"]);
  });

  it("pulls and acknowledges operations", async () => {
    const { client, store } = await createClientHarness();

    await client.registerSession({
      sessionId: "plugin-client-ops"
    });

    const queued = await store.enqueueOperations({
      sessionId: "plugin-client-ops",
      operations: [
        {
          type: "delete_node",
          nodeId: "2:1"
        }
      ]
    });

    const pulled = await client.pullOperations("plugin-client-ops", 10);
    expect(pulled.count).toBe(1);
    expect(pulled.operations[0]?.operationId).toBe(queued[0]?.operationId);
    expect(pulled.operations[0]?.batchId).toBe(queued[0]?.batchId);

    const acked = await client.acknowledge("plugin-client-ops", [
      {
        operationId: pulled.operations[0]!.operationId,
        status: "succeeded",
        touchedNodeIds: ["2:1"]
      }
    ]);

    expect(acked.count).toBe(1);
    expect(acked.operations[0]?.status).toBe("succeeded");
  });

  it("searches live components through the bridge", async () => {
    const { client, store } = await createClientHarness();

    await store.registerSession({
      sessionId: "plugin-client-components",
      fileName: "Travel Kit"
    });
    await store.upsertSnapshot({
      sessionId: "plugin-client-components",
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

    const components = await client.searchComponents({ query: "Button" });
    expect(components.count).toBe(1);
    expect((components.components[0] as { component?: { key?: string } }).component?.key).toBe("component-key-1");
  });

  it("instantiates a live component through the bridge", async () => {
    const { client, store } = await createClientHarness();

    await store.registerSession({
      sessionId: "target-session"
    });
    await store.registerSession({
      sessionId: "kit-session",
      fileName: "Travel Kit"
    });
    await store.upsertSnapshot({
      sessionId: "kit-session",
      fileName: "Travel Kit",
      nodes: [],
      variables: [],
      components: [
        {
          id: "component-1",
          key: "component-key-1",
          name: "Button / Primary"
        }
      ]
    });

    const instantiated = await client.instantiateComponent({
      targetSessionId: "target-session",
      sourceSessionId: "kit-session",
      query: "Button"
    });

    expect((instantiated.chosen as { component?: { key?: string } } | null)?.component?.key).toBe("component-key-1");
    expect(instantiated.queued[0]?.operation.type).toBe("create_instance");
    expect((instantiated.queued[0]?.operation as { componentKey?: string }).componentKey).toBe("component-key-1");
  });

  it("executes talk-to-figma commands through the HTTP client", async () => {
    const { client } = await createClientHarness();
    const talkServer = await createTalkToFigmaTestServer();

    const result = await client.executeTalkToFigmaCommand({
      channel: "canvas-room",
      command: "get_document_info",
      params: {
        includeSelection: true
      },
      wsUrl: talkServer.wsUrl
    });

    await talkServer.close();

    expect(result.ok).toBe(true);
    expect(result.command).toBe("get_document_info");
    expect(result.progressUpdates).toHaveLength(1);
    expect(result.result).toEqual({
      ok: true,
      command: "get_document_info",
      params: {
        includeSelection: true
      }
    });
  });

  it("syncs a talk-to-figma channel through the HTTP client", async () => {
    const { client } = await createClientHarness();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: {
        execute_code: {
          fileKey: "file-key-1",
          fileName: "Landing",
          pageId: "0:1",
          pageName: "Page 1",
          selectionIds: ["1:1"],
          nodes: [
            {
              id: "1:1",
              name: "Hero",
              type: "FRAME",
              parentId: "0:1",
              childIds: []
            }
          ],
          components: [],
          variables: []
        },
        get_local_components: {
          count: 1,
          components: [
            {
              id: "comp-1",
              key: "comp-key-1",
              name: "Button / Primary"
            }
          ]
        },
        get_variables: [
          {
            id: "var-1",
            name: "space/base",
            resolvedType: "FLOAT",
            value: 8
          }
        ]
      }
    });

    const result = await client.syncTalkToFigmaChannel({
      channel: "canvas-room",
      wsUrl: talkServer.wsUrl
    });

    await talkServer.close();

    expect(result.session.sessionId).toBe("talk-to-figma:canvas-room");
    expect(result.session.fileName).toBe("Landing");
    expect(result.snapshot.nodes[0]?.id).toBe("1:1");
    expect(result.snapshot.variables[0]?.id).toBe("var-1");
    expect(result.snapshot.components[0]?.key).toBe("comp-key-1");
  });

  it("ensures a talk-to-figma session through the HTTP client", async () => {
    const { client, store } = await createClientHarness();
    const talkServer = await createTalkToFigmaTestServer({
      commandResults: {
        execute_code: {
          fileKey: "file-key-1",
          fileName: "Landing",
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
      metadata: {
        source: "talk-to-figma",
        channel: "canvas-room",
        wsUrl: talkServer.wsUrl
      }
    });

    const result = await client.ensureTalkToFigmaSession({
      sessionId: "talk-to-figma:canvas-room",
      timeoutMs: 4000
    });

    await talkServer.close();

    expect(result.strategy).toBe("existing-session");
    expect(result.channel).toBe("canvas-room");
    expect(result.session.sessionId).toBe("talk-to-figma:canvas-room");
    expect(result.snapshot.fileName).toBe("Landing");
  });

  it("executes a talk-to-figma queue through the HTTP client", async () => {
    const { client, store } = await createClientHarness();

    await store.registerSession({
      sessionId: "talk-to-figma:canvas-room",
      metadata: {
        source: "talk-to-figma",
        channel: "canvas-room"
      }
    });

    await store.enqueueOperations({
      sessionId: "talk-to-figma:canvas-room",
      operations: [
        {
          type: "create_node",
          node: {
            type: "FRAME",
            name: "Queued frame"
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
            fileName: "Landing",
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

    const result = await client.executeTalkToFigmaQueue({
      sessionId: "talk-to-figma:canvas-room",
      wsUrl: talkServer.wsUrl
    });

    await talkServer.close();

    expect(result.processedCount).toBe(1);
    expect(result.snapshotSynced).toBe(true);
    expect(result.acknowledged[0]?.status).toBe("succeeded");
  });
});
