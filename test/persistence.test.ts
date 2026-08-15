import { describe, expect, it } from "vitest";
import { parseSnapshot, restoreFromBranch, serializeSnapshot, SNAPSHOT_ENTRY } from "../src/persistence.js";
import { createGraph } from "../src/reducer.js";

describe("schema-v2 persistence and legacy migration", () => {
  it("restores the latest current-branch v2 snapshot", () => {
    const old = createGraph("old", 1); old.semanticRevision = 2;
    const latest = createGraph("latest", 2); latest.semanticRevision = 7;
    const entries = [
      { type: "custom", customType: SNAPSHOT_ENTRY, data: serializeSnapshot(old) },
      { type: "message", message: { role: "user", content: "RAW_TRANSCRIPT_SENTINEL" } },
      { type: "custom", customType: SNAPSHOT_ENTRY, data: serializeSnapshot(latest) },
    ];
    const restored = restoreFromBranch(entries, "fallback");
    expect(restored.schemaVersion).toBe(2);
    expect(restored.semanticRevision).toBe(7);
    expect(restored.sessionId).toBe("latest");
    expect(JSON.stringify(restored)).not.toContain("RAW_TRANSCRIPT_SENTINEL");
  });

  it("migrates the real legacy scale without generic/restricted cards or revision churn", () => {
    const nodes = Array.from({ length: 104 }, (_, index) => index < 74
      ? {
          id: `legacy-${index}`, type: "implementation", label: index % 2 ? "Restricted activity" : "Implementing changes",
          agentId: "main", status: "completed", startedAt: index, revision: 329,
        }
      : {
          id: `legacy-${index}`, type: "verification", label: `Confirmed executive outcome ${index - 73}`,
          detail: `A concrete milestone captured meaningful outcome ${index - 73}`,
          agentId: "main", status: "completed", startedAt: index, revision: 329,
        });
    const legacy = {
      schemaVersion: 1,
      sessionId: "legacy-session",
      graph: { version: 329, updatedAt: 1000, nodes, edges: [], agents: [{ id: "main", label: "Main agent", status: "idle" }] },
    };
    const migrated = parseSnapshot(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.semanticRevision).toBe(1);
    expect(migrated.nodes.length).toBeGreaterThanOrEqual(5);
    expect(migrated.nodes.length).toBeLessThanOrEqual(10);
    expect(migrated.nodes.every((node) => !/restricted|implementing changes/i.test(node.title))).toBe(true);
    expect(JSON.stringify(serializeSnapshot(migrated))).not.toContain('"revision":329');
  });

  it("preserves superseded records for append-only compatibility while keeping valid links", () => {
    const graph = createGraph("s", 0);
    graph.nodes.push(
      { id: "old-a", type: "verification", title: "Confirmed first readiness signal", agentId: "main", status: "completed", startedAt: 1, supersededBy: "combined" },
      { id: "old-b", type: "verification", title: "Confirmed second readiness signal", agentId: "main", status: "completed", startedAt: 2, supersededBy: "combined" },
      { id: "combined", type: "integration", title: "Integrated readiness evidence", outcome: "The combined evidence supports the next direction", agentId: "main", status: "completed", startedAt: 3 },
    );
    graph.semanticRevision = 4;
    const restored = parseSnapshot(serializeSnapshot(graph));
    expect(restored.nodes.filter((node) => node.supersededBy === "combined")).toHaveLength(2);
    expect(restored.semanticRevision).toBe(4);
  });

  it("falls back safely for invalid, cyclic, or unsafe snapshots", () => {
    const invalid = restoreFromBranch([{ type: "custom", customType: SNAPSHOT_ENTRY, data: { raw: "RAW_SENTINEL" } }], "fallback");
    expect(invalid.sessionId).toBe("fallback");
    const graph = createGraph("s", 0);
    graph.nodes.push(
      { id: "a", type: "verification", title: "Confirmed initial readiness", agentId: "main", status: "completed", startedAt: 1 },
      { id: "b", type: "integration", title: "Integrated confirmed readiness", agentId: "main", status: "completed", startedAt: 2 },
    );
    graph.edges.push({ id: "one", from: "a", to: "b", kind: "sequence" }, { id: "two", from: "b", to: "a", kind: "sequence" });
    expect(() => parseSnapshot(serializeSnapshot(graph))).toThrow(/edge/);
  });
});
