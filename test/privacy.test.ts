import { describe, expect, it } from "vitest";
import { inspectPublicText, publicProjection } from "../src/privacy.js";
import { applyPatch, createGraph } from "../src/reducer.js";
import type { EvidenceItem, GraphNode } from "../src/types.js";

const evidence: EvidenceItem[] = [{ id: "sentinel", kind: "prompt", timestamp: 1, text: "alpha bravo charlie delta echo foxtrot private sentinel phrase" }];
const node = (title: string): GraphNode => ({ id: "safe-node", type: "verification", title, agentId: "main", status: "active", startedAt: 1 });

describe("recursive privacy boundary", () => {
  it("rejects paths, commands, code, secrets, and transcript wording", () => {
    for (const text of ["See /private/RAW_SENTINEL.ts", "npm run secret-task", "token=RAW_SENTINEL_VALUE", "assistant response: RAW_SENTINEL", "use `RAW_SENTINEL` now", "const x = secret", "SELECT * FROM users", "Expose @scope/private-package", "Mention pi-semantic-overview"]) {
      expect(inspectPublicText(text)).not.toHaveLength(0);
    }
  });

  it("rejects exact six-word copies without overmatching ordinary short phrases", () => {
    expect(inspectPublicText("alpha bravo", evidence)).toHaveLength(0);
    expect(inspectPublicText("alpha bravo charlie delta echo foxtrot", evidence).map((issue) => issue.code)).toContain("verbatim");
  });

  it("drops unsafe optional nested text but keeps safe semantic content", () => {
    const graph = applyPatch(createGraph("s", 0), {
      baseRevision: 0,
      operations: [{ op: "addNode", node: {
        ...node("Established independent readiness"),
        summary: ["A concrete review established the intended outcome", "See /private/RAW_SENTINEL.ts"],
        macroSteps: [
          { action: "Reviewed the intended operating behavior", result: "The expected outcome was confirmed" },
          { action: "Run npm test now", result: "RAW" },
        ],
        evidenceClaims: ["Independent checks support readiness", "token=RAW_SENTINEL"],
      } }],
    }, evidence);
    expect(graph.nodes[0]?.summary).toEqual(["A concrete review established the intended outcome"]);
    expect(graph.nodes[0]?.macroSteps).toHaveLength(1);
    expect(graph.nodes[0]?.evidenceClaims).toEqual(["Independent checks support readiness"]);
  });

  it("excludes an unsafe required title from public projection instead of rendering a restricted card", () => {
    const graph = createGraph("s", 0);
    graph.nodes.push(node("See /private/RAW_SENTINEL.ts"));
    const projected = publicProjection(graph, evidence);
    expect(projected.nodes).toHaveLength(0);
    expect(JSON.stringify(projected)).not.toContain("Restricted activity");
    expect(JSON.stringify(projected)).not.toContain("RAW_SENTINEL");
  });
});
