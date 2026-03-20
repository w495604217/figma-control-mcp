import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import { talkToFigmaCommandSchema, talkToFigmaProbeSchema, type TalkToFigmaCommandInput, type TalkToFigmaProbeInput } from "./schemas.js";

type JsonRecord = Record<string, unknown>;

type TalkToFigmaEnvelope = {
  id?: string;
  type?: string;
  channel?: string;
  sender?: string;
  message?: unknown;
};

type JoinedSocket = {
  socket: WebSocket;
  wsUrl: string;
  channel: string;
  joinedAt: string;
  close: () => void;
};

export type TalkToFigmaProbeResult = {
  ok: true;
  wsUrl: string;
  channel: string;
  joinedAt: string;
};

export type TalkToFigmaCommandResult = {
  ok: true;
  wsUrl: string;
  channel: string;
  joinedAt: string;
  requestId: string;
  command: string;
  result: unknown;
  progressUpdates: TalkToFigmaEnvelope[];
};

const DEFAULT_TALK_TO_FIGMA_WS_URL =
  process.env.FIGMA_CONTROL_TALK_TO_FIGMA_WS_URL ??
  process.env.TALK_TO_FIGMA_WS_URL ??
  "ws://127.0.0.1:3055";

function toText(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function parseEnvelope(raw: RawData): TalkToFigmaEnvelope {
  const text = toText(raw);
  const parsed = JSON.parse(text);
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("Expected WebSocket payload to be a JSON object");
  }
  return record as TalkToFigmaEnvelope;
}

function messageRecord(envelope: TalkToFigmaEnvelope): JsonRecord | null {
  return asRecord(envelope.message);
}

function messageId(envelope: TalkToFigmaEnvelope): string | undefined {
  const message = messageRecord(envelope);
  return typeof message?.id === "string" ? message.id : undefined;
}

function messageHasResult(envelope: TalkToFigmaEnvelope): boolean {
  const message = messageRecord(envelope);
  return Boolean(message && "result" in message);
}

function messageError(envelope: TalkToFigmaEnvelope): string | undefined {
  const message = messageRecord(envelope);
  return typeof message?.error === "string" ? message.error : undefined;
}

function messageResult(envelope: TalkToFigmaEnvelope): unknown {
  const message = messageRecord(envelope);
  return message?.result;
}

export class TalkToFigmaClient {
  private readonly defaultWsUrl: string;

  constructor(options: { wsUrl?: string } = {}) {
    this.defaultWsUrl = options.wsUrl ?? DEFAULT_TALK_TO_FIGMA_WS_URL;
  }

  async probeChannel(input: TalkToFigmaProbeInput): Promise<TalkToFigmaProbeResult> {
    const payload = talkToFigmaProbeSchema.parse(input);
    const joined = await this.openJoinedSocket(payload.channel, payload.wsUrl, payload.timeoutMs);
    joined.close();
    return {
      ok: true,
      wsUrl: joined.wsUrl,
      channel: joined.channel,
      joinedAt: joined.joinedAt
    };
  }

  async executeCommand(input: TalkToFigmaCommandInput): Promise<TalkToFigmaCommandResult> {
    const payload = talkToFigmaCommandSchema.parse(input);
    const joined = await this.openJoinedSocket(payload.channel, payload.wsUrl, payload.timeoutMs);
    const requestId = randomUUID();
    const progressUpdates: TalkToFigmaEnvelope[] = [];

    return await new Promise<TalkToFigmaCommandResult>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for talk-to-figma response to command "${payload.command}" on channel "${payload.channel}"`));
      }, payload.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        joined.socket.off("message", onMessage);
        joined.socket.off("error", onError);
        joined.socket.off("close", onClose);
        joined.close();
      };

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const onError = (error: Error) => {
        finish(() => reject(error));
      };

      const onClose = () => {
        finish(() => reject(new Error(`talk-to-figma socket closed before command "${payload.command}" completed`)));
      };

      const onMessage = (raw: RawData) => {
        try {
          const envelope = parseEnvelope(raw);

          if (envelope.type === "progress_update" && envelope.id === requestId) {
            progressUpdates.push(envelope);
            return;
          }

          if (messageId(envelope) !== requestId) {
            return;
          }

          const error = messageError(envelope);
          if (error) {
            finish(() => reject(new Error(error)));
            return;
          }

          if (!messageHasResult(envelope)) {
            return;
          }

          finish(() => resolve({
            ok: true,
            wsUrl: joined.wsUrl,
            channel: joined.channel,
            joinedAt: joined.joinedAt,
            requestId,
            command: payload.command,
            result: messageResult(envelope),
            progressUpdates
          }));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      };

      joined.socket.on("message", onMessage);
      joined.socket.on("error", onError);
      joined.socket.on("close", onClose);

      joined.socket.send(JSON.stringify({
        id: requestId,
        type: "message",
        channel: payload.channel,
        message: {
          id: requestId,
          command: payload.command,
          params: payload.params
        }
      }));
    });
  }

  private async openJoinedSocket(channel: string, wsUrlOverride: string | undefined, timeoutMs: number): Promise<JoinedSocket> {
    const wsUrl = wsUrlOverride ?? this.defaultWsUrl;
    const socket = new WebSocket(wsUrl);
    const joinId = randomUUID();

    return await new Promise<JoinedSocket>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out joining talk-to-figma channel "${channel}" at ${wsUrl}`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("open", onOpen);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
      };

      const close = () => {
        if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
          return;
        }
        socket.close();
      };

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const onOpen = () => {
        socket.send(JSON.stringify({
          id: joinId,
          type: "join",
          channel
        }));
      };

      const onMessage = (raw: RawData) => {
        try {
          const envelope = parseEnvelope(raw);
          if (envelope.type === "error") {
            finish(() => reject(new Error(typeof envelope.message === "string" ? envelope.message : "talk-to-figma join failed")));
            return;
          }

          if (messageId(envelope) !== joinId) {
            return;
          }

          if (!messageHasResult(envelope) && envelope.type !== "system") {
            return;
          }

          const joinedAt = new Date().toISOString();
          finish(() => resolve({
            socket,
            wsUrl,
            channel,
            joinedAt,
            close
          }));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      };

      const onError = (error: Error) => {
        finish(() => reject(error));
      };

      const onClose = () => {
        finish(() => reject(new Error(`talk-to-figma socket closed while joining channel "${channel}"`)));
      };

      socket.on("open", onOpen);
      socket.on("message", onMessage);
      socket.on("error", onError);
      socket.on("close", onClose);
    });
  }
}
