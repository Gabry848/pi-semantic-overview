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
  graph.nodes.push(
    { id: "n1", type: "planning", label: "Plan macro phase", agentId: "main", status: "completed", startedAt: 1, endedAt: 10, durationMs: 9, revision: 0 },
    { id: "n2", type: "implementation", label: "Implement macro phase", agentId: "main", status: "active", startedAt: 11, impact: "high", revision: 0 },
    { id: "n3", type: "blocker", label: "See /private/RAW_SENTINEL.ts", agentId: "main", status: "blocked", startedAt: 12, blocker: "token=RAW_SENTINEL", revision: 0 },
  );
  graph.edges.push({ id: "e1", from: "n1", to: "n2", kind: "sequence" });
  return graph;
}

describe("overview TUI", () => {
  it("obeys visible width and never renders a raw sentinel", () => {
    const component = new OverviewComponent({ store: new GraphStore(fixture()), theme, requestRender: vi.fn(), onClose: vi.fn(), onUpdate: vi.fn() });
    for (const width of [24, 64, 91]) {
      const lines = component.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("RAW_SENTINEL");
      if (width === 91) expect(lines.join("\n")).toContain("──→");
    }
    component.dispose();
  });

  it("supports spatial navigation, views, panning, update, and disposal", () => {
    const store = new GraphStore(fixture());
    const update = vi.fn(); const close = vi.fn();
    const component = new OverviewComponent({ store, theme, requestRender: vi.fn(), onClose: close, onUpdate: update });
    expect(component.selectedNodeId).toBe("n1");
    component.handleInput("\u001b[C");
    expect(component.selectedNodeId).toBe("n2");
    component.handleInput("b"); expect(component.currentView).toBe("blockers");
    component.handleInput("\u001b[1;5C"); expect(component.pan.x).toBeGreaterThanOrEqual(1);
    component.handleInput("u"); expect(update).toHaveBeenCalledOnce();
    component.handleInput("q"); expect(close).toHaveBeenCalledOnce();
    expect(store.listenerCount).toBe(1);
    component.dispose();
    expect(store.listenerCount).toBe(0);
  });
});
