import { afterEach, describe, expect, it } from "vitest";

import { TalkToFigmaClient } from "../src/talk-to-figma.js";
import { createTalkToFigmaTestServer } from "./helpers/talk-to-figma-server.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("TalkToFigmaClient", () => {
  it("probes a websocket channel by joining it", async () => {
    const server = await createTalkToFigmaTestServer();
    closeCallbacks.push(server.close);

    const client = new TalkToFigmaClient({ wsUrl: server.wsUrl });
    const result = await client.probeChannel({
      channel: "canvas-room"
    });

    expect(result.ok).toBe(true);
    expect(result.channel).toBe("canvas-room");
    expect(result.wsUrl).toBe(server.wsUrl);
    expect(server.received[0]?.type).toBe("join");
  });

  it("executes a raw command and collects progress updates", async () => {
    const server = await createTalkToFigmaTestServer();
    closeCallbacks.push(server.close);

    const client = new TalkToFigmaClient({ wsUrl: server.wsUrl });
    const result = await client.executeCommand({
      channel: "canvas-room",
      command: "get_document_info",
      params: {
        includeSelection: true
      }
    });

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

  it("surfaces command errors from the websocket peer", async () => {
    const server = await createTalkToFigmaTestServer();
    closeCallbacks.push(server.close);

    const client = new TalkToFigmaClient({ wsUrl: server.wsUrl });

    await expect(client.executeCommand({
      channel: "canvas-room",
      command: "cause_error"
    })).rejects.toThrow("Synthetic talk-to-figma failure");
  });
});
