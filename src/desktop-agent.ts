import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const currentDir = dirname(fileURLToPath(import.meta.url));
const desktopAgentPath = resolve(currentDir, "..", "..", "scripts", "desktop_agent.py");

export type DesktopPoint = {
  x: number;
  y: number;
};

export type DesktopBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopAgentMatch = {
  score?: number;
  mode?: string;
};

export type DesktopAgentOcrResult = {
  text: string;
  center_px?: DesktopPoint;
  center_pt?: DesktopPoint;
  bbox_px?: DesktopBox;
  confidence?: number;
  match?: DesktopAgentMatch;
};

export type DesktopAgentWindow = {
  id?: number;
  pid?: number;
  owner?: string;
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer?: number;
  alpha?: number;
  onscreen?: boolean;
  z_index?: number;
  source?: string;
  window_kind?: string;
  match_score?: number;
};

export type DesktopAgentCapturePayload = {
  ok?: boolean;
  output?: string;
  target?: DesktopAgentWindow;
  all_windows?: boolean;
};

export type DesktopAgentStatusPayload = {
  app?: string;
  window?: {
    title?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
  mouse?: DesktopPoint;
  screen?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
};

export type DesktopAgentOcrPayload = {
  image?: string;
  scale?: DesktopPoint;
  screen?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  scope?: string;
  results?: DesktopAgentOcrResult[];
};

async function execDesktopAgent(args: string[]): Promise<string> {
  const start = Date.now();
  const { stdout } = await execFileAsync("python3", [desktopAgentPath, ...args], {
    cwd: resolve(currentDir, "..", "..")
  });
  if (process.env.FIGMA_CONTROL_DEBUG === "1") {
    const durationMs = Date.now() - start;
    console.log(`[desktop-agent] python3 ${args.join(" ")} (${durationMs}ms)`);
  }
  return stdout.trim();
}

export async function runDesktopAgentJson<T>(args: string[]): Promise<T> {
  const stdout = await execDesktopAgent(args);
  return stdout ? JSON.parse(stdout) as T : {} as T;
}

export async function runDesktopAgent(args: string[]): Promise<void> {
  await execDesktopAgent(args);
}

export async function getDesktopStatus(): Promise<DesktopAgentStatusPayload> {
  return runDesktopAgentJson<DesktopAgentStatusPayload>(["status"]);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function activateDesktopApp(name: string): Promise<void> {
  await runAppleScript(`tell application ${JSON.stringify(name)} to activate`);
}

export async function captureAppWindow(options: {
  app: string;
  title?: string;
  limitAll?: boolean;
  outputPath: string;
}): Promise<DesktopAgentCapturePayload> {
  const args = ["capture-window", options.outputPath, "--app", options.app];
  if (options.title) {
    args.push(options.title);
  }
  if (options.limitAll !== false) {
    args.push("--all");
  }
  return runDesktopAgentJson<DesktopAgentCapturePayload>(args);
}

export async function ocrImage<T extends DesktopAgentOcrPayload = DesktopAgentOcrPayload>(options: {
  path: string;
  query?: string;
  limit?: number;
}): Promise<T> {
  const args = ["ocr", options.path, "--scope", "screen"];
  if (options.query) {
    args.push("--query", options.query);
  }
  if (typeof options.limit === "number") {
    args.push("--limit", String(options.limit));
  }
  return runDesktopAgentJson<T>(args);
}

export async function clickPoint(point: DesktopPoint): Promise<void> {
  await runDesktopAgentJson(["click", "--x", String(Math.round(point.x)), "--y", String(Math.round(point.y))]);
}

export async function clickWindowText(text: string): Promise<unknown> {
  return runDesktopAgentJson(["click-text", text, "--scope", "window"]);
}

export async function dragBetween(options: {
  from: DesktopPoint;
  to: DesktopPoint;
  holdMs?: number;
  releaseMs?: number;
  dryRun?: boolean;
}): Promise<unknown> {
  const args = [
    "drag",
    "--from-x", String(Math.round(options.from.x)),
    "--from-y", String(Math.round(options.from.y)),
    "--to-x", String(Math.round(options.to.x)),
    "--to-y", String(Math.round(options.to.y)),
    "--hold-ms", String(options.holdMs ?? 180),
    "--release-ms", String(options.releaseMs ?? 120)
  ];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  return runDesktopAgentJson(args);
}

export async function pressKey(key: string, mods: string[] = []): Promise<void> {
  const args = ["key", key];
  if (mods.length > 0) {
    args.push("--mods", mods.join(","));
  }
  await runDesktopAgentJson(args);
}

export async function typeText(text: string): Promise<void> {
  await runDesktopAgentJson(["type", text]);
}

export async function readImageSize(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
    cwd: resolve(currentDir, "..", "..")
  });
  const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  if (!widthMatch || !heightMatch) {
    throw new Error(`Unable to read image size for ${path}`);
  }
  return {
    width: Number.parseInt(widthMatch[1], 10),
    height: Number.parseInt(heightMatch[1], 10)
  };
}

