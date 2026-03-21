import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  activateDesktopApp,
  captureAppWindow,
  clickPoint,
  dragBetween,
  ocrImage,
  readImageSize,
  replaceFocusedText,
  sleep,
  type DesktopBox,
  type DesktopAgentOcrResult,
  type DesktopAgentWindow,
  type DesktopPoint
} from "./desktop-agent.js";
import {
  canonicalizeFigmaAssetsText,
  normalizeFigmaAssetsText
} from "./figma-assets-text.js";
import { parkTalkToFigmaOverlayIfPresent } from "./figma-plugin-overlay.js";

const ASSETS_TAB_BOUNDS = {
  minX: 0,
  maxX: 220,
  minY: 160,
  maxY: 320
} as const;

const SEARCH_FIELD_POINT = {
  x: 42,
  y: 199
} as const;

const SEARCH_RESULTS_TOP_Y = 560;
const SEARCH_RESULTS_TOP_PT = 250;
const SEARCH_RESULTS_MAX_X = 560;
const CANVAS_LEFT_GUTTER = 410;
const CANVAS_RIGHT_GUTTER = 320;
const CANVAS_TOP_GUTTER = 260;
const CANVAS_BOTTOM_GUTTER = 260;
const RESULT_PREVIEW_LIFT_PX = 72;
const SEARCH_FIELD_MIN_Y = 380;
const SEARCH_FIELD_MAX_Y = 540;
const SEARCH_FIELD_MAX_X = 520;
const INSERT_INSTANCE_LABEL = "Insert instance";

function debugStep(message: string): void {
  if (process.env.FIGMA_CONTROL_DEBUG === "1") {
    console.log(`[figma-assets-workflow] ${message}`);
  }
}

export type FigmaAssetsSearchMatch = {
  text: string;
  normalizedText: string;
  canonicalText: string;
  confidence?: number;
  match?: {
    score?: number;
    mode?: string;
  };
  localCenterPx?: DesktopPoint;
  localCenterPt?: DesktopPoint;
  localBoxPx?: DesktopBox;
  absoluteCenterPt?: DesktopPoint;
  dragStartPt?: DesktopPoint;
};

export type FigmaAssetsSearchResult = {
  query: string;
  image?: string;
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  searchFieldPt: DesktopPoint;
  dropTargetPt: DesktopPoint;
  count: number;
  matches: FigmaAssetsSearchMatch[];
};

type SearchFieldFocus = {
  clickPoint: DesktopPoint;
  clickPoints: DesktopPoint[];
  placeholderVisible: boolean;
  rawText?: string;
  visibleText?: string;
};

function isAssetsTabResult(result: DesktopAgentOcrResult): boolean {
  const center = result.center_px;
  return Boolean(
    center
    && center.x >= ASSETS_TAB_BOUNDS.minX
    && center.x <= ASSETS_TAB_BOUNDS.maxX
    && center.y >= ASSETS_TAB_BOUNDS.minY
    && center.y <= ASSETS_TAB_BOUNDS.maxY
  );
}

function isSearchResultResult(result: DesktopAgentOcrResult): boolean {
  const centerPx = result.center_px;
  return Boolean(centerPx && centerPx.x <= SEARCH_RESULTS_MAX_X && centerPx.y >= SEARCH_RESULTS_TOP_Y);
}

function toAbsolute(window: DesktopAgentWindow, point: DesktopPoint): DesktopPoint {
  return {
    x: window.x + point.x,
    y: window.y + point.y
  };
}

