import { describe, expect, it } from "vitest";
import { applyPatch, createGraph, isLegalTransition, reduceEvent } from "../src/reducer.js";
import type { GraphNode, NormalizedEvent } from "../src/types.js";

const event = (partial: Partial<NormalizedEvent> & Pick<NormalizedEvent, "id" | "kind">): NormalizedEvent => ({
  timestamp: 100, agentId: "main", ...partial,
});

const node = (id: string): GraphNode => ({
  id, type: "planning", label: "Plan macro phase", agentId: "main", status: "active",
  startedAt: 1, impact: "medium", revision: 0,
});

describe("graph reducer", () => {
  it("enforces legal status transitions", () => {
    expect(isLegalTransition("pending", "active")).toBe(true);
    expect(isLegalTransition("active", "completed")).toBe(true);
    expect(isLegalTransition("completed", "active")).toBe(false);
  });

  it("deduplicates normalized events", () => {
    const graph = createGraph("s", 0);
    const ev = event({ id: "same", kind: "agent.started" });
    const once = reduceEvent(graph, ev);
    const twice = reduceEvent(once, ev);
    expect(twice).toBe(once);
    expect(once.nodes).toHaveLength(1);
  });

  it("rejects stale patches", () => {
    const graph = createGraph("s", 0);
    expect(() => applyPatch(graph, { baseVersion: 2, operations: [] })).toThrow(/Stale/);
  });

  it("rejects duplicate nodes and cyclic edges", () => {
    const graph = createGraph("s", 0);
    const withNodes = applyPatch(graph, { baseVersion: 0, operations: [
      { op: "addNode", node: node("n1") },
      { op: "addNode", node: node("n2") },
    ] });
    expect(() => applyPatch(withNodes, { baseVersion: withNodes.version, operations: [
      { op: "addEdge", edge: { id: "e1", from: "n1", to: "n2", kind: "sequence" } },
      { op: "addEdge", edge: { id: "e2", from: "n2", to: "n1", kind: "sequence" } },
    ] })).toThrow(/Cyclic/);
    expect(() => applyPatch(withNodes, { baseVersion: withNodes.version, operations: [
      { op: "addNode", node: node("n1") },
    ] })).toThrow(/Duplicate/);
  });

  it("keeps a useful deterministic graph with no model", () => {
    let graph = createGraph("s", 0);
    graph = reduceEvent(graph, event({ id: "a", kind: "agent.started" }));
    graph = reduceEvent(graph, event({ id: "t", kind: "tool.started", correlationId: "x", toolClass: "investigation", timestamp: 110 }));
    graph = reduceEvent(graph, event({ id: "d", kind: "tool.completed", correlationId: "x", timestamp: 140, durationMs: 30 }));
    expect(graph.nodes.map((item) => item.type)).toContain("investigation");
    expect(graph.nodes.find((item) => item.type === "investigation")?.status).toBe("completed");
  });
});
