import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import semanticOverview, { OVERVIEW_SUBCOMMANDS } from "../src/index.js";
import { normalizeConfig } from "../src/config.js";
import { modelReference, parseModelReference } from "../src/model-reference.js";
import { listOverviewModelChoices, OverviewModelPicker } from "../src/settings.js";
import { resolveModel } from "../src/summarizer.js";

function model(provider: string, id: string, name = id) {
  return { provider, id, name } as never;
}

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

describe("overview command surface", () => {
  it("registers one parent command with discoverable child commands", () => {
    const commands: Array<{ name: string; options: { getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null } }> = [];
    semanticOverview({
      registerFlag: vi.fn(),
      registerShortcut: vi.fn(),
      registerCommand: (name: string, options: never) => commands.push({ name, options }),
      getFlag: vi.fn(),
      appendEntry: vi.fn(),
      on: vi.fn(),
      events: { on: vi.fn(() => vi.fn()) },
    } as never);
    expect(commands.map((command) => command.name)).toEqual(["overview"]);
    expect(OVERVIEW_SUBCOMMANDS.map((command) => command.name)).toEqual([
      "settings", "rules", "update", "rebuild", "status", "help",
    ]);
    expect(commands[0]?.options.getArgumentCompletions?.("set")?.map((item) => item.value)).toEqual(["settings"]);
  });
});

describe("overview model settings", () => {
  it("keeps provider identity when duplicate model IDs exist", () => {
    const choices = listOverviewModelChoices({
      model: model("local", "gpt-codex"),
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [
          model("openai", "gpt-codex", "GPT Codex API"),
          model("openai-codex", "gpt-codex", "GPT Codex OAuth"),
        ],
      },
    } as never);
    expect(choices.map((choice) => choice.value)).toEqual([
      "inherit",
      "off",
      "openai/gpt-codex",
      "openai-codex/gpt-codex",
    ]);
    expect(choices.find((choice) => choice.value === "openai/gpt-codex")?.provider).toBe("openai");
    expect(choices.find((choice) => choice.value === "openai-codex/gpt-codex")?.provider).toBe("openai-codex");
  });

  it("uses Pi's scoped model list when the session has one", () => {
    const choices = listOverviewModelChoices({
      scopedModels: [{ model: model("anthropic", "scoped") }],
      modelRegistry: { getAvailable: () => [model("openai", "unscoped")] },
    } as never);
    expect(choices.map((choice) => choice.value)).toEqual(["inherit", "off", "anthropic/scoped"]);
  });

  it("renders a searchable picker and returns the provider-qualified selection", () => {
    const done = vi.fn();
    const picker = new OverviewModelPicker({
      title: "Select model",
      choices: [
        { value: "openai/gpt-codex", label: "gpt-codex", provider: "openai", description: "API model" },
        { value: "openai-codex/gpt-codex", label: "gpt-codex", provider: "openai-codex", description: "OAuth model" },
      ],
      currentValue: "openai/gpt-codex",
      theme,
      keybindings: getKeybindings(),
      done,
    });
    for (const width of [24, 72]) expect(picker.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    for (const character of "openai-codex") picker.handleInput(character);
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith("openai-codex/gpt-codex");
  });

  it("supports model IDs containing slashes and resolves the exact provider", () => {
    expect(modelReference("openrouter", "anthropic/claude-sonnet")).toBe("openrouter/anthropic/claude-sonnet");
    expect(parseModelReference("openrouter/anthropic/claude-sonnet")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet",
    });
    expect(normalizeConfig({ model: "openrouter/anthropic/claude-sonnet" }).model).toBe("openrouter/anthropic/claude-sonnet");

    const selected = model("openrouter", "anthropic/claude-sonnet");
    const find = vi.fn(() => selected);
    expect(resolveModel({ modelRegistry: { find } } as never, "openrouter/anthropic/claude-sonnet")).toBe(selected);
    expect(find).toHaveBeenCalledWith("openrouter", "anthropic/claude-sonnet");
  });

  it("keeps inherit explicit and rejects malformed references", () => {
    const active = model("lmstudio", "local-model");
    expect(resolveModel({ model: active } as never, "inherit")).toBe(active);
    expect(resolveModel({ model: active } as never, "off")).toBeUndefined();
    expect(normalizeConfig({ model: "missing-provider" as never }).model).toBe("inherit");
    expect(normalizeConfig({ model: "custom/my model" }).model).toBe("custom/my model");
    expect(parseModelReference("openai/gpt model")).toEqual({ provider: "openai", modelId: "gpt model" });
  });
});
