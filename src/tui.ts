import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { GraphNode, PublicGraph } from "./types.js";
import type { GraphStore } from "./store.js";
import { publicProjection } from "./privacy.js";

export type OverviewView = "graph" | "agents" | "blockers";
interface Point { x: number; y: number }
interface VerticalLayout { lines: string[]; anchors: Map<string, Point> }

const BODY_HEIGHT = 28;

export interface OverviewComponentOptions {
  store: GraphStore;
  theme: Theme;
  requestRender: () => void;
  onClose: () => void;
  onUpdate: () => void;
}

export class OverviewComponent implements Component {
  private graph: PublicGraph;
  private selectedId: string | undefined;
  private selectedAgent = 0;
  private view: OverviewView = "graph";
  private focusedId: string | undefined;
  private panX = 0;
  private panY = 0;
  private focusScroll = 0;
  private lastFocusLength = 0;
  private lastLayout: VerticalLayout = { lines: [], anchors: new Map() };
  private unsubscribe: () => void;

  constructor(private options: OverviewComponentOptions) {
    this.graph = publicProjection(options.store.get());
    this.selectedId = this.graph.nodes[0]?.id;
    this.unsubscribe = options.store.subscribe((graph) => {
      this.graph = publicProjection(graph);
      if (!this.graph.nodes.some((node) => node.id === this.selectedId)) this.selectedId = this.graph.nodes[0]?.id;
      if (!this.graph.nodes.some((node) => node.id === this.focusedId)) this.focusedId = undefined;
      this.ensureVisible();
      options.requestRender();
    });
  }

