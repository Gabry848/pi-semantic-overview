import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGraph } from "../src/reducer.js";
import { GraphStore } from "../src/store.js";
import { buildDetailLines, OverviewComponent } from "../src/tui.js";
import { publicProjection } from "../src/privacy.js";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function fixture() {
  const graph = createGraph("s", 0);
  graph.agents.push(
    { id: "sub-a", label: "Independent reviewer", parentId: "main", status: "completed", mandate: "Assess the intended result against agreed success conditions" },
    { id: "sub-b", label: "Risk specialist", parentId: "main", status: "running", mandate: "Identify material concerns while main work continues" },
  );
  graph.nodes.push(
    {
      id: "main-1", type: "delegation", title: "Established the delivery direction and launched independent review",
      objective: "Deliver a compact executive workflow view with defensible outcomes", summary: ["The main direction and acceptance conditions were aligned", "Two bounded specialist reviews began in parallel"],
      macroSteps: [{ action: "Aligned the desired executive behavior", result: "The milestone structure and success conditions became explicit" }, { action: "Delegated independent review", result: "Parallel assessment began without pausing the main flow" }],
      outcome: "The delivery direction was ready for implementation", nextStep: "Continue the main flow while consuming explicit specialist checkpoints",
      agentId: "main", status: "completed", startedAt: 1,
    },
    {
      id: "sub-a-node", type: "verification", title: "Assessed the intended outcome independently", mandate: "Assess the intended result against agreed success conditions",
      summary: ["The review examined the result at executive level", "Intermediate findings were shared twice before completion"],
      macroSteps: [{ action: "Evaluated the intended behavior", result: "The review identified evidence supporting readiness" }, { action: "Refined the assessment after main feedback", result: "The final contribution became actionable" }],
      contribution: "Independent findings strengthened the final acceptance decision", currentWork: "The completed assessment is available to the main flow",
      agentId: "sub-a", status: "completed", startedAt: 2,
    },
    {
      id: "sub-b-node", type: "investigation", title: "Evaluating material delivery risks in parallel", mandate: "Identify material concerns while main work continues",
      summary: ["Risk review remains detached from the main execution path", "Only explicit findings will rejoin the main timeline"], currentWork: "Evaluating the remaining acceptance concern", concern: "One acceptance boundary still needs evidence", nextStep: "Report a concrete finding before any rejoin",
      agentId: "sub-b", status: "active", startedAt: 3,
    },
    {
      id: "main-2", type: "implementation", title: "Built the executive milestone timeline and global board",
      summary: ["The main flow now uses clear vertical circle connectors", "The board derives global status from the same milestones", "Parallel specialist work remains visually detached"],
      rationale: "A single semantic source prevents selection-dependent status drift", macroSteps: [{ action: "Structured concrete milestone cards", result: "Titles and summaries remain readable across multiple lines" }, { action: "Derived the global status board", result: "Done, current, issues, and next work stay stable" }],
      currentWork: "Refining the final integration behavior", concern: "Ambiguous branch correlation must never create a false rejoin", nextStep: "Complete verification with realistic parallel-branch scenarios",
      agentId: "main", status: "active", startedAt: 4,
    },
    {
      id: "main-3", type: "verification", title: "Confirm the complete executive workflow behavior", summary: ["The final review will cover privacy, width, persistence, and branch semantics", "Acceptance follows only after all checks pass"], nextStep: "Run the complete acceptance review",
      agentId: "main", status: "pending", startedAt: 6,
    },
    { id: "unsafe", type: "blocker", title: "See /private/RAW_SENTINEL.ts", agentId: "main", status: "blocked", startedAt: 7 },
  );
  graph.edges.push(
    { id: "main-seq-1", from: "main-1", to: "main-2", kind: "sequence" },
    { id: "main-seq-2", from: "main-2", to: "main-3", kind: "sequence" },
    { id: "delegate-a", from: "main-1", to: "sub-a-node", kind: "delegates" },
    { id: "delegate-b", from: "main-1", to: "sub-b-node", kind: "delegates" },
    { id: "check-a-1", from: "sub-a-node", to: "main-2", kind: "checks", strength: "intermediate", note: "The first finding informed the implementation direction" },
    { id: "check-a-2", from: "sub-a-node", to: "main-2", kind: "checks", strength: "intermediate", note: "A later finding refined the acceptance boundary" },
    { id: "integrate-a", from: "sub-a-node", to: "main-3", kind: "integrates", strength: "final", note: "The final contribution was incorporated into acceptance" },
  );
  return graph;
}

function component() {
  return new OverviewComponent({ store: new GraphStore(fixture()), theme, requestRender: vi.fn(), onClose: vi.fn(), onUpdate: vi.fn(), onRebuild: vi.fn() });
}

