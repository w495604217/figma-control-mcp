import { describe, expect, it, vi } from "vitest";

import type { DiscoveredTalkToFigmaChannel } from "../src/talk-to-figma-log.js";
import { FigmaPluginMenuClient } from "../src/figma-plugin-menu.js";

describe("FigmaPluginMenuClient", () => {
  it("parses development plugin names from AppleScript output", async () => {
    const runner = vi.fn(async () => "Cursor MCP Plugin\nFigma Control MCP Worker\nmissing value\n");
    const client = new FigmaPluginMenuClient({ runner });

    const result = await client.listDevelopmentPlugins();

    expect(result.plugins).toEqual([
      "Cursor MCP Plugin",
      "Figma Control MCP Worker"
    ]);
  });

  it("launches and discovers a talk-to-figma channel through the menu flow", async () => {
    const runner = vi.fn(async () => "");
    const discovered: DiscoveredTalkToFigmaChannel = {
      channel: "edfzmtlw",
      wsUrl: "ws://127.0.0.1:3055",
      logPath: "/tmp/figma-ws.log",
      observed: {
        channel: "edfzmtlw",
        joinEvents: 1,
        anonymousJoinEvents: 1,
        identifiedJoinEvents: 0,
        lastAnonymousJoinLine: 10,
        messageEvents: 0,
        peerBroadcasts: 0,
        lastSeenLine: 10
      },
      probe: {
        ok: true,
        wsUrl: "ws://127.0.0.1:3055",
        channel: "edfzmtlw",
        joinedAt: "2026-03-19T07:00:00.000Z",
        requestId: "request-1",
        command: "get_document_info",
        result: { id: "0:1" },
        progressUpdates: []
      },
      failedChannels: []
    };
    const discoverer = vi.fn(async () => discovered);
    const client = new FigmaPluginMenuClient({ runner, discoverer });

    const result = await client.launchAndDiscoverTalkToFigmaChannel({
      pluginName: "Cursor MCP Plugin",
      attempts: 2,
      delayMs: 0
    });

    expect(result.discovered.channel).toBe("edfzmtlw");
    expect(result.attempts).toBe(1);
    expect(runner).toHaveBeenCalledOnce();
    expect(discoverer).toHaveBeenCalledOnce();
  });
});