  handleInput(data: string): void {
    if (data === "q") { this.options.onClose(); return; }
    if (this.focusedId) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
        this.focusedId = undefined;
        this.focusScroll = 0;
      } else if (matchesKey(data, "up") || matchesKey(data, "ctrl+up")) {
        this.focusScroll = Math.max(0, this.focusScroll - 1);
      } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+down")) {
        this.focusScroll = Math.min(Math.max(0, this.lastFocusLength - BODY_HEIGHT), this.focusScroll + 1);
      }
      this.options.requestRender();
      return;
    }

    if (matchesKey(data, "escape")) { this.options.onClose(); return; }
    if (data === "g") this.setView("graph");
    else if (data === "a") this.setView("agents");
    else if (data === "b") this.setView("blockers");
    else if (data === "u") this.options.onUpdate();
    else if (matchesKey(data, "tab")) this.nextAgent();
    else if (matchesKey(data, "enter") && this.selectedId) { this.focusedId = this.selectedId; this.focusScroll = 0; }
    else if (matchesKey(data, "ctrl+left")) this.panX = Math.max(0, this.panX - 1);
    else if (matchesKey(data, "ctrl+right")) this.panX++;
    else if (matchesKey(data, "ctrl+up")) this.panY = Math.max(0, this.panY - 1);
    else if (matchesKey(data, "ctrl+down")) this.panY++;
    else if (this.view === "agents" && matchesKey(data, "up")) this.selectAgent(-1);
    else if (this.view === "agents" && matchesKey(data, "down")) this.selectAgent(1);
    else if (matchesKey(data, "left")) this.moveByRelation("incoming");
    else if (matchesKey(data, "right")) this.moveByRelation("outgoing");
    else if (matchesKey(data, "up")) this.moveVertical(-1);
    else if (matchesKey(data, "down")) this.moveVertical(1);
    this.ensureVisible();
    this.options.requestRender();
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const inner = Math.max(1, w - 2);
    const theme = this.options.theme;
    const lines: string[] = [];
    const border = (left: string, fill: string, right: string) => fit(theme.fg("border", left + fill.repeat(Math.max(0, inner)) + right), w);
    const row = (content: string) => {
      const clipped = truncateToWidth(content, inner, "");
      return fit(theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + theme.fg("border", "│"), w);
    };

    lines.push(border("╭", "─", "╮"));
    if (this.focusedId) {
      const node = this.graph.nodes.find((item) => item.id === this.focusedId);
      lines.push(row(` ${theme.fg("accent", theme.bold("Executive Focus"))}  ${theme.fg("dim", "semantic detail · no micro steps")}`));
      lines.push(row(` ${theme.fg("dim", "↑/↓ scroll  Enter/Esc back  q close")}`));
      lines.push(row(""));
      const focus = node ? this.renderFocus(node, inner) : [theme.fg("muted", " Focused activity is no longer available")];
      this.lastFocusLength = focus.length;
      this.focusScroll = Math.min(this.focusScroll, Math.max(0, focus.length - BODY_HEIGHT));
      const visibleFocus = focus.slice(this.focusScroll, this.focusScroll + BODY_HEIGHT);
      for (const line of visibleFocus) lines.push(row(line));
      for (let index = visibleFocus.length; index < BODY_HEIGHT; index++) lines.push(row(""));
    } else {
      lines.push(row(` ${theme.fg("accent", theme.bold("Semantic Overview"))}  ${theme.fg("dim", `vertical:${this.view} v${this.graph.version}`)}`));
      lines.push(row(` ${theme.fg("dim", "↑/↓ flow  ←/→ relations  Tab agent  Enter executive focus  g/a/b views  u update  q close")}`));
      lines.push(row(""));
      if (this.view === "agents") {
        const body = this.renderAgents(inner);
        this.lastLayout = { lines: body, anchors: new Map() };
        const visibleBody = body.slice(this.panY, this.panY + BODY_HEIGHT);
        if (!visibleBody.length) visibleBody.push(` ${theme.fg("muted", "No agents yet")}`);
        for (const line of visibleBody) lines.push(row(line));
        for (let index = visibleBody.length; index < BODY_HEIGHT; index++) lines.push(row(""));
      } else {
        this.lastLayout = this.renderVerticalGraph(inner, this.view === "blockers");
        const visibleBody = this.lastLayout.lines.slice(this.panY, this.panY + BODY_HEIGHT);
        if (!visibleBody.length) visibleBody.push(` ${theme.fg("muted", "No macro activity yet")}`);
        for (const line of visibleBody) lines.push(row(line));
        for (let index = visibleBody.length; index < BODY_HEIGHT; index++) lines.push(row(""));
      }
    }
    lines.push(border("╰", "─", "╯"));
    return lines.map((line) => fit(line, w));
  }

  invalidate(): void {}
  dispose(): void { this.unsubscribe(); }

  get selectedNodeId(): string | undefined { return this.selectedId; }
  get currentView(): OverviewView { return this.view; }
  get pan(): Point { return { x: this.panX, y: this.panY }; }
  get isFocused(): boolean { return this.focusedId !== undefined; }

  private renderVerticalGraph(width: number, blockersOnly: boolean): VerticalLayout {
    const nodes = this.nodesForView(blockersOnly ? "blockers" : "graph");
    const lines: string[] = [];
    const anchors = new Map<string, Point>();
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const agent = this.graph.agents.find((item) => item.id === node.agentId);
      const indent = agent?.parentId && width >= 42 ? Math.min(6, Math.max(2, Math.floor(width / 12))) : 1;
      if (index > 0) {
        const previous = nodes[index - 1]!;
        const direct = this.graph.edges.find((edge) => edge.from === previous.id && edge.to === node.id);
        const incoming = this.graph.edges.find((edge) => edge.to === node.id);
        const center = indent + Math.max(2, Math.floor(Math.min(58, width - indent - 2) / 2));
        if (direct) {
          lines.push(`${" ".repeat(center)}${this.options.theme.fg("dim", `│ ${edgeLabel(direct.kind)}`)}`);
          lines.push(`${" ".repeat(center)}${this.options.theme.fg("dim", "▼")}`);
        } else if (incoming) {
          lines.push(`${" ".repeat(indent + 1)}${this.options.theme.fg("dim", `↳ ${edgeLabel(incoming.kind)} branch`)}`);
        } else {
          lines.push("");
        }
      }
      anchors.set(node.id, { x: indent, y: lines.length });
      lines.push(...this.renderCard(node, width, indent));
    }
    return { lines, anchors };
  }

  private renderCard(node: GraphNode, width: number, indent: number): string[] {
    const available = Math.max(14, width - indent - 1);
    const cardWidth = Math.max(14, Math.min(58, available));
    const inner = Math.max(10, cardWidth - 2);
    const selected = node.id === this.selectedId;
    const chars = cardChars(node, selected);
    const raw: string[] = [];
    raw.push(chars.tl + chars.h.repeat(inner) + chars.tr);
    raw.push(chars.v + pad(`${node.type.toUpperCase()}  ${node.status.toUpperCase()}`, inner) + chars.v);
    raw.push(chars.v + " ".repeat(inner) + chars.v);
    const labelLines = wrapText(node.label, inner - 2).slice(0, 2);
    for (const line of labelLines.length ? labelLines : ["Activity"]) raw.push(chars.v + pad(` ${line}`, inner) + chars.v);
    if (node.detail) {
      raw.push(chars.v + " ".repeat(inner) + chars.v);
      for (const line of wrapText(node.detail, inner - 2).slice(0, 2)) raw.push(chars.v + pad(` ${line}`, inner) + chars.v);
    }
    raw.push(chars.v + " ".repeat(inner) + chars.v);
    const owner = agentLabel(this.graph, node.agentId);
    raw.push(chars.v + pad(` ${owner} · impact ${node.impact ?? "medium"}`, inner) + chars.v);
    raw.push(chars.bl + chars.h.repeat(inner) + chars.br);
    return raw.map((line) => `${" ".repeat(indent)}${this.paintCard(line, node, selected)}`);
  }

  private paintCard(line: string, node: GraphNode, selected: boolean): string {
    const theme = this.options.theme;
    if (selected) return theme.bg("selectedBg", theme.fg("accent", line));
    if (node.status === "blocked" || node.status === "failed") return theme.fg("warning", line);
    if (node.status === "completed") return theme.fg("success", line);
    return line;
  }

  private renderFocus(node: GraphNode, width: number): string[] {
    const theme = this.options.theme;
    const contentWidth = Math.max(12, Math.min(72, width - 6));
    const indent = Math.max(1, Math.floor((width - contentWidth) / 2));
    const lines: string[] = [];
    const add = (text = "") => lines.push(`${" ".repeat(indent)}${text}`);
    const wrapped = (text: string, prefix = "  ") => {
      for (const line of wrapText(text, Math.max(8, contentWidth - visibleWidth(prefix)))) add(prefix + line);
    };

    add(theme.fg("accent", theme.bold(`● ${node.type.toUpperCase()} — ${node.status.toUpperCase()}`)));
    add(theme.fg("dim", "│"));
    wrapped(node.label, "│  ");
    add(theme.fg("dim", "│"));
    add(theme.fg("accent", theme.bold("● EXECUTIVE SUMMARY")));
    add(theme.fg("dim", "│"));
    wrapped(node.detail ?? focusFallback(node), "│  ");
    add(theme.fg("dim", "│"));
    add(theme.fg("accent", theme.bold("● STATE")));
    add(theme.fg("dim", "│"));
    wrapped(`Owner: ${agentLabel(this.graph, node.agentId)} · Impact: ${node.impact ?? "medium"} · Duration: ${formatDuration(node.durationMs)} · Revisions: ${node.revision}`, "│  ");

    if (node.blocker || node.status === "blocked" || node.status === "failed") {
      add(theme.fg("dim", "│"));
      add(theme.fg("warning", theme.bold("◆ BLOCKER")));
      add(theme.fg("dim", "│"));
      wrapped(node.blocker ?? "This phase requires recovery before the workflow can advance.", "│  ");
    }

    const incoming = this.graph.edges.filter((edge) => edge.to === node.id);
    const outgoing = this.graph.edges.filter((edge) => edge.from === node.id);
    add(theme.fg("dim", "│"));
    add(theme.fg("accent", theme.bold("● SEMANTIC CONTEXT")));
    add(theme.fg("dim", "│"));
    if (!incoming.length && !outgoing.length) wrapped("This activity currently stands as an independent macro phase.", "│  ");
    for (const edge of incoming.slice(0, 3)) {
      const source = this.graph.nodes.find((item) => item.id === edge.from);
      if (source) wrapped(`From ${source.label} · ${edgeLabel(edge.kind)}`, "│  ");
    }
    for (const edge of outgoing.slice(0, 3)) {
      const target = this.graph.nodes.find((item) => item.id === edge.to);
      if (target) wrapped(`Toward ${target.label} · ${edgeLabel(edge.kind)}`, "│  ");
    }
    add(theme.fg("accent", "●"));
    return lines;
  }

  private renderAgents(width: number): string[] {
    const lines: string[] = [];
    for (let index = 0; index < this.graph.agents.length; index++) {
      const agent = this.graph.agents[index]!;
      const selected = index === this.selectedAgent ? this.options.theme.fg("accent", "▶") : " ";
      const owned = this.graph.nodes.filter((node) => node.agentId === agent.id);
      const active = owned.filter((node) => node.status === "active").length;
      const blocked = owned.filter((node) => node.status === "blocked" || node.status === "failed").length;
      lines.push(truncateToWidth(`${selected} ${agent.label}  ${agent.status}`, width, "…"));
      lines.push(truncateToWidth(`    macro phases:${owned.length}  active:${active}  blockers:${blocked}`, width, "…"));
      if (index < this.graph.agents.length - 1) lines.push("");
    }
    return lines;
  }

  private nodesForView(view = this.view): GraphNode[] {
    if (view === "blockers") return this.graph.nodes.filter((node) => node.type === "blocker" || node.status === "blocked" || node.status === "failed");
    if (view === "agents") {
      const agent = this.graph.agents[this.selectedAgent];
      if (agent) return this.graph.nodes.filter((node) => node.agentId === agent.id);
    }
    return this.graph.nodes;
  }

  private setView(view: OverviewView): void {
    this.view = view;
    this.panY = 0;
    const visible = this.nodesForView(view);
    if (visible.length && !visible.some((node) => node.id === this.selectedId)) this.selectedId = visible[0]!.id;
  }

  private moveVertical(direction: -1 | 1): void {
    const nodes = this.nodesForView();
    if (!nodes.length) return;
    const current = Math.max(0, nodes.findIndex((node) => node.id === this.selectedId));
    const next = Math.max(0, Math.min(nodes.length - 1, current + direction));
    this.selectNode(nodes[next]!);
  }

  private moveByRelation(direction: "incoming" | "outgoing"): void {
    if (!this.selectedId) return;
    const edge = direction === "incoming"
      ? this.graph.edges.find((item) => item.to === this.selectedId)
      : this.graph.edges.find((item) => item.from === this.selectedId);
    const targetId = edge ? (direction === "incoming" ? edge.from : edge.to) : undefined;
    const target = this.graph.nodes.find((node) => node.id === targetId);
    if (target) this.selectNode(target);
  }

  private selectNode(node: GraphNode): void {
    this.selectedId = node.id;
    const agentIndex = this.graph.agents.findIndex((agent) => agent.id === node.agentId);
    if (agentIndex >= 0) this.selectedAgent = agentIndex;
  }

  private selectAgent(direction: -1 | 1): void {
    if (!this.graph.agents.length) return;
    this.selectedAgent = Math.max(0, Math.min(this.graph.agents.length - 1, this.selectedAgent + direction));
    this.selectedId = this.graph.nodes.find((node) => node.agentId === this.graph.agents[this.selectedAgent]!.id)?.id ?? this.selectedId;
  }

  private nextAgent(): void {
    if (!this.graph.agents.length) return;
    this.selectedAgent = (this.selectedAgent + 1) % this.graph.agents.length;
    this.selectedId = this.graph.nodes.find((node) => node.agentId === this.graph.agents[this.selectedAgent]!.id)?.id ?? this.selectedId;
  }

  private ensureVisible(): void {
    if (this.view === "agents") {
      const y = this.selectedAgent * 3;
      if (y < this.panY) this.panY = y;
      if (y > this.panY + BODY_HEIGHT - 3) this.panY = Math.max(0, y - BODY_HEIGHT + 3);
      return;
    }
    const point = this.lastLayout.anchors.get(this.selectedId ?? "");
    if (!point) return;
    if (point.y < this.panY) this.panY = point.y;
    if (point.y > this.panY + BODY_HEIGHT - 8) this.panY = Math.max(0, point.y - 2);
  }
}

