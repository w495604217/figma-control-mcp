import { readFile } from "node:fs/promises";

import { TalkToFigmaClient, type TalkToFigmaCommandResult } from "./talk-to-figma.js";

export type ObservedTalkToFigmaChannel = {
  channel: string;
  joinEvents: number;
  anonymousJoinEvents: number;
  identifiedJoinEvents: number;
  lastAnonymousJoinLine?: number;
  messageEvents: number;
  peerBroadcasts: number;
  lastCommand?: string;
  lastSeenLine: number;
};

export type DiscoveredTalkToFigmaChannel = {
  channel: string;
  wsUrl: string;
  logPath: string;
  observed: ObservedTalkToFigmaChannel;
  probe: TalkToFigmaCommandResult;
  failedChannels: Array<{ channel: string; error: string }>;
};

const DEFAULT_TALK_TO_FIGMA_LOG_PATH =
  process.env.FIGMA_CONTROL_TALK_TO_FIGMA_LOG_PATH ??
  "/private/tmp/figma-ws.log";

function upsertChannel(
  channels: Map<string, ObservedTalkToFigmaChannel>,
  channel: string,
  lineIndex: number
): ObservedTalkToFigmaChannel {
  const next = channels.get(channel) ?? {
    channel,
    joinEvents: 0,
    anonymousJoinEvents: 0,
    identifiedJoinEvents: 0,
    messageEvents: 0,
    peerBroadcasts: 0,
    lastSeenLine: lineIndex
  };
  next.lastSeenLine = lineIndex;
  channels.set(channel, next);
  return next;
}

export async function listObservedTalkToFigmaChannels(input: {
  logPath?: string;
  limit?: number;
  afterLine?: number;
} = {}): Promise<{
  logPath: string;
  count: number;
  channels: ObservedTalkToFigmaChannel[];
}> {
  const logPath = input.logPath ?? DEFAULT_TALK_TO_FIGMA_LOG_PATH;
  const limit = input.limit ?? 20;
  const contents = await readFile(logPath, "utf8");
  const lines = contents.split(/\r?\n/);
  const channels = new Map<string, ObservedTalkToFigmaChannel>();

  let currentChannel: string | undefined;
  let pendingJoinChannel: string | undefined;
  let pendingJoinSawId = false;

  for (const [index, line] of lines.entries()) {
    const typeMatch = line.match(/^Type:\s+([^,]+),\s+Channel:\s+(.+)$/);
    if (typeMatch) {
      currentChannel = typeMatch[2]?.trim();
      if (currentChannel) {
        const observed = upsertChannel(channels, currentChannel, index);
        if (typeMatch[1]?.trim() === "join") {
          observed.joinEvents += 1;
          pendingJoinChannel = currentChannel;
          pendingJoinSawId = false;
        }
        if (typeMatch[1]?.trim() === "message") {
          observed.messageEvents += 1;
          pendingJoinChannel = undefined;
        }
      }
      continue;
    }

    if (pendingJoinChannel && /"id":\s*"/.test(line)) {
      const observed = upsertChannel(channels, pendingJoinChannel, index);
      observed.identifiedJoinEvents += 1;
      pendingJoinSawId = true;
      continue;
    }

    if (pendingJoinChannel && line.trim() === "}") {
      const observed = upsertChannel(channels, pendingJoinChannel, index);
      if (!pendingJoinSawId) {
        observed.anonymousJoinEvents += 1;
        observed.lastAnonymousJoinLine = index;
      }
      pendingJoinChannel = undefined;
      pendingJoinSawId = false;
      continue;
    }

    const joinedMatch = line.match(/^✓ Client joined channel "([^"]+)"/);
    if (joinedMatch) {
      const observed = upsertChannel(channels, joinedMatch[1]!, index);
      observed.joinEvents += 1;
      currentChannel = joinedMatch[1]!;
      continue;
    }

    const broadcastMatch = line.match(/^✓ Broadcast to (\d+) peer\(s\) in channel "([^"]+)"/);
    if (broadcastMatch) {
      const observed = upsertChannel(channels, broadcastMatch[2]!, index);
      observed.peerBroadcasts += Number.parseInt(broadcastMatch[1]!, 10);
      currentChannel = broadcastMatch[2]!;
      continue;
    }

    const commandMatch = line.match(/^Command:\s+([^,]+),\s+ID:/);
    if (commandMatch && currentChannel) {
      const observed = upsertChannel(channels, currentChannel, index);
      observed.lastCommand = commandMatch[1]?.trim();
    }
  }

  const sorted = Array.from(channels.values())
    .filter((channel) => {
      if (typeof input.afterLine !== "number") {
        return true;
      }
      return (channel.lastAnonymousJoinLine ?? channel.lastSeenLine) > input.afterLine;
    })
    .sort((left, right) => (
      (right.lastAnonymousJoinLine ?? -1) - (left.lastAnonymousJoinLine ?? -1) ||
      right.anonymousJoinEvents - left.anonymousJoinEvents ||
      right.lastSeenLine - left.lastSeenLine ||
      right.peerBroadcasts - left.peerBroadcasts ||
      right.messageEvents - left.messageEvents
    ))
    .slice(0, limit);

  return {
    logPath,
    count: sorted.length,
    channels: sorted
  };
}

export async function discoverResponsiveTalkToFigmaChannel(input: {
  client?: TalkToFigmaClient;
  wsUrl?: string;
  logPath?: string;
  limit?: number;
  timeoutMs?: number;
  afterLine?: number;
} = {}): Promise<DiscoveredTalkToFigmaChannel> {
  const client = input.client ?? new TalkToFigmaClient({ wsUrl: input.wsUrl });
  const observed = await listObservedTalkToFigmaChannels({
    logPath: input.logPath,
    limit: input.limit ?? 12,
    afterLine: input.afterLine
  });

  const failedChannels: Array<{ channel: string; error: string }> = [];

  for (const candidate of observed.channels) {
    try {
      const probe = await client.executeCommand({
        channel: candidate.channel,
        command: "get_document_info",
        params: {},
        wsUrl: input.wsUrl,
        timeoutMs: input.timeoutMs ?? 4000
      });

      return {
        channel: candidate.channel,
        wsUrl: probe.wsUrl,
        logPath: observed.logPath,
        observed: candidate,
        probe,
        failedChannels
      };
    } catch (error) {
      failedChannels.push({
        channel: candidate.channel,
        error: String(error)
      });
    }
  }

  throw new Error(`No responsive talk-to-figma channel found in ${observed.logPath}. Tried ${failedChannels.length} candidate(s).`);
}
