import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGraph } from "../src/reducer.js";
import { GraphStore } from "../src/store.js";
import { OverviewComponent } from "../src/tui.js";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function fixture() {
  const graph = createGraph("s", 0);
  graph.agents.push({ id: "sub", label: "Test specialist", parentId: "main", status: "running" });
  graph.nodes.push(
    { id: "n1", type: "planning", label: "Plan the stable macro workflow", detail: "The approach and success conditions are aligned before implementation begins.", agentId: "main", status: "completed", startedAt: 1, endedAt: 10, durationMs: 9, revision: 1 },
    { id: "n2", type: "implementation", label: "Implement the chosen semantic approach", detail: "The active phase evolves in place while preserving the wider workflow.", agentId: "main", status: "active", startedAt: 11, impact: "high", revision: 2 },
    { id: "n3", type: "blocker", label: "See /private/RAW_SENTINEL.ts", agentId: "main", status: "blocked", startedAt: 12, blocker: "token=RAW_SENTINEL", revision: 0 },
    { id: "n4", type: "delegation", label: "Validate the outcome independently", detail: "A specialist evaluates the macro result before integration.", agentId: "sub", status: "active", startedAt: 13, revision: 0 },
  );
  graph.edges.push(
    { id: "e1", from: "n1", to: "n2", kind: "sequence" },
    { id: "e2", from: "n2", to: "n3", kind: "blocks" },
    { id: "e3", from: "n2", to: "n4", kind: "delegates" },
  );
  return graph;
}

function component(overrides: Partial<ConstructorParameters<typeof OverviewComponent>[0]> = {}) {
  return new OverviewComponent({
    store: new GraphStore(fixture()), theme, requestRender: vi.fn(), onClose: vi.fn(), onUpdate: vi.fn(), ...overrides,
  });
}

describe("overview TUI", () => {
  it("renders a vertical multiline graph within visible width and hides raw data", () => {
    const view = component();
    for (const width of [24, 64, 91]) {
      const lines = view.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.length).toBeGreaterThanOrEqual(33);
      expect(lines.join("\n")).not.toContain("RAW_SENTINEL");
      if (width === 91) {
        expect(lines.join("\n")).toContain("▼");
        expect(lines.join("\n")).toContain("IMPLEMENTATION  ACTIVE");
        expect(lines.join("\n")).toContain("┌");
      }
    }
    view.dispose();
  });

  it("navigates vertically and opens executive focus for any selected block", () => {
    const view = component();
    view.render(91);
    expect(view.selectedNodeId).toBe("n1");
    view.handleInput("\u001b[B");
    expect(view.selectedNodeId).toBe("n2");
    view.handleInput("\r");
    expect(view.isFocused).toBe(true);
    const focus = view.render(91).join("\n");
    expect(focus).toContain("Executive Focus");
    expect(focus).toContain("EXECUTIVE SUMMARY");
    expect(focus).toContain("SEMANTIC CONTEXT");
    view.handleInput("\r");
    expect(view.isFocused).toBe(false);

    view.handleInput("\u001b[B");
    view.handleInput("\u001b[B");
    expect(view.selectedNodeId).toBe("n4");
    view.handleInput("\r");
    const subagentFocus = view.render(91).join("\n");
    expect(subagentFocus).toContain("Test specialist");
    expect(subagentFocus).toContain("DELEGATION");
    view.handleInput("\u001b");
    expect(view.isFocused).toBe(false);
    view.dispose();
  });

  it("returns from focus before closing and preserves update/disposal behavior", () => {
    const store = new GraphStore(fixture());
    const update = vi.fn(); const close = vi.fn();
    const view = new OverviewComponent({ store, theme, requestRender: vi.fn(), onClose: close, onUpdate: update });
    view.handleInput("b");
    expect(view.currentView).toBe("blockers");
    expect(view.selectedNodeId).toBe("n3");
    view.handleInput("\r");
    expect(view.isFocused).toBe(true);
    view.handleInput("\u001b");
    expect(view.isFocused).toBe(false);
    expect(close).not.toHaveBeenCalled();
    view.handleInput("u");
    expect(update).toHaveBeenCalledOnce();
    view.handleInput("\u001b");
    expect(close).toHaveBeenCalledOnce();
    expect(store.listenerCount).toBe(1);
    view.dispose();
    expect(store.listenerCount).toBe(0);
  });
});
