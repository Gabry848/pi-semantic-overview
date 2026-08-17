import { inspectPublicText, isGenericTitle, publicProjection, safePublicText, validatePublicGraph } from "./privacy.js";
import { createGraph, isLegalTransition, wouldCycle } from "./reducer.js";
import {
  EDGE_KINDS, NODE_STATUSES, NODE_TYPES,
  type GraphAgent, type GraphEdge, type GraphNode, type PublicGraph, type SemanticGraph,
} from "./types.js";

export const SNAPSHOT_ENTRY = "semantic-overview:snapshot";

export interface SnapshotDataV2 {
  schemaVersion: 2;
  sessionId: string;
  graph: PublicGraph;
}

interface SnapshotDataV1 {
  schemaVersion: 1;
  sessionId: string;
  graph: {
    version: number;
    updatedAt: number;
    nodes: unknown[];
    edges: unknown[];
    agents: unknown[];
  };
}

export function serializeSnapshot(graph: SemanticGraph, evidence: readonly import("./types.js").EvidenceItem[] = []): SnapshotDataV2 {
  const projected = publicProjection(graph, evidence);
  validatePublicGraph(projected, evidence);
  return { schemaVersion: 2, sessionId: graph.sessionId, graph: projected };
}

export function restoreFromBranch(entries: readonly unknown[], fallbackSessionId = "session"): SemanticGraph {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SNAPSHOT_ENTRY) continue;
    try { return parseSnapshot(entry.data, fallbackSessionId); } catch { /* Try the previous valid snapshot. */ }
  }
  return createGraph(fallbackSessionId);
}

export function parseSnapshot(value: unknown, fallbackSessionId = "session"): SemanticGraph {
  if (!isRecord(value)) throw new Error("Invalid snapshot");
  if (value.schemaVersion === 2) return parseV2(value, fallbackSessionId);
  if (value.schemaVersion === 1) return migrateV1(value, fallbackSessionId);
  throw new Error("Invalid snapshot version");
}

function parseV2(value: Record<string, unknown>, fallbackSessionId: string): SemanticGraph {
  if (!safeId(value.sessionId, 120) || !isRecord(value.graph)) throw new Error("Invalid v2 snapshot");
  const graph = value.graph as unknown as PublicGraph;
  if (graph.schemaVersion !== 2 || !Number.isInteger(graph.semanticRevision) || !finite(graph.updatedAt) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.agents)) throw new Error("Invalid v2 graph");
  validatePublicGraph(graph);
  validateStructure(graph);
  return {
    schemaVersion: 2,
    semanticRevision: graph.semanticRevision,
    telemetryRevision: 0,
    sessionId: value.sessionId || fallbackSessionId,
    updatedAt: graph.updatedAt,
    nodes: graph.nodes.map(cloneNode),
    edges: graph.edges.map((edge) => ({ ...edge })),
    agents: graph.agents.map((agent) => ({ ...agent })),
    processedEventIds: [],
  };
}

/** Safely imports only concrete public v1 milestones. Generic/restricted cards,
 * telemetry revisions, and excess noise are discarded. No new history is invented. */
