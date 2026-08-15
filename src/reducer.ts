import { inspectPublicText, isGenericTitle, sanitizeNode, safePublicText } from "./privacy.js";
import {
  EDGE_KINDS, NODE_STATUSES, NODE_TYPES,
  type EvidenceItem, type GraphAgent, type GraphEdge, type GraphNode, type GraphPatch,
  type NodeStatus, type NormalizedEvent, type PatchOperation, type SemanticGraph,
} from "./types.js";

export const MAX_MAIN_MILESTONES = 12;

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
    schemaVersion: 2,
    semanticRevision: 0,
    telemetryRevision: 0,
    sessionId,
    updatedAt: now,
    nodes: [],
    edges: [],
    agents: [{ id: "main", label: "Main agent", status: "idle" }],
    processedEventIds: [],
  };
}

/** Lifecycle reduction is deliberately telemetry-only. It may update agent presence,
 * but never authors milestones or advances the semantic revision. */
export function reduceEvent(graph: SemanticGraph, event: NormalizedEvent): SemanticGraph {
  if (graph.processedEventIds.includes(event.id)) return graph;
  const next = cloneGraph(graph);
  next.processedEventIds.push(event.id);
  if (next.processedEventIds.length > 500) next.processedEventIds.splice(0, next.processedEventIds.length - 500);
  next.telemetryRevision++;
  const agent = upsertEventAgent(next, event);
  switch (event.kind) {
    case "agent.started":
    case "turn.started":
    case "subagent.started":
      agent.status = "running";
      agent.startedAt ??= event.timestamp;
      break;
    case "agent.completed":
      agent.status = event.failed ? "failed" : "idle";
      agent.endedAt = event.timestamp;
      break;
    case "subagent.completed":
      agent.status = "completed";
      agent.endedAt = event.timestamp;
      break;
    case "subagent.failed":
      agent.status = "failed";
      agent.endedAt = event.timestamp;
      break;
    default:
      break;
  }
  return next;
}

function upsertEventAgent(graph: SemanticGraph, event: NormalizedEvent): GraphAgent {
  let agent = graph.agents.find((item) => item.id === event.agentId);
  if (!agent) {
    agent = { id: event.agentId, label: "Specialist", parentId: "main", status: "idle" };
    graph.agents.push(agent);
  }
  return agent;
}

export function applyPatch(graph: SemanticGraph, patch: GraphPatch, evidence: readonly EvidenceItem[] = []): SemanticGraph {
  const safePatch = sanitizePatch(patch, evidence);
  validatePatch(graph, safePatch, evidence);
  if (safePatch.operations.length === 0) return graph;
  const next = cloneGraph(graph);
  for (const operation of safePatch.operations) applyOperation(next, operation);
  if (sameSemanticState(graph, next)) return graph;
  next.semanticRevision++;
  next.updatedAt = Date.now();
  return next;
}

function applyOperation(graph: SemanticGraph, operation: PatchOperation): void {
  switch (operation.op) {
    case "addNode":
      graph.nodes.push({ ...operation.node, summary: operation.node.summary ? [...operation.node.summary] : undefined, macroSteps: operation.node.macroSteps?.map((step) => ({ ...step })), evidenceClaims: operation.node.evidenceClaims ? [...operation.node.evidenceClaims] : undefined } as GraphNode);
      break;
    case "updateNode": {
      const node = graph.nodes.find((item) => item.id === operation.id)!;
      Object.assign(node, cloneChanges(operation.changes));
      break;
    }
    case "addEdge":
      graph.edges.push({ ...operation.edge });
      break;
    case "upsertAgent": {
      const index = graph.agents.findIndex((agent) => agent.id === operation.agent.id);
      if (index >= 0) graph.agents[index] = { ...graph.agents[index]!, ...operation.agent };
      else graph.agents.push({ ...operation.agent });
      break;
    }
    case "consolidateNodes":
      for (const id of operation.ids) graph.nodes.find((node) => node.id === id)!.supersededBy = operation.node.id;
      graph.nodes.push(cloneNode(operation.node));
      graph.edges.push(...rewiredConsolidationEdges(graph, operation.ids, operation.node.id));
      for (const edge of operation.edges ?? []) graph.edges.push({ ...edge });
      break;
    case "supersedeNodes":
      for (const id of operation.ids) graph.nodes.find((node) => node.id === id)!.supersededBy = operation.by;
      break;
    case "checkBranch":
      graph.edges.push({ id: operation.id, from: operation.branchNodeId, to: operation.mainNodeId, kind: "checks", strength: "intermediate", ...(operation.note ? { note: operation.note } : {}) });
      break;
    case "integrateBranch":
      graph.edges.push({ id: operation.id, from: operation.branchNodeId, to: operation.mainNodeId, kind: "integrates", strength: "final", ...(operation.note ? { note: operation.note } : {}) });
      break;
  }
}

