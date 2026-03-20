import { describe, expect, it } from "vitest";

import { searchPublishedComponentsInFile } from "../src/figma-rest.js";

describe("figma-rest", () => {
  it("searches and ranks published components from REST payloads", async () => {
    const responses = new Map<string, unknown>([
      ["/v1/files/file-key/components", {
        meta: {
          components: [
            {
              key: "component-key-1",
              file_key: "file-key",
              node_id: "1:2",
              name: "Button / Primary",
              description: "Primary CTA"
            },
            {
              key: "component-key-2",
              file_key: "file-key",
              node_id: "1:3",
              name: "Card / Destination"
            }
          ]
        }
      }],
      ["/v1/files/file-key/component_sets", {
        meta: {
          component_sets: [
            {
              key: "set-key-1",
              file_key: "file-key",
              node_id: "2:1",
              name: "Button",
              description: "All button variants"
            }
          ]
        }
      }]
    ]);

    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      const body = responses.get(path);
      if (!body) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const components = await searchPublishedComponentsInFile({
      fileKey: "file-key",
      query: "Button",
      fetchFn,
      token: "test-token"
    });

    expect(components).toHaveLength(2);
    expect(components[0]?.key).toBe("set-key-1");
    expect(components[0]?.kind).toBe("component_set");
    expect(components[1]?.key).toBe("component-key-1");
  });
});
