import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PluginBridgeClient } from "./plugin-bridge-client.js";
import { enqueueBatchOperationsSchema } from "./schemas.js";

async function parseJsonArgument(raw?: string): Promise<Record<string, unknown>> {
  if (!raw) {
    return {};
  }

  if (raw.startsWith("@")) {
    const filePath = raw.slice(1);
    const fileContents = await readFile(resolve(filePath), "utf8");
    return JSON.parse(fileContents) as Record<string, unknown>;
  }

  return JSON.parse(raw) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const client = new PluginBridgeClient({
    baseUrl: process.env.FIGMA_CONTROL_BRIDGE_URL ?? "http://127.0.0.1:3847",
    token: process.env.FIGMA_CONTROL_BRIDGE_TOKEN
  });

  switch (command) {
    case "status": {
      const sessionId = args[0];
      const status = await client.status(sessionId);
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case "components": {
      const [query, sessionId] = args;
      const components = await client.searchComponents({
        query: query || undefined,
        sessionId: sessionId || undefined
      });
      console.log(JSON.stringify(components, null, 2));
      return;
    }
    case "published-components": {
      const [query, sourceSessionId, fileKey] = args;
      if (!query) {
        throw new Error("Usage: npm run bridge:published-components -- <query> [sourceSessionId] [fileKey]");
      }
      const components = await client.searchPublishedComponents({
        query,
        sourceSessionId: sourceSessionId || undefined,
        fileKey: fileKey || undefined
      });
      console.log(JSON.stringify(components, null, 2));
      return;
    }
    case "assets": {
      const assets = await client.scanAssetsPanel();
      console.log(JSON.stringify(assets, null, 2));
      return;
    }
    case "asset-search": {
      const [query, windowTitle] = args;
      if (!query) {
        throw new Error("Usage: npm run bridge:asset-search -- <query> [windowTitle]");
      }
      const assets = await client.searchAssetsPanel({
        query,
        windowTitle: windowTitle || undefined
      });
      console.log(JSON.stringify(assets, null, 2));
      return;
    }
    case "asset-insert": {
      const [query, indexRaw, windowTitle] = args;
      if (!query) {
        throw new Error("Usage: npm run bridge:asset-insert -- <query> [resultIndex] [windowTitle]");
      }
      const inserted = await client.insertAssetFromPanel({
        query,
        resultIndex: indexRaw ? Number.parseInt(indexRaw, 10) : undefined,
        windowTitle: windowTitle || undefined
      });
      console.log(JSON.stringify(inserted, null, 2));
      return;
    }
    case "asset-insert-sync": {
      const [syncSessionId, query, indexRaw, windowTitle] = args;
      if (!syncSessionId || !query) {
        throw new Error("Usage: npm run bridge:asset-insert-sync -- <syncSessionId> <query> [resultIndex] [windowTitle]");
      }
      const inserted = await client.insertAssetFromPanel({
        syncSessionId,
        query,
        resultIndex: indexRaw ? Number.parseInt(indexRaw, 10) : undefined,
        windowTitle: windowTitle || undefined
      });
      console.log(JSON.stringify(inserted, null, 2));
      return;
    }
    case "materialize-asset": {
      const [query, sessionId, indexRaw, windowTitle] = args;
      if (!query) {
        throw new Error("Usage: npm run bridge:materialize-asset -- <query> [sessionId] [resultIndex] [windowTitle]");
      }
      const result = await client.materializeAsset({
        query,
        sessionId: sessionId || undefined,
        resultIndex: indexRaw ? Number.parseInt(indexRaw, 10) : undefined,
        windowTitle: windowTitle || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "instantiate-component": {
      const [targetSessionId, query, sourceSessionId, sourceFileKey] = args;
      if (!targetSessionId || !query) {
        throw new Error("Usage: npm run bridge:instantiate-component -- <targetSessionId> <query> [sourceSessionId] [sourceFileKey]");
      }
      const instantiated = await client.instantiateComponent({
        targetSessionId,
        query,
        sourceSessionId: sourceSessionId || undefined,
        sourceFileKey: sourceFileKey || undefined
      });
      console.log(JSON.stringify(instantiated, null, 2));
      return;
    }
    case "talk-probe": {
      const [channel, wsUrl] = args;
      if (!channel) {
        throw new Error("Usage: npm run bridge:talk-probe -- <channel> [wsUrl]");
      }
      const result = await client.probeTalkToFigmaChannel({
        channel,
        wsUrl: wsUrl || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "talk-channels": {
      const [limitRaw, logPath] = args;
      const result = await client.listTalkToFigmaChannels({
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
        logPath: logPath || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "talk-discover": {
      const [wsUrl, logPath, limitRaw] = args;
      const result = await client.discoverTalkToFigmaChannel({
        wsUrl: wsUrl || undefined,
        logPath: logPath || undefined,
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "talk-sync": {
      const [channel, sessionId, wsUrl] = args;
      if (!channel) {
        throw new Error("Usage: npm run bridge:talk-sync -- <channel> [sessionId] [wsUrl]");
      }
      const result = await client.syncTalkToFigmaChannel({
        channel,
        sessionId: sessionId || undefined,
        wsUrl: wsUrl || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "talk-ensure": {
      const [sessionId, pluginName, wsUrl, logPath] = args;
      const result = await client.ensureTalkToFigmaSession({
        sessionId: sessionId || undefined,
        pluginName: pluginName || undefined,
        wsUrl: wsUrl || undefined,
        logPath: logPath || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "talk-run-queue": {
      const [sessionId, limitRaw, wsUrl] = args;
      if (!sessionId) {
        throw new Error("Usage: npm run bridge:talk-run-queue -- <sessionId> [limit] [wsUrl]");
      }
      const result = await client.executeTalkToFigmaQueue({
        sessionId,
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
        wsUrl: wsUrl || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "figma-dev-plugins": {
      const [appName] = args;
      const result = await client.listFigmaDevelopmentPlugins({
        appName: appName || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "figma-launch-plugin": {
      const [pluginName, appName] = args;
      if (!pluginName) {
        throw new Error("Usage: npm run bridge:figma-launch-plugin -- <pluginName> [appName]");
      }
      const result = await client.launchFigmaDevelopmentPlugin({
        pluginName,
        appName: appName || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "figma-launch-discover": {
      const [pluginName, wsUrl, logPath] = args;
      if (!pluginName) {
        throw new Error("Usage: npm run bridge:figma-launch-discover -- <pluginName> [wsUrl] [logPath]");
      }
      const result = await client.launchAndDiscoverTalkToFigma({
        pluginName,
        wsUrl: wsUrl || undefined,
        logPath: logPath || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "talk-command": {
      const [channel, commandName, paramsRaw, wsUrl] = args;
      if (!channel || !commandName) {
        throw new Error("Usage: npm run bridge:talk-command -- <channel> <command> [paramsJson|@file] [wsUrl]");
      }
      const result = await client.executeTalkToFigmaCommand({
        channel,
        command: commandName,
        params: await parseJsonArgument(paramsRaw),
        wsUrl: wsUrl || undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "resolve":
    case "enqueue": {
      const filePath = args[0];
      if (!filePath) {
        throw new Error(`Usage: npm run bridge:${command} -- <request.json>`);
      }

      const raw = await readFile(resolve(filePath), "utf8");
      const input = enqueueBatchOperationsSchema.parse(JSON.parse(raw));

      const output = command === "resolve"
        ? await client.resolveBatch(input.sessionId, input.operations)
        : await client.enqueueBatch(input);

      console.log(JSON.stringify(output, null, 2));
      return;
    }
    default:
      throw new Error("Usage: npm run bridge:status -- [sessionId] | npm run bridge:components -- [query] [sessionId] | npm run bridge:published-components -- <query> [sourceSessionId] [fileKey] | npm run bridge:assets | npm run bridge:asset-search -- <query> [windowTitle] | npm run bridge:asset-insert -- <query> [resultIndex] [windowTitle] | npm run bridge:asset-insert-sync -- <syncSessionId> <query> [resultIndex] [windowTitle] | npm run bridge:materialize-asset -- <query> [sessionId] [resultIndex] [windowTitle] | npm run bridge:instantiate-component -- <targetSessionId> <query> [sourceSessionId] [sourceFileKey] | npm run bridge:figma-dev-plugins -- [appName] | npm run bridge:figma-launch-plugin -- <pluginName> [appName] | npm run bridge:figma-launch-discover -- <pluginName> [wsUrl] [logPath] | npm run bridge:talk-probe -- <channel> [wsUrl] | npm run bridge:talk-channels -- [limit] [logPath] | npm run bridge:talk-discover -- [wsUrl] [logPath] [limit] | npm run bridge:talk-sync -- <channel> [sessionId] [wsUrl] | npm run bridge:talk-ensure -- [sessionId] [pluginName] [wsUrl] [logPath] | npm run bridge:talk-run-queue -- <sessionId> [limit] [wsUrl] | npm run bridge:talk-command -- <channel> <command> [paramsJson|@file] [wsUrl] | npm run bridge:resolve -- request.json | npm run bridge:enqueue -- request.json");
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
