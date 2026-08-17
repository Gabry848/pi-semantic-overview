import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { GraphEdge, GraphNode, PublicGraph } from "./types.js";
import type { GraphStore } from "./store.js";
import { publicProjection } from "./privacy.js";

export type OverviewView = "graph" | "agents" | "blockers";
interface Point { x: number; y: number }
interface VerticalLayout { lines: string[]; anchors: Map<string, Point>; order: string[]; fixedViewport?: boolean }

const BODY_HEIGHT = 36;
const BOARD_MIN_WIDTH = 76;

export interface OverviewComponentOptions {
  store: GraphStore;
  theme: Theme;
  requestRender: () => void;
  onClose: () => void;
  onUpdate: () => void;
  onRebuild: () => void;
  getStatus?: () => string;
}

export class OverviewComponent implements Component {
  private graph: PublicGraph;
  private selectedId: string | undefined;
  private selectedAgent = 0;
  private view: OverviewView = "graph";
  private focusedId: string | undefined;
  private panY = 0;
  private focusScroll = 0;
  private lastFocusLength = 0;
  private lastLayout: VerticalLayout = { lines: [], anchors: new Map(), order: [] };
  private unsubscribe: () => void;

  constructor(private options: OverviewComponentOptions) {
    this.graph = publicProjection(options.store.get());
    this.selectedId = visibleNodes(this.graph)[0]?.id;
    this.unsubscribe = options.store.subscribe((graph) => {
      this.graph = publicProjection(graph);
      const visible = visibleNodes(this.graph);
      if (!visible.some((node) => node.id === this.selectedId)) this.selectedId = visible[0]?.id;
      if (!visible.some((node) => node.id === this.focusedId)) this.focusedId = undefined;
      this.ensureVisible();
      options.requestRender();
    });
  }

