import type { EvidenceItem } from "./types.js";

const MAX_ITEMS = 14;
const MAX_TOTAL_CHARS = 8_000;
const MAX_ITEM_CHARS = 1_200;

/** Collects only compaction/branch summaries and recent visible user/assistant text.
 * Tool results, thinking, arguments, custom private state, and filesystem data are not read. */
export function collectRebuildEvidence(entries: readonly unknown[], now = Date.now()): EvidenceItem[] {
  const summaries: EvidenceItem[] = [];
  const messages: EvidenceItem[] = [];
  let sequence = 0;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
      const text = normalize(entry.summary);
      if (text) summaries.push({ id: `rebuild-summary-${++sequence}`, kind: "compaction", text: text.slice(0, MAX_ITEM_CHARS), timestamp: timestamp(entry, now) });
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = visibleText(entry.message.content);
    if (text) messages.push({ id: `rebuild-message-${++sequence}`, kind: role === "user" ? "prompt" : "assistant", text: text.slice(0, MAX_ITEM_CHARS), timestamp: timestamp(entry, now) });
  }
  const chosen = [...summaries.slice(-6), ...messages.slice(-10)].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_ITEMS);
  let budget = MAX_TOTAL_CHARS;
  const packed: EvidenceItem[] = [];
  for (let index = chosen.length - 1; index >= 0; index--) {
    const item = chosen[index]!;
    if (budget <= 0) break;
    const text = item.text.slice(0, budget);
    if (text) packed.unshift({ ...item, text });
    budget -= text.length;
  }
  return packed;
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return normalize(value);
  if (!Array.isArray(value)) return "";
  return normalize(value.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join(" "));
}

function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }
function timestamp(entry: Record<string, unknown>, fallback: number): number {
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
