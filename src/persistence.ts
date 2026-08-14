import { publicProjection, validatePublicGraph } from "./privacy.js";
import { createGraph, isLegalTransition, wouldCycle } from "./reducer.js";
import { NODE_STATUSES, NODE_TYPES, type EvidenceItem, type PublicGraph, type SemanticGraph } from "./types.js";

export const SNAPSHOT_ENTRY = "semantic-overview:snapshot";

export interface SnapshotData {
  schemaVersion: 1;
  sessionId: string;
  graph: PublicGraph;
}

export function serializeSnapshot(graph: SemanticGraph, evidence: readonly EvidenceItem[] = []): SnapshotData {
  const projected = publicProjection(graph, evidence);
  validatePublicGraph(projected, evidence);
  return { schemaVersion: 1, sessionId: graph.sessionId, graph: projected };
}

export function restoreFromBranch(entries: readonly unknown[], fallbackSessionId = "session"): SemanticGraph {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "custom" || record.customType !== SNAPSHOT_ENTRY) continue;
    try { return parseSnapshot(record.data, fallbackSessionId); } catch { continue; }
  }
  return createGraph(fallbackSessionId);
}

export function parseSnapshot(value: unknown, fallbackSessionId = "session"): SemanticGraph {
  if (!value || typeof value !== "object") throw new Error("Invalid snapshot");
  const snapshot = value as Partial<SnapshotData>;
  if (snapshot.schemaVersion !== 1 || !snapshot.graph || typeof snapshot.sessionId !== "string") throw new Error("Invalid snapshot version");
  const graph = snapshot.graph;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.agents) || !Number.isInteger(graph.version)) throw new Error("Invalid graph");
  validatePublicGraph(graph);
  const safeId = (input: unknown, max = 100): input is string =>
    typeof input === "string" && input.length <= max && /^[-:a-zA-Z0-9]+$/.test(input);
  const finite = (input: unknown): input is number => typeof input === "number" && Number.isFinite(input);
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (
      !node || !safeId(node.id) || nodeIds.has(node.id) || !safeId(node.agentId) ||
      !NODE_TYPES.includes(node.type) || !NODE_STATUSES.includes(node.status) ||
      typeof node.label !== "string" || !finite(node.startedAt) || !Number.isInteger(node.revision) ||
      (node.detail !== undefined && typeof node.detail !== "string") ||
      (node.blocker !== undefined && typeof node.blocker !== "string") ||
      (node.endedAt !== undefined && !finite(node.endedAt)) ||
      (node.durationMs !== undefined && !finite(node.durationMs)) ||
      (node.impact !== undefined && !["low", "medium", "high"].includes(node.impact))
    ) throw new Error("Invalid persisted node");
    nodeIds.add(node.id);
  }
  const agentIds = new Set<string>();
  for (const agent of graph.agents) {
    if (
      !agent || !safeId(agent.id, 80) || agentIds.has(agent.id) || typeof agent.label !== "string" ||
      !["idle", "running", "completed", "failed"].includes(agent.status) ||
      (agent.parentId !== undefined && !safeId(agent.parentId, 80)) ||
      (agent.startedAt !== undefined && !finite(agent.startedAt)) ||
      (agent.endedAt !== undefined && !finite(agent.endedAt))
    ) throw new Error("Invalid persisted agent");
    agentIds.add(agent.id);
  }
  if (graph.nodes.some((node) => !agentIds.has(node.agentId))) throw new Error("Unknown persisted agent");
  const edgeIds = new Set<string>();
  const acceptedEdges = [] as typeof graph.edges;
  for (const edge of graph.edges) {
    if (
      !edge || !safeId(edge.id) || edgeIds.has(edge.id) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) ||
      !["sequence", "depends-on", "delegates", "revises", "integrates", "blocks"].includes(edge.kind) ||
      wouldCycle({ edges: acceptedEdges }, edge.from, edge.to)
    ) throw new Error("Invalid persisted edge");
    edgeIds.add(edge.id); acceptedEdges.push(edge);
  }
  return {
    schemaVersion: 1,
    version: graph.version,
    sessionId: snapshot.sessionId || fallbackSessionId,
    updatedAt: graph.updatedAt,
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    agents: graph.agents.map((agent) => ({ ...agent })),
    processedEventIds: [],
  };
}

// Exported to make the transition contract auditable by persistence tests.
export const persistedTransitionIsLegal = isLegalTransition;