  handleInput(data: string): void {
    if (data === "q") { this.options.onClose(); return; }
    if (this.focusedId) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) { this.focusedId = undefined; this.focusScroll = 0; }
      else if (matchesKey(data, "up") || matchesKey(data, "ctrl+up")) this.focusScroll = Math.max(0, this.focusScroll - 1);
      else if (matchesKey(data, "down") || matchesKey(data, "ctrl+down")) this.focusScroll = Math.min(Math.max(0, this.lastFocusLength - BODY_HEIGHT), this.focusScroll + 1);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) { this.options.onClose(); return; }
    if (data === "g") this.setView("graph");
    else if (data === "a") this.setView("agents");
    else if (data === "b") this.setView("blockers");
    else if (data === "u") this.options.onUpdate();
    else if (data === "r") { this.options.onRebuild(); return; }
    else if (matchesKey(data, "tab")) this.nextAgent();
    else if (matchesKey(data, "enter") && this.selectedId) { this.focusedId = this.selectedId; this.focusScroll = 0; }
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
    const border = (left: string, fill: string, right: string) => fit(theme.fg("border", left + fill.repeat(inner) + right), w);
    const row = (content: string) => {
      const clipped = truncateToWidth(content, inner, "");
      return fit(theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + theme.fg("border", "│"), w);
    };
    lines.push(border("╭", "─", "╮"));
    if (this.focusedId) {
      const node = visibleNodes(this.graph).find((item) => item.id === this.focusedId);
      lines.push(row(` ${theme.fg("accent", theme.bold("Dettaglio milestone"))}`));
      lines.push(row(` ${theme.fg("dim", "↑/↓ scorri  Enter/Esc torna  q chiudi")}`));
      lines.push(row(""));
      const focus = node ? this.renderFocus(node, inner) : [];
      this.lastFocusLength = focus.length;
      this.focusScroll = Math.min(this.focusScroll, Math.max(0, focus.length - BODY_HEIGHT));
      const visible = focus.slice(this.focusScroll, this.focusScroll + BODY_HEIGHT);
      for (const line of visible) lines.push(row(line));
    } else {
      const milestoneCount = visibleNodes(this.graph).filter((node) => node.agentId === "main").length;
      lines.push(row(` ${theme.fg("accent", theme.bold("Semantic Overview"))}  ${theme.fg("dim", `${milestoneCount} milestone principali`)}`));
      lines.push(row(` ${theme.fg("dim", "↑/↓ timeline  ←/→ relazioni  Tab agente  Enter dettaglio  g/a/b viste  u aggiorna  r ricostruisci  q chiudi")}`));
      lines.push(row(""));
      if (this.view === "agents") {
        const body = this.renderAgents(inner);
        this.lastLayout = { lines: body, anchors: new Map(), order: [] };
      } else {
        this.lastLayout = this.renderDashboard(inner, this.view === "blockers");
      }
      const visible = this.lastLayout.fixedViewport
        ? this.lastLayout.lines.slice(0, BODY_HEIGHT)
        : this.lastLayout.lines.slice(this.panY, this.panY + BODY_HEIGHT);
      if (!visible.length) {
        const status = this.options.getStatus?.();
        const detail = status && /rejected|unavailable|not persisted/.test(status) ? ` · ${status}` : "";
        visible.push(` ${theme.fg("muted", this.view === "graph" ? `Vista v2 pulita: nessuna milestone semantica ancora disponibile${detail}` : "Nessun elemento disponibile")}`);
      }
      for (const line of visible) lines.push(row(line));
      for (let index = visible.length; index < BODY_HEIGHT; index++) lines.push(row(""));
    }
    lines.push(border("╰", "─", "╯"));
    return lines.map((line) => fit(line, w));
  }

  invalidate(): void {}
  dispose(): void { this.unsubscribe(); }
  get selectedNodeId(): string | undefined { return this.selectedId; }
  get currentView(): OverviewView { return this.view; }
  get isFocused(): boolean { return this.focusedId !== undefined; }

  private renderDashboard(width: number, blockersOnly: boolean): VerticalLayout {
    if (width < BOARD_MIN_WIDTH) return this.renderTimeline(width, blockersOnly);
    const boardWidth = Math.max(28, Math.min(38, Math.floor(width * 0.32)));
    const gap = 2;
    const timelineWidth = Math.max(42, width - boardWidth - gap);
    const timeline = this.renderTimeline(timelineWidth, blockersOnly);
    const board = this.renderGlobalBoard(boardWidth);
    const visibleTimeline = timeline.lines.slice(this.panY, this.panY + BODY_HEIGHT);
    const height = Math.max(visibleTimeline.length, board.length);
    const lines: string[] = [];
    for (let index = 0; index < height; index++) lines.push(`${padVisible(visibleTimeline[index] ?? "", timelineWidth)}${" ".repeat(gap)}${board[index] ?? ""}`);
    return { ...timeline, lines, fixedViewport: true };
  }

  private renderGlobalBoard(width: number): string[] {
    const theme = this.options.theme;
    const inner = Math.max(12, width - 2);
    const nodes = visibleNodes(this.graph);
    const categories = [
      { title: "DONE", marker: "✓", tone: "success" as const, nodes: nodes.filter((node) => node.status === "completed" && node.type !== "blocker") },
      { title: "NOW", marker: "▶", tone: "accent" as const, nodes: nodes.filter((node) => node.status === "active" && node.type !== "blocker") },
      { title: "ISSUES", marker: "!", tone: "warning" as const, nodes: nodes.filter((node) => node.type === "blocker" || node.status === "blocked" || node.status === "failed") },
      { title: "NEXT", marker: "○", tone: "muted" as const, nodes: nodes.filter((node) => node.status === "pending") },
    ];
    const box = (content = "") => `│${pad(content, inner)}│`;
    const lines = [theme.fg("border", `┌${"─".repeat(inner)}┐`), theme.fg("accent", box(" BOARD GLOBALE")), theme.fg("border", `├${"─".repeat(inner)}┤`)];
    for (const category of categories) {
      lines.push(theme.fg("dim", box(` ${category.title}`)));
      if (!category.nodes.length) lines.push(theme.fg("dim", box("   —")));
      for (const node of category.nodes.slice(-4)) {
        const owner = node.agentId === "main" ? "" : `${agentLabel(this.graph, node.agentId)} · `;
        const wrapped = wrapText(`${owner}${node.title}`, Math.max(8, inner - 4)).slice(0, 2);
        wrapped.forEach((text, index) => lines.push(theme.fg(category.tone, box(` ${index === 0 ? category.marker : " "} ${text}`))));
      }
      lines.push(box());
    }
    lines.push(theme.fg("border", `└${"─".repeat(inner)}┘`));
    return lines;
  }

  private renderTimeline(width: number, blockersOnly: boolean): VerticalLayout {
    const all = visibleNodes(this.graph);
    const selected = blockersOnly ? all.filter((node) => node.type === "blocker" || node.status === "blocked" || node.status === "failed") : all;
    const main = selected.filter((node) => node.agentId === "main").sort(byTime);
    const lines: string[] = [];
    const anchors = new Map<string, Point>();
    const order: string[] = [];
    if (blockersOnly || width < 64) {
      for (const node of selected.sort(byTime)) {
        anchors.set(node.id, { x: 1, y: lines.length }); order.push(node.id);
        lines.push(...this.renderCard(node, width, "○──", "│  "));
        lines.push("│");
      }
      return { lines, anchors, order };
    }

    const gap = 3;
    const mainWidth = Math.max(34, Math.floor(width * 0.56));
    const branchWidth = Math.max(24, width - mainWidth - gap);
    const renderedAgents = new Set<string>();
    const appendParallelBlock = (mainNode: GraphNode | undefined, agentIds: readonly string[]) => {
      const left = mainNode ? this.renderCard(mainNode, mainWidth, "○──", "│  ") : [];
      const right: string[] = [];
      const localAnchors: Array<{ id: string; y: number }> = [];
      for (const agentId of agentIds) {
        const branchNodes = all.filter((candidate) => candidate.agentId === agentId).sort(byTime);
        if (!branchNodes.length) continue;
        if (right.length) right.push("");
        right.push(this.options.theme.fg("accent", "RAMO PARALLELO"));
        right.push(this.options.theme.fg("accent", truncateToWidth(`▶ ○ ${agentLabel(this.graph, agentId)}`, branchWidth, "…")));
        for (const branch of branchNodes) {
          localAnchors.push({ id: branch.id, y: right.length });
          right.push(...this.renderCard(branch, branchWidth, "○──", "│  "));
          right.push(this.options.theme.fg("dim", "│"));
        }
        right.push(this.options.theme.fg("dim", "╰╌ ramo separato dal main"));
      }
      const start = lines.length;
      if (mainNode) { anchors.set(mainNode.id, { x: 0, y: start }); order.push(mainNode.id); }
      for (const anchor of localAnchors) { anchors.set(anchor.id, { x: mainWidth + gap, y: start + anchor.y }); order.push(anchor.id); }
      const height = Math.max(left.length, right.length, 1);
      for (let index = 0; index < height; index++) {
        const mainLane = left[index] ?? this.options.theme.fg("dim", "│");
        lines.push(`${padVisible(mainLane, mainWidth)}${" ".repeat(gap)}${right[index] ?? ""}`);
      }
    };

    for (const node of main) {
      const joins = visibleEdges(this.graph).filter((edge) => edge.to === node.id && (edge.kind === "checks" || edge.kind === "integrates"));
      for (const edge of joins) lines.push(this.renderJoin(edge, width));
      if (lines.length) lines.push(this.options.theme.fg("dim", "│"));
      const agentIds = [...new Set(visibleEdges(this.graph)
        .filter((edge) => edge.from === node.id && edge.kind === "delegates")
        .map((edge) => all.find((candidate) => candidate.id === edge.to)?.agentId)
        .filter((agentId): agentId is string => Boolean(agentId && agentId !== "main" && !renderedAgents.has(agentId))))];
      for (const agentId of agentIds) renderedAgents.add(agentId);
      appendParallelBlock(node, agentIds);
    }
    const uncorrelated = this.graph.agents
      .filter((agent) => agent.id !== "main" && !renderedAgents.has(agent.id) && all.some((node) => node.agentId === agent.id))
      .map((agent) => agent.id);
    if (uncorrelated.length) {
      lines.push(this.options.theme.fg("dim", "│"));
      appendParallelBlock(undefined, uncorrelated);
    }
    if (main.length) lines.push(this.options.theme.fg("dim", "○"));
    return { lines, anchors, order };
  }

  private renderJoin(edge: GraphEdge, width: number): string {
    const branch = visibleNodes(this.graph).find((node) => node.id === edge.from);
    const title = branch?.contribution ?? edge.note ?? branch?.title ?? "";
    const owner = branch ? agentLabel(this.graph, branch.agentId) : "Specialist";
    const strong = edge.kind === "integrates" || edge.strength === "final";
    const prefix = strong ? "┣◀════● INTEGRAZIONE FINALE" : "├◀╌╌╌○ CONTROLLO DEL MAIN";
    const text = `${prefix} · ${owner}${title ? ` · ${title}` : ""}`;
    return truncateToWidth(strong ? this.options.theme.fg("success", text) : this.options.theme.fg("accent", text), width, "…");
  }

  private renderCard(node: GraphNode, width: number, firstPrefix: string, restPrefix: string, extraIndent = 0): string[] {
    const available = Math.max(18, width - visibleWidth(firstPrefix) - extraIndent);
    const cardWidth = Math.max(18, Math.min(66, available));
    const inner = cardWidth - 2;
    const selected = node.id === this.selectedId;
    const chars = cardChars(node, selected);
    const raw = [chars.tl + chars.h.repeat(inner) + chars.tr];
    const titleLines = wrapText(node.title, Math.max(8, inner - 5)).slice(0, 3);
    const marker = statusMarker(node.status);
    for (let index = 0; index < titleLines.length; index++) {
      const suffix = index === titleLines.length - 1 ? ` ${marker}` : "";
      raw.push(chars.v + pad(` ${titleLines[index]}${suffix}`, inner) + chars.v);
    }
    const statements = [...(node.summary ?? []), ...(node.outcome && !(node.summary ?? []).includes(node.outcome) ? [node.outcome] : [])];
    const summaryLines = statements.flatMap((statement) => wrapText(statement, Math.max(8, inner - 2))).slice(0, 4);
    if (summaryLines.length) raw.push(chars.v + " ".repeat(inner) + chars.v);
    for (const line of summaryLines) raw.push(chars.v + pad(` ${line}`, inner) + chars.v);
    raw.push(chars.bl + chars.h.repeat(inner) + chars.br);
    return raw.map((line, index) => `${index === 0 ? firstPrefix : restPrefix}${this.paintCard(line, node, selected)}`);
  }

  private paintCard(line: string, node: GraphNode, selected: boolean): string {
    const theme = this.options.theme;
    if (selected) return theme.bg("selectedBg", theme.fg("accent", line));
    if (node.status === "blocked" || node.status === "failed" || node.type === "blocker") return theme.fg("warning", line);
    if (node.status === "completed") return theme.fg("success", line);
    return line;
  }

  private renderFocus(node: GraphNode, width: number): string[] {
    const theme = this.options.theme;
    const contentWidth = Math.max(12, Math.min(82, width - 6));
    const indent = " ".repeat(Math.max(1, Math.floor((width - contentWidth) / 2)));
    return buildDetailLines(this.graph, node, contentWidth).map((line) => {
      if (/^[A-ZÀ-Ù ]+$/.test(line) || line === "PASSAGGI SVOLTI" || line === "CONTROLLI DEL MAIN") return `${indent}${theme.fg("accent", theme.bold(line))}`;
      if (line.startsWith("INTEGRAZIONE FINALE")) return `${indent}${theme.fg("success", line)}`;
      if (line.startsWith("ATTENZIONE")) return `${indent}${theme.fg("warning", line)}`;
      return `${indent}${line}`;
    });
  }

  private renderAgents(width: number): string[] {
    const lines: string[] = [];
    const nodes = visibleNodes(this.graph);
    for (let index = 0; index < this.graph.agents.length; index++) {
      const agent = this.graph.agents[index]!;
      const selected = index === this.selectedAgent ? this.options.theme.fg("accent", "▶") : " ";
      const owned = nodes.filter((node) => node.agentId === agent.id);
      lines.push(truncateToWidth(`${selected} ${agent.label}  ${humanState(agent.status)}`, width, "…"));
      if (agent.mandate) for (const line of wrapText(agent.mandate, Math.max(8, width - 4)).slice(0, 3)) lines.push(`    ${line}`);
      lines.push(`    milestone visibili: ${owned.length}`);
      if (index < this.graph.agents.length - 1) lines.push("");
    }
    return lines;
  }

  private nodesForView(): GraphNode[] {
    const nodes = visibleNodes(this.graph);
    if (this.view === "blockers") return nodes.filter((node) => node.type === "blocker" || node.status === "blocked" || node.status === "failed");
    if (this.view === "agents") {
      const agent = this.graph.agents[this.selectedAgent];
      return agent ? nodes.filter((node) => node.agentId === agent.id) : [];
    }
    return nodes;
  }

  private setView(view: OverviewView): void {
    this.view = view;
    this.panY = 0;
    const visible = this.nodesForView();
    if (visible.length && !visible.some((node) => node.id === this.selectedId)) this.selectedId = visible[0]!.id;
  }

  private moveVertical(direction: -1 | 1): void {
    const ids = this.view === "graph" && this.lastLayout.order.length ? this.lastLayout.order : this.nodesForView().map((node) => node.id);
    if (!ids.length) return;
    const current = Math.max(0, ids.indexOf(this.selectedId ?? ""));
    const target = ids[Math.max(0, Math.min(ids.length - 1, current + direction))]!;
    const node = visibleNodes(this.graph).find((item) => item.id === target);
    if (node) this.selectNode(node);
  }

  private moveByRelation(direction: "incoming" | "outgoing"): void {
    if (!this.selectedId) return;
    const edges = visibleEdges(this.graph);
    const edge = direction === "incoming" ? edges.find((item) => item.to === this.selectedId) : edges.find((item) => item.from === this.selectedId);
    const targetId = edge ? (direction === "incoming" ? edge.from : edge.to) : undefined;
    const node = visibleNodes(this.graph).find((item) => item.id === targetId);
    if (node) this.selectNode(node);
  }

  private selectNode(node: GraphNode): void {
    this.selectedId = node.id;
    const index = this.graph.agents.findIndex((agent) => agent.id === node.agentId);
    if (index >= 0) this.selectedAgent = index;
  }
  private selectAgent(direction: -1 | 1): void {
    if (!this.graph.agents.length) return;
    this.selectedAgent = Math.max(0, Math.min(this.graph.agents.length - 1, this.selectedAgent + direction));
    this.selectedId = visibleNodes(this.graph).find((node) => node.agentId === this.graph.agents[this.selectedAgent]!.id)?.id ?? this.selectedId;
  }
  private nextAgent(): void {
    if (!this.graph.agents.length) return;
    this.selectedAgent = (this.selectedAgent + 1) % this.graph.agents.length;
    this.selectedId = visibleNodes(this.graph).find((node) => node.agentId === this.graph.agents[this.selectedAgent]!.id)?.id ?? this.selectedId;
  }
  private ensureVisible(): void {
    if (this.view === "agents") {
      const y = this.selectedAgent * 4;
      if (y < this.panY) this.panY = y;
      if (y > this.panY + BODY_HEIGHT - 4) this.panY = Math.max(0, y - BODY_HEIGHT + 4);
      return;
    }
    const point = this.lastLayout.anchors.get(this.selectedId ?? "");
    if (!point) return;
    if (point.y < this.panY) this.panY = point.y;
    if (point.y > this.panY + BODY_HEIGHT - 10) this.panY = Math.max(0, point.y - 2);
  }
}

