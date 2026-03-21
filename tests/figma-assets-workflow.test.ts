import { describe, expect, it } from "vitest";

import {
  buildSearchFieldClickPoints,
  computeCanvasDropPoint,
  extractAssetSearchMatches,
  searchFieldContainsQuery
} from "../src/figma-assets-workflow.js";

describe("figma-assets-workflow", () => {
  it("keeps canvas drop point inside the likely editable canvas area", () => {
    const point = computeCanvasDropPoint({
      x: 1326,
      y: 540,
      w: 1400,
      h: 900
    });

    expect(point).toEqual({
      x: 2138,
      y: 882
    });
  });

  it("extracts drag-ready search matches and skips the search field row", () => {
    const matches = extractAssetSearchMatches({
      window: {
        x: 1326,
        y: 540,
        w: 1400,
        h: 900
      },
      imageSize: {
        width: 3024,
        height: 2024
      },
      results: [
        {
          text: "Button",
          center_px: { x: 190, y: 398 },
          bbox_px: { x: 120, y: 384, width: 140, height: 28 },
          match: { score: 1, mode: "exact" }
        },
        {
          text: "radio button",
          center_px: { x: 212, y: 611 },
          bbox_px: { x: 150, y: 596, width: 124, height: 30 },
          match: { score: 0.97, mode: "contains" }
        }
      ]
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("radio button");
    expect(matches[0]?.absoluteCenterPt?.x).toBeCloseTo(1424.15, 2);
    expect(matches[0]?.absoluteCenterPt?.y).toBeCloseTo(811.69, 2);
    expect(matches[0]?.dragStartPt?.x).toBeCloseTo(1424.15, 2);
    expect(matches[0]?.dragStartPt?.y).toBe(808);
  });

  it("detects when the search field already contains the requested query", () => {
    expect(searchFieldContainsQuery({
      results: [
        {
          text: "Search all libraries",
          center_px: { x: 210, y: 450 }
        },
        {
          text: "Toolbar",
          center_px: { x: 182, y: 448 },
          bbox_px: { x: 128, y: 434, width: 108, height: 24 }
        },
        {
          text: "Toolbar - iPad",
          center_px: { x: 210, y: 640 }
        }
      ]
    }, "Toolbar")).toBe(true);
  });

  it("ignores matching text outside the search field band", () => {
    expect(searchFieldContainsQuery({
      results: [
        {
          text: "Toolbar - iPad",
          center_px: { x: 220, y: 640 }
        }
      ]
    }, "Toolbar")).toBe(false);
  });

  it("builds multiple in-field search click candidates before falling back", () => {
    const points = buildSearchFieldClickPoints({
      window: {
        x: 669,
        y: 198,
        w: 1400,
        h: 900
      },
      imageSize: {
        width: 3024,
        height: 2024
      },
      candidate: {
        text: "Q HomeNavigationTab Bar",
        bbox_px: {
          x: 153.837,
          y: 460.998,
          width: 294.488,
          height: 31.002
        },
        center_px: {
          x: 301.081,
          y: 476.499
        }
      }
    });

    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({
      x: 711,
      y: 397
    });
    expect(points[1]?.x).toBeGreaterThan(points[0]?.x ?? 0);
    expect(points[2]?.x).toBeGreaterThan(points[1]?.x ?? 0);
    expect(points[4]).not.toEqual(points[0]);
  });
});
