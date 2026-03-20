import { describe, expect, it, vi } from "vitest";

import { TalkToFigmaAdapter } from "../src/talk-to-figma-adapter.js";

describe("TalkToFigmaAdapter", () => {
  it("executes structured operations through execute_code and unwraps the result", async () => {
    const executeCommand = vi.fn(async () => ({
      ok: true as const,
      wsUrl: "ws://127.0.0.1:3055",
      channel: "canvas-room",
      joinedAt: "2026-03-19T00:00:00.000Z",
      requestId: "req-1",
      command: "execute_code",
      result: {
        success: true,
        result: {
          touchedNodeIds: ["node-1"],
          result: {
            createdNodeId: "node-1"
          }
        }
      },
      progressUpdates: []
    }));

    const adapter = new TalkToFigmaAdapter({
      channel: "canvas-room",
      client: { executeCommand }
    });

    const result = await adapter.createNode({
      type: "create_node",
      parentId: "0:1",
      node: {
        type: "FRAME",
        name: "Hero"
      },
      position: {
        x: 120,
        y: 120,
        width: 240,
        height: 120
      }
    });

    expect(result.touchedNodeIds).toEqual(["node-1"]);
    expect(result.result).toEqual({
      createdNodeId: "node-1"
    });
    expect(executeCommand).toHaveBeenCalledOnce();
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      channel: "canvas-room",
      command: "execute_code"
    }));

    const payload = executeCommand.mock.calls[0]?.[0];
    expect((payload?.params as { code?: string }).code).toContain('"type":"create_node"');
  });
});
