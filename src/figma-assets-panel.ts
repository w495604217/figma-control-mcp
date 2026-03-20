import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  activateDesktopApp,
  captureAppWindow,
  clickPoint,
  clickWindowText,
  ocrImage,
  readImageSize,
  sleep,
  systemKeyCode,
  systemKeystroke,
  type DesktopAgentOcrPayload,
  type DesktopAgentOcrResult,
  type DesktopAgentWindow
} from "./desktop-agent.js";
import {
  canonicalizeFigmaAssetsText,
  normalizeVisibleLibraryDetail,
  normalizeVisibleLibraryName
} from "./figma-assets-text.js";
import { parkTalkToFigmaOverlayIfPresent } from "./figma-plugin-overlay.js";

export type VisibleFigmaLibrary = {
  name: string;
  normalizedName: string;
  canonicalName: string;
  detail?: string;
  normalizedDetail?: string;
  centerPx?: { x: number; y: number };
  detailCenterPx?: { x: number; y: number };
};

const LEFT_PANEL_MAX_X = 520;
const PANEL_START_Y = 520;
const DETAIL_PATTERN = /\b\d[\d,]*\s+(components?|icons?|styles?|variables?)\b/i;
const SEARCH_FIELD_MIN_Y = 380;
const SEARCH_FIELD_MAX_Y = 540;
const SEARCH_FIELD_MAX_X = 520;
const TITLE_EXCLUSIONS = new Set([
  "Untitled",
  "Drafts",
  "File",
  "Assets",
  "Search all libraries",
  "All libraries",
  "Design",
  "Prototype",
  "Page",
  "Variables",
  "Styles",
  "Export",
  "Share"
]);

function isLeftPanelEntry(result: OcrResult): boolean {
  const center = result.center_px;
  return Boolean(center && center.x <= LEFT_PANEL_MAX_X && center.y >= PANEL_START_Y);
}

function isLibraryTitle(text: string): boolean {
  if (!text || TITLE_EXCLUSIONS.has(text)) {
    return false;
  }
  if (DETAIL_PATTERN.test(text)) {
    return false;
  }
  return text.includes("(Community)") || /^[A-Za-z0-9].{2,}$/.test(text);
}

type OcrResult = DesktopAgentOcrResult;
type OcrPayload = DesktopAgentOcrPayload;

export type VisibleAssetsSearchField = {
  placeholderVisible: boolean;
  rawText: string;
  visibleText?: string;
  clickPointPx: { x: number; y: number };
};

export function extractVisibleLibraries(payload: OcrPayload): VisibleFigmaLibrary[] {
  const candidates = (payload.results ?? [])
    .filter(isLeftPanelEntry)
    .sort((left, right) => (left.center_px?.y ?? 0) - (right.center_px?.y ?? 0));

  const libraries: VisibleFigmaLibrary[] = [];

  for (const candidate of candidates) {
    const text = candidate.text?.trim();
    if (!isLibraryTitle(text)) {
      continue;
    }

    const alreadySeen = libraries.some((library) => library.name === text);
    if (alreadySeen) {
      continue;
    }

    const detail = candidates.find((entry) => {
      if (!entry.text || !DETAIL_PATTERN.test(entry.text)) {
        return false;
      }
      const sameColumn = Math.abs((entry.center_px?.x ?? 0) - (candidate.center_px?.x ?? 0)) < 120;
      const belowTitle = (entry.center_px?.y ?? 0) > (candidate.center_px?.y ?? 0);
      const nearTitle = (entry.center_px?.y ?? 0) - (candidate.center_px?.y ?? 0) < 90;
      return sameColumn && belowTitle && nearTitle;
    });

    if (!text.includes("(Community)") && !detail) {
      continue;
    }

    libraries.push({
      name: text,
      normalizedName: normalizeVisibleLibraryName(text),
      canonicalName: canonicalizeFigmaAssetsText(normalizeVisibleLibraryName(text)),
      detail: detail?.text?.trim(),
      normalizedDetail: normalizeVisibleLibraryDetail(detail?.text?.trim()),
      centerPx: candidate.center_px,
      detailCenterPx: detail?.center_px
    });
  }

  return libraries;
}

