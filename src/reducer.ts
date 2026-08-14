import { inspectPublicText } from "./privacy.js";
import { NODE_STATUSES, NODE_TYPES, type EvidenceItem, type GraphEdge, type GraphNode, type GraphPatch, type NodeStatus, type NodeType, type NormalizedEvent, type SemanticGraph } from "./types.js";

const LEGAL_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  pending: ["active", "cancelled"],
  active: ["completed", "blocked", "failed", "cancelled"],
  blocked: ["active", "completed", "failed", "cancelled"],
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
      ensureStableNode(next, event, "goal", "Active objective", "goal");
      break;
    case "agent.completed":
      agent.status = event.failed ? "failed" : "idle";
      agent.endedAt = event.timestamp;
      // A Pi agent run is not necessarily a workflow phase boundary. Keep the
      // semantic phase open across runs so the model can reconcile it in place.
      if (event.failed) {
        const phase = latestActiveNode(next, event.agentId);
        if (phase && isLegalTransition(phase.status, "blocked")) {
          phase.status = "blocked";
          phase.blocker = "Agent run did not complete";
          phase.impact = "high";
          phase.revision++;
        }
        ensureStableNode(next, event, "blocker", "Agent progress blocked", "run-blocker", "blocked");
      }
      break;
    case "turn.started":
      agent.status = "running";
      break;
    case "turn.completed": {
      const phase = latestActiveNode(next, event.agentId);
      if (phase) {
        phase.durationMs = Math.max(0, event.timestamp - phase.startedAt);
        phase.revision++;
      }
      break;
    }
    case "tool.started": {
      const phaseType = event.toolClass ?? "implementation";
      const phase = ensureStableNode(next, event, phaseType, labelForType(phaseType), "current");
      if (phase.status === "blocked") {
        phase.status = "active";
        delete phase.blocker;
        phase.revision++;
      }
      if (phase.status === "active" && phase.type !== phaseType) {
        phase.type = phaseType;
        phase.label = labelForType(phaseType);
        phase.revision++;
      }
      const blocker = [...next.nodes].reverse().find((node) => node.agentId === event.agentId && node.type === "blocker" && node.status === "blocked");
      if (blocker && isLegalTransition(blocker.status, "completed")) {
        blocker.status = "completed";
        blocker.endedAt = event.timestamp;
        blocker.durationMs = Math.max(0, event.timestamp - blocker.startedAt);
        blocker.revision++;
      }
      break;
    }
    case "tool.completed": {
      const node = latestActiveNode(next, event.agentId);
      if (node) {
        node.durationMs = event.durationMs ?? Math.max(0, event.timestamp - node.startedAt);
        node.revision++;
      }
      if (event.failed) {
        if (node && isLegalTransition(node.status, "blocked")) {
          node.status = "blocked";
          node.impact = "high";
          node.blocker = "Execution did not complete";
        }
        const blocker = ensureStableNode(next, event, "blocker", "Execution progress blocked", "tool-blocker", "blocked");
        blocker.blocker = "Execution did not complete";
        if (node) addEdge(next, node.id, blocker.id, "blocks");
      }
      break;
    }
    case "subagent.created":
      agent.status = "idle";
      ensureStableNode(next, event, "delegation", "Delegated work", "delegation");
      break;
    case "subagent.started":
      agent.status = "running";
      agent.startedAt ??= event.timestamp;
      ensureStableNode(next, event, "delegation", "Delegated work", "delegation");
      activateLatest(next, event.agentId, "delegation");
      break;
    case "subagent.completed":
      agent.status = "completed";
      agent.endedAt = event.timestamp;
      closeActiveNodes(next, event.agentId, event.timestamp, "completed", event.durationMs);
      ensureStableNode(next, event, "handoff", "Subagent handoff", "handoff", "completed");
      break;
    case "subagent.failed":
      agent.status = "failed";
      agent.endedAt = event.timestamp;
      closeActiveNodes(next, event.agentId, event.timestamp, "failed", event.durationMs);
      ensureStableNode(next, event, "blocker", "Delegated work blocked", "delegation-blocker", "blocked");
      break;
    case "subagent.steered": {
      const delegation = ensureStableNode(next, event, "delegation", "Delegated work", "delegation");
      delegation.label = "Delegated work redirected";
      delegation.revision++;
      break;
    }
    case "subagent.compacted":
    case "session.compacted":
    case "session.tree":
      // Compaction and branch telemetry are implementation mechanics, not macro
      // workflow phases. Evidence can still inform the next reconciliation.
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

