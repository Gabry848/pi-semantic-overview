import { describe, expect, it } from "vitest";
import { applyPatch, applyPatchBestEffort, createGraph, isLegalTransition, reduceEvent } from "../src/reducer.js";
import type { GraphNode, NormalizedEvent } from "../src/types.js";

const event = (partial: Partial<NormalizedEvent> & Pick<NormalizedEvent, "id" | "kind">): NormalizedEvent => ({ timestamp: 100, agentId: "main", ...partial });
const milestone = (id: string, startedAt = 1): GraphNode => ({
  id, type: "verification", title: `Confirmed meaningful outcome ${id}`, outcome: `The outcome ${id} is supported by observable checks`,
  agentId: "main", status: "completed", startedAt, endedAt: startedAt + 1,
});

describe("schema-v2 semantic reducer", () => {
  it("enforces legal status transitions", () => {
    expect(isLegalTransition("pending", "active")).toBe(true);
    expect(isLegalTransition("active", "completed")).toBe(true);
    expect(isLegalTransition("completed", "active")).toBe(false);
  });

  it("keeps 500 tool events entirely outside semantic nodes and revisions", () => {
    let graph = createGraph("s", 7);
    for (let index = 0; index < 500; index++) graph = reduceEvent(graph, event({ id: `tool-${index}`, kind: index % 2 ? "tool.completed" : "tool.started", timestamp: 10 + index }));
    expect(graph.nodes).toHaveLength(0);
    expect(graph.semanticRevision).toBe(0);
    expect(graph.updatedAt).toBe(7);
    expect(graph.telemetryRevision).toBe(500);
    expect(graph.processedEventIds).toHaveLength(500);
  });

  it("requires exact semantic revisions and rejects generic titles", () => {
    expect(() => applyPatch(createGraph("s", 0), { baseRevision: 2, operations: [] })).toThrow(/Stale/);
    expect(() => applyPatch(createGraph("s", 0), { baseRevision: 0, operations: [{ op: "addNode", node: { ...milestone("x"), title: "Verification completed" } }] })).toThrow(/generic/i);
  });

  it("preserves prior safe detail when an unsafe optional update is fully removed", () => {
    const evidence = [{ id: "e", kind: "prompt" as const, text: "alpha bravo charlie delta echo foxtrot", timestamp: 1 }];
    let graph = applyPatch(createGraph("s", 0), { baseRevision: 0, operations: [{ op: "addNode", node: { ...milestone("safe"), summary: ["A defensible readiness review produced a concrete outcome"] } }] });
    const revision = graph.semanticRevision;
    graph = applyPatch(graph, { baseRevision: revision, operations: [{ op: "updateNode", id: "safe", changes: { summary: ["alpha bravo charlie delta echo foxtrot"] } }] }, evidence);
    expect(graph.nodes[0]?.summary).toEqual(["A defensible readiness review produced a concrete outcome"]);
    expect(graph.semanticRevision).toBe(revision);
  });

  it("keeps at most one visible active milestone per agent", () => {
    const active = (id: string) => { const node = milestone(id); delete node.endedAt; node.status = "active"; return node; };
    expect(() => applyPatch(createGraph("s", 0), { baseRevision: 0, operations: [
      { op: "addNode", node: active("active-one") },
      { op: "addNode", node: active("active-two") },
    ] })).toThrow(/Multiple active/i);
  });

  it("validates agent parent topology", () => {
    expect(() => applyPatch(createGraph("s", 0), { baseRevision: 0, operations: [{ op: "upsertAgent", agent: { id: "orphan", label: "Independent reviewer", parentId: "missing", status: "running" } }] })).toThrow(/parent/i);
    expect(() => applyPatch(createGraph("s", 0), { baseRevision: 0, operations: [
      { op: "upsertAgent", agent: { id: "one", label: "First specialist", parentId: "two", status: "running" } },
      { op: "upsertAgent", agent: { id: "two", label: "Second specialist", parentId: "one", status: "running" } },
    ] })).toThrow(/Cyclic/i);
  });

  it("rejects cycles", () => {
    const graph = applyPatch(createGraph("s", 0), { baseRevision: 0, operations: [{ op: "addNode", node: milestone("a", 1) }, { op: "addNode", node: milestone("b", 2) }] });
    expect(() => applyPatch(graph, { baseRevision: graph.semanticRevision, operations: [
      { op: "addEdge", edge: { id: "one", from: "a", to: "b", kind: "sequence" } },
      { op: "addEdge", edge: { id: "two", from: "b", to: "a", kind: "sequence" } },
    ] })).toThrow(/Cyclic/);
  });

  it("enforces the main cap and supports atomic consolidation before adding", () => {
    let graph = applyPatch(createGraph("s", 0), { baseRevision: 0, operations: Array.from({ length: 12 }, (_, index) => ({ op: "addNode" as const, node: milestone(`m${index}`, index) })) });
    expect(() => applyPatch(graph, { baseRevision: graph.semanticRevision, operations: [{ op: "addNode", node: milestone("overflow", 20) }] })).toThrow(/consolidate/i);
    graph = applyPatch(graph, { baseRevision: graph.semanticRevision, operations: [
      { op: "consolidateNodes", ids: ["m0", "m1", "m2"], node: {
        id: "foundation", type: "integration", title: "Integrated the initial readiness foundation", outcome: "Three early outcomes now form one meaningful foundation", agentId: "main", status: "completed", startedAt: 0,
      } },
      { op: "addNode", node: milestone("next-direction", 30) },
    ] });
    expect(graph.nodes.filter((node) => node.agentId === "main" && !node.supersededBy)).toHaveLength(11);
    expect(graph.nodes.filter((node) => node.supersededBy === "foundation")).toHaveLength(3);
  });

  it("rewires external relationships when milestones are consolidated", () => {
    let graph = applyPatch(createGraph("s", 0), { baseRevision: 0, operations: [
      { op: "addNode", node: milestone("before", 0) },
      { op: "addNode", node: milestone("old-one", 1) },
      { op: "addNode", node: milestone("old-two", 2) },
      { op: "addNode", node: milestone("after", 3) },
      { op: "addEdge", edge: { id: "before-old", from: "before", to: "old-one", kind: "sequence" } },
      { op: "addEdge", edge: { id: "old-pair", from: "old-one", to: "old-two", kind: "sequence" } },
      { op: "addEdge", edge: { id: "old-after", from: "old-two", to: "after", kind: "sequence" } },
    ] });
    graph = applyPatch(graph, { baseRevision: graph.semanticRevision, operations: [{
      op: "consolidateNodes", ids: ["old-one", "old-two"], node: {
        id: "combined", type: "integration", title: "Integrated the related readiness outcomes", outcome: "Two related outcomes now form one executive milestone", agentId: "main", status: "completed", startedAt: 1,
      },
    }] });
    expect(graph.edges.some((edge) => edge.from === "before" && edge.to === "combined" && edge.kind === "sequence")).toBe(true);
    expect(graph.edges.some((edge) => edge.from === "combined" && edge.to === "after" && edge.kind === "sequence")).toBe(true);
    expect(graph.edges.some((edge) => edge.from === "combined" && edge.to === "combined")).toBe(false);
  });

  it("supports two explicit branch checks and a stronger final integration", () => {
    let graph = applyPatch(createGraph("s", 0), { baseRevision: 0, operations: [
      { op: "upsertAgent", agent: { id: "sub-one", label: "Independent reviewer", parentId: "main", status: "running", mandate: "Assess whether the planned outcome is defensible" } },
      { op: "addNode", node: { id: "main-delegate", type: "delegation", title: "Commissioned an independent outcome review", mandate: "Provide independent evidence while main work continues", agentId: "main", status: "completed", startedAt: 1 } },
      { op: "addNode", node: { id: "main-integrate", type: "integration", title: "Integrated independent findings into the outcome", outcome: "The main result incorporates the final specialist contribution", agentId: "main", status: "completed", startedAt: 5 } },
      { op: "addNode", node: { id: "sub-review", type: "verification", title: "Assessed the outcome independently", mandate: "Test the outcome against the agreed success conditions", contribution: "Independent findings strengthened the final result", agentId: "sub-one", status: "completed", startedAt: 2 } },
      { op: "addEdge", edge: { id: "delegates", from: "main-delegate", to: "sub-review", kind: "delegates" } },
      { op: "addEdge", edge: { id: "main-sequence", from: "main-delegate", to: "main-integrate", kind: "sequence" } },
    ] });
    graph = applyPatch(graph, { baseRevision: graph.semanticRevision, operations: [
      { op: "checkBranch", id: "check-one", branchNodeId: "sub-review", mainNodeId: "main-integrate", note: "The first intermediate finding informed the main direction" },
      { op: "checkBranch", id: "check-two", branchNodeId: "sub-review", mainNodeId: "main-integrate", note: "A later finding refined the acceptance decision" },
      { op: "integrateBranch", id: "final-integration", branchNodeId: "sub-review", mainNodeId: "main-integrate", note: "The final contribution was incorporated into the result" },
    ] });
    expect(graph.edges.filter((edge) => edge.kind === "checks")).toHaveLength(2);
    expect(graph.edges.find((edge) => edge.id === "final-integration")?.strength).toBe("final");
    expect(() => applyPatch(graph, { baseRevision: graph.semanticRevision, operations: [{ op: "checkBranch", id: "false-rejoin", branchNodeId: "main-delegate", mainNodeId: "main-integrate" }] })).toThrow(/Ambiguous/);
  });

  it("keeps valid operations when a sibling model node is unsafe", () => {
    const result = applyPatchBestEffort(createGraph("s", 0), {
      baseRevision: 0,
      operations: [
        { op: "addNode", node: milestone("accepted") },
        { op: "addNode", node: { ...milestone("unsafe"), title: "See /private/RAW_SENTINEL.ts" } },
        { op: "addEdge", edge: { id: "dangling", from: "accepted", to: "unsafe", kind: "sequence" } },
      ],
    });
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["accepted"]);
    expect(result.graph.edges).toHaveLength(0);
  });
});
