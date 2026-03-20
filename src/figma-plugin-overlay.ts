import {
  dragBetween,
  sleep,
  type DesktopAgentOcrResult,
  type DesktopAgentWindow,
  type DesktopBox,
  type DesktopPoint
} from "./desktop-agent.js";

const OVERLAY_TITLE_PATTERNS = [
  /^Cursor MCP Plugin$/i,
  /^Talk To Figma MCP Plugin$/i
];

const OVERLAY_CONTEXT_PATTERNS = [
  /^Talk To Figma MCP Plugin$/i,
  /^Connection$/i,
  /^About$/i,
  /^Disconnect$/i,
  /^WebSocket Server Port$/i,
  /^Connected to server in channel:/i,
  /^MCP Configuration$/i
];

const OVERLAY_SAFE_MIN_X = 360;

export type FigmaPluginOverlay = {
  title: string;
  boundsPx: DesktopBox;
  titleBarCenterPx: DesktopPoint;
  obstructsAssetsPanel: boolean;
  matchedTexts: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function matchesAnyPattern(text: string | undefined, patterns: RegExp[]): boolean {
  const normalized = text?.trim();
  return Boolean(normalized && patterns.some((pattern) => pattern.test(normalized)));
}

function toBoundingBox(result: DesktopAgentOcrResult): DesktopBox | undefined {
  if (result.bbox_px) {
    return result.bbox_px;
  }
  if (!result.center_px) {
    return undefined;
  }
  return {
    x: result.center_px.x - 20,
    y: result.center_px.y - 12,
    width: 40,
    height: 24
  };
}

function unionBoxes(boxes: DesktopBox[]): DesktopBox {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function pixelToWindowPoint(
  window: DesktopAgentWindow,
  imageSize: { width: number; height: number },
  point: DesktopPoint
): DesktopPoint {
  return {
    x: (point.x / imageSize.width) * window.w,
    y: (point.y / imageSize.height) * window.h
  };
}

function toAbsolutePoint(
  window: DesktopAgentWindow,
  imageSize: { width: number; height: number },
  pointPx: DesktopPoint
): DesktopPoint {
  const local = pixelToWindowPoint(window, imageSize, pointPx);
  return {
    x: window.x + local.x,
    y: window.y + local.y
  };
}

export function detectTalkToFigmaOverlay(payload: {
  results?: DesktopAgentOcrResult[];
}): FigmaPluginOverlay | undefined {
  const results = payload.results ?? [];
  const titleEntry = results.find((result) => matchesAnyPattern(result.text, OVERLAY_TITLE_PATTERNS));
  if (!titleEntry?.center_px) {
    return undefined;
  }

  const titleBox = toBoundingBox(titleEntry);
  if (!titleBox) {
    return undefined;
  }

  const companionBoxes = results
    .filter((result) => {
      if (!result.center_px) {
        return false;
      }
      if (!matchesAnyPattern(result.text, OVERLAY_CONTEXT_PATTERNS)) {
        return false;
      }
      return Math.abs(result.center_px.x - titleEntry.center_px!.x) < 420
        && result.center_px.y >= titleBox.y - 80
        && result.center_px.y <= titleBox.y + 1500;
    })
    .map(toBoundingBox)
    .filter((box): box is DesktopBox => Boolean(box));

  if (companionBoxes.length === 0) {
    return undefined;
  }

  const bounds = unionBoxes([titleBox, ...companionBoxes]);

  return {
    title: titleEntry.text.trim(),
    boundsPx: bounds,
    titleBarCenterPx: {
      x: titleBox.x + titleBox.width / 2,
      y: titleBox.y + titleBox.height / 2
    },
    obstructsAssetsPanel: bounds.x < OVERLAY_SAFE_MIN_X,
    matchedTexts: [titleEntry.text, ...results
      .filter((result) => result !== titleEntry && matchesAnyPattern(result.text, OVERLAY_CONTEXT_PATTERNS))
      .map((result) => result.text)
      .filter((text): text is string => Boolean(text))]
  };
}

export function computeOverlayParkPoint(window: DesktopAgentWindow): DesktopPoint {
  const localX = clamp(Math.round(window.w * 0.47), 520, Math.max(520, window.w - 360));
  const localY = clamp(120, 110, Math.max(110, window.h - 120));
  return {
    x: window.x + localX,
    y: window.y + localY
  };
}

export async function parkTalkToFigmaOverlayIfPresent(options: {
  window: DesktopAgentWindow;
  imageSize: {
    width: number;
    height: number;
  };
  results?: DesktopAgentOcrResult[];
  holdMs?: number;
  releaseMs?: number;
  settleMs?: number;
  force?: boolean;
}): Promise<{
  moved: boolean;
  overlay?: FigmaPluginOverlay;
  from?: DesktopPoint;
  to?: DesktopPoint;
}> {
  const overlay = detectTalkToFigmaOverlay({ results: options.results });
  if (!overlay) {
    return { moved: false };
  }

  if (!options.force && !overlay.obstructsAssetsPanel) {
    return { moved: false, overlay };
  }

  const from = toAbsolutePoint(options.window, options.imageSize, overlay.titleBarCenterPx);
  const to = computeOverlayParkPoint(options.window);

  await dragBetween({
    from,
    to,
    holdMs: options.holdMs,
    releaseMs: options.releaseMs
  });
  await sleep(options.settleMs ?? 260);

  return {
    moved: true,
    overlay,
    from,
    to
  };
}
