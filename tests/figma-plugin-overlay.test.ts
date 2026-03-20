import { describe, expect, it } from "vitest";

import { computeOverlayParkPoint, detectTalkToFigmaOverlay } from "../src/figma-plugin-overlay.js";

describe("figma-plugin-overlay", () => {
  it("detects the talk-to-figma overlay when plugin title and status text are visible", () => {
    const overlay = detectTalkToFigmaOverlay({
      results: [
        {
          text: "Cursor MCP Plugin",
          center_px: { x: 319, y: 606 },
          bbox_px: { x: 215, y: 593, width: 206, height: 26 }
        },
        {
          text: "Talk To Figma MCP Plugin",
          center_px: { x: 398, y: 702 },
          bbox_px: { x: 202, y: 685, width: 391, height: 35 }
        },
        {
          text: "Disconnect",
          center_px: { x: 477, y: 940 },
          bbox_px: { x: 404, y: 926, width: 145, height: 26 }
        },
        {
          text: "Connected to server in channel:",
          center_px: { x: 411, y: 1238 },
          bbox_px: { x: 202, y: 1225, width: 418, height: 26 }
        }
      ]
    });

    expect(overlay).toEqual({
      title: "Cursor MCP Plugin",
      boundsPx: { x: 202, y: 593, width: 418, height: 658 },
      titleBarCenterPx: { x: 318, y: 606 },
      obstructsAssetsPanel: true,
      matchedTexts: [
        "Cursor MCP Plugin",
        "Talk To Figma MCP Plugin",
        "Disconnect",
        "Connected to server in channel:"
      ]
    });
  });

  it("computes a parking point inside the canvas area", () => {
    expect(computeOverlayParkPoint({
      x: 1353,
      y: 338,
      w: 1400,
      h: 900
    })).toEqual({
      x: 2011,
      y: 458
    });
  });
});
