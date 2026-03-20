import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type LocalFileExtension = {
  id: number;
  manifestPath: string;
  lastKnownName?: string;
  lastKnownPluginId?: string;
  fileMetadata?: Record<string, unknown>;
};

type FigmaSettings = {
  localFileExtensions?: LocalFileExtension[];
  [key: string]: unknown;
};

function usage(): never {
  throw new Error("Usage: tsx src/register-dev-plugin.ts register|unregister|list");
}

function getSettingsPath(): string {
  return resolve(process.env.HOME ?? "~", "Library", "Application Support", "Figma", "settings.json");
}

function getPluginPaths() {
  const projectRoot = resolve(process.cwd());
  const pluginDir = resolve(projectRoot, "plugin-dist");
  return {
    manifestPath: resolve(pluginDir, "manifest.json"),
    codePath: resolve(pluginDir, "code.js"),
    uiPath: resolve(pluginDir, "ui.html"),
    pluginDir
  };
}

async function readSettings(settingsPath: string): Promise<FigmaSettings> {
  const raw = await readFile(settingsPath, "utf8");
  return JSON.parse(raw) as FigmaSettings;
}

function nextId(entries: LocalFileExtension[]): number {
  return entries.reduce((maxId, entry) => Math.max(maxId, entry.id), 0) + 1;
}

function isManagedPath(path: string): boolean {
  const { pluginDir } = getPluginPaths();
  return resolve(path).startsWith(pluginDir);
}

async function backupSettings(settingsPath: string): Promise<void> {
  const backupDir = resolve(dirname(settingsPath), "codex-backups");
  await mkdir(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `settings.${Date.now().toString(36)}.json`);
  await copyFile(settingsPath, backupPath);
}

async function registerPlugin(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settings = await readSettings(settingsPath);
  const { manifestPath, codePath, uiPath } = getPluginPaths();
  const localFileExtensions = (settings.localFileExtensions ?? []).filter((entry) => !isManagedPath(entry.manifestPath));

  const manifestId = nextId(localFileExtensions);
  const codeId = manifestId + 1;
  const uiId = manifestId + 2;

  localFileExtensions.push(
    {
      id: manifestId,
      manifestPath,
      lastKnownName: "Figma Control MCP Worker",
      lastKnownPluginId: "figma-control-mcp-worker",
      fileMetadata: {
        type: "manifest",
        codeFileId: codeId,
        uiFileIds: [uiId]
      }
    },
    {
      id: codeId,
      manifestPath: codePath,
      fileMetadata: {
        type: "code",
        manifestFileId: manifestId
      }
    },
    {
      id: uiId,
      manifestPath: uiPath,
      fileMetadata: {
        type: "ui",
        manifestFileId: manifestId
      }
    }
  );

  settings.localFileExtensions = localFileExtensions;
  await backupSettings(settingsPath);
  await writeFile(settingsPath, JSON.stringify(settings, null, 0));
  console.log(JSON.stringify({
    ok: true,
    action: "register",
    settingsPath,
    manifestPath,
    count: localFileExtensions.length
  }, null, 2));
}

async function unregisterPlugin(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settings = await readSettings(settingsPath);
  const current = settings.localFileExtensions ?? [];
  const next = current.filter((entry) => !isManagedPath(entry.manifestPath));
  settings.localFileExtensions = next;
  await backupSettings(settingsPath);
  await writeFile(settingsPath, JSON.stringify(settings, null, 0));
  console.log(JSON.stringify({
    ok: true,
    action: "unregister",
    settingsPath,
    removed: current.length - next.length
  }, null, 2));
}

async function listPlugins(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settings = await readSettings(settingsPath);
  const entries = (settings.localFileExtensions ?? []).filter((entry) => entry.fileMetadata?.type === "manifest");
  console.log(JSON.stringify({
    ok: true,
    settingsPath,
    plugins: entries.map((entry) => ({
      id: entry.id,
      name: entry.lastKnownName,
      pluginId: entry.lastKnownPluginId,
      manifestPath: entry.manifestPath,
      managedByCodex: isManagedPath(entry.manifestPath)
    }))
  }, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "register":
      await registerPlugin();
      return;
    case "unregister":
      await unregisterPlugin();
      return;
    case "list":
      await listPlugins();
      return;
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