async function runAppleScript(script: string): Promise<void> {
  const start = Date.now();
  await execFileAsync("osascript", ["-e", script], {
    cwd: resolve(currentDir, "..", "..")
  });
  if (process.env.FIGMA_CONTROL_DEBUG === "1") {
    const durationMs = Date.now() - start;
    console.log(`[desktop-agent] osascript (${durationMs}ms)`);
  }
}

export async function systemKeystroke(key: string, modifiers: string[] = []): Promise<void> {
  const modifierMap = new Map([
    ["cmd", "command down"],
    ["command", "command down"],
    ["shift", "shift down"],
    ["ctrl", "control down"],
    ["control", "control down"],
    ["opt", "option down"],
    ["option", "option down"]
  ]);

  const using = modifiers
    .map((modifier) => modifierMap.get(modifier.toLowerCase()))
    .filter((value): value is string => Boolean(value));
  const quotedKey = JSON.stringify(key);
  const script = using.length > 0
    ? `tell application "System Events" to keystroke ${quotedKey} using {${using.join(", ")}}`
    : `tell application "System Events" to keystroke ${quotedKey}`;
  await runAppleScript(script);
}

export async function systemKeyCode(code: number, modifiers: string[] = []): Promise<void> {
  const modifierMap = new Map([
    ["cmd", "command down"],
    ["command", "command down"],
    ["shift", "shift down"],
    ["ctrl", "control down"],
    ["control", "control down"],
    ["opt", "option down"],
    ["option", "option down"]
  ]);

  const using = modifiers
    .map((modifier) => modifierMap.get(modifier.toLowerCase()))
    .filter((value): value is string => Boolean(value));
  const script = using.length > 0
    ? `tell application "System Events" to key code ${Math.round(code)} using {${using.join(", ")}}`
    : `tell application "System Events" to key code ${Math.round(code)}`;
  await runAppleScript(script);
}

export async function replaceFocusedText(text: string): Promise<void> {
  await execFileAsync("bash", ["-lc", `printf %s ${JSON.stringify(text)} | pbcopy`], {
    cwd: resolve(currentDir, "..", "..")
  });
  await systemKeystroke("a", ["cmd"]);
  await sleep(50);
  await systemKeyCode(51);
  await sleep(50);
  await systemKeystroke("v", ["cmd"]);
  await sleep(20);
}

export async function pasteText(text: string): Promise<void> {
  await execFileAsync("bash", ["-lc", `printf %s ${JSON.stringify(text)} | pbcopy`], {
    cwd: resolve(currentDir, "..", "..")
  });
  await systemKeystroke("v", ["cmd"]);
  await sleep(20);
}

export function localPointToAbsolute(window: DesktopAgentWindow, point: DesktopPoint | undefined): DesktopPoint | undefined {
  if (!point) {
    return undefined;
  }
  return {
    x: window.x + point.x,
    y: window.y + point.y
  };
}
