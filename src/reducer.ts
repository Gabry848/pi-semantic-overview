import { inspectPublicText } from "./privacy.js";
import { NODE_STATUSES, NODE_TYPES, type EvidenceItem, type GraphEdge, type GraphNode, type GraphPatch, type NodeStatus, type NodeType, type NormalizedEvent, type SemanticGraph } from "./types.js";

const LEGAL_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  pending: ["active", "cancelled"],
  active: ["completed", "blocked", "failed", "cancelled"],
  blocked: ["active", "failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};

export function isLegalTransition(from: NodeStatus, to: NodeStatus): boolean {
  return from === to || LEGAL_TRANSITIONS[from].includes(to);
}

export function createGraph(sessionId = "session", now = Date.now()): SemanticGraph {
  return {
    schemaVersion: 1,
    version: 0,
    sessionId,
    updatedAt: now,
    nodes: [], edges: [],
    agents: [{ id: "main", label: "Main agent", status: "idle" }],
    processedEventIds: [],
  };
}

export function reduceEvent(graph: SemanticGraph, event: NormalizedEvent): SemanticGraph {
  if (graph.processedEventIds.includes(event.id)) return graph;
  const next = cloneGraph(graph);
  next.processedEventIds.push(event.id);
  if (next.processedEventIds.length > 500) next.processedEventIds.splice(0, next.processedEventIds.length - 500);
  next.updatedAt = event.timestamp;
  next.version++;

  const agent = upsertEventAgent(next, event);
  switch (event.kind) {
    case "session.started":
      break;
    case "agent.started":
      agent.status = "running";
      agent.startedAt ??= event.timestamp;
      ensureActivityNode(next, event, "goal", "Active objective");
      break;
    case "agent.completed":
      agent.status = event.failed ? "failed" : "completed";
      agent.endedAt = event.timestamp;
      closeActiveNodes(next, event.agentId, event.timestamp, event.failed ? "failed" : "completed");
      break;
    case "turn.started":
      agent.status = "running";
      break;
    case "turn.completed":
      closeTurnNodes(next, event);
      break;
    case "tool.started":
      ensureActivityNode(next, event, event.toolClass ?? "implementation", labelForType(event.toolClass ?? "implementation"));
      break;
    case "tool.completed": {
      const node = findCorrelatedNode(next, event);
      if (node && isLegalTransition(node.status, event.failed ? "failed" : "completed")) {
        node.status = event.failed ? "failed" : "completed";
        node.endedAt = event.timestamp;
        node.durationMs = event.durationMs ?? Math.max(0, event.timestamp - node.startedAt);
        node.revision++;
        if (event.failed) {
          node.impact = "high";
          const blocker = ensureActivityNode(next, event, "blocker", "Tool activity blocked");
          blocker.status = "blocked";
          blocker.blocker = "Execution did not complete";
          addEdge(next, node.id, blocker.id, "blocks");
        }
      }
      break;
    }
    case "subagent.created":
      agent.status = "idle";
      ensureActivityNode(next, event, "delegation", "Delegated work");
      break;
    case "subagent.started":
      agent.status = "running";
      agent.startedAt ??= event.timestamp;
      ensureActivityNode(next, event, "delegation", "Delegated work");
      activateLatest(next, event.agentId, "delegation");
      break;
    case "subagent.completed":
      agent.status = "completed";
      agent.endedAt = event.timestamp;
      closeActiveNodes(next, event.agentId, event.timestamp, "completed", event.durationMs);
      ensureActivityNode(next, event, "handoff", "Subagent handoff", "completed");
      break;
    case "subagent.failed":
      agent.status = "failed";
      agent.endedAt = event.timestamp;
      closeActiveNodes(next, event.agentId, event.timestamp, "failed", event.durationMs);
      ensureActivityNode(next, event, "blocker", "Delegated work blocked", "blocked");
      break;
    case "subagent.compacted":
      ensureActivityNode(next, event, "reflection", "Subagent context consolidated", "completed");
      break;
    case "subagent.steered":
      ensureActivityNode(next, event, "revision", "Delegation redirected", "completed");
      break;
    case "session.compacted":
      ensureActivityNode(next, event, "reflection", "Context consolidated", "completed");
      break;
    case "session.tree":
      ensureActivityNode(next, event, "revision", "Session branch changed", "completed");
      break;
  }
  return next;
}

function upsertEventAgent(graph: SemanticGraph, event: NormalizedEvent) {
  let agent = graph.agents.find((item) => item.id === event.agentId);
  if (!agent) {
    agent = { id: event.agentId, label: "Subagent", parentId: "main", status: "idle" };
    graph.agents.push(agent);
  }
  return agent;
}

function ensureActivityNode(graph: SemanticGraph, event: NormalizedEvent, type: NodeType, label: string, status: NodeStatus = "active"): GraphNode {
  const correlation = event.correlationId ?? `turn:${event.turn ?? graph.version}`;
  const key = `${event.agentId}:${type}:${correlation}`;
  const existing = graph.nodes.find((node) => node.id === `n:${key}`);
  if (existing) return existing;
  const node: GraphNode = {
    id: `n:${key}`,
    type, label, agentId: event.agentId, status,
    startedAt: event.timestamp,
    ...(status === "completed" ? { endedAt: event.timestamp, durationMs: event.durationMs ?? 0 } : {}),
    impact: type === "blocker" ? "high" : type === "decision" ? "high" : "medium",
    revision: 0,
  };
  graph.nodes.push(node);
  const previous = [...graph.nodes].reverse().find((item) => item.id !== node.id && item.agentId === node.agentId);
  if (previous) addEdge(graph, previous.id, node.id, type === "handoff" ? "integrates" : type === "revision" ? "revises" : "sequence");
  if (event.agentId !== "main" && type === "delegation") {
    const main = [...graph.nodes].reverse().find((item) => item.agentId === "main");
    if (main) addEdge(graph, main.id, node.id, "delegates");
  }
  return node;
}

function labelForType(type: NodeType): string {
  const labels: Record<NodeType, string> = {
    goal: "Active objective", reflection: "Reviewing progress", decision: "Decision point", planning: "Planning next steps",
    delegation: "Delegating work", investigation: "Investigating context", implementation: "Implementing changes",
    verification: "Verifying outcome", integration: "Integrating results", blocker: "Progress blocked",
    revision: "Revising approach", handoff: "Preparing handoff",
  };
  return labels[type];
}

function findCorrelatedNode(graph: SemanticGraph, event: NormalizedEvent): GraphNode | undefined {
  if (event.correlationId) return [...graph.nodes].reverse().find((node) => node.id.endsWith(`:${event.correlationId}`));
  return [...graph.nodes].reverse().find((node) => node.agentId === event.agentId && node.status === "active");
}
function closeTurnNodes(graph: SemanticGraph, event: NormalizedEvent): void {
  for (const node of graph.nodes) {
    if (node.agentId === event.agentId && node.status === "active" && isLegalTransition(node.status, event.failed ? "failed" : "completed")) {
      node.status = event.failed ? "failed" : "completed";
      node.endedAt = event.timestamp;
      node.durationMs = Math.max(0, event.timestamp - node.startedAt);
      node.revision++;
    }
  }
}
function closeActiveNodes(graph: SemanticGraph, agentId: string, now: number, status: NodeStatus, duration?: number): void {
  for (const node of graph.nodes) if (node.agentId === agentId && node.status === "active" && isLegalTransition(node.status, status)) {
    node.status = status; node.endedAt = now; node.durationMs = duration ?? Math.max(0, now - node.startedAt); node.revision++;
  }
}
function activateLatest(graph: SemanticGraph, agentId: string, type: NodeType): void {
  const node = [...graph.nodes].reverse().find((item) => item.agentId === agentId && item.type === type);
  if (node && isLegalTransition(node.status, "active")) node.status = "active";
}
function addEdge(graph: SemanticGraph, from: string, to: string, kind: GraphEdge["kind"]): void {
  if (from === to || graph.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind)) return;
  if (wouldCycle(graph, from, to)) return;
  graph.edges.push({ id: `e:${from}:${to}:${kind}`, from, to, kind });
}

