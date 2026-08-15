import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PRESETS } from "./config.js";
import { modelReference } from "./model-reference.js";
import type { OverviewConfig, OverviewModel, OverviewThinking, PresetName } from "./types.js";

export interface OverviewModelChoice {
  value: OverviewModel;
  label: string;
  provider?: string;
  description: string;
}

/** Build the same effective model catalogue exposed by Pi to this session. */
export function listOverviewModelChoices(ctx: ExtensionCommandContext): OverviewModelChoice[] {
  const source = ctx.scopedModels.length > 0
    ? ctx.scopedModels.map((entry) => entry.model)
    : ctx.modelRegistry.getAvailable();
  const models = new Map<string, (typeof source)[number]>();
  for (const model of source) models.set(modelReference(model.provider, model.id), model);
  const exact = [...models.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
  const active = ctx.model ? modelReference(ctx.model.provider, ctx.model.id) : "none";
  return [
    {
      value: "inherit",
      label: "Use active Pi model",
      description: `Follow Pi's current model (${active}). This can include a local model.`,
    },
    {
      value: "off",
      label: "Model off",
      description: "Never make semantic overview model calls.",
    },
    ...exact.map((model) => ({
      value: modelReference(model.provider, model.id),
      label: model.id,
      provider: model.provider,
      description: `${model.name} · exact provider ${model.provider}`,
    })),
  ];
}

interface ChoicePickerOptions {
  title: string;
  choices: readonly OverviewModelChoice[];
  currentValue: string;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: (value?: string) => void;
}

export class OverviewModelPicker implements Component, Focusable {
  private readonly search = new Input();
  private filtered: OverviewModelChoice[];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.search.focused = value; }

  constructor(private readonly options: ChoicePickerOptions) {
    this.filtered = [...options.choices];
    const currentIndex = this.filtered.findIndex((choice) => choice.value === options.currentValue);
    this.selectedIndex = currentIndex < 0 ? 0 : currentIndex;
  }

  handleInput(data: string): void {
    const { keybindings } = this.options;
    if (keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
    } else if (keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 10);
    } else if (keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(Math.max(0, this.filtered.length - 1), this.selectedIndex + 10);
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.options.done(selected.value);
    } else if (keybindings.matches(data, "tui.select.cancel")) {
      this.options.done();
    } else {
      this.search.handleInput(data);
      const query = this.search.getValue();
      this.filtered = query
        ? fuzzyFilter([...this.options.choices], query, (choice) => `${choice.value} ${choice.label} ${choice.provider ?? ""} ${choice.description}`)
        : [...this.options.choices];
      this.selectedIndex = 0;
    }
  }

  render(width: number): string[] {
    const { theme } = this.options;
    const lines = [theme.fg("accent", theme.bold(this.options.title)), ""];
    lines.push(...this.search.render(width));
    lines.push("");
    const maxVisible = 10;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
    const end = Math.min(start + maxVisible, this.filtered.length);
    for (let index = start; index < end; index++) {
      const choice = this.filtered[index]!;
      const selected = index === this.selectedIndex;
      const prefix = selected ? theme.fg("accent", "→ ") : "  ";
      const label = selected ? theme.fg("accent", choice.label) : choice.label;
      const provider = choice.provider ? theme.fg("muted", ` [${choice.provider}]`) : "";
      const current = choice.value === this.options.currentValue ? theme.fg("success", " ✓") : "";
      lines.push(truncateToWidth(`${prefix}${label}${provider}${current}`, width));
    }
    if (this.filtered.length === 0) lines.push(theme.fg("muted", "  No matching models"));
    else {
      if (start > 0 || end < this.filtered.length) lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`));
      const selected = this.filtered[this.selectedIndex];
      if (selected) {
        lines.push("");
        for (const line of wrapTextWithAnsi(selected.description, Math.max(1, width - 4))) {
          lines.push(theme.fg("muted", `  ${line}`));
        }
        lines.push(theme.fg("dim", `  Saved as: ${selected.value}`));
      }
    }
    lines.push("", theme.fg("dim", "  Type to search · ↑↓ navigate · Enter select · Esc back"));
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void { this.search.invalidate(); }
}

export async function showOverviewSettings(
  ctx: ExtensionCommandContext,
  config: OverviewConfig,
): Promise<Partial<OverviewConfig> | undefined> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("Overview settings require interactive TUI mode", "warning");
    return undefined;
  }

  const refreshController = new AbortController();
  const refreshTimeout = setTimeout(() => refreshController.abort(), 15_000);
  let refreshWarning: string | undefined;
  try {
    const result = await ctx.modelRegistry.refresh({ signal: refreshController.signal });
    if (result.aborted) refreshWarning = "Model refresh timed out; showing Pi's cached model list.";
    else if (result.errors.size > 0) refreshWarning = `Could not refresh ${result.errors.size} provider catalogue(s); showing cached models.`;
  } catch {
    refreshWarning = "Could not refresh Pi's model list; showing cached models.";
  } finally {
    clearTimeout(refreshTimeout);
  }

  const modelChoices = listOverviewModelChoices(ctx);
  const changes: Partial<OverviewConfig> = {};
  let changed = false;
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const items: SettingItem[] = [
      {
        id: "enabled", label: "Overview", currentValue: config.enabled ? "enabled" : "disabled",
        values: ["enabled", "disabled"], description: "Enable or pause overview synthesis and status updates.",
      },
      {
        id: "preset", label: "Preset", currentValue: config.preset,
        values: Object.keys(PRESETS), description: "Choose the semantic emphasis and default update cadence.",
      },
      {
        id: "model", label: "Model", currentValue: config.model,
        description: "Choose an exact provider/model from Pi's configured catalogue. Duplicate model IDs remain distinct by provider.",
      },
      {
        id: "thinking", label: "Thinking", currentValue: config.thinking,
        values: ["low", "medium", "high"], description: "Reasoning effort used only for semantic overview calls.",
      },
      {
        id: "everyTurns", label: "Update interval", currentValue: String(config.everyTurns),
        values: Array.from({ length: 50 }, (_, index) => String(index + 1)), description: "Turns between periodic semantic updates (1–50).",
      },
    ];
    const container = new Container();
    let activeModelPicker: OverviewModelPicker | undefined;
    let focused = false;
    const modelItem = items.find((item) => item.id === "model");
    if (modelItem) {
      modelItem.submenu = (currentValue, submenuDone) => {
        const picker = new OverviewModelPicker({
          title: "Select the overview model",
          choices: modelChoices,
          currentValue,
          theme,
          keybindings,
          done: (value) => { activeModelPicker = undefined; submenuDone(value); },
        });
        picker.focused = focused;
        activeModelPicker = picker;
        return picker;
      };
    }
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Semantic overview settings")), 1, 0));
    if (refreshWarning) container.addChild(new Text(theme.fg("warning", refreshWarning), 1, 0));
    const settings = new SettingsList(
      items,
      9,
      getSettingsListTheme(),
      (id, value) => {
        changed = true;
        if (id === "enabled") changes.enabled = value === "enabled";
        else if (id === "preset") changes.preset = value as PresetName;
        else if (id === "model") changes.model = value as OverviewModel;
        else if (id === "thinking") changes.thinking = value as OverviewThinking;
        else if (id === "everyTurns") changes.everyTurns = Number(value);
      },
      () => done(undefined),
    );
    container.addChild(settings);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; if (activeModelPicker) activeModelPicker.focused = value; },
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => { settings.handleInput(data); tui.requestRender(); },
    };
  });
  return changed ? changes : undefined;
}
