import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { resolveBatchOperations } from "./batch-resolver.js";
import { BridgeStore } from "./bridge-store.js";
import { insertFigmaAssetWithOptionalSync } from "./figma-assets-insert-orchestrator.js";
import { scanVisibleAssetsPanel } from "./figma-assets-panel.js";
import { insertFigmaAssetFromPanel, searchFigmaAssetsPanel } from "./figma-assets-workflow.js";
import { FigmaPluginMenuClient } from "./figma-plugin-menu.js";
import { materializeFigmaAsset } from "./materialize-figma-asset.js";
import { searchPublishedComponentsInFile } from "./figma-rest.js";
import { enqueueBatchOperationsSchema, talkToFigmaCommandSchema, talkToFigmaProbeSchema } from "./schemas.js";
import { discoverResponsiveTalkToFigmaChannel, listObservedTalkToFigmaChannels } from "./talk-to-figma-log.js";
import { executeTalkToFigmaSessionQueue } from "./talk-to-figma-queue.js";
import { ensureTalkToFigmaSession } from "./talk-to-figma-session.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";
import { syncTalkToFigmaChannel } from "./talk-to-figma-sync.js";

type BridgeHttpServerOptions = {
  host?: string;
  port?: number;
  token?: string;
};

type JsonResponse = {
  statusCode: number;
  body: unknown;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS"
} as const;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res: ServerResponse, response: JsonResponse): void {
  res.writeHead(response.statusCode, JSON_HEADERS);
  res.end(JSON.stringify(response.body, null, 2));
}

function unauthorized(): JsonResponse {
  return {
    statusCode: 401,
    body: {
      error: "Unauthorized"
    }
  };
}

async function resolveSourceFileKey(store: BridgeStore, sourceSessionId?: string, sourceFileKey?: string): Promise<string | undefined> {
  if (sourceFileKey) {
    return sourceFileKey;
  }
  if (!sourceSessionId) {
    return undefined;
  }
  const session = await store.getSession(sourceSessionId);
  return session?.fileKey;
}

export class BridgeHttpServer {
  private readonly store: BridgeStore;
  private readonly options: Required<Pick<BridgeHttpServerOptions, "host">> & BridgeHttpServerOptions;
  private readonly figmaPluginMenuClient: FigmaPluginMenuClient;
  private readonly talkToFigmaClient: TalkToFigmaClient;
  private server: Server | null = null;

