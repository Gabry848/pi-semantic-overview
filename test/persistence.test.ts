import { describe, expect, it } from "vitest";
import { parseSnapshot, restoreFromBranch, serializeSnapshot, SNAPSHOT_ENTRY } from "../src/persistence.js";
import { createGraph } from "../src/reducer.js";

describe("sanitized persistence", () => {
  it("restores the latest current-branch snapshot", () => {
    const old = createGraph("old", 1); old.version = 2;
    const latest = createGraph("latest", 2); latest.version = 7;
    const entries = [
      { type: "custom", customType: SNAPSHOT_ENTRY, data: serializeSnapshot(old) },
      { type: "message", message: { role: "user", content: "RAW_TRANSCRIPT_SENTINEL" } },
      { type: "custom", customType: SNAPSHOT_ENTRY, data: serializeSnapshot(latest) },
    ];
    const restored = restoreFromBranch(entries, "fallback");
    expect(restored.version).toBe(7);
    expect(restored.sessionId).toBe("latest");
    expect(JSON.stringify(restored)).not.toContain("RAW_TRANSCRIPT_SENTINEL");
  });

  it("falls back safely when snapshot data is invalid", () => {
    const restored = restoreFromBranch([{ type: "custom", customType: SNAPSHOT_ENTRY, data: { raw: "RAW_SENTINEL" } }], "fallback");
    expect(restored.sessionId).toBe("fallback");
    expect(restored.version).toBe(0);
  });

  it("rejects malformed runtime fields outside public text", () => {
    const graph = createGraph("s", 0);
    const data = serializeSnapshot(graph);
    (data.graph.agents[0] as unknown as Record<string, unknown>).status = "RAW_PRIVATE_STATUS";
    expect(() => parseSnapshot(data)).toThrow(/agent/);

    const badEdge = serializeSnapshot(createGraph("s", 0));
    (badEdge.graph.edges as unknown[]).push({ id: "e1", from: "missing", to: "missing", kind: "RAW_KIND" });
    expect(() => parseSnapshot(badEdge)).toThrow(/edge/);
  });

  it("rejects raw unsafe persisted text", () => {
    const graph = createGraph("s", 0);
    const data = serializeSnapshot(graph);
    data.graph.agents[0]!.label = "See /private/RAW_SENTINEL.ts";
    expect(() => parseSnapshot(data)).toThrow();
  });
});
