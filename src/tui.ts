import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { GraphNode, PublicGraph } from "./types.js";
import type { GraphStore } from "./store.js";
import { publicProjection } from "./privacy.js";

export type OverviewView = "graph" | "agents" | "blockers";
interface Point { x: number; y: number }

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
  private detail = false;
  private panX = 0;
  private panY = 0;
  private unsubscribe: () => void;

  constructor(private options: OverviewComponentOptions) {
    this.graph = publicProjection(options.store.get());
    this.selectedId = this.graph.nodes[0]?.id;
    this.unsubscribe = options.store.subscribe((graph) => {
      this.graph = publicProjection(graph);
      if (!this.graph.nodes.some((node) => node.id === this.selectedId)) this.selectedId = this.graph.nodes[0]?.id;
      this.ensureVisible();
      options.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") { this.options.onClose(); return; }
    if (data === "g") this.view = "graph";
    else if (data === "a") this.view = "agents";
    else if (data === "b") this.view = "blockers";
    else if (data === "u") this.options.onUpdate();
    else if (matchesKey(data, "tab")) this.nextAgent();
    else if (matchesKey(data, "enter")) this.detail = !this.detail;
    else if (matchesKey(data, "ctrl+left")) this.panX = Math.max(0, this.panX - 1);
    else if (matchesKey(data, "ctrl+right")) this.panX++;
    else if (matchesKey(data, "ctrl+up")) this.panY = Math.max(0, this.panY - 1);
    else if (matchesKey(data, "ctrl+down")) this.panY++;
    else if (matchesKey(data, "left")) this.move(-1, 0);
    else if (matchesKey(data, "right")) this.move(1, 0);
    else if (matchesKey(data, "up")) this.move(0, -1);
    else if (matchesKey(data, "down")) this.move(0, 1);
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
    lines.push(row(` ${theme.fg("accent", theme.bold("Semantic Overview"))}  ${theme.fg("dim", `view:${this.view} v${this.graph.version}`)}`));
    lines.push(row(` ${theme.fg("dim", "arrows navigate  ctrl+arrows pan  Tab agent  Enter details  g/a/b views  u update  q close")}`));
    lines.push(row(""));

    const body = this.view === "agents" ? this.renderAgents(inner) : this.renderNodes(inner, this.view === "blockers");
    for (const line of body.slice(this.panY, this.panY + 14)) lines.push(row(line));
    if (body.length === 0) lines.push(row(` ${theme.fg("muted", "No macro activity yet")}`));

    const selected = this.graph.nodes.find((node) => node.id === this.selectedId);
    if (this.detail && selected) {
      lines.push(row(""));
      lines.push(row(` ${theme.fg("accent", "Details")} ${selected.label}`));
      lines.push(row(` owner:${agentLabel(this.graph, selected.agentId)} status:${selected.status} duration:${formatDuration(selected.durationMs)} impact:${selected.impact ?? "medium"}`));
      if (selected.blocker) lines.push(row(` blocker:${selected.blocker}`));
      if (selected.detail) lines.push(row(` ${selected.detail}`));
    }
    lines.push(border("╰", "─", "╯"));
    return lines.map((line) => fit(line, w));
  }

  invalidate(): void {}
  dispose(): void { this.unsubscribe(); }

  get selectedNodeId(): string | undefined { return this.selectedId; }
  get currentView(): OverviewView { return this.view; }
  get pan(): Point { return { x: this.panX, y: this.panY }; }

  private renderNodes(width: number, blockersOnly: boolean): string[] {
    const theme = this.options.theme;
    const matching = this.graph.nodes.filter((node) =>
      !blockersOnly || node.type === "blocker" || node.status === "blocked" || node.status === "failed",
    );
    if (blockersOnly) {
      return matching.map((node) => {
        const marker = node.id === this.selectedId ? theme.fg("accent", "▶") : " ";
        return truncateToWidth(
          `${marker} ${statusGlyph(node.status)} ${node.label} · ${agentLabel(this.graph, node.agentId)} · impact:${node.impact ?? "medium"}`,
          width,
          "…",
        );
      });
    }

    const lines: string[] = [];
    for (const agent of this.graph.agents) {
      const lane = matching.filter((node) => node.agentId === agent.id);
      if (lane.length === 0) continue;
      const visibleLane = lane.slice(this.panX);
      const laneState = agent.status === "running" ? theme.fg("success", "running") : theme.fg("dim", agent.status);
      const firstNode = visibleLane[0];
      const inbound = firstNode && this.graph.edges.some((edge) => edge.to === firstNode.id && this.graph.nodes.find((node) => node.id === edge.from)?.agentId !== agent.id)
        ? theme.fg("dim", " ↳ cross-agent handoff")
        : "";
      lines.push(truncateToWidth(` ${theme.fg("accent", theme.bold(agent.label))}  ${laneState}${inbound}`, width, "…"));
      const flow: string[] = [];
      for (let index = 0; index < visibleLane.length; index++) {
        const node = visibleLane[index]!;
        if (index > 0) {
          const previous = visibleLane[index - 1]!;
          const edge = this.graph.edges.find((candidate) => candidate.from === previous.id && candidate.to === node.id);
          flow.push(theme.fg("dim", edge ? connectorFor(edge.kind) : "   "));
        }
        flow.push(this.renderCard(node));
      }
      lines.push(truncateToWidth(`   ${flow.join(" ")}`, width, "…"));
      const selected = visibleLane.find((node) => node.id === this.selectedId);
      if (selected?.blocker) lines.push(truncateToWidth(`      ${theme.fg("warning", `└─ blocked: ${selected.blocker}`)}`, width, "…"));
    }
    return lines;
  }

  private renderCard(node: GraphNode): string {
    const theme = this.options.theme;
    const selected = node.id === this.selectedId;
    const compactLabel = truncateToWidth(node.label, 22, "…");
    const content = `${statusGlyph(node.status)} ${node.type}: ${compactLabel}`;
    const card = `[ ${content} ]`;
    if (selected) return theme.bg("selectedBg", theme.fg("accent", card));
    if (node.status === "blocked" || node.status === "failed") return theme.fg("warning", card);
    if (node.status === "completed") return theme.fg("success", card);
    return card;
  }

  private renderAgents(width: number): string[] {
    return this.graph.agents.map((agent, index) => {
      const selected = index === this.selectedAgent ? this.options.theme.fg("accent", "▶") : " ";
      const owned = this.graph.nodes.filter((node) => node.agentId === agent.id);
      const active = owned.filter((node) => node.status === "active").length;
      const blocked = owned.filter((node) => node.status === "blocked" || node.status === "failed").length;
      return truncateToWidth(`${selected} ${agent.label} status:${agent.status} active:${active} blockers:${blocked}`, width, "…");
    });
  }

  private visibleNodes(): GraphNode[] {
    if (this.view === "graph" || this.view === "blockers") return this.graph.nodes;
    const agent = this.graph.agents[this.selectedAgent];
    if (!agent) return this.graph.nodes;
    const owned = this.graph.nodes.filter((node) => node.agentId === agent.id);
    return owned.length ? owned : this.graph.nodes;
  }

  private layout(): Map<string, Point> {
    const lanes = new Map(this.graph.agents.map((agent, index) => [agent.id, index]));
    const perLane = new Map<number, number>();
    const points = new Map<string, Point>();
    for (const node of this.graph.nodes) {
      const y = (lanes.get(node.agentId) ?? 0) * 2;
      const x = perLane.get(y) ?? 0;
      points.set(node.id, { x, y }); perLane.set(y, x + 1);
    }
    return points;
  }

  private move(dx: number, dy: number): void {
    const nodes = this.graph.nodes;
    if (!nodes.length) return;
    const points = this.layout();
    const current = points.get(this.selectedId ?? "") ?? points.get(nodes[0]!.id)!;
    let best: { node: GraphNode; score: number } | undefined;
    for (const node of nodes) {
      if (node.id === this.selectedId) continue;
      const point = points.get(node.id)!;
      const vx = point.x - current.x; const vy = point.y - current.y;
      if ((dx < 0 && vx >= 0) || (dx > 0 && vx <= 0) || (dy < 0 && vy >= 0) || (dy > 0 && vy <= 0)) continue;
      const primary = dx ? Math.abs(vx) : Math.abs(vy);
      const secondary = dx ? Math.abs(vy) : Math.abs(vx);
      const score = primary * 10 + secondary;
      if (!best || score < best.score) best = { node, score };
    }
    if (best) {
      this.selectedId = best.node.id;
      const agentIndex = this.graph.agents.findIndex((agent) => agent.id === best!.node.agentId);
      if (agentIndex >= 0) this.selectedAgent = agentIndex;
    }
  }

  private nextAgent(): void {
    if (!this.graph.agents.length) return;
    this.selectedAgent = (this.selectedAgent + 1) % this.graph.agents.length;
    this.selectedId = this.graph.nodes.find((node) => node.agentId === this.graph.agents[this.selectedAgent]!.id)?.id ?? this.selectedId;
  }

  private ensureVisible(): void {
    const point = this.layout().get(this.selectedId ?? "");
    if (!point) return;
    if (point.x < this.panX) this.panX = point.x;
    if (point.x > this.panX + 4) this.panX = point.x - 4;
    if (point.y < this.panY) this.panY = point.y;
    if (point.y > this.panY + 8) this.panY = point.y - 8;
  }
}

function fit(text: string, width: number): string { return truncateToWidth(text, Math.max(1, width), ""); }
function agentLabel(graph: PublicGraph, id: string): string { return graph.agents.find((agent) => agent.id === id)?.label ?? "Agent"; }
function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "active";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
function connectorFor(kind: PublicGraph["edges"][number]["kind"]): string {
  return ({
    sequence: "──→",
    "depends-on": "═dep→",
    delegates: "─del→",
    revises: "↺──→",
    integrates: "─int→",
    blocks: "─!→",
  })[kind];
}
function statusGlyph(status: GraphNode["status"]): string {
  return ({ pending: "○", active: "◉", completed: "✓", blocked: "!", failed: "×", cancelled: "–" })[status];
}
