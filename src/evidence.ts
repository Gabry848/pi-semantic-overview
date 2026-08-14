import type { EvidenceItem } from "./types.js";

export class EvidenceBuffer {
  private items: EvidenceItem[] = [];
  private sequence = 0;

  constructor(private maxItems = 16, private maxChars = 800) {}

  configure(maxItems: number, maxChars: number): void {
    this.maxItems = Math.max(1, maxItems);
    this.maxChars = Math.max(80, maxChars);
    this.trim();
  }

  add(kind: EvidenceItem["kind"], raw: unknown, timestamp = Date.now()): void {
    const text = extractText(raw).replace(/\s+/g, " ").trim();
    if (!text) return;
    this.items.push({ id: `e${++this.sequence}`, kind, text: text.slice(0, this.maxChars), timestamp });
    this.trim();
  }

  snapshot(): EvidenceItem[] { return this.items.map((item) => ({ ...item })); }

  consume(ids?: readonly string[]): void {
    if (!ids) this.items = [];
    else {
      const consumed = new Set(ids);
      this.items = this.items.filter((item) => !consumed.has(item.id));
    }
  }

  clear(): void { this.items = []; }
  get size(): number { return this.items.length; }

  private trim(): void {
    if (this.items.length > this.maxItems) this.items.splice(0, this.items.length - this.maxItems);
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string" || Array.isArray(record.content)) return extractText(record.content);
  return "";
}
