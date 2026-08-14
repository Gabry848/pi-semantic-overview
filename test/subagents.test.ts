import { describe, expect, it } from "vitest";
import { EventNormalizer, normalizeSubagentEvent } from "../src/normalizer.js";
import { createGraph, reduceEvent } from "../src/reducer.js";

describe("subagent correlation", () => {
  it("correlates lifecycle by an opaque stable agent id", () => {
    const normalizer = new EventNormalizer();
    const rawId = "RAW_PRIVATE_AGENT_ID";
    const created = normalizeSubagentEvent("subagents:created", { id: rawId, type: "Explore", description: "RAW_DESCRIPTION" }, normalizer, 10)!;
    const started = normalizeSubagentEvent("subagents:started", { id: rawId, type: "Explore", description: "RAW_DESCRIPTION" }, normalizer, 20)!;
    const completed = normalizeSubagentEvent("subagents:completed", { id: rawId, result: "RAW_RESULT", durationMs: 30 }, normalizer, 40)!;
    expect(created.agentId).toBe(started.agentId);
    expect(started.agentId).toBe(completed.agentId);
    expect(JSON.stringify([created, started, completed])).not.toContain("RAW_");

    let graph = createGraph("s", 0);
    graph = reduceEvent(graph, created);
    graph = reduceEvent(graph, started);
    graph = reduceEvent(graph, completed);
    const agent = graph.agents.find((item) => item.id === created.agentId);
    expect(agent?.status).toBe("completed");
    expect(graph.nodes.some((node) => node.type === "handoff")).toBe(true);
  });

  it("keeps repeated steering and compaction occurrences distinct", () => {
    const normalizer = new EventNormalizer();
    const first = normalizeSubagentEvent("subagents:steered", { id: "same", message: "private one" }, normalizer, 10)!;
    const second = normalizeSubagentEvent("subagents:steered", { id: "same", message: "private two" }, normalizer, 20)!;
    const compactOne = normalizeSubagentEvent("subagents:compacted", { id: "same", compactionCount: 1 }, normalizer, 30)!;
    const compactTwo = normalizeSubagentEvent("subagents:compacted", { id: "same", compactionCount: 2 }, normalizer, 40)!;
    expect(first.id).not.toBe(second.id);
    expect(compactOne.id).not.toBe(compactTwo.id);
    expect(first.agentId).toBe(second.agentId);
  });

  it("deduplicates repeated terminal child telemetry", () => {
    const normalizer = new EventNormalizer();
    const one = normalizeSubagentEvent("subagents:completed", { id: "same", durationMs: 1 }, normalizer, 10)!;
    const two = normalizeSubagentEvent("subagents:completed", { id: "same", durationMs: 1 }, normalizer, 20)!;
    expect(one.id).toBe(two.id);
    let graph = reduceEvent(createGraph("s", 0), one);
    const version = graph.version;
    graph = reduceEvent(graph, two);
    expect(graph.version).toBe(version);
  });
});
