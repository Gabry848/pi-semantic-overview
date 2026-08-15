import { describe, expect, it } from "vitest";
import { correlatedSubagentIdFromTool, EventNormalizer, explicitSubagentResultStatus, normalizeSubagentEvent } from "../src/normalizer.js";
import { createGraph, reduceEvent } from "../src/reducer.js";

describe("subagent telemetry correlation", () => {
  it("correlates lifecycle by an opaque id without inventing semantic branch cards", () => {
    const normalizer = new EventNormalizer();
    const rawId = "RAW_PRIVATE_AGENT_ID";
    const created = normalizeSubagentEvent("subagents:created", { id: rawId, type: "Explore", description: "RAW_DESCRIPTION" }, normalizer, 10)!;
    const started = normalizeSubagentEvent("subagents:started", { id: rawId, description: "RAW_DESCRIPTION" }, normalizer, 20)!;
    const completed = normalizeSubagentEvent("subagents:completed", { id: rawId, result: "RAW_RESULT" }, normalizer, 40)!;
    expect(created.agentId).toBe(started.agentId);
    expect(started.agentId).toBe(completed.agentId);
    expect(JSON.stringify([created, started, completed])).not.toContain("RAW_");
    let graph = createGraph("s", 0);
    graph = reduceEvent(graph, created);
    graph = reduceEvent(graph, started);
    graph = reduceEvent(graph, completed);
    expect(graph.agents.find((agent) => agent.id === created.agentId)?.status).toBe("completed");
    expect(graph.nodes).toHaveLength(0);
    expect(graph.semanticRevision).toBe(0);
  });

  it("correlates explicit main checks using only an opaque child id", () => {
    const rawId = "RAW_PRIVATE_AGENT_ID";
    const lifecycle = normalizeSubagentEvent("subagents:started", { id: rawId }, new EventNormalizer(), 10)!;
    expect(correlatedSubagentIdFromTool("get_subagent_result", { agent_id: rawId })).toBe(lifecycle.agentId);
    expect(correlatedSubagentIdFromTool("get_subagent_result", { agent_id: "" })).toBeUndefined();
    expect(correlatedSubagentIdFromTool("read", { agent_id: rawId })).toBeUndefined();
    expect(correlatedSubagentIdFromTool("get_subagent_result", { other: rawId })).toBeUndefined();
    expect(explicitSubagentResultStatus({ content: [{ type: "text", text: "Type: reviewer | Status: running | Duration: 2s" }] })).toBe("running");
    expect(explicitSubagentResultStatus("Type: reviewer | Status: completed | Duration: 4s")).toBe("completed");
    expect(explicitSubagentResultStatus("Agent not found")).toBeUndefined();
  });

  it("keeps repeated steering distinct and terminal telemetry idempotent", () => {
    const normalizer = new EventNormalizer();
    const first = normalizeSubagentEvent("subagents:steered", { id: "same", message: "private one" }, normalizer, 10)!;
    const second = normalizeSubagentEvent("subagents:steered", { id: "same", message: "private two" }, normalizer, 20)!;
    expect(first.id).not.toBe(second.id);
    const one = normalizeSubagentEvent("subagents:completed", { id: "same" }, normalizer, 30)!;
    const two = normalizeSubagentEvent("subagents:completed", { id: "same" }, normalizer, 40)!;
    expect(one.id).toBe(two.id);
    let graph = reduceEvent(createGraph("s", 0), one);
    const telemetryRevision = graph.telemetryRevision;
    graph = reduceEvent(graph, two);
    expect(graph.telemetryRevision).toBe(telemetryRevision);
  });
});
