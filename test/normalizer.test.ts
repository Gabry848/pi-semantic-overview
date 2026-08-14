import { describe, expect, it } from "vitest";
import { classifyTool, EventNormalizer } from "../src/normalizer.js";

describe("normalizer and tool classifier", () => {
  it("classifies macro activity", () => {
    expect(classifyTool("read")).toBe("investigation");
    expect(classifyTool("write")).toBe("implementation");
    expect(classifyTool("vitest_runner")).toBe("verification");
    expect(classifyTool("Agent")).toBe("delegation");
  });

  it("never copies arguments, output, commands, paths, or code", () => {
    const n = new EventNormalizer();
    const raw = {
      toolCallId: "call-secret", toolName: "bash",
      args: { command: "RAW_COMMAND_SENTINEL", path: "/RAW/PATH.ts", code: "RAW_CODE" },
      result: "RAW_OUTPUT_SENTINEL", error: "RAW_ERROR_SENTINEL",
    };
    const normalized = n.normalize("tool.started", raw, 100);
    const json = JSON.stringify(normalized);
    for (const sentinel of ["RAW_COMMAND_SENTINEL", "RAW", "PATH.ts", "RAW_CODE", "RAW_OUTPUT_SENTINEL", "RAW_ERROR_SENTINEL", "call-secret"]) {
      expect(json).not.toContain(sentinel);
    }
    expect(normalized.toolClass).toBe("implementation");
  });

  it("correlates duration without exposing call ids", () => {
    const n = new EventNormalizer();
    n.normalize("tool.started", { toolCallId: "private-call", toolName: "read" }, 10);
    const end = n.normalize("tool.completed", { toolCallId: "private-call", toolName: "read" }, 35);
    expect(end.durationMs).toBe(25);
    expect(end.correlationId).not.toBe("private-call");
  });
});