export function wouldCycle(graph: Pick<SemanticGraph, "edges">, from: string, to: string): boolean {
  const stack = [to]; const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of graph.edges) if (edge.from === current) stack.push(edge.to);
  }
  return false;
}

export function applyPatch(graph: SemanticGraph, patch: GraphPatch, evidence: readonly EvidenceItem[] = []): SemanticGraph {
  validatePatch(graph, patch, evidence);
  const next = cloneGraph(graph);
  for (const operation of patch.operations) {
    if (operation.op === "addNode") next.nodes.push({ ...operation.node });
    else if (operation.op === "updateNode") {
      const node = next.nodes.find((item) => item.id === operation.id)!;
      if (operation.changes.status && !isLegalTransition(node.status, operation.changes.status)) throw new Error("Illegal status transition");
      Object.assign(node, operation.changes); node.revision++;
    } else if (operation.op === "addEdge") next.edges.push({ ...operation.edge });
    else {
      const index = next.agents.findIndex((item) => item.id === operation.agent.id);
      if (index >= 0) next.agents[index] = { ...next.agents[index]!, ...operation.agent };
      else next.agents.push({ ...operation.agent });
    }
  }
  next.version++;
  next.updatedAt = Date.now();
  return next;
}

export function validatePatch(graph: SemanticGraph, patch: GraphPatch, evidence: readonly EvidenceItem[] = []): void {
  if (!Number.isInteger(patch.baseVersion) || patch.baseVersion !== graph.version) throw new Error("Stale patch");
  if (!Array.isArray(patch.operations) || patch.operations.length > 24) throw new Error("Invalid operation count");
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const scratchEdges = graph.edges.map((edge) => ({ ...edge }));
  for (const operation of patch.operations) {
    if (operation.op === "addNode") {
      validateNode(operation.node, evidence);
      if (nodeIds.has(operation.node.id)) throw new Error("Duplicate node");
      nodeIds.add(operation.node.id);
    } else if (operation.op === "updateNode") {
      if (!nodeIds.has(operation.id)) throw new Error("Missing node");
      for (const text of [operation.changes.label, operation.changes.detail, operation.changes.blocker]) if (text && inspectPublicText(text, evidence).length) throw new Error("Unsafe patch text");
      if (operation.changes.status && !NODE_STATUSES.includes(operation.changes.status)) throw new Error("Invalid status");
      if (operation.changes.impact && !["low", "medium", "high"].includes(operation.changes.impact)) throw new Error("Invalid impact");
    } else if (operation.op === "addEdge") {
      const edge = operation.edge;
      if (edgeIds.has(edge.id) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to || !["sequence", "depends-on", "delegates", "revises", "integrates", "blocks"].includes(edge.kind)) throw new Error("Invalid edge");
      if (wouldCycle({ edges: scratchEdges }, edge.from, edge.to)) throw new Error("Cyclic edge");
      edgeIds.add(edge.id); scratchEdges.push({ ...edge });
    } else if (operation.op === "upsertAgent") {
      if (!/^[-:a-zA-Z0-9]{1,80}$/.test(operation.agent.id) || inspectPublicText(operation.agent.label, evidence).length) throw new Error("Invalid agent");
    } else throw new Error("Unknown operation");
  }
}

