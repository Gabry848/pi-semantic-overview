export const NODE_TYPES = [
  "goal", "reflection", "decision", "planning", "delegation", "investigation",
  "implementation", "verification", "integration", "blocker", "revision", "handoff",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_STATUSES = ["pending", "active", "completed", "blocked", "failed", "cancelled"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type AgentStatus = "idle" | "running" | "completed" | "failed";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  detail?: string;
  agentId: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  impact?: "low" | "medium" | "high";
  blocker?: string;
  revision: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "sequence" | "depends-on" | "delegates" | "revises" | "integrates" | "blocks";
}

export interface GraphAgent {
  id: string;
  label: string;
  parentId?: string;
  status: AgentStatus;
  startedAt?: number;
  endedAt?: number;
}

export interface SemanticGraph {
  schemaVersion: 1;
  version: number;
  sessionId: string;
  updatedAt: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  agents: GraphAgent[];
  processedEventIds: string[];
}

export type EventKind =
  | "session.started" | "session.compacted" | "session.tree" | "agent.started" | "agent.completed"
  | "turn.started" | "turn.completed" | "tool.started" | "tool.completed"
  | "subagent.created" | "subagent.started" | "subagent.completed" | "subagent.failed"
  | "subagent.compacted" | "subagent.steered";

export interface NormalizedEvent {
  id: string;
  kind: EventKind;
  timestamp: number;
  agentId: string;
  turn?: number;
  toolClass?: NodeType;
  toolName?: string;
  correlationId?: string;
  durationMs?: number;
  failed?: boolean;
  status?: string;
  metric?: number;
}

export interface EvidenceItem {
  id: string;
  kind: "prompt" | "assistant" | "tool" | "subagent";
  text: string;
  timestamp: number;
}

export type PatchOperation =
  | { op: "addNode"; node: GraphNode }
  | { op: "updateNode"; id: string; changes: Partial<Pick<GraphNode, "label" | "detail" | "status" | "impact" | "blocker">> }
  | { op: "addEdge"; edge: GraphEdge }
  | { op: "upsertAgent"; agent: GraphAgent };

export interface GraphPatch {
  baseVersion: number;
  operations: PatchOperation[];
}

export interface PublicGraph {
  version: number;
  updatedAt: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  agents: GraphAgent[];
}

export type PresetName = "executive" | "balanced" | "technical-macro" | "blockers" | "delegation";
export type OverviewModel = "inherit" | "off" | `${string}/${string}`;
export type OverviewThinking = "low" | "medium" | "high";

export interface OverviewConfig {
  enabled: boolean;
  preset: PresetName;
  model: OverviewModel;
  thinking: OverviewThinking;
  everyTurns: number;
  maxEvidenceItems: number;
  maxEvidenceChars: number;
  customRules: string;
}
