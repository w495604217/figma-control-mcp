import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { discoverResponsiveTalkToFigmaChannel, listObservedTalkToFigmaChannels } from "../src/talk-to-figma-log.js";
import { createTalkToFigmaTestServer } from "./helpers/talk-to-figma-server.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function createLogFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "figma-talk-log-"));
  const logPath = join(dir, "figma-ws.log");
  await writeFile(logPath, contents, "utf8");
  return logPath;
}

describe("talk-to-figma relay log helpers", () => {
  it("lists recently observed relay channels", async () => {
    const logPath = await createLogFile([
      "Type: join, Channel: alpha1234",
      '✓ Client joined channel "alpha1234" (1 total clients)',
      "Type: message, Channel: beta5678",
      "Command: get_document_info, ID: request-1",
      '✓ Broadcast to 1 peer(s) in channel "beta5678"'
    ].join("\n"));

    const result = await listObservedTalkToFigmaChannels({ logPath, limit: 10 });

    expect(result.count).toBe(2);
    expect(result.channels[0]?.channel).toBe("beta5678");
    expect(result.channels[0]?.lastCommand).toBe("get_document_info");
    expect(result.channels[0]?.peerBroadcasts).toBe(1);
    expect(result.channels[0]?.anonymousJoinEvents).toBe(0);
  });

  it("discovers a responsive channel by trying get_document_info", async () => {
    const talkServer = await createTalkToFigmaTestServer({
      responsiveChannels: ["live2222"]
    });
    closeCallbacks.push(talkServer.close);

    const logPath = await createLogFile([
      "Type: join, Channel: live2222",
      "Full message: {",
      '  "type": "join",',
      '  "channel": "live2222"',
      "}",
      "Type: message, Channel: live2222",
      "Command: get_document_info, ID: request-live",
      '✓ Broadcast to 1 peer(s) in channel "live2222"',
      "Type: message, Channel: stale1111",
      "Command: get_document_info, ID: request-stale",
      '✓ Broadcast to 1 peer(s) in channel "stale1111"'
    ].join("\n"));

    const discovered = await discoverResponsiveTalkToFigmaChannel({
      wsUrl: talkServer.wsUrl,
      logPath,
      limit: 10,
      timeoutMs: 250
    });

    expect(discovered.channel).toBe("live2222");
    expect(discovered.probe.command).toBe("get_document_info");
    expect(discovered.failedChannels).toHaveLength(0);
  });
});
