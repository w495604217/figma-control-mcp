import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveBatchOperations } from "./batch-resolver.js";
import { BridgeStore } from "./bridge-store.js";
import { insertFigmaAssetWithOptionalSync } from "./figma-assets-insert-orchestrator.js";
import { scanVisibleAssetsPanel } from "./figma-assets-panel.js";
import { insertFigmaAssetFromPanel, searchFigmaAssetsPanel } from "./figma-assets-workflow.js";
import { FigmaPluginMenuClient } from "./figma-plugin-menu.js";
import { materializeFigmaAssetTraced } from "./materialize-figma-asset.js";
import { searchPublishedComponentsInFile } from "./figma-rest.js";
import {
  acknowledgeOperationsSchema,
  enqueueBatchOperationsSchema,
  enqueueOperationsSchema,
  figmaSnapshotSchema,
  figmaSessionSchema,
  pullOperationsSchema,
  talkToFigmaCommandSchema,
  talkToFigmaProbeSchema
} from "./schemas.js";
import { discoverResponsiveTalkToFigmaChannel, listObservedTalkToFigmaChannels } from "./talk-to-figma-log.js";
import { executeTalkToFigmaSessionQueueTraced } from "./talk-to-figma-queue.js";
import { ensureTalkToFigmaSession } from "./talk-to-figma-session.js";
import { syncTalkToFigmaChannel } from "./talk-to-figma-sync.js";
import { TalkToFigmaClient } from "./talk-to-figma.js";

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

