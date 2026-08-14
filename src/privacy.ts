import type { EvidenceItem, GraphAgent, GraphEdge, GraphNode, PublicGraph, SemanticGraph } from "./types.js";

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
  if (/[`]/.test(text) || /```/.test(text) || CODE_PATTERNS.some((p) => p.test(text))) issues.push({ code: "code", message: "likely code" });
  if (PATH_PATTERNS.some((p) => p.test(text))) issues.push({ code: "path", message: "likely path or filename" });
  if (COMMAND_PATTERNS.some((p) => p.test(text))) issues.push({ code: "command", message: "likely shell command" });
  if (SECRET_PATTERNS.some((p) => p.test(text))) issues.push({ code: "secret", message: "likely secret" });
  if (TRANSCRIPT_PATTERNS.some((p) => p.test(text))) issues.push({ code: "transcript", message: "transcript-like wording" });

  const candidateWords = words(text);
  if (candidateWords.length >= 2) {
    const normalizedCandidate = candidateWords.join(" ");
    outer: for (const item of evidence) {
      const sourceWords = words(item.text);
      const maxWindow = Math.min(6, candidateWords.length, sourceWords.length);
      for (let size = 2; size <= maxWindow; size++) {
        const candidateWindows = new Set<string>();
        for (let i = 0; i + size <= candidateWords.length; i++) candidateWindows.add(candidateWords.slice(i, i + size).join(" "));
        for (let i = 0; i + size <= sourceWords.length; i++) {
          if (candidateWindows.has(sourceWords.slice(i, i + size).join(" "))) {
            issues.push({ code: "verbatim", message: `exact ${size}-word copy from sensitive evidence` });
            break outer;
          }
        }
      }
      if (sourceWords.join(" ") === normalizedCandidate) {
        issues.push({ code: "verbatim", message: "exact copy from sensitive evidence" });
        break;
      }
    }
  }
  return issues;
}

export function assertPublicText(text: string, evidence: readonly EvidenceItem[] = []): void {
  const issues = inspectPublicText(text, evidence);
  if (issues.length > 0) throw new Error(`Unsafe public text: ${issues.map((x) => x.code).join(",")}`);
}

export function safePublicText(text: string | undefined, evidence: readonly EvidenceItem[] = [], fallback = "Restricted summary"): string | undefined {
  if (text === undefined) return undefined;
  const normalized = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
  return inspectPublicText(normalized, evidence).length === 0 ? normalized : fallback;
}

function projectNode(node: GraphNode, evidence: readonly EvidenceItem[]): GraphNode {
  return {
    ...node,
    label: safePublicText(node.label, evidence, "Restricted activity") ?? "Restricted activity",
    ...(node.detail === undefined ? {} : { detail: safePublicText(node.detail, evidence)! }),
    ...(node.blocker === undefined ? {} : { blocker: safePublicText(node.blocker, evidence, "Restricted blocker")! }),
  };
}

function projectAgent(agent: GraphAgent, evidence: readonly EvidenceItem[]): GraphAgent {
  return { ...agent, label: safePublicText(agent.label, evidence, "Agent") ?? "Agent" };
}

export function publicProjection(graph: SemanticGraph, evidence: readonly EvidenceItem[] = []): PublicGraph {
  return {
    version: graph.version,
    updatedAt: graph.updatedAt,
    nodes: graph.nodes.map((node) => projectNode(node, evidence)),
    edges: graph.edges.map((edge): GraphEdge => ({ ...edge })),
    agents: graph.agents.map((agent) => projectAgent(agent, evidence)),
  };
}

export function validatePublicGraph(graph: PublicGraph, evidence: readonly EvidenceItem[] = []): void {
  for (const node of graph.nodes) {
    assertPublicText(node.label, evidence);
    if (node.detail) assertPublicText(node.detail, evidence);
    if (node.blocker) assertPublicText(node.blocker, evidence);
  }
  for (const agent of graph.agents) assertPublicText(agent.label, evidence);
}
