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
      { op: "addNode", node: { ...node("n1"), status: "completed", endedAt: 2 } },
      { op: "addNode", node: { ...node("n2"), type: "implementation" } },
    ] });
    expect(() => applyPatch(withNodes, { baseVersion: withNodes.version, operations: [
      { op: "addEdge", edge: { id: "e1", from: "n1", to: "n2", kind: "sequence" } },
      { op: "addEdge", edge: { id: "e2", from: "n2", to: "n1", kind: "sequence" } },
    ] })).toThrow(/Cyclic/);
    expect(() => applyPatch(withNodes, { baseVersion: withNodes.version, operations: [
      { op: "addNode", node: node("n1") },
    ] })).toThrow(/Duplicate/);
  });

  it("keeps one deterministic macro phase across repeated tools and turns", () => {
    let graph = createGraph("s", 0);
    graph = reduceEvent(graph, event({ id: "a", kind: "agent.started" }));
    graph = reduceEvent(graph, event({ id: "t1", kind: "tool.started", correlationId: "x", toolClass: "investigation", timestamp: 110 }));
    graph = reduceEvent(graph, event({ id: "d1", kind: "tool.completed", correlationId: "x", timestamp: 140, durationMs: 30 }));
    graph = reduceEvent(graph, event({ id: "turn1", kind: "turn.completed", timestamp: 150 }));
    graph = reduceEvent(graph, event({ id: "t2", kind: "tool.started", correlationId: "y", toolClass: "implementation", timestamp: 160 }));
    graph = reduceEvent(graph, event({ id: "d2", kind: "tool.completed", correlationId: "y", timestamp: 190, durationMs: 30 }));
    expect(graph.nodes).toHaveLength(2); // one goal and one stable current phase
    expect(graph.nodes.find((item) => item.id === "n:main:current")?.status).toBe("active");
    expect(graph.nodes.find((item) => item.id === "n:main:current")?.revision).toBeGreaterThan(1);
  });

  it("recovers a stable blocked phase and lets its macro type evolve in place", () => {
    let graph = createGraph("s", 0);
    graph = reduceEvent(graph, event({ id: "start", kind: "agent.started" }));
    graph = reduceEvent(graph, event({ id: "tool-a", kind: "tool.started", toolClass: "investigation", timestamp: 110 }));
    graph = reduceEvent(graph, event({ id: "fail", kind: "tool.completed", failed: true, timestamp: 120 }));
    expect(graph.nodes.find((item) => item.id === "n:main:current")?.status).toBe("blocked");
    graph = reduceEvent(graph, event({ id: "tool-b", kind: "tool.started", toolClass: "implementation", timestamp: 130 }));
    const phase = graph.nodes.find((item) => item.id === "n:main:current");
    expect(phase?.status).toBe("active");
    expect(phase?.type).toBe("implementation");
    expect(phase?.blocker).toBeUndefined();
    expect(graph.nodes.filter((item) => item.type === "blocker" && item.status === "blocked")).toHaveLength(0);
  });

  it("does not turn lifecycle mechanics into workflow blocks", () => {
    let graph = createGraph("s", 0);
    for (const [id, kind] of [["c1", "session.compacted"], ["c2", "session.compacted"], ["tree", "session.tree"]] as const) {
      graph = reduceEvent(graph, event({ id, kind }));
    }
    expect(graph.nodes).toHaveLength(0);
  });

  it("requires active macro phases to be updated instead of duplicated", () => {
    const graph = applyPatch(createGraph("s", 0), { baseVersion: 0, operations: [{ op: "addNode", node: node("n1") }] });
    expect(() => applyPatch(graph, { baseVersion: graph.version, operations: [{ op: "addNode", node: { ...node("n2"), type: "implementation" } }] })).toThrow(/update it instead/);
    const transitioned = applyPatch(graph, { baseVersion: graph.version, operations: [
      { op: "updateNode", id: "n1", changes: { status: "completed", detail: "Planning outcome established" } },
      { op: "addNode", node: node("n2") },
      { op: "addEdge", edge: { id: "phase-edge", from: "n1", to: "n2", kind: "sequence" } },
    ] });
    expect(transitioned.nodes).toHaveLength(2);
    expect(transitioned.nodes.find((item) => item.id === "n1")?.status).toBe("completed");
  });
});
