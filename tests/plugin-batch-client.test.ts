import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { BridgeHttpServer } from "../src/bridge-http.js";
import { BridgeStore } from "../src/bridge-store.js";
import { PluginBridgeClient } from "../src/plugin-bridge-client.js";

const servers: BridgeHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), "figma-control-batch-client-"));
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

describe("PluginBridgeClient batch helpers", () => {
  it("resolves and enqueues batch operations from node paths", async () => {
    const { client, store } = await createHarness();
    await store.registerSession({
      sessionId: "batch-session",
      metadata: {}
    });
    await store.upsertSnapshot({
      sessionId: "batch-session",
      nodes: [
        {
          id: "hero",
          name: "Hero",
          type: "FRAME",
          childIds: ["button"],
          pluginData: {}
        },
        {
          id: "button",
          name: "Button",
          type: "FRAME",
          parentId: "hero",
          childIds: [],
          pluginData: {}
        }
      ],
      variables: [],
      components: []
    });

    const preview = await client.resolveBatch("batch-session", [
      {
        type: "update_node",
        nodePath: "Hero/Button",
        patch: { name: "Primary CTA" }
      }
    ]);

    expect(preview.errors).toHaveLength(0);
    expect(preview.resolvedOperations[0]).toMatchObject({
      type: "update_node",
      nodeId: "button"
    });

    const queued = await client.enqueueBatch({
      sessionId: "batch-session",
      operations: [
        {
          type: "update_node",
          nodePath: "Hero/Button",
          patch: { name: "Primary CTA" }
        }
      ]
    });

    expect(queued.operationIds).toHaveLength(1);
    expect(queued.queued[0]?.operation.type).toBe("update_node");
  });
});