function migrateV1(value: Record<string, unknown>, fallbackSessionId: string): SemanticGraph {
  const snapshot = value as unknown as SnapshotDataV1;
  if (typeof snapshot.sessionId !== "string" || !snapshot.graph || !Array.isArray(snapshot.graph.nodes) || !Array.isArray(snapshot.graph.edges) || !Array.isArray(snapshot.graph.agents)) throw new Error("Invalid v1 snapshot");
  const sessionId = safeId(snapshot.sessionId, 120) ? snapshot.sessionId : safeId(fallbackSessionId, 120) ? fallbackSessionId : "session";
  const graph = createGraph(sessionId, finite(snapshot.graph.updatedAt) ? snapshot.graph.updatedAt : Date.now());

  const legacyAgents = new Map<string, GraphAgent>();
  for (const raw of snapshot.graph.agents) {
    if (!isRecord(raw) || !safeId(raw.id, 80) || typeof raw.label !== "string" || typeof raw.status !== "string" || !["idle", "running", "completed", "failed"].includes(raw.status)) continue;
    const label = safePublicText(raw.label, [], 120) ?? (raw.id === "main" ? "Main agent" : "Specialist");
    legacyAgents.set(raw.id, {
      id: raw.id,
      label,
      status: raw.status as GraphAgent["status"],
      ...(safeId(raw.parentId, 80) ? { parentId: raw.parentId } : {}),
      ...(finite(raw.startedAt) ? { startedAt: raw.startedAt } : {}),
      ...(finite(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
    });
  }
  if (!legacyAgents.has("main")) legacyAgents.set("main", { id: "main", label: "Main agent", status: "idle" });

  const candidates: GraphNode[] = [];
  for (const raw of snapshot.graph.nodes) {
    if (!isRecord(raw) || !safeId(raw.id) || !safeId(raw.agentId) || !NODE_TYPES.includes(raw.type as never) || !NODE_STATUSES.includes(raw.status as never) || typeof raw.label !== "string" || !finite(raw.startedAt)) continue;
    const title = safePublicText(raw.label, [], 160);
    if (!title || isGenericTitle(title) || inspectPublicText(title).length) continue;
    const summaryText = typeof raw.detail === "string" ? safePublicText(raw.detail, [], 600) : undefined;
    const concern = typeof raw.blocker === "string" ? safePublicText(raw.blocker, [], 600) : undefined;
    candidates.push({
      id: raw.id,
      type: raw.type as GraphNode["type"],
      title,
      agentId: raw.agentId,
      status: raw.status as GraphNode["status"],
      startedAt: raw.startedAt,
      ...(finite(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
      ...(raw.impact === "low" || raw.impact === "medium" || raw.impact === "high" ? { impact: raw.impact } : {}),
      ...(summaryText ? { summary: [summaryText] } : {}),
      ...(concern ? { concern } : {}),
    });
  }

  const selected: GraphNode[] = [];
  const byAgent = new Map<string, GraphNode[]>();
  for (const node of candidates) {
    const owned = byAgent.get(node.agentId) ?? [];
    owned.push(node);
    byAgent.set(node.agentId, owned);
  }
  for (const [agentId, owned] of byAgent) {
    owned.sort((a, b) => a.startedAt - b.startedAt);
    selected.push(...selectEvenly(owned, agentId === "main" ? 10 : 6));
  }
  selected.sort((a, b) => a.startedAt - b.startedAt);
  for (const agentId of new Set(selected.map((node) => node.agentId))) {
    const active = selected.filter((node) => node.agentId === agentId && node.status === "active");
    for (const stale of active.slice(0, -1)) selected.splice(selected.indexOf(stale), 1);
  }
  const selectedIds = new Set(selected.map((node) => node.id));
  graph.nodes = selected;
  graph.agents = [...legacyAgents.values()]
    .filter((agent) => agent.id === "main" || selected.some((node) => node.agentId === agent.id))
    .map((agent) => agent.id === "main"
      ? { id: agent.id, label: agent.label, status: agent.status, ...(agent.startedAt === undefined ? {} : { startedAt: agent.startedAt }), ...(agent.endedAt === undefined ? {} : { endedAt: agent.endedAt }) }
      : { ...agent, parentId: "main" });
  for (const node of selected) if (!graph.agents.some((agent) => agent.id === node.agentId)) graph.agents.push({ id: node.agentId, label: "Specialist", parentId: "main", status: "idle" });

  for (const raw of snapshot.graph.edges) {
    if (!isRecord(raw) || !safeId(raw.id) || !safeId(raw.from) || !safeId(raw.to) || !selectedIds.has(raw.from) || !selectedIds.has(raw.to) || typeof raw.kind !== "string") continue;
    const kind = raw.kind === "integrates" ? "integrates" : EDGE_KINDS.includes(raw.kind as never) ? raw.kind as GraphEdge["kind"] : undefined;
    if (!kind) continue;
    const edge: GraphEdge = { id: raw.id, from: raw.from, to: raw.to, kind, ...(kind === "integrates" ? { strength: "final" } : {}) };
    if (!graph.edges.some((item) => item.id === edge.id) && !wouldCycle(graph, edge.from, edge.to)) graph.edges.push(edge);
  }
  graph.semanticRevision = selected.length > 0 ? 1 : 0;
  return graph;
}

function validateStructure(graph: PublicGraph): void {
  const agentIds = new Set<string>();
  for (const agent of graph.agents) {
    if (!agent || !safeId(agent.id, 80) || agentIds.has(agent.id) || typeof agent.label !== "string" || !["idle", "running", "completed", "failed"].includes(agent.status) || (agent.parentId !== undefined && !safeId(agent.parentId, 80)) || (agent.startedAt !== undefined && !finite(agent.startedAt)) || (agent.endedAt !== undefined && !finite(agent.endedAt))) throw new Error("Invalid persisted agent");
    agentIds.add(agent.id);
  }
  const main = graph.agents.find((agent) => agent.id === "main");
  if (!main || main.parentId !== undefined) throw new Error("Invalid persisted main agent");
  for (const agent of graph.agents) {
    if (agent.id !== "main" && (!agent.parentId || !agentIds.has(agent.parentId) || agent.parentId === agent.id)) throw new Error("Invalid persisted agent parent");
    const seen = new Set<string>();
    let current: GraphAgent | undefined = agent;
    while (current?.parentId) {
      if (seen.has(current.id)) throw new Error("Cyclic persisted agent topology");
      seen.add(current.id);
      current = graph.agents.find((candidate) => candidate.id === current!.parentId);
    }
  }
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || !safeId(node.id) || nodeIds.has(node.id) || !safeId(node.agentId) || !agentIds.has(node.agentId) || !NODE_TYPES.includes(node.type) || !NODE_STATUSES.includes(node.status) || typeof node.title !== "string" || !finite(node.startedAt) || (node.endedAt !== undefined && !finite(node.endedAt)) || (node.impact !== undefined && !["low", "medium", "high"].includes(node.impact)) || (node.supersededBy !== undefined && !safeId(node.supersededBy))) throw new Error("Invalid persisted node");
    nodeIds.add(node.id);
  }
  for (const node of graph.nodes) if (node.supersededBy && !nodeIds.has(node.supersededBy)) throw new Error("Unknown supersession target");
  for (const agent of graph.agents) {
    if (graph.nodes.filter((node) => node.agentId === agent.id && !node.supersededBy && node.status === "active").length > 1) throw new Error("Multiple persisted active milestones");
  }
  const edgeIds = new Set<string>();
  const accepted: GraphEdge[] = [];
  for (const edge of graph.edges) {
    if (!edge || !safeId(edge.id) || edgeIds.has(edge.id) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !EDGE_KINDS.includes(edge.kind) || edge.from === edge.to || (edge.strength !== undefined && !["intermediate", "final"].includes(edge.strength)) || wouldCycle({ edges: accepted } as SemanticGraph, edge.from, edge.to)) throw new Error("Invalid persisted edge");
    edgeIds.add(edge.id);
    accepted.push(edge);
  }
}

function selectEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const selected: T[] = [];
  for (let index = 0; index < limit; index++) selected.push(items[Math.round(index * (items.length - 1) / (limit - 1))]!);
  return selected;
}

function cloneNode(node: GraphNode): GraphNode {
  return {
    ...node,
    ...(node.summary ? { summary: [...node.summary] } : {}),
    ...(node.macroSteps ? { macroSteps: node.macroSteps.map((step) => ({ ...step })) } : {}),
    ...(node.evidenceClaims ? { evidenceClaims: [...node.evidenceClaims] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function safeId(value: unknown, max = 100): value is string {
  return typeof value === "string" && value.length <= max && /^[-:_a-zA-Z0-9]+$/.test(value) && !/(?:api[-_]?key|token|secret|password|authorization)/i.test(value);
}

export const persistedTransitionIsLegal = isLegalTransition;
