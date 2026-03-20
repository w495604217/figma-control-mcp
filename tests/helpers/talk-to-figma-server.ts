import { WebSocketServer, type WebSocket } from "ws";

type ReceivedMessage = {
  type?: string;
  channel?: string;
  message?: Record<string, unknown>;
};

type CommandHandler = (command: string, params: Record<string, unknown>, payload: ReceivedMessage & { id?: string }) => unknown;

export async function createTalkToFigmaTestServer(): Promise<{
  wsUrl: string;
  received: ReceivedMessage[];
  close: () => Promise<void>;
}>;

export async function createTalkToFigmaTestServer(input: {
  responsiveChannels?: string[];
  commandResults?: Record<string, unknown>;
  commandHandler?: CommandHandler;
} = {}): Promise<{
  wsUrl: string;
  received: ReceivedMessage[];
  close: () => Promise<void>;
}> {
  const received: ReceivedMessage[] = [];
  const channels = new Map<string, Set<WebSocket>>();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const responsiveChannels = input.responsiveChannels
    ? new Set(input.responsiveChannels)
    : null;
  const commandResults = input.commandResults ?? {};
  const commandHandler = input.commandHandler;

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const payload = JSON.parse(raw.toString()) as ReceivedMessage & { id?: string };
      received.push(payload);

      if (payload.type === "join" && payload.channel) {
        const peers = channels.get(payload.channel) ?? new Set<WebSocket>();
        peers.add(socket);
        channels.set(payload.channel, peers);

        socket.send(JSON.stringify({
          type: "system",
          channel: payload.channel,
          message: {
            id: payload.id,
            result: `Connected to channel: ${payload.channel}`
          }
        }));
        return;
      }

      if (payload.type !== "message" || !payload.channel || !payload.message) {
        return;
      }

      const requestId = typeof payload.message.id === "string" ? payload.message.id : undefined;
      const command = typeof payload.message.command === "string" ? payload.message.command : undefined;
      if (!requestId || !command) {
        return;
      }

      if (responsiveChannels && !responsiveChannels.has(payload.channel)) {
        return;
      }

      socket.send(JSON.stringify({
        type: "progress_update",
        id: requestId,
        channel: payload.channel,
        message: {
          data: {
            progress: 50,
            commandType: command,
            status: "running",
            message: `Running ${command}`
          }
        }
      }));

      if (command === "cause_error") {
        socket.send(JSON.stringify({
          type: "broadcast",
          channel: payload.channel,
          message: {
            id: requestId,
            error: "Synthetic talk-to-figma failure",
            result: {}
          }
        }));
        return;
      }

      if (commandHandler) {
        const handled = commandHandler(command, (payload.message?.params as Record<string, unknown>) ?? {}, payload);
        if (handled !== undefined) {
          socket.send(JSON.stringify({
            type: "broadcast",
            channel: payload.channel,
            message: {
              id: requestId,
              result: handled
            }
          }));
          return;
        }
      }

      if (command in commandResults) {
        socket.send(JSON.stringify({
          type: "broadcast",
          channel: payload.channel,
          message: {
            id: requestId,
            result: commandResults[command]
          }
        }));
        return;
      }

      socket.send(JSON.stringify({
        type: "broadcast",
        channel: payload.channel,
        message: {
          id: requestId,
          result: {
            ok: true,
            command,
            params: payload.message.params ?? {}
          }
        }
      }));
    });

    socket.on("close", () => {
      for (const peers of channels.values()) {
        peers.delete(socket);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve talk-to-figma test server address");
  }

  return {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    received,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