function cloneChanges(changes: Extract<PatchOperation, { op: "updateNode" }>["changes"]) {
  return {
    ...changes,
    ...(changes.summary ? { summary: [...changes.summary] } : {}),
    ...(changes.macroSteps ? { macroSteps: changes.macroSteps.map((step) => ({ ...step })) } : {}),
    ...(changes.evidenceClaims ? { evidenceClaims: [...changes.evidenceClaims] } : {}),
  };
}

function sanitizePatch(patch: GraphPatch, evidence: readonly EvidenceItem[]): GraphPatch {
  return {
    ...patch,
    operations: patch.operations.map((operation): PatchOperation => {
      if (operation.op === "addNode") return { ...operation, node: sanitizeOptionalNodeText(operation.node, evidence) };
      if (operation.op === "consolidateNodes") {
        const edges = operation.edges?.map((edge) => sanitizeEdgeText(edge, evidence));
        return { ...operation, node: sanitizeOptionalNodeText(operation.node, evidence), ...(edges ? { edges } : {}) };
      }
      if (operation.op === "updateNode") {
        const changes = { ...operation.changes };
        for (const key of ["objective", "mandate", "outcome", "rationale", "currentWork", "concern", "nextStep", "contribution"] as const) {
          if (changes[key] !== undefined && !safePublicText(changes[key], evidence)) delete changes[key];
        }
        if (changes.summary) {
          const safe = changes.summary.filter((text) => safePublicText(text, evidence)).slice(0, 4);
          if (safe.length) changes.summary = safe; else delete changes.summary;
        }
        if (changes.evidenceClaims) {
          const safe = changes.evidenceClaims.filter((text) => safePublicText(text, evidence)).slice(0, 8);
          if (safe.length) changes.evidenceClaims = safe; else delete changes.evidenceClaims;
        }
        if (changes.macroSteps) {
          const safe = changes.macroSteps.flatMap((step) => {
            const action = safePublicText(step.action, evidence);
            if (!action) return [];
            const result = safePublicText(step.result, evidence);
            return [{ action, ...(result ? { result } : {}) }];
          }).slice(0, 12);
          if (safe.length) changes.macroSteps = safe; else delete changes.macroSteps;
        }
        return { ...operation, changes };
      }
      if (operation.op === "addEdge") return { ...operation, edge: sanitizeEdgeText(operation.edge, evidence) };
      if (operation.op === "upsertAgent") {
        const agent = { ...operation.agent };
        if (agent.mandate && !safePublicText(agent.mandate, evidence)) delete agent.mandate;
        return { ...operation, agent };
      }
      if ((operation.op === "checkBranch" || operation.op === "integrateBranch") && operation.note && !safePublicText(operation.note, evidence)) {
        const clean = { ...operation }; delete clean.note; return clean;
      }
      return operation;
    }),
  };
}

function sanitizeOptionalNodeText(node: GraphNode, evidence: readonly EvidenceItem[]): GraphNode {
  const sanitized = sanitizeNode(node, evidence);
  if (!sanitized) return { ...node }; // Required-title failure is handled by validation; never substitute a label.
  return sanitized;
}

function sanitizeEdgeText(edge: GraphEdge, evidence: readonly EvidenceItem[]): GraphEdge {
  if (!edge.note || safePublicText(edge.note, evidence)) return { ...edge };
  const clean = { ...edge }; delete clean.note; return clean;
}

