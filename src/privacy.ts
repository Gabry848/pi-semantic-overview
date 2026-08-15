import type { EvidenceItem, GraphAgent, GraphEdge, GraphNode, MacroStep, PublicGraph, SemanticGraph } from "./types.js";

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const TRANSCRIPT_PATTERNS = [
  /\b(?:user|assistant|system|tool)\s*(?:said|message|output|result|prompt|response)\s*:/i,
  /\b(?:the user asked|the assistant replied|verbatim|transcript)\b/i,
];
const COMMAND_PATTERNS = [
  /(?:^|[\s:])(?:sudo\s+)?(?:cd|ls|cat|sed|awk|grep|rg|find|git|npm|pnpm|yarn|bun|bash|sh|zsh|curl|wget|rm|cp|mv|chmod|chown|python|node|make|docker|kubectl)\s+[\w@./-]+/im,
  /(?:&&|\|\||\$\(|;\s*(?:git|npm|rm|cd)\b)/i,
  /\b(?:select\s+.+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i,
];
const PATH_PATTERNS = [
  /(?:^|\s)(?:~\/|\.\.?\/|\/[A-Za-z0-9_.-]+\/)[^\s]*/,
  /\b(?:src|lib|app|test|tests|packages|components|services|modules|config)\/[A-Za-z0-9_./-]+\b/i,
  /\b(?:Gemfile|Rakefile|Dockerfile|Makefile|Procfile|CMakeLists\.txt)\b/,
  /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|json|md|py|rb|rs|go|java|c|cpp|h|sh|sql|yaml|yml|toml|env|lock)\b/i,
  /[A-Za-z]:\\[^\s]+/,
];
const CODE_PATTERNS = [
  /(?:^|\s)(?:const|let|var|function|class|interface|type|def|fn|public|private|return|import|export)\s+[A-Za-z_$][\w$]*/m,
  /[A-Za-z_$][\w$]*\s*=\s*(?:["'`{\[\d]|new\s+)/,
  /=>|\{\s*[A-Za-z_$][\w$]*\s*:/,
];
const PACKAGE_IDENTIFIER_PATTERNS = [
  /@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/,
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/,
];

export interface PrivacyIssue { code: string; message: string }

function words(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

export function sixWordWindows(text: string): Set<string> {
  const tokens = words(text);
  const out = new Set<string>();
  for (let i = 0; i + 6 <= tokens.length; i++) out.add(tokens.slice(i, i + 6).join(" "));
  return out;
}

export function inspectPublicText(text: string, evidence: readonly EvidenceItem[] = []): PrivacyIssue[] {
  const issues: PrivacyIssue[] = [];
  if (!text.trim()) issues.push({ code: "empty", message: "public text is empty" });
  if (/[`]/.test(text) || CODE_PATTERNS.some((pattern) => pattern.test(text))) issues.push({ code: "code", message: "likely code" });
  if (PATH_PATTERNS.some((pattern) => pattern.test(text))) issues.push({ code: "path", message: "likely path or filename" });
  if (COMMAND_PATTERNS.some((pattern) => pattern.test(text))) issues.push({ code: "command", message: "likely shell command" });
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) issues.push({ code: "secret", message: "likely secret" });
  if (TRANSCRIPT_PATTERNS.some((pattern) => pattern.test(text))) issues.push({ code: "transcript", message: "transcript-like wording" });
  if (PACKAGE_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(text))) issues.push({ code: "identifier", message: "likely package identifier" });

  const candidate = sixWordWindows(text);
  if (candidate.size > 0) {
    outer: for (const item of evidence) {
      for (const window of sixWordWindows(item.text)) {
        if (candidate.has(window)) {
          issues.push({ code: "verbatim", message: "exact six-word copy from sensitive evidence" });
          break outer;
        }
      }
    }
  }
  return issues;
}

export function isGenericTitle(title: string): boolean {
  const normalized = title.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalized || /^(restricted|semantic activity|activity unavailable)/.test(normalized)) return true;
  const placeholders = new Set([
    "active objective", "reviewing progress", "decision point", "planning next steps", "delegating work",
    "delegated work", "delegated work redirected", "investigating context", "implementing changes", "verifying outcome",
    "integrating results", "progress blocked", "execution progress blocked", "agent progress blocked",
    "delegated work blocked", "revising approach", "preparing handoff", "subagent handoff",
  ]);
  if (placeholders.has(normalized)) return true;
  return /^(goal|reflection|decision|planning|delegation|investigation|implementation|verification|integration|blocker|revision|handoff)( pending| active| completed| blocked| failed| cancelled)?$/.test(normalized);
}

export function assertPublicText(text: string, evidence: readonly EvidenceItem[] = []): void {
  const issues = inspectPublicText(text, evidence);
  if (issues.length > 0) throw new Error(`Unsafe public text: ${issues.map((issue) => issue.code).join(",")}`);
}

export function safePublicText(text: string | undefined, evidence: readonly EvidenceItem[] = [], maxLength = 600): string | undefined {
  if (text === undefined) return undefined;
  const normalized = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
  return inspectPublicText(normalized, evidence).length === 0 ? normalized : undefined;
}

function sanitizeList(values: string[] | undefined, evidence: readonly EvidenceItem[], maxItems: number, maxLength = 600): string[] | undefined {
  if (!values) return undefined;
  const safe = values.map((value) => safePublicText(value, evidence, maxLength)).filter((value): value is string => value !== undefined).slice(0, maxItems);
  return safe.length > 0 ? safe : undefined;
}

function sanitizeSteps(steps: MacroStep[] | undefined, evidence: readonly EvidenceItem[]): MacroStep[] | undefined {
  if (!steps) return undefined;
  const safe: MacroStep[] = [];
  for (const step of steps.slice(0, 12)) {
    if (!step || typeof step.action !== "string") continue;
    const action = safePublicText(step.action, evidence, 500);
    if (!action) continue;
    const result = safePublicText(step.result, evidence, 500);
    safe.push({ action, ...(result ? { result } : {}) });
  }
  return safe.length > 0 ? safe : undefined;
}

export function sanitizeNode(node: GraphNode, evidence: readonly EvidenceItem[] = []): GraphNode | undefined {
  const title = safePublicText(node.title, evidence, 160);
  if (!title || isGenericTitle(title)) return undefined;
  const optional = (value: string | undefined, max = 600) => safePublicText(value, evidence, max);
  const summary = sanitizeList(node.summary, evidence, 4);
  const evidenceClaims = sanitizeList(node.evidenceClaims, evidence, 8);
  const macroSteps = sanitizeSteps(node.macroSteps, evidence);
  const sanitized: GraphNode = { ...node, title };
  delete sanitized.summary;
  delete sanitized.evidenceClaims;
  delete sanitized.macroSteps;
  for (const key of ["objective", "mandate", "outcome", "rationale", "currentWork", "concern", "nextStep", "contribution"] as const) delete sanitized[key];
  if (summary) sanitized.summary = summary;
  if (evidenceClaims) sanitized.evidenceClaims = evidenceClaims;
  if (macroSteps) sanitized.macroSteps = macroSteps;
  const optionalFields = {
    objective: optional(node.objective), mandate: optional(node.mandate), outcome: optional(node.outcome),
    rationale: optional(node.rationale), currentWork: optional(node.currentWork), concern: optional(node.concern),
    nextStep: optional(node.nextStep), contribution: optional(node.contribution),
  };
  for (const [key, value] of Object.entries(optionalFields)) if (value) (sanitized as unknown as Record<string, unknown>)[key] = value;
  return sanitized;
}

function sanitizeAgent(agent: GraphAgent, evidence: readonly EvidenceItem[]): GraphAgent {
  const sanitized: GraphAgent = { ...agent, label: safePublicText(agent.label, evidence, 120) ?? (agent.id === "main" ? "Main agent" : "Specialist") };
  delete sanitized.mandate;
  const mandate = safePublicText(agent.mandate, evidence, 600);
  if (mandate) sanitized.mandate = mandate;
  return sanitized;
}

function sanitizeEdge(edge: GraphEdge, evidence: readonly EvidenceItem[]): GraphEdge {
  const sanitized: GraphEdge = { ...edge };
  delete sanitized.note;
  const note = safePublicText(edge.note, evidence, 400);
  if (note) sanitized.note = note;
  return sanitized;
}

export function publicProjection(graph: SemanticGraph, evidence: readonly EvidenceItem[] = []): PublicGraph {
  const nodes = graph.nodes.map((node) => sanitizeNode(node, evidence)).filter((node): node is GraphNode => node !== undefined);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    schemaVersion: 2,
    semanticRevision: graph.semanticRevision,
    updatedAt: graph.updatedAt,
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).map((edge) => sanitizeEdge(edge, evidence)),
    agents: graph.agents.map((agent) => sanitizeAgent(agent, evidence)),
  };
}

export function validatePublicGraph(graph: PublicGraph, evidence: readonly EvidenceItem[] = []): void {
  for (const node of graph.nodes) {
    assertPublicText(node.title, evidence);
    if (isGenericTitle(node.title)) throw new Error("Generic public title");
    for (const value of [node.objective, node.mandate, node.outcome, node.rationale, node.currentWork, node.concern, node.nextStep, node.contribution]) {
      if (value) assertPublicText(value, evidence);
    }
    for (const value of node.summary ?? []) assertPublicText(value, evidence);
    for (const value of node.evidenceClaims ?? []) assertPublicText(value, evidence);
    for (const step of node.macroSteps ?? []) {
      assertPublicText(step.action, evidence);
      if (step.result) assertPublicText(step.result, evidence);
    }
  }
  for (const edge of graph.edges) if (edge.note) assertPublicText(edge.note, evidence);
  for (const agent of graph.agents) {
    assertPublicText(agent.label, evidence);
    if (agent.mandate) assertPublicText(agent.mandate, evidence);
  }
}