function cardChars(node: GraphNode, selected: boolean) {
  if (selected || node.type === "decision") return { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" };
  if (node.type === "blocker" || node.status === "blocked" || node.status === "failed") return { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" };
  return { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
}

function focusFallback(node: GraphNode): string {
  const descriptions: Partial<Record<GraphNode["type"], string>> = {
    goal: "Defines the outcome that organizes the current workflow.",
    planning: "Coordinates the next meaningful phase and its success conditions.",
    delegation: "Assigns a bounded outcome that will later rejoin the main workflow.",
    investigation: "Builds enough understanding to support the next decision or implementation phase.",
    implementation: "Advances the chosen approach while preserving the broader workflow constraints.",
    verification: "Evaluates whether the intended outcome is complete and defensible.",
    blocker: "Represents a material obstacle that changes or pauses workflow progress.",
    handoff: "Transfers a completed semantic outcome back into the broader workflow.",
  };
  return descriptions[node.type] ?? "Represents a meaningful macro activity in the current workflow.";
}

function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = "";
  for (const original of words) {
    let word = original;
    while (word.length > limit) {
      if (current) { lines.push(current); current = ""; }
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    if (!word) continue;
    if (!current) current = word;
    else if (current.length + 1 + word.length <= limit) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function fit(text: string, width: number): string { return truncateToWidth(text, Math.max(1, width), ""); }
function agentLabel(graph: PublicGraph, id: string): string { return graph.agents.find((agent) => agent.id === id)?.label ?? "Agent"; }
function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "active";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
function edgeLabel(kind: PublicGraph["edges"][number]["kind"]): string {
  return ({
    sequence: "next phase",
    "depends-on": "depends on",
    delegates: "delegates",
    revises: "revises",
    integrates: "integrates",
    blocks: "blocks",
  })[kind];
}
