import { describe, expect, it } from "vitest";

import {
  canonicalizeFigmaAssetsText,
  normalizeVisibleLibraryDetail,
  normalizeVisibleLibraryName
} from "../src/figma-assets-text.js";

describe("figma-assets-text", () => {
  it("normalizes visible library names conservatively", () => {
    expect(normalizeVisibleLibraryName("ios and iPados 26 0")).toBe("iOS and iPadOS 26");
    expect(normalizeVisibleLibraryName("macOS 26 ตำ")).toBe("macOS 26");
  });

  it("normalizes detail labels", () => {
    expect(normalizeVisibleLibraryDetail("1 component")).toBe("1 components");
    expect(normalizeVisibleLibraryDetail("3 icon")).toBe("3 icons");
  });

  it("canonicalizes OCR text for matching", () => {
    expect(canonicalizeFigmaAssetsText("Toolbar - Top ...")).toBe("toolbar top");
  });
});
