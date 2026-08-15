export const NODE_TYPES = [
  "goal", "reflection", "decision", "planning", "delegation", "investigation",
  "implementation", "verification", "integration", "blocker", "revision", "handoff",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_STATUSES = ["pending", "active", "completed", "blocked", "failed", "cancelled"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type AgentStatus = "idle" | "running" | "completed" | "failed";

export interface MacroStep {
  action: string;
  result?: string;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  title: string;
  agentId: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
  impact?: "low" | "medium" | "high";
  objective?: string;
  mandate?: string;
  summary?: string[];
  outcome?: string;
  rationale?: string;
  macroSteps?: MacroStep[];
  evidenceClaims?: string[];
  currentWork?: string;
  concern?: string;
  nextStep?: string;
  contribution?: string;
  supersededBy?: string;
}

export const EDGE_KINDS = ["sequence", "depends-on", "delegates", "revises", "checks", "integrates", "blocks"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  strength?: "intermediate" | "final";
  note?: string;
}

export interface GraphAgent {
  id: string;
  label: string;
  parentId?: string;
  status: AgentStatus;
  startedAt?: number;
  endedAt?: number;
  mandate?: string;
}

export interface SemanticGraph {
  schemaVersion: 2;
  semanticRevision: number;
  telemetryRevision: number;
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
  kind: "prompt" | "assistant" | "tool" | "subagent" | "compaction";
  text: string;
  timestamp: number;
}

export type NodeChanges = Partial<Omit<GraphNode, "id" | "agentId" | "supersededBy">>;

export type PatchOperation =
  | { op: "addNode"; node: GraphNode }
  | { op: "updateNode"; id: string; changes: NodeChanges }
  | { op: "addEdge"; edge: GraphEdge }
  | { op: "upsertAgent"; agent: GraphAgent }
  | { op: "consolidateNodes"; ids: string[]; node: GraphNode; edges?: GraphEdge[] }
  | { op: "supersedeNodes"; ids: string[]; by: string }
  | { op: "checkBranch"; id: string; branchNodeId: string; mainNodeId: string; note?: string }
  | { op: "integrateBranch"; id: string; branchNodeId: string; mainNodeId: string; note?: string };

export interface GraphPatch {
  baseRevision: number;
  operations: PatchOperation[];
}

export interface PublicGraph {
  schemaVersion: 2;
  semanticRevision: number;
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
