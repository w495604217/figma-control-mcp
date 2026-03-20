import { describe, expect, it } from "vitest";

import {
  LibraryIndex,
  createEmptyImportReport,
  recordAttempt,
} from "../src/library-index.js";

import type { FigmaComponentSummary } from "../src/schemas.js";
import type { FigmaPublishedComponentResult } from "../src/figma-rest.js";

function makeComponent(overrides: Partial<FigmaComponentSummary> = {}): FigmaComponentSummary {
  return {
    id: "1:1",
    name: "Button",
    ...overrides,
  };
}

function makeRestResult(overrides: Partial<FigmaPublishedComponentResult> = {}): FigmaPublishedComponentResult {
  return {
    source: "rest",
    kind: "component",
    key: "abc123",
    fileKey: "file-key",
    nodeId: "1:1",
    name: "Button",
    ...overrides,
  };
}

describe("LibraryIndex", () => {
  describe("addFromLiveSession", () => {
    it("populates entries from session components", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("session-1", [
        makeComponent({ id: "1:1", key: "key-1", name: "Button" }),
        makeComponent({ id: "1:2", key: "key-2", name: "Card" }),
      ], "file-key");

      expect(index.size).toBe(2);
    });

    it("stores source provenance as live-session", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("session-1", [
        makeComponent({ id: "1:1", key: "key-1", name: "Button" }),
      ]);

      const results = index.search("Button");
      expect(results).toHaveLength(1);
      expect(results[0]?.source).toBe("live-session");
      expect(results[0]?.sourceSessionId).toBe("session-1");
    });
  });

  describe("addFromRest", () => {
    it("populates entries from REST API results", () => {
      const index = new LibraryIndex();
      index.addFromRest([
        makeRestResult({ key: "rest-1", name: "Toolbar" }),
        makeRestResult({ key: "rest-2", name: "Nav Bar" }),
      ]);

      expect(index.size).toBe(2);
    });

    it("stores source provenance as rest-api", () => {
      const index = new LibraryIndex();
      index.addFromRest([
        makeRestResult({ key: "rest-1", name: "Toolbar" }),
      ]);

      const results = index.search("Toolbar");
      expect(results).toHaveLength(1);
      expect(results[0]?.source).toBe("rest-api");
    });
  });

  describe("search", () => {
    it("ranks exact match above starts-with and contains", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("s1", [
        makeComponent({ id: "1:1", key: "k1", name: "Button" }),
        makeComponent({ id: "1:2", key: "k2", name: "Button / Primary" }),
        makeComponent({ id: "1:3", key: "k3", name: "Radio Button" }),
      ]);

      const results = index.search("Button");
      expect(results).toHaveLength(3);
      expect(results[0]?.name).toBe("Button");
      expect(results[1]?.name).toBe("Button / Primary");
      expect(results[2]?.name).toBe("Radio Button");
    });

    it("returns empty when no matches found", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("s1", [
        makeComponent({ id: "1:1", name: "Button" }),
      ]);

      const results = index.search("Nonexistent");
      expect(results).toHaveLength(0);
    });

    it("returns all entries when query is empty", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("s1", [
        makeComponent({ id: "1:1", name: "A" }),
        makeComponent({ id: "1:2", name: "B" }),
      ]);

      const results = index.search("");
      expect(results).toHaveLength(2);
    });

    it("boosts entries with published keys", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("s1", [
        makeComponent({ id: "1:1", name: "Button" }),
        makeComponent({ id: "1:2", key: "published-key", name: "Button" }),
      ]);

      const results = index.search("Button");
      // The entry with key should rank higher
      expect(results[0]?.key).toBe("published-key");
    });

    it("respects the limit parameter", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("s1", [
        makeComponent({ id: "1:1", name: "Button A" }),
        makeComponent({ id: "1:2", name: "Button B" }),
        makeComponent({ id: "1:3", name: "Button C" }),
      ]);

      const results = index.search("Button", 2);
      expect(results).toHaveLength(2);
    });
  });

  describe("getByKey", () => {
    it("retrieves an entry by its component key", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("s1", [
        makeComponent({ id: "1:1", key: "my-key", name: "Button" }),
      ]);

      const entry = index.getByKey("my-key");
      expect(entry).toBeDefined();
      expect(entry?.name).toBe("Button");
    });

    it("returns undefined for unknown keys", () => {
      const index = new LibraryIndex();
      expect(index.getByKey("nonexistent")).toBeUndefined();
    });
  });

  describe("rankStrategies", () => {
    it("returns runtime-first when component is in the target session", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("session-target", [
        makeComponent({ id: "1:1", key: "k1", name: "Button" }),
      ]);

      const entry = index.search("Button")[0]!;
      const strategies = index.rankStrategies(entry, "session-target");
      expect(strategies).toEqual(["runtime", "published-key", "desktop-panel"]);
    });

    it("skips runtime when component is in a different session", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("session-source", [
        makeComponent({ id: "1:1", key: "k1", name: "Button" }),
      ]);

      const entry = index.search("Button")[0]!;
      const strategies = index.rankStrategies(entry, "session-target");
      expect(strategies).toEqual(["published-key", "desktop-panel"]);
    });

    it("returns only desktop-panel when no key and no local id", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("session-source", [
        makeComponent({ id: "1:1", name: "Button" }),
      ]);

      const entry = index.search("Button")[0]!;
      // Different session, no key
      const strategies = index.rankStrategies(entry, "session-target");
      expect(strategies).toEqual(["desktop-panel"]);
    });

    it("excludes component_set from runtime and published-key strategies", () => {
      const index = new LibraryIndex();
      // Insert a component_set via REST (the only source that reports kind explicitly)
      index.addFromRest([
        makeRestResult({ key: "set-key-1", name: "Button", kind: "component_set" }),
      ]);

      const entry = index.search("Button")[0]!;
      expect(entry.kind).toBe("component_set");

      // Even with a key, component_set should only get desktop-panel
      const strategies = index.rankStrategies(entry, "any-session");
      expect(strategies).toEqual(["desktop-panel"]);
    });

    it("still allows runtime and published-key for component kind entries", () => {
      const index = new LibraryIndex();
      index.addFromRest([
        makeRestResult({ key: "comp-key-1", name: "Button", kind: "component" }),
      ]);

      const entry = index.search("Button")[0]!;
      expect(entry.kind).toBe("component");

      // Regular component should get published-key + desktop-panel
      const strategies = index.rankStrategies(entry, "some-session");
      expect(strategies).toEqual(["published-key", "desktop-panel"]);
    });
  });

  describe("toJSON / fromJSON", () => {
    it("round-trips correctly", () => {
      const index = new LibraryIndex();
      index.addFromLiveSession("s1", [
        makeComponent({ id: "1:1", key: "k1", name: "Button" }),
      ]);
      index.addFromRest([
        makeRestResult({ key: "r1", name: "Toolbar" }),
      ]);

      const json = index.toJSON();
      const restored = LibraryIndex.fromJSON(json);

      expect(restored.size).toBe(2);
      expect(restored.search("Button")).toHaveLength(1);
      expect(restored.search("Toolbar")).toHaveLength(1);
      expect(restored.getByKey("k1")?.source).toBe("live-session");
      expect(restored.getByKey("r1")?.source).toBe("rest-api");
    });

    it("returns empty index when data is undefined", () => {
      const restored = LibraryIndex.fromJSON(undefined);
      expect(restored.size).toBe(0);
    });
  });
});

describe("ImportReport helpers", () => {
  it("records attempts and marks first success as strategyUsed", () => {
    const report = createEmptyImportReport();

    recordAttempt(report, "runtime", false, 100, "connection lost");
    expect(report.strategyUsed).toBe("none");
    expect(report.attempts).toHaveLength(1);

    recordAttempt(report, "published-key", true, 200);
    expect(report.strategyUsed).toBe("published-key");
    expect(report.attempts).toHaveLength(2);

    // A later success should not overwrite the first
    recordAttempt(report, "desktop-panel", true, 300);
    expect(report.strategyUsed).toBe("published-key");
    expect(report.attempts).toHaveLength(3);
  });

  it("keeps strategyUsed as none when all attempts fail", () => {
    const report = createEmptyImportReport();
    recordAttempt(report, "runtime", false, 50);
    recordAttempt(report, "published-key", false, 80);
    expect(report.strategyUsed).toBe("none");
  });
});
