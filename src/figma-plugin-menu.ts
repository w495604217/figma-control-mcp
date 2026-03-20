import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { discoverResponsiveTalkToFigmaChannel, type DiscoveredTalkToFigmaChannel } from "./talk-to-figma-log.js";

const execFileAsync = promisify(execFile);

export type AppleScriptRunner = (lines: string[]) => Promise<string>;
export type TalkToFigmaDiscoverer = typeof discoverResponsiveTalkToFigmaChannel;

export type LaunchFigmaDevelopmentPluginInput = {
  pluginName: string;
  appName?: string;
};

export type LaunchAndDiscoverInput = LaunchFigmaDevelopmentPluginInput & {
  wsUrl?: string;
  logPath?: string;
  limit?: number;
  timeoutMs?: number;
  attempts?: number;
  delayMs?: number;
};

function defaultRunner(): AppleScriptRunner {
  return async (lines) => {
    const args = lines.flatMap((line) => ["-e", line]);
    const { stdout } = await execFileAsync("osascript", args);
    return stdout.trim();
  };
}

async function getLogLineCount(logPath?: string): Promise<number | undefined> {
  if (!logPath) {
    return undefined;
  }
  try {
    const contents = await readFile(logPath, "utf8");
    return contents.split(/\r?\n/).length;
  } catch {
    return undefined;
  }
}

function appNameLiteral(appName: string): string {
  return appName.replace(/"/g, '\\"');
}

function pluginNameLiteral(pluginName: string): string {
  return pluginName.replace(/"/g, '\\"');
}

export class FigmaPluginMenuClient {
  private readonly runAppleScript: AppleScriptRunner;
  private readonly discoverTalkToFigmaChannel: TalkToFigmaDiscoverer;

  constructor(input: { runner?: AppleScriptRunner; discoverer?: TalkToFigmaDiscoverer } = {}) {
    this.runAppleScript = input.runner ?? defaultRunner();
    this.discoverTalkToFigmaChannel = input.discoverer ?? discoverResponsiveTalkToFigmaChannel;
  }

  async listDevelopmentPlugins(appName = "Figma"): Promise<{
    appName: string;
    plugins: string[];
  }> {
    const escapedAppName = appNameLiteral(appName);
    const raw = await this.runAppleScript([
      'set AppleScript\'s text item delimiters to linefeed',
      'tell application "System Events"',
      `  tell process "${escapedAppName}"`,
      "    set frontmost to true",
      '    click menu bar item "Plugins" of menu bar 1',
      "    delay 0.2",
      '    set itemNames to name of every menu item of menu 1 of menu item "Development" of menu 1 of menu bar item "Plugins" of menu bar 1',
      "    key code 53",
      "  end tell",
      "end tell",
      "return itemNames as string"
    ]);

    return {
      appName,
      plugins: raw
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value !== "missing value")
    };
  }

  async launchDevelopmentPlugin(input: LaunchFigmaDevelopmentPluginInput): Promise<{
    ok: true;
    appName: string;
    pluginName: string;
    launchedAt: string;
  }> {
    const appName = input.appName ?? "Figma";
    const escapedAppName = appNameLiteral(appName);
    const escapedPluginName = pluginNameLiteral(input.pluginName);
    await this.runAppleScript([
      'tell application "System Events"',
      `  tell process "${escapedAppName}"`,
      "    set frontmost to true",
      '    click menu bar item "Plugins" of menu bar 1',
      "    delay 0.2",
      `    click menu item "${escapedPluginName}" of menu 1 of menu item "Development" of menu 1 of menu bar item "Plugins" of menu bar 1`,
      "  end tell",
      "end tell"
    ]);

    return {
      ok: true,
      appName,
      pluginName: input.pluginName,
      launchedAt: new Date().toISOString()
    };
  }

  async launchAndDiscoverTalkToFigmaChannel(input: LaunchAndDiscoverInput): Promise<{
    launch: {
      ok: true;
      appName: string;
      pluginName: string;
      launchedAt: string;
    };
    discovered: DiscoveredTalkToFigmaChannel;
    attempts: number;
  }> {
    const attempts = input.attempts ?? 5;
    const delayMs = input.delayMs ?? 700;
    const afterLine = await getLogLineCount(input.logPath);
    const launch = await this.launchDevelopmentPlugin(input);

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (attempt > 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const discovered = await this.discoverTalkToFigmaChannel({
          wsUrl: input.wsUrl,
          logPath: input.logPath,
          limit: input.limit,
          timeoutMs: input.timeoutMs,
          afterLine
        });
        return {
          launch,
          discovered,
          attempts: attempt
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Launched plugin "${input.pluginName}" but could not discover a responsive talk-to-figma channel after ${attempts} attempts: ${String(lastError)}`);
  }
}