describe("executive overview TUI", () => {
  it("renders within width, uses circle/junction timeline, and never emits restricted cards", () => {
    const view = component();
    for (const width of [24, 72, 120]) {
      const rendered = view.render(width);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
      const text = rendered.join("\n");
      expect(text).not.toContain("RAW_SENTINEL");
      expect(text).not.toContain("Restricted activity");
      if (width === 120) {
        expect(text).toContain("○──");
        expect(text).toContain("RAMO PARALLELO");
        expect(rendered.some((line) => line.includes("○──") && line.includes("RAMO PARALLELO"))).toBe(true);
        expect(text.match(/CONTROLLO DEL MAIN/g)).toHaveLength(2);
        for (const heading of ["DONE", "NOW", "ISSUES", "NEXT"]) expect(text).toContain(heading);
        for (let index = 0; index < 4; index++) view.handleInput("\u001b[B");
        expect(view.render(120).join("\n")).toContain("INTEGRAZIONE FINALE");
      }
    }
    view.dispose();
  });

  it("keeps the global board stable regardless of selection", () => {
    const view = component();
    const before = view.render(120).join("\n");
    view.handleInput("\u001b[B");
    view.handleInput("\u001b[B");
    const after = view.render(120).join("\n");
    for (const content of ["Built the executive milestone", "Confirm the complete executive", "Independent reviewer", "Risk specialist"]) {
      expect(before).toContain(content);
      expect(after).toContain(content);
    }
    for (let index = 0; index < 20; index++) view.handleInput("\u001b[1;5B");
    const panned = view.render(120).join("\n");
    for (const heading of ["BOARD GLOBALE", "DONE", "NOW", "ISSUES", "NEXT"]) expect(panned).toContain(heading);
    view.dispose();
  });

  it("builds variable meaningful detail sections without telemetry or fixed padding", () => {
    const graph = publicProjection(fixture());
    const main = graph.nodes.find((node) => node.id === "main-2")!;
    const sub = graph.nodes.find((node) => node.id === "sub-a-node")!;
    const mainLines = buildDetailLines(graph, main, 62);
    const subLines = buildDetailLines(graph, sub, 62);
    expect(mainLines.length).toBeGreaterThanOrEqual(7);
    expect(mainLines.length).toBeLessThanOrEqual(45);
    expect(mainLines).toContain("PASSAGGI SVOLTI");
    expect(mainLines).toContain("IN CORSO");
    expect(subLines).toContain("MANDATO");
    expect(subLines).toContain("PASSAGGI SVOLTI");
    expect(subLines).toContain("CONTROLLI DEL MAIN");
    expect(subLines).toContain("CONTRIBUTO AL WORKFLOW");
    expect(subLines).toContain("STATO DEL RAMO");
    expect(subLines.filter((line) => line.includes("Controllo intermedio"))).toHaveLength(2);
    expect(subLines.some((line) => line.includes("INTEGRAZIONE FINALE"))).toBe(true);
    expect([...mainLines, ...subLines].join("\n")).not.toMatch(/revision|duration|telemetry|implementation · active/i);
    expect(mainLines.at(-1)).not.toBe("");
    const sparse = buildDetailLines(graph, { id: "sparse", type: "decision", title: "Selected the defensible direction", agentId: "main", status: "completed", startedAt: 1 }, 62);
    expect(sparse).toEqual(["Selected the defensible direction", "Main agent · Completato"]);
  });

  it("renders sparse Enter detail at its natural height without blank padding", () => {
    const graph = createGraph("sparse", 0);
    graph.nodes.push({ id: "sparse", type: "decision", title: "Selected the defensible direction", agentId: "main", status: "completed", startedAt: 1 });
    const view = new OverviewComponent({ store: new GraphStore(graph), theme, requestRender: vi.fn(), onClose: vi.fn(), onUpdate: vi.fn(), onRebuild: vi.fn() });
    view.render(120);
    view.handleInput("\r");
    const rendered = view.render(120);
    expect(rendered.length).toBeLessThan(12);
    expect(rendered.at(-2)).toContain("Main agent · Completato");
    view.dispose();
  });

  it("opens detail, returns before closing, and disposes subscriptions", () => {
    const store = new GraphStore(fixture());
    const close = vi.fn(); const update = vi.fn(); const rebuild = vi.fn();
    const view = new OverviewComponent({ store, theme, requestRender: vi.fn(), onClose: close, onUpdate: update, onRebuild: rebuild });
    view.render(120);
    view.handleInput("\r");
    expect(view.isFocused).toBe(true);
    expect(view.render(120).join("\n")).toContain("PASSAGGI SVOLTI");
    view.handleInput("\u001b");
    expect(view.isFocused).toBe(false);
    view.handleInput("u"); expect(update).toHaveBeenCalledOnce();
    view.handleInput("r"); expect(rebuild).toHaveBeenCalledOnce();
    view.handleInput("\u001b"); expect(close).toHaveBeenCalledOnce();
    expect(store.listenerCount).toBe(1);
    view.dispose();
    expect(store.listenerCount).toBe(0);
  });
});