export function validatePatch(graph: SemanticGraph, patch: GraphPatch, evidence: readonly EvidenceItem[] = []): void {
  if (!Number.isInteger(patch.baseRevision) || patch.baseRevision !== graph.semanticRevision) throw new Error("Stale semantic patch");
  if (!Array.isArray(patch.operations) || patch.operations.length > 32) throw new Error("Invalid operation count");
  const scratch = cloneGraph(graph);
  for (const operation of patch.operations) {
    switch (operation.op) {
      case "addNode":
        validateNewNode(scratch, operation.node, evidence);
        scratch.nodes.push(cloneNode(operation.node));
        break;
      case "updateNode":
        validateUpdate(scratch, operation.id, operation.changes, evidence);
        Object.assign(scratch.nodes.find((node) => node.id === operation.id)!, cloneChanges(operation.changes));
        break;
      case "addEdge":
        validateEdge(scratch, operation.edge, evidence);
        scratch.edges.push({ ...operation.edge });
        break;
      case "upsertAgent":
        validateAgent(operation.agent, evidence);
        upsertScratchAgent(scratch, operation.agent);
        break;
      case "consolidateNodes":
        validateConsolidation(scratch, operation, evidence);
        for (const id of operation.ids) scratch.nodes.find((node) => node.id === id)!.supersededBy = operation.node.id;
        scratch.nodes.push(cloneNode(operation.node));
        scratch.edges.push(...rewiredConsolidationEdges(scratch, operation.ids, operation.node.id));
        for (const edge of operation.edges ?? []) { validateEdge(scratch, edge, evidence); scratch.edges.push({ ...edge }); }
        break;
      case "supersedeNodes":
        validateSupersession(scratch, operation.ids, operation.by);
        for (const id of operation.ids) scratch.nodes.find((node) => node.id === id)!.supersededBy = operation.by;
        break;
      case "checkBranch": {
        const edge = branchEdge(scratch, operation.id, operation.branchNodeId, operation.mainNodeId, "checks", operation.note, evidence);
        scratch.edges.push(edge);
        break;
      }
      case "integrateBranch": {
        const edge = branchEdge(scratch, operation.id, operation.branchNodeId, operation.mainNodeId, "integrates", operation.note, evidence);
        scratch.edges.push(edge);
        break;
      }
      default:
        throw new Error("Unknown patch operation");
    }
  }
  validateAgentTopology(scratch);
  for (const agent of scratch.agents) {
    const active = scratch.nodes.filter((node) => node.agentId === agent.id && !node.supersededBy && node.status === "active");
    if (active.length > 1) throw new Error("Multiple active milestones for one agent");
  }
}

function validateNewNode(graph: SemanticGraph, node: GraphNode, evidence: readonly EvidenceItem[]): void {
  validateNode(node, evidence);
  if (graph.nodes.some((item) => item.id === node.id)) throw new Error("Duplicate node");
  if (!graph.agents.some((agent) => agent.id === node.agentId)) throw new Error("Unknown node agent");
  if (!qualifiesAsMilestone(node)) throw new Error("New node lacks a real semantic milestone");
  if (node.agentId === "main" && visibleMainCount(graph) >= MAX_MAIN_MILESTONES) throw new Error("Main milestone cap reached; consolidate first");
}

function validateUpdate(graph: SemanticGraph, id: string, changes: Extract<PatchOperation, { op: "updateNode" }>["changes"], evidence: readonly EvidenceItem[]): void {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node) throw new Error("Missing node");
  if (node.supersededBy) throw new Error("Cannot update superseded node");
  validateTextFields(changes as Partial<GraphNode>, evidence);
  if (changes.title !== undefined && (changes.title.length > 160 || isGenericTitle(changes.title) || inspectPublicText(changes.title, evidence).length)) throw new Error("Unsafe or generic node title");
  if (changes.type && !NODE_TYPES.includes(changes.type)) throw new Error("Invalid type");
  if (changes.status && (!NODE_STATUSES.includes(changes.status) || !isLegalTransition(node.status, changes.status))) throw new Error("Invalid status transition");
  if (changes.impact && !["low", "medium", "high"].includes(changes.impact)) throw new Error("Invalid impact");
  for (const value of [changes.startedAt, changes.endedAt]) if (value !== undefined && !Number.isFinite(value)) throw new Error("Invalid timestamp");
}

function validateConsolidation(graph: SemanticGraph, operation: Extract<PatchOperation, { op: "consolidateNodes" }>, evidence: readonly EvidenceItem[]): void {
  const ids = [...new Set(operation.ids)];
  if (ids.length < 2 || ids.length !== operation.ids.length) throw new Error("Consolidation requires distinct source nodes");
  const sources = ids.map((id) => graph.nodes.find((node) => node.id === id));
  if (sources.some((node) => !node || node.supersededBy)) throw new Error("Invalid consolidation source");
  validateNode(operation.node, evidence);
  if (!qualifiesAsMilestone(operation.node)) throw new Error("Consolidated node lacks semantic content");
  if (graph.nodes.some((node) => node.id === operation.node.id)) throw new Error("Duplicate consolidation target");
  if (sources.some((node) => node!.agentId !== operation.node.agentId)) throw new Error("Consolidation cannot cross agents");
}