function pixelToWindowPoint(window: DesktopAgentWindow, imageSize: { width: number; height: number }, point: DesktopPoint | undefined): DesktopPoint | undefined {
  if (!point) {
    return undefined;
  }
  return {
    x: (point.x / imageSize.width) * window.w,
    y: (point.y / imageSize.height) * window.h
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toAbsoluteFromPixels(
  window: DesktopAgentWindow,
  imageSize: { width: number; height: number },
  point: DesktopPoint | undefined
): DesktopPoint | undefined {
  const local = pixelToWindowPoint(window, imageSize, point);
  return local ? toAbsolute(window, local) : undefined;
}

function computeSearchFieldPoint(window: DesktopAgentWindow): DesktopPoint {
  return {
    x: window.x + SEARCH_FIELD_POINT.x,
    y: window.y + SEARCH_FIELD_POINT.y
  };
}

function dedupeDesktopPoints(points: DesktopPoint[]): DesktopPoint[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildSearchFieldClickPoints(payload: {
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  candidate?: DesktopAgentOcrResult;
}): DesktopPoint[] {
  const fallback = computeSearchFieldPoint(payload.window);
  if (!payload.candidate?.bbox_px) {
    return [fallback];
  }

  const { x, y, width, height } = payload.candidate.bbox_px;
  const midY = y + (height / 2);
  const interiorRightPx = x + Math.max(24, width - 56);
  const candidatesPx: DesktopPoint[] = [
    {
      x: x + Math.min(40, width * 0.2),
      y: midY
    },
    {
      x: x + Math.max(24, width * 0.45),
      y: midY
    },
    {
      x: interiorRightPx,
      y: midY
    },
    {
      x: x + Math.min(20, width * 0.1),
      y: y + Math.max(12, height * 0.35)
    }
  ];

  const absoluteCandidates = candidatesPx
    .map((candidate) => pixelToWindowPoint(payload.window, payload.imageSize, candidate))
    .filter((candidate): candidate is DesktopPoint => Boolean(candidate))
    .map((candidate) => toAbsolute(payload.window, candidate));

  return dedupeDesktopPoints([fallback, ...absoluteCandidates]);
}

function detectSearchFieldPoint(payload: {
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  results: DesktopAgentOcrResult[];
}): SearchFieldFocus | undefined {
  const candidate = payload.results
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
    .sort((left, right) => {
      const leftScore = scoreSearchFieldCandidate(left);
      const rightScore = scoreSearchFieldCandidate(right);
      return rightScore - leftScore;
    })[0];

  if (!candidate?.center_px) {
    return undefined;
  }

  const localPt = pixelToWindowPoint(payload.window, payload.imageSize, candidate.center_px);
  if (!localPt) {
    return undefined;
  }

  const clickPoints = buildSearchFieldClickPoints({
    window: payload.window,
    imageSize: payload.imageSize,
    candidate
  });
  const clickPoint = clickPoints[0] ?? toAbsolute(payload.window, localPt);

  return {
    clickPoint: normalizeSearchFieldText(candidate.text).includes("Search all libraries")
      ? computeSearchFieldPoint(payload.window)
      : clickPoint,
    clickPoints,
    placeholderVisible: normalizeSearchFieldText(candidate.text).includes("Search all libraries"),
    rawText: candidate.text,
    visibleText: normalizeSearchFieldText(candidate.text)
  };
}

function normalizeSearchFieldText(text: string | undefined): string {
  return (text ?? "")
    .replace(/^[•QO0]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeUiText(text: string | undefined): string {
  return (text ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function findWindowTextResult(
  results: DesktopAgentOcrResult[] | undefined,
  text: string
): DesktopAgentOcrResult | undefined {
  const normalized = normalizeUiText(text);
  return (results ?? []).find((result) => normalizeUiText(result.text) === normalized)
    ?? (results ?? []).find((result) => normalizeUiText(result.text).includes(normalized));
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

export function searchFieldContainsQuery(payload: {
  results?: DesktopAgentOcrResult[];
}, query: string): boolean {
  const normalizedQuery = normalizeSearchFieldText(query).toLowerCase();
  return (payload.results ?? []).some((result) => {
    const center = result.center_px;
    if (!center) {
      return false;
    }
    if (center.x > SEARCH_FIELD_MAX_X || center.y < SEARCH_FIELD_MIN_Y || center.y > SEARCH_FIELD_MAX_Y) {
      return false;
    }
    return normalizeSearchFieldText(result.text).toLowerCase().includes(normalizedQuery);
  });
}

async function ensureFigmaFrontmost(): Promise<void> {
  debugStep("ensureFigmaFrontmost activate");
  await activateDesktopApp("Figma");
  await sleep(180);
}

export function computeCanvasDropPoint(window: DesktopAgentWindow): DesktopPoint {
  const localX = clamp(Math.round(window.w * 0.58), CANVAS_LEFT_GUTTER, Math.max(CANVAS_LEFT_GUTTER, window.w - CANVAS_RIGHT_GUTTER));
  const localY = clamp(Math.round(window.h * 0.38), CANVAS_TOP_GUTTER, Math.max(CANVAS_TOP_GUTTER, window.h - CANVAS_BOTTOM_GUTTER));
  return {
    x: window.x + localX,
    y: window.y + localY
  };
}

export function computeAssetDragStart(
  result: DesktopAgentOcrResult,
  window: DesktopAgentWindow,
  imageSize: { width: number; height: number }
): DesktopPoint | undefined {
  const localCenter = pixelToWindowPoint(window, imageSize, result.center_px);
  const center = localCenter ? toAbsolute(window, localCenter) : undefined;
  if (!center) {
    return undefined;
  }

  const localY = Math.max(SEARCH_RESULTS_TOP_PT + 18, Math.round((localCenter?.y ?? SEARCH_RESULTS_TOP_PT) - RESULT_PREVIEW_LIFT_PX));

  return {
    x: center.x,
    y: window.y + localY
  };
}

export function extractAssetSearchMatches(payload: {
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  results?: DesktopAgentOcrResult[];
  query?: string;
}): FigmaAssetsSearchMatch[] {
  const allMatches = (payload.results ?? [])
    .filter(isSearchResultResult)
    .map((result) => {
      const localCenterPt = pixelToWindowPoint(payload.window, payload.imageSize, result.center_px);
      return {
        text: result.text,
        normalizedText: normalizeFigmaAssetsText(result.text),
        canonicalText: canonicalizeFigmaAssetsText(result.text),
        confidence: result.confidence,
        match: result.match,
        localCenterPx: result.center_px,
        localCenterPt,
        localBoxPx: result.bbox_px,
        absoluteCenterPt: localCenterPt ? toAbsolute(payload.window, localCenterPt) : undefined,
        dragStartPt: computeAssetDragStart(result, payload.window, payload.imageSize)
      };
    });

  const canonicalQuery = canonicalizeFigmaAssetsText(payload.query);
  if (!canonicalQuery) {
    return allMatches;
  }

  const queryMatches = allMatches.filter((result) => result.canonicalText.includes(canonicalQuery));
  if (queryMatches.length === 0) {
    return allMatches;
  }

  return queryMatches;
}

async function captureWindowWithOcr(options: {
  title?: string;
  query?: string;
  limit?: number;
}): Promise<{
  image?: string;
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  results: DesktopAgentOcrResult[];
}> {
  const capturePath = resolve(tmpdir(), `figma-assets-search-${Date.now().toString(36)}.png`);
  try {
    debugStep(`captureWindowWithOcr start title=${options.title ?? "<front>"} query=${options.query ?? "<none>"} limit=${options.limit ?? 30}`);
    const capture = await captureAppWindow({
      app: "Figma",
      title: options.title,
      outputPath: capturePath
    });
    if (!capture.target) {
      throw new Error("Figma window capture did not return target geometry");
    }

    const payload = await ocrImage({
      path: capturePath,
      query: options.query,
      limit: options.limit ?? 30
    });
    const imageSize = await readImageSize(capturePath);
    debugStep(`captureWindowWithOcr done results=${payload.results?.length ?? 0}`);

    const parked = await parkTalkToFigmaOverlayIfPresent({
      window: capture.target,
      imageSize,
      results: payload.results
    });
    if (parked.moved) {
      debugStep("captureWindowWithOcr overlay parked; recapturing");
      const recapture = await captureAppWindow({
        app: "Figma",
        title: options.title,
        outputPath: capturePath
      });
      if (!recapture.target) {
        throw new Error("Figma window recapture did not return target geometry");
      }
      const refreshed = await ocrImage({
        path: capturePath,
        query: options.query,
        limit: options.limit ?? 30
      });
      return {
        image: refreshed.image,
        window: recapture.target,
        imageSize,
        results: refreshed.results ?? []
      };
    }

    return {
      image: payload.image,
      window: capture.target,
      imageSize,
      results: payload.results ?? []
    };
  } finally {
    await unlink(capturePath).catch(() => undefined);
  }
}

async function activateAssetsTab(windowTitle?: string): Promise<{
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  results: DesktopAgentOcrResult[];
}> {
  debugStep("activateAssetsTab start");
  await ensureFigmaFrontmost();
  const payload = await captureWindowWithOcr({ title: windowTitle, limit: 120 });
  const assetsTab = payload.results.find((result) => result.text === "Assets" && isAssetsTabResult(result));
  const fallbackPoint = {
    x: payload.window.x + 106,
    y: payload.window.y + 220
  };
  const assetsTabLocalPt = pixelToWindowPoint(payload.window, payload.imageSize, assetsTab?.center_px);

  await clickPoint(assetsTabLocalPt ? toAbsolute(payload.window, assetsTabLocalPt) : fallbackPoint);
  await sleep(180);
  debugStep("activateAssetsTab clicked via point fallback");
  return captureWindowWithOcr({ title: windowTitle, limit: 120 });
}

async function focusSearchField(payload: {
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  results: DesktopAgentOcrResult[];
}, attempt = 0): Promise<SearchFieldFocus> {
  const detected = detectSearchFieldPoint(payload);
  const focus = detected ?? {
    clickPoint: computeSearchFieldPoint(payload.window),
    clickPoints: [computeSearchFieldPoint(payload.window)],
    placeholderVisible: false
  };
  const clickPoints = focus.clickPoints.length > 0 ? focus.clickPoints : [focus.clickPoint];
  const selectedPoint = clickPoints[Math.min(attempt, clickPoints.length - 1)] ?? focus.clickPoint;
  await ensureFigmaFrontmost();
  debugStep(`focusSearchField attempt=${attempt + 1} clickPoint x=${Math.round(selectedPoint.x)} y=${Math.round(selectedPoint.y)} candidates=${clickPoints.length}`);
  await clickPoint(selectedPoint);
  await sleep(90);
  await clickPoint(selectedPoint);
  await sleep(140);
  return {
    ...focus,
    clickPoint: selectedPoint
  };
}

async function pasteQuery(query: string, focus: SearchFieldFocus): Promise<void> {
  if (!query) {
    return;
  }

  await ensureFigmaFrontmost();
  if (focus.placeholderVisible) {
    debugStep(`pasteQuery placeholder replaceFocusedText query=${query}`);
  } else {
    debugStep(`pasteQuery replaceFocusedText query=${query}`);
  }
  await replaceFocusedText(query);
}

async function applySearchQuery(options: {
  query: string;
  windowTitle?: string;
  settleMs?: number;
  limit?: number;
}): Promise<{
  searchField: SearchFieldFocus;
  verification: {
    image?: string;
    window: DesktopAgentWindow;
    imageSize: {
      width: number;
      height: number;
    };
    results: DesktopAgentOcrResult[];
  };
}> {
  let lastFocus: SearchFieldFocus | undefined;
  let lastVerification: Awaited<ReturnType<typeof captureWindowWithOcr>> | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    debugStep(`applySearchQuery attempt=${attempt + 1}`);
    await ensureFigmaFrontmost();
    const activated = await activateAssetsTab(options.windowTitle);
    const focus = await focusSearchField(activated, attempt);
    await pasteQuery(options.query, focus);
    await sleep(options.settleMs ?? 520);

    const verification = await captureWindowWithOcr({
      title: options.windowTitle,
      limit: Math.max(options.limit ?? 40, 120)
    });
    debugStep(`applySearchQuery verificationResults=${verification.results.length}`);
    if (searchFieldContainsQuery(verification, options.query)) {
      debugStep("applySearchQuery verified");
      return {
        searchField: focus,
        verification
      };
    }

    lastFocus = focus;
    lastVerification = verification;
  }

  throw new Error(`Failed to focus the Figma Assets search field and apply query "${options.query}" after 3 attempts${lastFocus ? ` (last click at ${Math.round(lastFocus.clickPoint.x)}, ${Math.round(lastFocus.clickPoint.y)})` : ""}${lastVerification?.image ? `; latest capture: ${lastVerification.image}` : ""}`);
}

export async function searchFigmaAssetsPanel(options: {
  query: string;
  activateApp?: boolean;
  windowTitle?: string;
  limit?: number;
  settleMs?: number;
}): Promise<FigmaAssetsSearchResult> {
  if (options.activateApp !== false) {
    debugStep("searchFigmaAssetsPanel activateApp");
    await activateDesktopApp("Figma");
    await sleep(280);
  }
  await ensureFigmaFrontmost();
  const applied = await applySearchQuery({
    query: options.query,
    windowTitle: options.windowTitle,
    settleMs: options.settleMs,
    limit: options.limit
  });
  debugStep(`searchFigmaAssetsPanel verifiedAt x=${Math.round(applied.searchField.clickPoint.x)} y=${Math.round(applied.searchField.clickPoint.y)}`);

  const matches = extractAssetSearchMatches({
    window: applied.verification.window,
    imageSize: applied.verification.imageSize,
    results: applied.verification.results,
    query: options.query
  });
  debugStep(`searchFigmaAssetsPanel finalMatches=${matches.length}`);

  return {
    query: options.query,
    image: applied.verification.image,
    window: applied.verification.window,
    imageSize: applied.verification.imageSize,
    searchFieldPt: applied.searchField.clickPoint,
    dropTargetPt: computeCanvasDropPoint(applied.verification.window),
    count: matches.length,
    matches
  };
}

export async function insertFigmaAssetFromPanel(options: {
  query: string;
  activateApp?: boolean;
  windowTitle?: string;
  resultIndex?: number;
  limit?: number;
  settleMs?: number;
  holdMs?: number;
  releaseMs?: number;
  dryRun?: boolean;
}): Promise<{
  query: string;
  resultIndex: number;
  dryRun: boolean;
  inserted: boolean;
  strategy: "button" | "drag" | "dry-run";
  image?: string;
  window: DesktopAgentWindow;
  match: FigmaAssetsSearchMatch;
  from: DesktopPoint;
  to: DesktopPoint;
}> {
  const search = await searchFigmaAssetsPanel(options);
  const resultIndex = options.resultIndex ?? 0;
  const match = search.matches[resultIndex];
  if (!match) {
    throw new Error(`No asset search result matched "${options.query}" at index ${resultIndex}`);
  }
  if (!match.dragStartPt) {
    throw new Error(`Matched asset "${match.text}" does not expose a drag start point`);
  }

  const from = match.absoluteCenterPt ?? match.dragStartPt;
  let to = search.dropTargetPt;
  let strategy: "button" | "drag" | "dry-run" = options.dryRun ? "dry-run" : "drag";

  if (!options.dryRun) {
    if (match.absoluteCenterPt) {
      await clickPoint(match.absoluteCenterPt);
      await sleep(220);

      const detailCapture = await captureWindowWithOcr({
        title: options.windowTitle,
        query: INSERT_INSTANCE_LABEL,
        limit: 40
      });
      const insertButton = findWindowTextResult(detailCapture.results, INSERT_INSTANCE_LABEL);
      const insertButtonPoint = toAbsoluteFromPixels(
        detailCapture.window,
        detailCapture.imageSize,
        insertButton?.center_px
      );

      if (insertButtonPoint) {
        await clickPoint(insertButtonPoint);
        await sleep(420);
        to = insertButtonPoint;
        strategy = "button";
      } else {
        await dragBetween({
          from: match.dragStartPt,
          to: search.dropTargetPt,
          holdMs: options.holdMs,
          releaseMs: options.releaseMs
        });
        await sleep(380);
      }
    } else {
      await dragBetween({
        from: match.dragStartPt,
        to: search.dropTargetPt,
        holdMs: options.holdMs,
        releaseMs: options.releaseMs
      });
      await sleep(380);
    }
  }

  return {
    query: options.query,
    resultIndex,
    dryRun: options.dryRun ?? false,
    inserted: !options.dryRun,
    strategy,
    image: search.image,
    window: search.window,
    match,
    from,
    to
  };
}