export function buildDetailLines(graph: PublicGraph, node: GraphNode, width = 76): string[] {
  const lines: string[] = [];
  const addSection = (heading: string, values: readonly string[]) => {
    const meaningful = values.filter(Boolean);
    if (!meaningful.length) return;
    if (lines.length) lines.push("");
    lines.push(heading);
    for (const value of meaningful) lines.push(...wrapText(value, width));
  };
  lines.push(...wrapText(node.title, width));
  lines.push(`${agentLabel(graph, node.agentId)} · ${humanState(node.status)}`);
  const isSubagent = node.agentId !== "main";
  if (isSubagent) {
    const mandate = node.mandate ?? graph.agents.find((agent) => agent.id === node.agentId)?.mandate;
    if (mandate) addSection("MANDATO", [mandate]);
  } else if (node.objective) addSection("OBIETTIVO", [node.objective]);
  if (node.macroSteps?.length) {
    lines.push("");
    lines.push("PASSAGGI SVOLTI");
    node.macroSteps.forEach((step, index) => {
      if (index > 0) lines.push("");
      const prefix = `${String(index + 1).padStart(2, "0")}  `;
      const wrapped = wrapText(step.action, Math.max(8, width - prefix.length));
      wrapped.forEach((line, lineIndex) => lines.push(`${lineIndex === 0 ? prefix : " ".repeat(prefix.length)}${line}`));
      if (step.result) {
        lines.push("");
        lines.push("    Risultato:");
        for (const line of wrapText(step.result, Math.max(8, width - 4))) lines.push(`    ${line}`);
      }
    });
  }
  if (node.outcome) addSection("RISULTATO COMPLESSIVO", [node.outcome]);
  if (isSubagent) {
    const branchNodeIds = new Set(graph.nodes.filter((candidate) => candidate.agentId === node.agentId && !candidate.supersededBy).map((candidate) => candidate.id));
    const controls = visibleEdges(graph).filter((edge) => branchNodeIds.has(edge.from) && (edge.kind === "checks" || edge.kind === "integrates"));
    if (controls.length) addSection("CONTROLLI DEL MAIN", controls.map((edge, index) => {
      const target = graph.nodes.find((candidate) => candidate.id === edge.to);
      const label = edge.note ?? target?.title ?? "";
      return `${String(index + 1).padStart(2, "0")}  ${edge.kind === "integrates" ? "INTEGRAZIONE FINALE" : "Controllo intermedio"}${label ? ` — ${label}` : ""}`;
    }));
    if (node.contribution) addSection("CONTRIBUTO AL WORKFLOW", [node.contribution]);
    addSection("STATO DEL RAMO", [humanState(node.status), ...(node.currentWork ? [node.currentWork] : [])]);
  } else if (node.currentWork) addSection("IN CORSO", [node.currentWork]);
  if (node.concern) addSection("ATTENZIONE", [node.concern]);
  if (node.nextStep) addSection("PROSSIMO PASSO", [node.nextStep]);
  return lines;
}