function validateSupersession(graph: SemanticGraph, ids: string[], by: string): void {
  if (!ids.length || new Set(ids).size !== ids.length || ids.includes(by)) throw new Error("Invalid supersession");
  const target = graph.nodes.find((node) => node.id === by);
  if (!target || target.supersededBy) throw new Error("Missing supersession target");
  for (const id of ids) {
    const source = graph.nodes.find((node) => node.id === id);
    if (!source || source.supersededBy || source.agentId !== target.agentId) throw new Error("Invalid supersession source");
  }
}

function branchEdge(graph: SemanticGraph, id: string, branchNodeId: string, mainNodeId: string, kind: "checks" | "integrates", note: string | undefined, evidence: readonly EvidenceItem[]): GraphEdge {
  const branch = graph.nodes.find((node) => node.id === branchNodeId && !node.supersededBy);
  const main = graph.nodes.find((node) => node.id === mainNodeId && !node.supersededBy);
  const branchAgent = branch ? graph.agents.find((agent) => agent.id === branch.agentId) : undefined;
  if (!branch || !main || main.agentId !== "main" || branch.agentId === "main" || branchAgent?.parentId !== "main") throw new Error("Ambiguous branch correlation");
  const edge: GraphEdge = { id, from: branchNodeId, to: mainNodeId, kind, strength: kind === "integrates" ? "final" : "intermediate", ...(note ? { note } : {}) };
  validateEdge(graph, edge, evidence);
  return edge;
}

function validateNode(node: GraphNode, evidence: readonly EvidenceItem[]): void {
  if (!safeId(node.id) || !safeId(node.agentId) || !NODE_TYPES.includes(node.type) || !NODE_STATUSES.includes(node.status)) throw new Error("Invalid node");
  if (typeof node.title !== "string" || node.title.length > 160 || isGenericTitle(node.title) || inspectPublicText(node.title, evidence).length) throw new Error("Unsafe or generic node title");
  if (!Number.isFinite(node.startedAt) || (node.endedAt !== undefined && !Number.isFinite(node.endedAt))) throw new Error("Invalid node timestamp");
  if (node.impact !== undefined && !["low", "medium", "high"].includes(node.impact)) throw new Error("Invalid node impact");
  if (node.supersededBy !== undefined && !safeId(node.supersededBy)) throw new Error("Invalid supersession id");
  validateTextFields(node, evidence);
}

function validateTextFields(node: Partial<GraphNode>, evidence: readonly EvidenceItem[]): void {
  for (const value of [node.objective, node.mandate, node.outcome, node.rationale, node.currentWork, node.concern, node.nextStep, node.contribution]) {
    if (value !== undefined && (typeof value !== "string" || value.length > 600 || inspectPublicText(value, evidence).length)) throw new Error("Unsafe node text");
  }
  if (node.summary && (node.summary.length > 4 || node.summary.some((value) => typeof value !== "string" || value.length > 600 || inspectPublicText(value, evidence).length))) throw new Error("Unsafe summary");
  if (node.evidenceClaims && (node.evidenceClaims.length > 8 || node.evidenceClaims.some((value) => typeof value !== "string" || value.length > 600 || inspectPublicText(value, evidence).length))) throw new Error("Unsafe evidence claim");
  if (node.macroSteps && (node.macroSteps.length > 12 || node.macroSteps.some((step) => !step || typeof step.action !== "string" || step.action.length > 500 || inspectPublicText(step.action, evidence).length || (step.result !== undefined && (typeof step.result !== "string" || step.result.length > 500 || inspectPublicText(step.result, evidence).length))))) throw new Error("Unsafe macro step");
}

function qualifiesAsMilestone(node: GraphNode): boolean {
  if (["decision", "blocker", "delegation", "revision", "verification", "integration", "handoff"].includes(node.type)) return true;
  return Boolean(node.outcome || node.rationale || node.concern || node.nextStep || node.mandate || node.contribution || node.macroSteps?.length);
}

function validateEdge(graph: SemanticGraph, edge: GraphEdge, evidence: readonly EvidenceItem[]): void {
  if (!safeId(edge.id) || graph.edges.some((item) => item.id === edge.id) || !graph.nodes.some((node) => node.id === edge.from) || !graph.nodes.some((node) => node.id === edge.to) || edge.from === edge.to || !EDGE_KINDS.includes(edge.kind)) throw new Error("Invalid edge");
  if (edge.strength !== undefined && !["intermediate", "final"].includes(edge.strength)) throw new Error("Invalid edge strength");
  if (edge.note !== undefined && (edge.note.length > 400 || inspectPublicText(edge.note, evidence).length)) throw new Error("Unsafe edge note");
  if (wouldCycle(graph, edge.from, edge.to)) throw new Error("Cyclic edge");
}