function ensureStableNode(graph: SemanticGraph, event: NormalizedEvent, type: NodeType, label: string, slot: string, status: NodeStatus = "active"): GraphNode {
  const baseId = `n:${event.agentId}:${slot}`;
  const candidates = graph.nodes.filter((node) => node.id === baseId || node.id.startsWith(`${baseId}:`));
  const ongoing = [...candidates].reverse().find((node) => !isTerminal(node.status));
  if (ongoing) return ongoing;
  const existing = candidates[0];
  if (existing && (slot === "goal" || status === "completed")) return existing;
  const id = existing ? `${baseId}:${candidates.length + 1}` : baseId;
  const node: GraphNode = {
    id,
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

function latestActiveNode(graph: SemanticGraph, agentId: string): GraphNode | undefined {
  return [...graph.nodes].reverse().find((node) => node.agentId === agentId && node.status === "active" && node.type !== "goal");
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
  const safePatch = stripUnsafeOptionalText(patch, evidence);
  validatePatch(graph, safePatch, evidence);
  const next = cloneGraph(graph);
  for (const operation of safePatch.operations) {
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

function stripUnsafeOptionalText(patch: GraphPatch, evidence: readonly EvidenceItem[]): GraphPatch {
  return {
    ...patch,
    operations: patch.operations.map((operation) => {
      if (operation.op === "addNode") {
        const node = { ...operation.node };
        if (node.detail && inspectPublicText(node.detail, evidence).length) delete node.detail;
        if (node.blocker && inspectPublicText(node.blocker, evidence).length) delete node.blocker;
        return { ...operation, node };
      }
      if (operation.op === "updateNode") {
        const changes = { ...operation.changes };
        if (changes.detail && inspectPublicText(changes.detail, evidence).length) delete changes.detail;
        if (changes.blocker && inspectPublicText(changes.blocker, evidence).length) delete changes.blocker;
        return { ...operation, changes };
      }
      return operation;
    }),
  };
}

export function validatePatch(graph: SemanticGraph, patch: GraphPatch, evidence: readonly EvidenceItem[] = []): void {
  if (!Number.isInteger(patch.baseVersion) || patch.baseVersion !== graph.version) throw new Error("Stale patch");
  if (!Array.isArray(patch.operations) || patch.operations.length > 24) throw new Error("Invalid operation count");
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const scratchNodes = new Map(graph.nodes.map((node) => [node.id, { ...node }]));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const scratchEdges = graph.edges.map((edge) => ({ ...edge }));
  for (const operation of patch.operations) {
    if (operation.op === "addNode") {
      validateNode(operation.node, evidence);
      if (nodeIds.has(operation.node.id)) throw new Error("Duplicate node");
      const duplicatePhase = isExclusivePhase(operation.node.type) && isRunningPhase(operation.node.status) && [...scratchNodes.values()].some((node) =>
        node.agentId === operation.node.agentId && isExclusivePhase(node.type) && isRunningPhase(node.status),
      );
      if (duplicatePhase) throw new Error("Active macro phase already exists; update it instead");
      nodeIds.add(operation.node.id);
      scratchNodes.set(operation.node.id, { ...operation.node });
    } else if (operation.op === "updateNode") {
      const scratch = scratchNodes.get(operation.id);
      if (!scratch) throw new Error("Missing node");
      for (const [field, text] of [["label", operation.changes.label], ["detail", operation.changes.detail], ["blocker", operation.changes.blocker]] as const) {
        if (text && inspectPublicText(text, evidence).length) throw new Error(`Unsafe patch ${field}`);
      }
      if (operation.changes.type && !NODE_TYPES.includes(operation.changes.type)) throw new Error("Invalid type");
      if (operation.changes.status && (!NODE_STATUSES.includes(operation.changes.status) || !isLegalTransition(scratch.status, operation.changes.status))) throw new Error("Invalid status");
      if (operation.changes.impact && !["low", "medium", "high"].includes(operation.changes.impact)) throw new Error("Invalid impact");
      if (operation.changes.startedAt !== undefined && !Number.isFinite(operation.changes.startedAt)) throw new Error("Invalid startedAt");
      if (operation.changes.endedAt !== undefined && !Number.isFinite(operation.changes.endedAt)) throw new Error("Invalid endedAt");
      if (operation.changes.durationMs !== undefined && (!Number.isFinite(operation.changes.durationMs) || operation.changes.durationMs < 0)) throw new Error("Invalid durationMs");
      if (isGenericTitle(scratch.label) && (!operation.changes.label || isGenericTitle(operation.changes.label))) throw new Error("Action-specific title required");
      const projected = { ...scratch, ...operation.changes };
      const duplicateRunningPhase = isExclusivePhase(projected.type) && isRunningPhase(projected.status) && [...scratchNodes.values()].some((node) =>
        node.id !== projected.id && node.agentId === projected.agentId && isExclusivePhase(node.type) && isRunningPhase(node.status),
      );
      if (duplicateRunningPhase) throw new Error("Active macro phase already exists; complete it before activating planned work");
      Object.assign(scratch, operation.changes);
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
  if (node.label.length > 120 || (node.detail?.length ?? 0) > 400 || inspectPublicText(node.label, evidence).length || isGenericTitle(node.label)) throw new Error("Unsafe or generic node title");
  if (node.detail && inspectPublicText(node.detail, evidence).length) throw new Error("Unsafe detail");
  if (node.blocker && inspectPublicText(node.blocker, evidence).length) throw new Error("Unsafe blocker");
}

function isGenericTitle(label: string): boolean {
  const normalized = label.trim().toLowerCase().replace(/\s+/g, " ");
  const placeholders = new Set([
    "active objective", "reviewing progress", "decision point", "planning next steps", "delegating work",
    "delegated work", "investigating context", "implementing changes", "verifying outcome", "integrating results",
    "progress blocked", "execution progress blocked", "agent progress blocked", "delegated work blocked",
    "revising approach", "preparing handoff", "subagent handoff",
  ]);
  if (placeholders.has(normalized)) return true;
  return /^(goal|reflection|decision|planning|delegation|investigation|implementation|verification|integration|blocker|revision|handoff)( pending| active| completed| blocked| failed| cancelled)?$/.test(normalized);
}

function isExclusivePhase(type: NodeType): boolean {
  return type !== "goal" && type !== "blocker" && type !== "delegation" && type !== "handoff";
}

function isRunningPhase(status: NodeStatus): boolean {
  return status === "active" || status === "blocked";
}

function isTerminal(status: NodeStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