function visibleNodes(graph: PublicGraph): GraphNode[] { return graph.nodes.filter((node) => !node.supersededBy); }
function visibleEdges(graph: PublicGraph): GraphEdge[] {
  const ids = new Set(visibleNodes(graph).map((node) => node.id));
  return graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}
function byTime(a: GraphNode, b: GraphNode): number { return a.startedAt - b.startedAt || a.id.localeCompare(b.id); }
function cardChars(node: GraphNode, selected: boolean) {
  if (selected || node.type === "decision") return { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" };
  if (node.type === "blocker" || node.status === "blocked" || node.status === "failed") return { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" };
  return { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
}
function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = "";
  for (const original of words) {
    let word = original;
    while (word.length > limit) { if (current) { lines.push(current); current = ""; } lines.push(word.slice(0, limit)); word = word.slice(limit); }
    if (!word) continue;
    if (!current) current = word;
    else if (current.length + word.length + 1 <= limit) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}
function pad(text: string, width: number): string { const clipped = truncateToWidth(text, width, ""); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); }
function fit(text: string, width: number): string { return truncateToWidth(text, Math.max(1, width), ""); }
function padVisible(text: string, width: number): string { const clipped = truncateToWidth(text, Math.max(1, width), ""); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); }
function agentLabel(graph: PublicGraph, id: string): string { return graph.agents.find((agent) => agent.id === id)?.label ?? "Specialist"; }
function statusMarker(status: GraphNode["status"]): string {
  return ({ pending: "○", active: "▶", completed: "✓", blocked: "!", failed: "×", cancelled: "–" })[status];
}
function humanState(status: GraphNode["status"] | PublicGraph["agents"][number]["status"]): string {
  return ({ pending: "Da avviare", active: "In corso", completed: "Completato", blocked: "Bloccato", failed: "Non riuscito", cancelled: "Annullato", idle: "In attesa", running: "In corso" } as Record<string, string>)[status] ?? "";
}