function validateAgent(agent: GraphAgent, evidence: readonly EvidenceItem[]): void {
  if (!safeId(agent.id, 80) || typeof agent.label !== "string" || inspectPublicText(agent.label, evidence).length || !["idle", "running", "completed", "failed"].includes(agent.status)) throw new Error("Invalid agent");
  if (agent.parentId !== undefined && !safeId(agent.parentId, 80)) throw new Error("Invalid agent parent");
  if (agent.mandate !== undefined && inspectPublicText(agent.mandate, evidence).length) throw new Error("Unsafe agent mandate");
}

function validateAgentTopology(graph: SemanticGraph): void {
  const main = graph.agents.find((agent) => agent.id === "main");
  if (!main || main.parentId !== undefined) throw new Error("Invalid main agent topology");
  const ids = new Set(graph.agents.map((agent) => agent.id));
  for (const agent of graph.agents) {
    if (agent.id !== "main" && (!agent.parentId || !ids.has(agent.parentId) || agent.parentId === agent.id)) throw new Error("Invalid agent parent");
    const seen = new Set<string>();
    let current: GraphAgent | undefined = agent;
    while (current?.parentId) {
      if (seen.has(current.id)) throw new Error("Cyclic agent topology");
      seen.add(current.id);
      current = graph.agents.find((candidate) => candidate.id === current!.parentId);
    }
  }
}

function upsertScratchAgent(graph: SemanticGraph, agent: GraphAgent): void {
  const index = graph.agents.findIndex((item) => item.id === agent.id);
  if (index >= 0) graph.agents[index] = { ...graph.agents[index]!, ...agent };
  else graph.agents.push({ ...agent });
}

function rewiredConsolidationEdges(graph: SemanticGraph, sourceIds: readonly string[], targetId: string): GraphEdge[] {
  const sources = new Set(sourceIds);
  const generated: GraphEdge[] = [];
  let sequence = 0;
  for (const edge of graph.edges) {
    const from = sources.has(edge.from) ? targetId : edge.from;
    const to = sources.has(edge.to) ? targetId : edge.to;
    if (from === edge.from && to === edge.to) continue;
    if (from === to) continue;
    const all = [...graph.edges, ...generated];
    if (all.some((candidate) => candidate.from === from && candidate.to === to && candidate.kind === edge.kind)) continue;
    if (wouldCycle({ edges: all }, from, to)) throw new Error("Cyclic consolidated edge");
    generated.push({
      ...edge,
      id: `e:merge:${graph.semanticRevision}:${graph.edges.length}:${sequence++}`,
      from,
      to,
    });
  }
  return generated;
}

export function wouldCycle(graph: Pick<SemanticGraph, "edges">, from: string, to: string): boolean {
  const stack = [to];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of graph.edges) if (edge.from === current) stack.push(edge.to);
  }
  return false;
}

function visibleMainCount(graph: SemanticGraph): number {
  return graph.nodes.filter((node) => node.agentId === "main" && !node.supersededBy).length;
}

function safeId(value: unknown, max = 100): value is string {
  return typeof value === "string" && value.length <= max && /^[-:a-zA-Z0-9]+$/.test(value) && !/(?:api[-_]?key|token|secret|password|authorization)/i.test(value);
}

function cloneNode(node: GraphNode): GraphNode {
  return {
    ...node,
    ...(node.summary ? { summary: [...node.summary] } : {}),
    ...(node.macroSteps ? { macroSteps: node.macroSteps.map((step) => ({ ...step })) } : {}),
    ...(node.evidenceClaims ? { evidenceClaims: [...node.evidenceClaims] } : {}),
  };
}

function sameSemanticState(left: SemanticGraph, right: SemanticGraph): boolean {
  return JSON.stringify([left.nodes, left.edges, left.agents]) === JSON.stringify([right.nodes, right.edges, right.agents]);
}

function cloneGraph(graph: SemanticGraph): SemanticGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(cloneNode),
    edges: graph.edges.map((edge) => ({ ...edge })),
    agents: graph.agents.map((agent) => ({ ...agent })),
    processedEventIds: [...graph.processedEventIds],
  };
}