function validateNode(node: GraphNode, evidence: readonly EvidenceItem[]): void {
  if (!/^[-:a-zA-Z0-9]{1,100}$/.test(node.id) || !/^[-:a-zA-Z0-9]{1,100}$/.test(node.agentId) || !NODE_TYPES.includes(node.type) || !NODE_STATUSES.includes(node.status)) throw new Error("Invalid node");
  if (typeof node.label !== "string" || !Number.isFinite(node.startedAt) || !Number.isInteger(node.revision) || (node.endedAt !== undefined && !Number.isFinite(node.endedAt)) || (node.durationMs !== undefined && !Number.isFinite(node.durationMs))) throw new Error("Invalid node fields");
  if (node.impact !== undefined && !["low", "medium", "high"].includes(node.impact)) throw new Error("Invalid node impact");
  if (node.label.length > 120 || (node.detail?.length ?? 0) > 400 || inspectPublicText(node.label, evidence).length) throw new Error("Unsafe node");
  if (node.detail && inspectPublicText(node.detail, evidence).length) throw new Error("Unsafe detail");
  if (node.blocker && inspectPublicText(node.blocker, evidence).length) throw new Error("Unsafe blocker");
}

function cloneGraph(graph: SemanticGraph): SemanticGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    agents: graph.agents.map((agent) => ({ ...agent })),
    processedEventIds: [...graph.processedEventIds],
  };
}
