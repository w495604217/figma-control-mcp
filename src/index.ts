import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BridgeStore } from "./bridge-store.js";
import { BridgeHttpServer } from "./bridge-http.js";
import { createServer } from "./server.js";

const defaultStatePath = resolve(process.cwd(), ".figma-control-mcp", "bridge-state.json");

async function main(): Promise<void> {
  const statePath = process.env.FIGMA_CONTROL_MCP_STATE_PATH
    ? resolve(process.env.FIGMA_CONTROL_MCP_STATE_PATH)
    : defaultStatePath;

  const store = new BridgeStore(statePath);
  await store.init();

  const bridgeHttpServer = new BridgeHttpServer(store, {
    port: process.env.FIGMA_CONTROL_BRIDGE_PORT ? Number.parseInt(process.env.FIGMA_CONTROL_BRIDGE_PORT, 10) : 3847,
    token: process.env.FIGMA_CONTROL_BRIDGE_TOKEN
  });
  const address = await bridgeHttpServer.start();
  console.error(`figma-control-mcp bridge listening on http://${address.host}:${address.port}`);

  const server = createServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("figma-control-mcp failed to start", error);
  process.exitCode = 1;
});
