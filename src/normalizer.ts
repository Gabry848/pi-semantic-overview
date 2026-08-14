import { createHash } from "node:crypto";
import type { EventKind, NodeType, NormalizedEvent } from "./types.js";

const TOOL_CLASSES: Record<string, NodeType> = {
  read: "investigation", grep: "investigation", find: "investigation", ls: "investigation",
  browser: "investigation", browseros: "investigation", web: "investigation", search: "investigation",
  edit: "implementation", write: "implementation", patch: "implementation", apply_patch: "implementation",
  bash: "implementation", exec: "implementation",
  test: "verification", vitest: "verification", xcodebuild: "verification",
  agent: "delegation", get_subagent_result: "integration", steer_subagent: "delegation",
  ask_user: "decision", create_goal: "planning", update_goal: "verification",
};

export function classifyTool(toolName: string): NodeType {
  const key = toolName.toLocaleLowerCase();
  if (TOOL_CLASSES[key]) return TOOL_CLASSES[key];
  if (/test|check|lint|build|verify/.test(key)) return "verification";
  if (/agent|delegate|spawn/.test(key)) return "delegation";
  if (/read|search|fetch|query|inspect|list|grep|find/.test(key)) return "investigation";
  if (/write|edit|patch|execute|run|shell|bash/.test(key)) return "implementation";
  return "implementation";
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}
function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}
function booleanField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

export class EventNormalizer {
  private sequence = 0;
  private toolStarts = new Map<string, number>();

  normalize(kind: EventKind, raw: unknown, now = Date.now(), agentId = "main"): NormalizedEvent {
    const correlationId = stringField(raw, "toolCallId") ?? stringField(raw, "id");
    const toolName = stringField(raw, "toolName") ?? stringField(raw, "type");
    const turn = numberField(raw, "turnIndex");
    const explicitDuration = numberField(raw, "durationMs");
    const status = stringField(raw, "status");
    const metric = numberField(raw, "tokensBefore");
    const failure = booleanField(raw, "isError") ?? (kind.endsWith("failed") ? true : undefined);

    let durationMs = explicitDuration;
    if (kind === "tool.started" && correlationId) this.toolStarts.set(correlationId, now);
    if (kind === "tool.completed" && correlationId) {
      const started = this.toolStarts.get(correlationId);
      if (started !== undefined) durationMs = Math.max(0, now - started);
      this.toolStarts.delete(correlationId);
    }

    const safeAgentId = kind.startsWith("subagent.") && correlationId ? `sub:${stableToken(correlationId)}` : agentId;
    const sequence = ++this.sequence;
    const repeatable = kind === "subagent.steered" || kind === "subagent.compacted" || kind === "session.compacted";
    const identity = repeatable
      ? `${correlationId ?? "event"}:sequence:${sequence}`
      : correlationId ?? (turn === undefined ? `sequence:${sequence}` : `turn:${turn}`);
    const id = stableToken([kind, safeAgentId, identity].join("|"));
    return {
      id: `ev:${id}`,
      kind,
      timestamp: now,
      agentId: safeAgentId,
      ...(turn === undefined ? {} : { turn }),
      ...(toolName === undefined ? {} : { toolName: safeToolName(toolName), toolClass: classifyTool(toolName) }),
      ...(correlationId === undefined ? {} : { correlationId: stableToken(correlationId) }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(failure === undefined ? {} : { failed: failure }),
      ...(status === undefined ? {} : { status: safeStatus(status) }),
      ...(metric === undefined ? {} : { metric }),
    };
  }

  clear(): void { this.toolStarts.clear(); }
}

export function normalizeSubagentEvent(channel: string, raw: unknown, normalizer: EventNormalizer, now = Date.now()): NormalizedEvent | undefined {
  const map: Record<string, EventKind> = {
    "subagents:created": "subagent.created",
    "subagents:started": "subagent.started",
    "subagents:completed": "subagent.completed",
    "subagents:failed": "subagent.failed",
    "subagents:compacted": "subagent.compacted",
    "subagents:steered": "subagent.steered",
  };
  const kind = map[channel];
  return kind ? normalizer.normalize(kind, raw, now) : undefined;
}

function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 48) || "tool";
}
function safeStatus(status: string): string {
  const normalized = status.toLocaleLowerCase().replace(/[^a-z_-]/g, "");
  return normalized.slice(0, 24) || "unknown";
}
export function stableToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
