import { describe, expect, it } from "vitest";

import { detectVisibleAssetsSearchField, extractVisibleLibraries } from "../src/figma-assets-panel.js";

describe("extractVisibleLibraries", () => {
  it("extracts visible library cards from OCR payload", () => {
    const libraries = extractVisibleLibraries({
      results: [
        {
          text: "Assets",
          center_px: { x: 140, y: 310 }
        },
        {
          text: "Daily UI Challenge (Community)",
          center_px: { x: 200, y: 776 }
        },
        {
          text: "2 components",
          center_px: { x: 110, y: 808 }
        },
        {
          text: "Phosphor Icons (Community)",
          center_px: { x: 190, y: 1467 }
        },
        {
          text: "1512 components",
          center_px: { x: 126, y: 1499 }
        }
      ]
    });

    expect(libraries).toEqual([
      {
        name: "Daily UI Challenge (Community)",
        normalizedName: "Daily UI Challenge (Community)",
        canonicalName: "daily ui challenge community",
        detail: "2 components",
        normalizedDetail: "2 components",
        centerPx: { x: 200, y: 776 },
        detailCenterPx: { x: 110, y: 808 }
      },
      {
        name: "Phosphor Icons (Community)",
        normalizedName: "Phosphor Icons (Community)",
        canonicalName: "phosphor icons community",
        detail: "1512 components",
        normalizedDetail: "1512 components",
        centerPx: { x: 190, y: 1467 },
        detailCenterPx: { x: 126, y: 1499 }
      }
    ]);
  });

  it("detects when the visible assets search field still contains a query", () => {
    const searchField = detectVisibleAssetsSearchField({
      results: [
        {
          text: "Assets",
          center_px: { x: 240, y: 388 }
        },
        {
          text: "Q Toolbar",
          center_px: { x: 215, y: 476 },
          bbox_px: { x: 154, y: 461, width: 123, height: 31 }
        }
      ]
    });

    expect(searchField).toEqual({
      placeholderVisible: false,
      rawText: "Q Toolbar",
      visibleText: "Toolbar",
      clickPointPx: { x: 178.6, y: 476.5 }
    });
  });

  it("recognizes the empty libraries search placeholder", () => {
    const searchField = detectVisibleAssetsSearchField({
      results: [
        {
          text: "Q Search all libraries",
          center_px: { x: 238, y: 478 },
          bbox_px: { x: 150, y: 463, width: 176, height: 30 }
        }
      ]
    });

    expect(searchField).toEqual({
      placeholderVisible: true,
      rawText: "Q Search all libraries",
      visibleText: "Search all libraries",
      clickPointPx: { x: 185.2, y: 478 }
    });
  });
});