function normalizeSearchFieldText(text: string | undefined): string {
  return (text ?? "")
    .replace(/^[•QO0]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function scoreSearchFieldCandidate(result: DesktopAgentOcrResult): number {
  const text = normalizeSearchFieldText(result.text);
  const width = result.bbox_px?.width ?? 0;
  const height = result.bbox_px?.height ?? 0;
  return (text.includes("Search all libraries") ? 3 : 0)
    + Math.min(width / 120, 3)
    + Math.min(height / 20, 1)
    + (text.length >= 4 ? 0.5 : 0);
}

function pixelToWindowPoint(
  window: DesktopAgentWindow,
  imageSize: { width: number; height: number },
  point: { x: number; y: number }
): { x: number; y: number } {
  return {
    x: (point.x / imageSize.width) * window.w,
    y: (point.y / imageSize.height) * window.h
  };
}

function toAbsolute(
  window: DesktopAgentWindow,
  imageSize: { width: number; height: number },
  point: { x: number; y: number }
): { x: number; y: number } {
  const local = pixelToWindowPoint(window, imageSize, point);
  return {
    x: window.x + local.x,
    y: window.y + local.y
  };
}

export function detectVisibleAssetsSearchField(payload: OcrPayload): VisibleAssetsSearchField | undefined {
  const candidate = (payload.results ?? [])
    .filter((result) => {
      const center = result.center_px;
      if (!center) {
        return false;
      }
      if (center.x > SEARCH_FIELD_MAX_X || center.y < SEARCH_FIELD_MIN_Y || center.y > SEARCH_FIELD_MAX_Y) {
        return false;
      }
      const text = normalizeSearchFieldText(result.text);
      if (!text) {
        return false;
      }
      return text !== "All libraries" && text !== "Assets";
    })
    .sort((left, right) => scoreSearchFieldCandidate(right) - scoreSearchFieldCandidate(left))[0];

  if (!candidate?.center_px) {
    return undefined;
  }

  const focusAnchorPx = candidate.bbox_px
    ? {
      x: candidate.bbox_px.x + Math.min(40, candidate.bbox_px.width * 0.2),
      y: candidate.bbox_px.y + (candidate.bbox_px.height / 2)
    }
    : candidate.center_px;

  return {
    placeholderVisible: normalizeSearchFieldText(candidate.text).includes("Search all libraries"),
    rawText: candidate.text,
    visibleText: normalizeSearchFieldText(candidate.text),
    clickPointPx: focusAnchorPx
  };
}

async function clearActiveAssetsSearchIfNeeded(payload: {
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  results?: OcrResult[];
}): Promise<boolean> {
  const searchField = detectVisibleAssetsSearchField({ results: payload.results });
  if (!searchField || searchField.placeholderVisible || !searchField.visibleText) {
    return false;
  }

  await clickWindowText(searchField.rawText);
  await sleep(100);
  await systemKeystroke("a", ["cmd"]);
  await sleep(60);
  await systemKeyCode(51);
  await sleep(280);
  return true;
}

export async function scanVisibleAssetsPanel(options: {
  activateApp?: boolean;
  limit?: number;
} = {}): Promise<{
  count: number;
  libraries: VisibleFigmaLibrary[];
  image?: string;
}> {
  if (options.activateApp) {
    await activateDesktopApp("Figma");
    await sleep(350);
  }

  const limit = options.limit ?? 250;
  const capturePath = resolve(tmpdir(), `figma-assets-panel-${Date.now().toString(36)}.png`);

  try {
    const capturePayload = async (): Promise<{
      image?: string;
      results?: OcrResult[];
      window?: DesktopAgentWindow;
      imageSize?: { width: number; height: number };
    }> => {
      const capture = await captureAppWindow({
        app: "Figma",
        outputPath: capturePath
      });
      const payload = await ocrImage<{
        image?: string;
        results?: OcrResult[];
      }>({
        path: capturePath,
        limit
      });
      const imageSize = await readImageSize(capturePath);
      return {
        ...payload,
        window: capture.target,
        imageSize
      };
    };

    let payload = await capturePayload();

    if (payload.window && payload.imageSize) {
      const parked = await parkTalkToFigmaOverlayIfPresent({
        window: payload.window,
        imageSize: payload.imageSize,
        results: payload.results
      });
      if (parked.moved) {
        payload = await capturePayload();
      }

      if (payload.window && payload.imageSize) {
        const cleared = await clearActiveAssetsSearchIfNeeded({
          window: payload.window,
          imageSize: payload.imageSize,
          results: payload.results
        });
        if (cleared) {
          payload = await capturePayload();
        }
      }
    }

    const libraries = extractVisibleLibraries(payload);
    return {
      count: libraries.length,
      libraries,
      image: payload.image
    };
  } finally {
    await unlink(capturePath).catch(() => undefined);
  }
}