export function createServer(store: BridgeStore): McpServer {
  const server = new McpServer({
    name: "figma-control-mcp",
    version: "0.1.0"
  });
  const figmaPluginMenuClient = new FigmaPluginMenuClient();
  const talkToFigmaClient = new TalkToFigmaClient();

  server.registerTool(
    "register_figma_session",
    {
      title: "Register Figma Session",
      description: "Registers or heartbeats a live Figma plugin bridge session.",
      inputSchema: figmaSessionSchema
    },
    async (input) => {
      try {
        const session = await store.registerSession(input);
        return {
          content: [{ type: "text", text: jsonText(session) }],
          structuredContent: session
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `register_figma_session failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "publish_figma_snapshot",
    {
      title: "Publish Figma Snapshot",
      description: "Publishes the latest node graph, selection, and variable snapshot from the Figma plugin.",
      inputSchema: figmaSnapshotSchema
    },
    async (input) => {
      try {
        const snapshot = await store.upsertSnapshot(input);
        return {
          content: [{ type: "text", text: jsonText(snapshot) }],
          structuredContent: snapshot
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `publish_figma_snapshot failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "resolve_figma_batch",
    {
      title: "Resolve Figma Batch",
      description: "Resolves path-based Figma operations against the latest snapshot without enqueueing them.",
      inputSchema: enqueueBatchOperationsSchema
    },
    async (input) => {
      try {
        const snapshot = await store.getSnapshot(input.sessionId);
        const resolution = resolveBatchOperations(snapshot, input.operations);
        return {
          content: [{ type: "text", text: jsonText(resolution) }],
          structuredContent: resolution,
          isError: resolution.errors.length > 0
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `resolve_figma_batch failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "enqueue_figma_batch",
    {
      title: "Enqueue Figma Batch",
      description: "Resolves path-based Figma operations against the latest snapshot and enqueues the concrete operations.",
      inputSchema: enqueueBatchOperationsSchema
    },
    async (input) => {
      try {
        const snapshot = await store.getSnapshot(input.sessionId);
        const resolution = resolveBatchOperations(snapshot, input.operations);

        if (resolution.errors.length > 0) {
          return {
            isError: true,
            content: [{ type: "text", text: jsonText(resolution) }],
            structuredContent: resolution
          };
        }

        const queued = await store.enqueueOperations({
          sessionId: input.sessionId,
          clientRequestId: input.clientRequestId,
          description: input.description,
          operations: resolution.resolvedOperations
        });

        return {
          content: [{ type: "text", text: jsonText({ resolution, queued }) }],
          structuredContent: {
            resolution,
            operationIds: queued.map((record) => record.operationId),
            queued
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `enqueue_figma_batch failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "enqueue_figma_operations",
    {
      title: "Enqueue Figma Operations",
      description: "Queues deterministic operations for the Figma plugin bridge to execute.",
      inputSchema: enqueueOperationsSchema
    },
    async (input) => {
      try {
        const operations = await store.enqueueOperations(input);
        return {
          content: [{ type: "text", text: jsonText(operations) }],
          structuredContent: {
            operationIds: operations.map((record) => record.operationId),
            operations
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `enqueue_figma_operations failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "pull_figma_operations",
    {
      title: "Pull Figma Operations",
      description: "Lets the Figma plugin bridge claim queued operations for execution.",
      inputSchema: pullOperationsSchema
    },
    async (input) => {
      try {
        const operations = await store.pullQueuedOperations(input.sessionId, input.limit);
        return {
          content: [{ type: "text", text: jsonText(operations) }],
          structuredContent: {
            count: operations.length,
            operations
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `pull_figma_operations failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "acknowledge_figma_operations",
    {
      title: "Acknowledge Figma Operations",
      description: "Marks dispatched Figma operations as succeeded or failed after plugin execution.",
      inputSchema: acknowledgeOperationsSchema
    },
    async (input) => {
      try {
        const operations = await store.acknowledgeOperations(input);
        return {
          content: [{ type: "text", text: jsonText(operations) }],
          structuredContent: {
            count: operations.length,
            operations
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `acknowledge_figma_operations failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "get_figma_bridge_status",
    {
      title: "Get Figma Bridge Status",
      description: "Returns active sessions and queued/dispatched/completed operation state.",
      inputSchema: {
        sessionId: z.string().optional()
      }
    },
    async ({ sessionId }) => {
      try {
        const status = await store.getStatus(sessionId);
        return {
          content: [{ type: "text", text: jsonText(status) }],
          structuredContent: status
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `get_figma_bridge_status failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "list_figma_development_plugins",
    {
      title: "List Figma Development Plugins",
      description: "Lists the plugins currently available under Figma > Plugins > Development on this Mac.",
      inputSchema: {
        appName: z.string().default("Figma")
      }
    },
    async ({ appName }) => {
      try {
        const result = await figmaPluginMenuClient.listDevelopmentPlugins(appName);
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `list_figma_development_plugins failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "launch_figma_development_plugin",
    {
      title: "Launch Figma Development Plugin",
      description: "Uses the macOS menu bar to run a named Figma development plugin in the frontmost Figma document.",
      inputSchema: {
        pluginName: z.string().min(1),
        appName: z.string().default("Figma")
      }
    },
    async ({ pluginName, appName }) => {
      try {
        const result = await figmaPluginMenuClient.launchDevelopmentPlugin({ pluginName, appName });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `launch_figma_development_plugin failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "launch_and_discover_talk_to_figma",
    {
      title: "Launch And Discover Talk To Figma",
      description: "Launches a named Figma development plugin and then discovers the responsive talk-to-figma relay channel it connected to.",
      inputSchema: {
        pluginName: z.string().min(1),
        appName: z.string().default("Figma"),
        wsUrl: z.string().url().optional(),
        logPath: z.string().optional(),
        limit: z.number().int().positive().max(50).default(12),
        timeoutMs: z.number().int().positive().max(30000).default(4000),
        attempts: z.number().int().positive().max(20).default(5),
        delayMs: z.number().int().positive().max(10000).default(700)
      }
    },
    async ({ pluginName, appName, wsUrl, logPath, limit, timeoutMs, attempts, delayMs }) => {
      try {
        const result = await figmaPluginMenuClient.launchAndDiscoverTalkToFigmaChannel({
          pluginName,
          appName,
          wsUrl,
          logPath,
          limit,
          timeoutMs,
          attempts,
          delayMs
        });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `launch_and_discover_talk_to_figma failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "list_talk_to_figma_channels",
    {
      title: "List Talk To Figma Channels",
      description: "Parses the talk-to-figma relay log and lists recently observed websocket channels.",
      inputSchema: {
        logPath: z.string().optional(),
        limit: z.number().int().positive().max(100).default(20)
      }
    },
    async ({ logPath, limit }) => {
      try {
        const result = await listObservedTalkToFigmaChannels({ logPath, limit });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `list_talk_to_figma_channels failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "discover_talk_to_figma_channel",
    {
      title: "Discover Talk To Figma Channel",
      description: "Tries recent relay-log channels with a read-only get_document_info probe and returns the first responsive one.",
      inputSchema: {
        wsUrl: z.string().url().optional(),
        logPath: z.string().optional(),
        limit: z.number().int().positive().max(50).default(12),
        timeoutMs: z.number().int().positive().max(30000).default(4000)
      }
    },
    async ({ wsUrl, logPath, limit, timeoutMs }) => {
      try {
        const result = await discoverResponsiveTalkToFigmaChannel({ wsUrl, logPath, limit, timeoutMs });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `discover_talk_to_figma_channel failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "probe_talk_to_figma_channel",
    {
      title: "Probe Talk To Figma Channel",
      description: "Opens a short-lived websocket session to a talk-to-figma relay and confirms that a specific channel can be joined.",
      inputSchema: talkToFigmaProbeSchema
    },
    async (input) => {
      try {
        const result = await talkToFigmaClient.probeChannel(input);
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `probe_talk_to_figma_channel failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "execute_talk_to_figma_command",
    {
      title: "Execute Talk To Figma Command",
      description: "Executes a raw silent canvas command against a talk-to-figma websocket relay channel.",
      inputSchema: talkToFigmaCommandSchema
    },
    async (input) => {
      try {
        const result = await talkToFigmaClient.executeCommand(input);
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `execute_talk_to_figma_command failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "sync_talk_to_figma_channel",
    {
      title: "Sync Talk To Figma Channel",
      description: "Pulls a live canvas snapshot from a talk-to-figma channel and persists it as a first-class bridge session/snapshot.",
      inputSchema: {
        channel: z.string().min(1),
        sessionId: z.string().optional(),
        wsUrl: z.string().url().optional(),
        timeoutMs: z.number().int().positive().max(30000).default(15000)
      }
    },
    async ({ channel, sessionId, wsUrl, timeoutMs }) => {
      try {
        const result = await syncTalkToFigmaChannel({
          store,
          channel,
          sessionId,
          wsUrl,
          timeoutMs
        });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `sync_talk_to_figma_channel failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "execute_talk_to_figma_queue",
    {
      title: "Execute Talk To Figma Queue",
      description: "Pulls queued deterministic operations for a talk-to-figma-backed session, executes them silently on canvas, acknowledges results, and re-syncs the snapshot.",
      inputSchema: {
        sessionId: z.string().min(1),
        limit: z.number().int().positive().max(100).default(20),
        wsUrl: z.string().url().optional(),
        timeoutMs: z.number().int().positive().max(300000).default(30000),
        syncAfter: z.boolean().default(true)
      }
    },
    async ({ sessionId, limit, wsUrl, timeoutMs, syncAfter }) => {
      try {
        const traceStore = await store.getTraceStore();
        try {
          const result = await executeTalkToFigmaSessionQueueTraced({
            store,
            sessionId,
            limit,
            wsUrl,
            timeoutMs,
            syncAfter,
            traceStore
          });
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result
          };
        } finally {
          await store.persistTraces();
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `execute_talk_to_figma_queue failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "ensure_talk_to_figma_session",
    {
      title: "Ensure Talk To Figma Session",
      description: "Reuses, discovers, or launches a talk-to-figma channel and syncs it into a fresh bridge session snapshot.",
      inputSchema: {
        sessionId: z.string().optional(),
        channel: z.string().optional(),
        wsUrl: z.string().url().optional(),
        logPath: z.string().optional(),
        timeoutMs: z.number().int().positive().max(30000).default(15000),
        limit: z.number().int().positive().max(50).default(12),
        pluginName: z.string().default("Cursor MCP Plugin"),
        appName: z.string().default("Figma"),
        attempts: z.number().int().positive().max(20).default(5),
        delayMs: z.number().int().positive().max(10000).default(700),
        forceLaunch: z.boolean().default(false),
        staleThresholdMs: z.number().int().positive().max(3600000).default(300000).describe("Milliseconds before a session heartbeat is considered stale (default 5 min)")
      }
    },
    async ({ sessionId, channel, wsUrl, logPath, timeoutMs, limit, pluginName, appName, attempts, delayMs, forceLaunch, staleThresholdMs }) => {
      try {
        const traceStore = await store.getTraceStore();
        try {
          const result = await ensureTalkToFigmaSession({
            store,
            sessionId,
            channel,
            wsUrl,
            logPath,
            timeoutMs,
            limit,
            pluginName,
            appName,
            attempts,
            delayMs,
            forceLaunch,
            staleThresholdMs,
            traceStore
          });
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result
          };
        } finally {
          await store.persistTraces();
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `ensure_talk_to_figma_session failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "search_live_figma_components",
    {
      title: "Search Live Figma Components",
      description: "Searches component catalogs captured from live Figma plugin sessions, including kit/library files opened in other tabs.",
      inputSchema: {
        query: z.string().optional(),
        sessionId: z.string().optional(),
        limit: z.number().int().positive().max(200).default(50)
      }
    },
    async ({ query, sessionId, limit }) => {
      try {
        const components = await store.searchComponents({ query, sessionId, limit });
        return {
          content: [{ type: "text", text: jsonText({ count: components.length, components }) }],
          structuredContent: {
            count: components.length,
            components
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `search_live_figma_components failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "instantiate_live_figma_component",
    {
      title: "Instantiate Live Figma Component",
      description: "Finds a component from live Figma session snapshots and enqueues a silent create_instance operation into a target session.",
      inputSchema: z.object({
        targetSessionId: z.string(),
        sourceSessionId: z.string().optional(),
        sourceFileKey: z.string().optional(),
        query: z.string().min(1).optional(),
        componentKey: z.string().optional(),
        componentId: z.string().optional(),
        parentId: z.string().optional(),
        index: z.number().int().nonnegative().optional()
      }).refine((value) => Boolean(value.query || value.componentKey || value.componentId), {
        message: "instantiate_live_figma_component requires query, componentKey, or componentId"
      })
    },
    async ({ targetSessionId, sourceSessionId, sourceFileKey, query, componentKey, componentId, parentId, index }) => {
      try {
        let publishedFallbackError: string | undefined;
        let resolved = await store.resolveComponentReference({
          targetSessionId,
          sourceSessionId,
          query,
          componentId,
          componentKey
        });

        if (!resolved.componentId && !resolved.componentKey && query) {
          const fileKey = await resolveSourceFileKey(store, sourceSessionId, sourceFileKey);
          if (fileKey) {
            try {
              const published = await searchPublishedComponentsInFile({
                fileKey,
                query,
                limit: 50
              });
              if (published[0]?.key) {
                resolved = {
                  chosen: resolved.chosen,
                  componentKey: published[0].key
                };
              }
            } catch (error) {
              publishedFallbackError = String(error);
            }
          }
        }

        if (!resolved.chosen && !resolved.componentId && !resolved.componentKey) {
          return {
            isError: true,
            content: [{ type: "text", text: publishedFallbackError
              ? `No live component matched "${query ?? ""}", and published fallback failed: ${publishedFallbackError}`
              : `No live component matched "${query ?? ""}"` }]
          };
        }

        if (!resolved.componentId && !resolved.componentKey) {
          return {
            isError: true,
            content: [{ type: "text", text: `Matched component "${resolved.chosen?.component.name ?? "unknown"}" is only available as a local component in session ${resolved.chosen?.sessionId ?? "unknown"}. Open the source kit in the same target session or use a published component key.` }]
          };
        }

        const queued = await store.enqueueOperations({
          sessionId: targetSessionId,
          description: query
            ? `Instantiate live component: ${query}`
            : "Instantiate live component",
          operations: [
            {
              type: "create_instance",
              componentId: resolved.componentId,
              componentKey: resolved.componentKey,
              parentId,
              index
            }
          ]
        });

        return {
          content: [{ type: "text", text: jsonText({ chosen: resolved.chosen, queued }) }],
          structuredContent: {
            chosen: resolved.chosen,
            operationIds: queued.map((record) => record.operationId),
            queued
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `instantiate_live_figma_component failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "search_published_figma_components",
    {
      title: "Search Published Figma Components",
      description: "Searches published components and component sets in a Figma file via the official REST API.",
      inputSchema: z.object({
        query: z.string().min(1),
        sourceSessionId: z.string().optional(),
        fileKey: z.string().optional(),
        limit: z.number().int().positive().max(200).default(50),
        includeComponentSets: z.boolean().default(true)
      }).refine((value) => Boolean(value.sourceSessionId || value.fileKey), {
        message: "search_published_figma_components requires sourceSessionId or fileKey"
      })
    },
    async ({ query, sourceSessionId, fileKey, limit, includeComponentSets }) => {
      try {
        const resolvedFileKey = await resolveSourceFileKey(store, sourceSessionId, fileKey);
        if (!resolvedFileKey) {
          return {
            isError: true,
            content: [{ type: "text", text: "Could not resolve a Figma file key for published component search" }]
          };
        }

        const components = await searchPublishedComponentsInFile({
          fileKey: resolvedFileKey,
          query,
          limit,
          includeComponentSets
        });
        return {
          content: [{ type: "text", text: jsonText({ count: components.length, components }) }],
          structuredContent: {
            count: components.length,
            components
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `search_published_figma_components failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "materialize_figma_asset",
    {
      title: "Materialize Figma Asset",
      description: "Ensures a live talk-to-figma session, inserts an asset from the current Assets panel, syncs the result, and selects the inserted nodes.",
      inputSchema: {
        query: z.string().min(1),
        sessionId: z.string().optional(),
        channel: z.string().optional(),
        wsUrl: z.string().url().optional(),
        logPath: z.string().optional(),
        timeoutMs: z.number().int().positive().max(120000).default(15000),
        limit: z.number().int().positive().max(100).default(20),
        pluginName: z.string().default("Cursor MCP Plugin"),
        appName: z.string().default("Figma"),
        attempts: z.number().int().positive().max(20).default(5),
        delayMs: z.number().int().positive().max(10000).default(700),
        forceLaunch: z.boolean().default(false),
        activateApp: z.boolean().default(true),
        windowTitle: z.string().optional(),
        resultIndex: z.number().int().min(0).default(0),
        settleMs: z.number().int().positive().max(5000).default(520),
        holdMs: z.number().int().positive().max(2000).default(180),
        releaseMs: z.number().int().positive().max(2000).default(120),
        dryRun: z.boolean().default(false),
        postInsertDelayMs: z.number().int().positive().max(10000).default(900),
        selectInsertedNodes: z.boolean().default(true)
      }
    },
    async ({ query, sessionId, channel, wsUrl, logPath, timeoutMs, limit, pluginName, appName, attempts, delayMs, forceLaunch, activateApp, windowTitle, resultIndex, settleMs, holdMs, releaseMs, dryRun, postInsertDelayMs, selectInsertedNodes }) => {
      try {
        const traceStore = await store.getTraceStore();
        try {
          const result = await materializeFigmaAssetTraced({
            store,
            query,
            sessionId,
            channel,
            wsUrl,
            logPath,
            timeoutMs,
            limit,
            pluginName,
            appName,
            attempts,
            delayMs,
            forceLaunch,
            activateApp,
            windowTitle,
            resultIndex,
            settleMs,
            holdMs,
            releaseMs,
            dryRun,
            postInsertDelayMs,
            selectInsertedNodes,
            traceStore
          });
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result
          };
        } finally {
          await store.persistTraces();
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `materialize_figma_asset failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "scan_figma_assets_panel",
    {
      title: "Scan Figma Assets Panel",
      description: "Uses desktop OCR to list the currently visible kits/libraries in the Figma Assets panel.",
      inputSchema: {
        activateApp: z.boolean().default(false),
        limit: z.number().int().positive().max(400).default(250)
      }
    },
    async ({ activateApp, limit }) => {
      try {
        const result = await scanVisibleAssetsPanel({ activateApp, limit });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `scan_figma_assets_panel failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "search_figma_assets_results",
    {
      title: "Search Figma Assets Results",
      description: "Uses desktop automation to search the current Figma Assets panel and return live matching library items without dragging them manually.",
      inputSchema: {
        query: z.string().min(1),
        activateApp: z.boolean().default(true),
        windowTitle: z.string().optional(),
        limit: z.number().int().positive().max(100).default(20),
        settleMs: z.number().int().positive().max(5000).default(520)
      }
    },
    async ({ query, activateApp, windowTitle, limit, settleMs }) => {
      try {
        const result = await searchFigmaAssetsPanel({
          query,
          activateApp,
          windowTitle,
          limit,
          settleMs
        });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `search_figma_assets_results failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerTool(
    "insert_figma_asset_from_panel",
    {
      title: "Insert Figma Asset From Panel",
      description: "Searches the current Figma Assets panel and drags a matching library item into the current canvas, without requiring a manual drag step.",
      inputSchema: {
        query: z.string().min(1),
        activateApp: z.boolean().default(true),
        windowTitle: z.string().optional(),
        resultIndex: z.number().int().min(0).default(0),
        limit: z.number().int().positive().max(100).default(20),
        settleMs: z.number().int().positive().max(5000).default(520),
        holdMs: z.number().int().positive().max(2000).default(180),
        releaseMs: z.number().int().positive().max(2000).default(120),
        dryRun: z.boolean().default(false),
        syncSessionId: z.string().optional(),
        syncWsUrl: z.string().url().optional(),
        syncTimeoutMs: z.number().int().positive().max(120000).optional(),
        postInsertDelayMs: z.number().int().positive().max(10000).optional()
      }
    },
    async ({ query, activateApp, windowTitle, resultIndex, limit, settleMs, holdMs, releaseMs, dryRun, syncSessionId, syncWsUrl, syncTimeoutMs, postInsertDelayMs }) => {
      try {
        const result = await insertFigmaAssetWithOptionalSync({
          store,
          query,
          activateApp,
          windowTitle,
          resultIndex,
          limit,
          settleMs,
          holdMs,
          releaseMs,
          dryRun,
          syncSessionId,
          syncWsUrl,
          syncTimeoutMs,
          postInsertDelayMs
        });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `insert_figma_asset_from_panel failed: ${String(error)}` }]
        };
      }
    }
  );

  server.registerResource(
    "figma-sessions",
    "figma://sessions",
    {
      title: "Figma Sessions",
      description: "Current Figma bridge sessions and operation status.",
      mimeType: "application/json"
    },
    async (uri) => {
      const status = await store.getStatus();
      return {
        contents: [{ uri: uri.href, text: jsonText(status) }]
      };
    }
  );

  server.registerResource(
    "figma-components",
    "figma://components",
    {
      title: "Live Figma Components",
      description: "Component catalogs captured from live Figma sessions.",
      mimeType: "application/json"
    },
    async (uri) => {
      const components = await store.searchComponents();
      return {
        contents: [{ uri: uri.href, text: jsonText({ count: components.length, components }) }]
      };
    }
  );

  server.registerResource(
    "figma-session-snapshot",
    new ResourceTemplate("figma://session/{sessionId}/snapshot", { list: undefined }),
    {
      title: "Figma Session Snapshot",
      description: "Latest published snapshot for a registered Figma bridge session.",
      mimeType: "application/json"
    },
    async (uri, { sessionId }) => {
      const resolvedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      const snapshot = await store.getSnapshot(resolvedSessionId);
      return {
        contents: [{ uri: uri.href, text: jsonText(snapshot ?? { sessionId: resolvedSessionId, snapshot: null }) }]
      };
    }
  );

  return server;
}