  constructor(store: BridgeStore, options: BridgeHttpServerOptions = {}) {
    this.store = store;
    this.options = {
      host: options.host ?? "127.0.0.1",
      ...options
    };
    this.figmaPluginMenuClient = new FigmaPluginMenuClient();
    this.talkToFigmaClient = new TalkToFigmaClient();
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      const address = this.server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP bridge already started but address is unavailable");
      }
      return { host: this.options.host, port: address.port };
    }

    this.server = createServer(async (req, res) => {
      try {
        if (req.method === "OPTIONS") {
          writeJson(res, { statusCode: 200, body: { ok: true } });
          return;
        }

        if (this.options.token) {
          const header = req.headers.authorization;
          if (header !== `Bearer ${this.options.token}`) {
            writeJson(res, unauthorized());
            return;
          }
        }

        const response = await this.route(req);
        writeJson(res, response);
      } catch (error) {
        writeJson(res, {
          statusCode: 500,
          body: {
            error: String(error)
          }
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port ?? 0, this.options.host, () => resolve());
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve HTTP bridge address");
    }

    return { host: this.options.host, port: address.port };
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.server = null;
  }

  private async route(req: IncomingMessage): Promise<JsonResponse> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      return {
        statusCode: 200,
        body: {
          ok: true
        }
      };
    }

    if (req.method === "GET" && url.pathname === "/bridge/status") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const status = await this.store.getStatus(sessionId);
      return { statusCode: 200, body: status };
    }

    if (req.method === "GET" && url.pathname === "/bridge/components") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const query = url.searchParams.get("query") ?? undefined;
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
      const components = await this.store.searchComponents({ sessionId, query, limit });
      return {
        statusCode: 200,
        body: {
          count: components.length,
          components
        }
      };
    }

    if (req.method === "GET" && url.pathname === "/bridge/published-components") {
      const query = url.searchParams.get("query");
      const sourceSessionId = url.searchParams.get("sourceSessionId") ?? undefined;
      const fileKey = url.searchParams.get("fileKey") ?? undefined;
      const includeComponentSets = url.searchParams.get("includeComponentSets") !== "false";
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

      if (!query) {
        return {
          statusCode: 400,
          body: {
            error: "query is required"
          }
        };
      }

      const resolvedFileKey = await resolveSourceFileKey(this.store, sourceSessionId, fileKey);
      if (!resolvedFileKey) {
        return {
          statusCode: 400,
          body: {
            error: "sourceSessionId or fileKey must resolve to a Figma file key"
          }
        };
      }

      let components;
      try {
        components = await searchPublishedComponentsInFile({
          fileKey: resolvedFileKey,
          query,
          limit,
          includeComponentSets
        });
      } catch (error) {
        return {
          statusCode: 424,
          body: {
            error: String(error)
          }
        };
      }
      return {
        statusCode: 200,
        body: {
          count: components.length,
          components
        }
      };
    }

    if (req.method === "GET" && url.pathname === "/bridge/talk-to-figma/channels") {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
      const logPath = url.searchParams.get("logPath") ?? undefined;
      const result = await listObservedTalkToFigmaChannels({ limit, logPath });
      return {
        statusCode: 200,
        body: result
      };
    }

    if (req.method === "GET" && url.pathname === "/bridge/figma/development-plugins") {
      const appName = url.searchParams.get("appName") ?? undefined;
      const result = await this.figmaPluginMenuClient.listDevelopmentPlugins(appName ?? "Figma");
      return {
        statusCode: 200,
        body: result
      };
    }

    if (req.method === "GET" && url.pathname === "/bridge/assets-panel") {
      const activateApp = url.searchParams.get("activateApp") === "true";
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
      const result = await scanVisibleAssetsPanel({ activateApp, limit });
      return {
        statusCode: 200,
        body: result
      };
    }

    if (req.method === "GET" && url.pathname === "/bridge/assets-search") {
      const query = url.searchParams.get("query");
      if (!query) {
        return {
          statusCode: 400,
          body: {
            error: "query is required"
          }
        };
      }

      const activateApp = url.searchParams.get("activateApp") !== "false";
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
      const windowTitle = url.searchParams.get("windowTitle") ?? undefined;
      const settleMsParam = url.searchParams.get("settleMs");
      const settleMs = settleMsParam ? Number.parseInt(settleMsParam, 10) : undefined;

      const result = await searchFigmaAssetsPanel({
        query,
        activateApp,
        limit,
        windowTitle,
        settleMs
      });
      return {
        statusCode: 200,
        body: result
      };
    }

    if (req.method !== "POST") {
      return {
        statusCode: 404,
        body: {
          error: `Unsupported route: ${req.method} ${url.pathname}`
        }
      };
    }

    const body = await readJson(req);

    switch (url.pathname) {
      case "/bridge/register-session": {
        const session = await this.store.registerSession(body);
        return { statusCode: 200, body: session };
      }
      case "/bridge/snapshot": {
        const snapshot = await this.store.upsertSnapshot(body);
        return { statusCode: 200, body: snapshot };
      }
      case "/bridge/pull-operations": {
        const payload = body as { sessionId?: string; limit?: number };
        const operations = await this.store.pullQueuedOperations(payload.sessionId ?? "", payload.limit ?? 20);
        return { statusCode: 200, body: { count: operations.length, operations } };
      }
      case "/bridge/resolve-batch": {
        const payload = enqueueBatchOperationsSchema.parse(body);
        const snapshot = await this.store.getSnapshot(payload.sessionId);
        const resolution = resolveBatchOperations(snapshot, payload.operations);
        return { statusCode: resolution.errors.length > 0 ? 422 : 200, body: resolution };
      }
      case "/bridge/enqueue-batch": {
        const payload = enqueueBatchOperationsSchema.parse(body);
        const snapshot = await this.store.getSnapshot(payload.sessionId);
        const resolution = resolveBatchOperations(snapshot, payload.operations);
        if (resolution.errors.length > 0) {
          return { statusCode: 422, body: resolution };
        }
        const queued = await this.store.enqueueOperations({
          sessionId: payload.sessionId,
          clientRequestId: payload.clientRequestId,
          description: payload.description,
          operations: resolution.resolvedOperations
        });
        return {
          statusCode: 200,
          body: {
            resolution,
            operationIds: queued.map((record) => record.operationId),
            queued
          }
        };
      }
      case "/bridge/acknowledge": {
        const operations = await this.store.acknowledgeOperations(body);
        return { statusCode: 200, body: { count: operations.length, operations } };
      }
      case "/bridge/insert-asset": {
        const payload = body as {
          query?: string;
          activateApp?: boolean;
          windowTitle?: string;
          resultIndex?: number;
          limit?: number;
          settleMs?: number;
          holdMs?: number;
          releaseMs?: number;
          dryRun?: boolean;
          syncSessionId?: string;
          syncWsUrl?: string;
          syncTimeoutMs?: number;
          postInsertDelayMs?: number;
        };
        if (!payload.query) {
          return {
            statusCode: 400,
            body: {
              error: "query is required"
            }
          };
        }
        const result = await insertFigmaAssetWithOptionalSync({
          store: this.store,
          query: payload.query,
          activateApp: payload.activateApp,
          windowTitle: payload.windowTitle,
          resultIndex: payload.resultIndex,
          limit: payload.limit,
          settleMs: payload.settleMs,
          holdMs: payload.holdMs,
          releaseMs: payload.releaseMs,
          dryRun: payload.dryRun,
          syncSessionId: payload.syncSessionId,
          syncWsUrl: payload.syncWsUrl,
          syncTimeoutMs: payload.syncTimeoutMs,
          postInsertDelayMs: payload.postInsertDelayMs
        });
        return { statusCode: 200, body: result };
      }
      case "/bridge/materialize-asset": {
        const payload = body as {
          query?: string;
          sessionId?: string;
          channel?: string;
          wsUrl?: string;
          logPath?: string;
          timeoutMs?: number;
          limit?: number;
          pluginName?: string;
          appName?: string;
          attempts?: number;
          delayMs?: number;
          forceLaunch?: boolean;
          activateApp?: boolean;
          windowTitle?: string;
          resultIndex?: number;
          settleMs?: number;
          holdMs?: number;
          releaseMs?: number;
          dryRun?: boolean;
          postInsertDelayMs?: number;
          selectInsertedNodes?: boolean;
        };
        if (!payload.query) {
          return {
            statusCode: 400,
            body: {
              error: "query is required"
            }
          };
        }
        const result = await materializeFigmaAsset({
          store: this.store,
          query: payload.query,
          sessionId: payload.sessionId,
          channel: payload.channel,
          wsUrl: payload.wsUrl,
          logPath: payload.logPath,
          timeoutMs: payload.timeoutMs,
          limit: payload.limit,
          pluginName: payload.pluginName,
          appName: payload.appName,
          attempts: payload.attempts,
          delayMs: payload.delayMs,
          forceLaunch: payload.forceLaunch,
          activateApp: payload.activateApp,
          windowTitle: payload.windowTitle,
          resultIndex: payload.resultIndex,
          settleMs: payload.settleMs,
          holdMs: payload.holdMs,
          releaseMs: payload.releaseMs,
          dryRun: payload.dryRun,
          postInsertDelayMs: payload.postInsertDelayMs,
          selectInsertedNodes: payload.selectInsertedNodes
        });
        return { statusCode: 200, body: result };
      }
      case "/bridge/instantiate-component": {
        const payload = body as {
          targetSessionId?: string;
          sourceSessionId?: string;
          sourceFileKey?: string;
          query?: string;
          componentId?: string;
          componentKey?: string;
          parentId?: string;
          index?: number;
        };
        let publishedFallbackError: string | undefined;
        if (!payload.targetSessionId) {
          return {
            statusCode: 400,
            body: {
              error: "targetSessionId is required"
            }
          };
        }
        if (!payload.query && !payload.componentId && !payload.componentKey) {
          return {
            statusCode: 400,
            body: {
              error: "query, componentId, or componentKey is required"
            }
          };
        }

        const resolved = await this.store.resolveComponentReference({
          targetSessionId: payload.targetSessionId,
          sourceSessionId: payload.sourceSessionId,
          query: payload.query,
          componentId: payload.componentId,
          componentKey: payload.componentKey
        });

        if (!resolved.componentId && !resolved.componentKey && payload.query) {
          const fileKey = await resolveSourceFileKey(this.store, payload.sourceSessionId, payload.sourceFileKey);
          if (fileKey) {
            try {
              const published = await searchPublishedComponentsInFile({
                fileKey,
                query: payload.query,
                limit: 50
              });
              if (published[0]?.key) {
                resolved.componentKey = published[0].key;
              }
            } catch (error) {
              publishedFallbackError = String(error);
            }
          }
        }

        if (!resolved.chosen && !resolved.componentId && !resolved.componentKey) {
          return {
            statusCode: publishedFallbackError ? 424 : 404,
            body: {
              error: publishedFallbackError
                ? `No live component matched "${payload.query ?? ""}", and published fallback failed: ${publishedFallbackError}`
                : `No live component matched "${payload.query ?? ""}"`
            }
          };
        }

        if (!resolved.componentId && !resolved.componentKey) {
          return {
            statusCode: 409,
            body: {
              error: `Matched component "${resolved.chosen?.component.name ?? "unknown"}" is only available as a local component in session ${resolved.chosen?.sessionId ?? "unknown"}. Open the source kit in the same target session or use a published component key.`
            }
          };
        }

        const queued = await this.store.enqueueOperations({
          sessionId: payload.targetSessionId,
          description: payload.query
            ? `Instantiate live component: ${payload.query}`
            : "Instantiate live component",
          operations: [
            {
              type: "create_instance",
              componentId: resolved.componentId,
              componentKey: resolved.componentKey,
              parentId: payload.parentId,
              index: payload.index
            }
          ]
        });

        return {
          statusCode: 200,
          body: {
            chosen: resolved.chosen,
            operationIds: queued.map((record) => record.operationId),
            queued
          }
        };
      }
      case "/bridge/talk-to-figma/probe": {
        const payload = talkToFigmaProbeSchema.parse(body);
        const result = await this.talkToFigmaClient.probeChannel(payload);
        return { statusCode: 200, body: result };
      }
      case "/bridge/talk-to-figma/discover": {
        const payload = body as {
          wsUrl?: string;
          logPath?: string;
          limit?: number;
          timeoutMs?: number;
        };
        const result = await discoverResponsiveTalkToFigmaChannel({
          wsUrl: payload.wsUrl,
          logPath: payload.logPath,
          limit: payload.limit,
          timeoutMs: payload.timeoutMs
        });
        return { statusCode: 200, body: result };
      }
      case "/bridge/talk-to-figma/command": {
        const payload = talkToFigmaCommandSchema.parse(body);
        const result = await this.talkToFigmaClient.executeCommand(payload);
        return { statusCode: 200, body: result };
      }
      case "/bridge/talk-to-figma/sync": {
        const payload = body as {
          channel?: string;
          sessionId?: string;
          wsUrl?: string;
          timeoutMs?: number;
        };
        if (!payload.channel) {
          return {
            statusCode: 400,
            body: {
              error: "channel is required"
            }
          };
        }
        const result = await syncTalkToFigmaChannel({
          store: this.store,
          channel: payload.channel,
          sessionId: payload.sessionId,
          wsUrl: payload.wsUrl,
          timeoutMs: payload.timeoutMs
        });
        return { statusCode: 200, body: result };
      }
      case "/bridge/talk-to-figma/ensure-session": {
        const payload = body as {
          sessionId?: string;
          channel?: string;
          wsUrl?: string;
          logPath?: string;
          timeoutMs?: number;
          limit?: number;
          pluginName?: string;
          appName?: string;
          attempts?: number;
          delayMs?: number;
          forceLaunch?: boolean;
        };
        const result = await ensureTalkToFigmaSession({
          store: this.store,
          sessionId: payload.sessionId,
          channel: payload.channel,
          wsUrl: payload.wsUrl,
          logPath: payload.logPath,
          timeoutMs: payload.timeoutMs,
          limit: payload.limit,
          pluginName: payload.pluginName,
          appName: payload.appName,
          attempts: payload.attempts,
          delayMs: payload.delayMs,
          forceLaunch: payload.forceLaunch
        });
        return { statusCode: 200, body: result };
      }
      case "/bridge/talk-to-figma/run-queue": {
        const payload = body as {
          sessionId?: string;
          limit?: number;
          wsUrl?: string;
          timeoutMs?: number;
          syncAfter?: boolean;
        };
        if (!payload.sessionId) {
          return {
            statusCode: 400,
            body: {
              error: "sessionId is required"
            }
          };
        }
        const result = await executeTalkToFigmaSessionQueue({
          store: this.store,
          sessionId: payload.sessionId,
          limit: payload.limit,
          wsUrl: payload.wsUrl,
          timeoutMs: payload.timeoutMs,
          syncAfter: payload.syncAfter
        });
        return { statusCode: 200, body: result };
      }
      case "/bridge/figma/launch-development-plugin": {
        const payload = body as {
          pluginName?: string;
          appName?: string;
        };
        if (!payload.pluginName) {
          return {
            statusCode: 400,
            body: {
              error: "pluginName is required"
            }
          };
        }
        const result = await this.figmaPluginMenuClient.launchDevelopmentPlugin({
          pluginName: payload.pluginName,
          appName: payload.appName
        });
        return { statusCode: 200, body: result };
      }
      case "/bridge/figma/launch-and-discover-talk-to-figma": {
        const payload = body as {
          pluginName?: string;
          appName?: string;
          wsUrl?: string;
          logPath?: string;
          limit?: number;
          timeoutMs?: number;
          attempts?: number;
          delayMs?: number;
        };
        if (!payload.pluginName) {
          return {
            statusCode: 400,
            body: {
              error: "pluginName is required"
            }
          };
        }
        const result = await this.figmaPluginMenuClient.launchAndDiscoverTalkToFigmaChannel({
          pluginName: payload.pluginName,
          appName: payload.appName,
          wsUrl: payload.wsUrl,
          logPath: payload.logPath,
          limit: payload.limit,
          timeoutMs: payload.timeoutMs,
          attempts: payload.attempts,
          delayMs: payload.delayMs
        });
        return { statusCode: 200, body: result };
      }
      default:
        return {
          statusCode: 404,
          body: {
            error: `Unsupported route: ${req.method} ${url.pathname}`
          }
        };
    }
  }
}
