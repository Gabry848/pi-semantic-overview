import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { loadConfig, PRESETS } from "./config.js";
import { EvidenceBuffer } from "./evidence.js";
import { EventNormalizer, normalizeSubagentEvent } from "./normalizer.js";
import { serializeSnapshot, restoreFromBranch, SNAPSHOT_ENTRY } from "./persistence.js";
import { reduceEvent, createGraph } from "./reducer.js";
import { SingleFlightScheduler } from "./scheduler.js";
import { GraphStore } from "./store.js";
import { SemanticSummarizer } from "./summarizer.js";
import { OverviewComponent } from "./tui.js";
import type { EventKind, NormalizedEvent, OverviewConfig, PresetName } from "./types.js";

const SUBAGENT_CHANNELS = [
  "subagents:created", "subagents:started", "subagents:completed",
  "subagents:failed", "subagents:compacted", "subagents:steered",
] as const;

export default function semanticOverview(pi: ExtensionAPI) {
  let config: OverviewConfig = {
    enabled: true, preset: "balanced", model: "inherit", thinking: "low", everyTurns: 4,
    maxEvidenceItems: 12, maxEvidenceChars: 600, customRules: PRESETS.balanced.customRules,
  };
  let sessionOverrides: Partial<OverviewConfig> = {};
  let currentContext: ExtensionContext | undefined;
  let lastStatus = "deterministic mode";
  let started = false;
  let unsubscribers: Array<() => void> = [];
  const normalizer = new EventNormalizer();
  const evidence = new EvidenceBuffer(config.maxEvidenceItems, config.maxEvidenceChars);
  const store = new GraphStore(createGraph());

  const summarizer = new SemanticSummarizer({
    getGraph: () => store.get(),
    setGraph: (graph) => { store.set(graph); persist(); },
    getConfig: () => config,
    evidence,
    getContext: () => currentContext,
    onStatus: (status) => { lastStatus = status; updateFooter(); },
  });
  let scheduler = makeScheduler();

  function makeScheduler(): SingleFlightScheduler {
    return new SingleFlightScheduler({
      everyTurns: config.everyTurns,
      run: async (reason) => { await summarizer.run(reason); },
      onError: () => { lastStatus = "semantic update unavailable"; updateFooter(); },
    });
  }

  function updateFooter(): void {
    const ctx = currentContext;
    if (!ctx?.hasUI) return;
    if (!config.enabled) ctx.ui.setStatus("semantic-overview", undefined);
    else ctx.ui.setStatus("semantic-overview", ctx.ui.theme.fg("dim", `overview:${config.preset}`));
  }

  function persist(): void {
    if (!started || !currentContext) return;
    try { pi.appendEntry(SNAPSHOT_ENTRY, serializeSnapshot(store.get(), evidence.snapshot())); }
    catch { lastStatus = "snapshot rejected"; }
  }

  function ingest(kind: EventKind, raw: unknown, options: { key?: boolean; agentId?: string; timestamp?: number } = {}): void {
    if (!config.enabled) return;
    const event = normalizer.normalize(kind, raw, options.timestamp ?? Date.now(), options.agentId ?? "main");
    ingestNormalized(event, options.key ?? false);
  }

  function ingestNormalized(event: NormalizedEvent, key = false): void {
    const before = store.get();
    const after = reduceEvent(before, event);
    if (after !== before) { store.set(after); persist(); }
    if (key) scheduler.onKeyEvent();
  }

  async function reloadConfig(ctx: ExtensionContext): Promise<void> {
    const flagPreset = pi.getFlag("overview-preset");
    const flagModel = pi.getFlag("overview-model");
    const disabled = pi.getFlag("overview-disabled") === true;
    const flags: Partial<OverviewConfig> = {
      ...(typeof flagPreset === "string" ? { preset: flagPreset as PresetName } : {}),
      ...(typeof flagModel === "string" ? { model: flagModel as OverviewConfig["model"] } : {}),
      ...(disabled ? { enabled: false } : {}),
    };
    config = await loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), session: { ...flags, ...sessionOverrides } });
    evidence.configure(config.maxEvidenceItems, config.maxEvidenceChars);
    scheduler.configureEveryTurns(config.everyTurns);
    updateFooter();
  }

  async function showOverlay(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("Semantic overview requires interactive TUI mode", "warning");
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => new OverviewComponent({
        store, theme,
        requestRender: () => tui.requestRender(),
        onClose: () => done(undefined),
        onUpdate: () => scheduler.force(),
      }),
      {
        overlay: true,
        overlayOptions: { width: "78%", maxHeight: "90%", minWidth: 64, anchor: "center" },
      },
    );
  }

  pi.registerFlag("overview-model", { type: "string", description: "Semantic overview model: inherit, provider/model, or off" });
  pi.registerFlag("overview-preset", { type: "string", description: "Semantic overview preset" });
  pi.registerFlag("overview-disabled", { type: "boolean", description: "Disable semantic overview", default: false });

  pi.registerShortcut(Key.ctrlShift("o"), { description: "Open semantic overview", handler: showOverlay });
  pi.registerCommand("overview", { description: "Open the semantic overview overlay", handler: async (_args, ctx) => showOverlay(ctx) });
  pi.registerCommand("overview-update", {
    description: "Request a non-blocking semantic graph update",
    handler: async (_args, ctx) => { scheduler.force(); if (ctx.hasUI) ctx.ui.notify("Semantic update queued", "info"); },
  });
  pi.registerCommand("overview-status", {
    description: "Show semantic overview status",
    handler: async (_args, ctx) => {
      const graph = store.get();
      const model = config.model === "off" ? "off" : config.model;
      if (ctx.hasUI) ctx.ui.notify(`Overview ${config.enabled ? "enabled" : "disabled"}; ${graph.nodes.length} nodes; model ${model}; ${lastStatus}`, "info");
    },
  });
  pi.registerCommand("overview-rules", {
    description: "Edit session-level macro emphasis rules",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const rules = await ctx.ui.editor("Semantic overview rules", config.customRules);
      if (rules === undefined) return;
      sessionOverrides.customRules = rules.slice(0, 1000);
      await reloadConfig(ctx);
      ctx.ui.notify("Overview rules updated for this session; hard privacy rules remain enforced", "info");
    },
  });
  pi.registerCommand("overview-settings", {
    description: "Configure semantic overview for this session",
    handler: async (_args, ctx) => configureSession(ctx),
  });

  async function configureSession(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) return;
    const item = await ctx.ui.select("Semantic overview setting", ["Preset", "Model", "Thinking", "Update interval", "Enabled"]);
    if (!item) return;
    if (item === "Preset") {
      const value = await ctx.ui.select("Preset", Object.keys(PRESETS));
      if (value) sessionOverrides.preset = value as PresetName;
    } else if (item === "Model") {
      const value = await ctx.ui.input("Model", "inherit, off, or provider/model");
      if (value) sessionOverrides.model = value as OverviewConfig["model"];
    } else if (item === "Thinking") {
      const value = await ctx.ui.select("Thinking", ["low", "medium", "high"]);
      if (value) sessionOverrides.thinking = value as OverviewConfig["thinking"];
    } else if (item === "Update interval") {
      const value = await ctx.ui.input("Turns between updates", String(config.everyTurns));
      if (value && /^\d+$/.test(value)) sessionOverrides.everyTurns = Number(value);
    } else {
      const value = await ctx.ui.select("Overview", ["enabled", "disabled"]);
      if (value) sessionOverrides.enabled = value === "enabled";
    }
    await reloadConfig(ctx);
    ctx.ui.notify("Semantic overview session settings updated", "info");
  }

  pi.on("session_start", async (event, ctx) => {
    currentContext = ctx;
    started = false;
    await reloadConfig(ctx);
    store.set(restoreFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()));
    started = true;
    ingest("session.started", { status: event.reason });
    subscribeSubagents();
    updateFooter();
  });

  pi.on("session_before_switch", () => { /* lifecycle observed; no private target retained */ });
  pi.on("session_before_fork", () => { /* lifecycle observed; no entry content retained */ });
  pi.on("session_before_compact", () => { /* lifecycle observed; compaction payload ignored */ });
  pi.on("session_before_tree", () => { /* lifecycle observed; branch content ignored */ });
  pi.on("session_info_changed", () => { /* lifecycle observed; session name ignored */ });
  pi.on("session_compact", (event) => ingest("session.compacted", event, { key: true }));
  pi.on("session_tree", (event, ctx) => {
    store.set(restoreFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()));
    ingest("session.tree", event, { key: true });
  });
  pi.on("agent_start", (event) => ingest("agent.started", event));
  pi.on("agent_end", (event) => {
    const failed = event.messages.some((message) => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"));
    ingest("agent.completed", { isError: failed }, { key: true });
  });
  pi.on("agent_settled", () => { lastStatus = config.model === "off" ? "deterministic mode" : lastStatus; updateFooter(); });
  pi.on("turn_start", (event) => ingest("turn.started", event, { timestamp: event.timestamp }));
  pi.on("turn_end", (event) => { ingest("turn.completed", event); scheduler.onTurn(); });
  pi.on("tool_execution_start", (event) => ingest("tool.started", event));
  pi.on("tool_execution_update", () => { /* observed without retaining partial output */ });
  pi.on("tool_execution_end", (event) => {
    evidence.add("tool", event.result);
    ingest("tool.completed", event, { key: event.isError });
  });
  pi.on("tool_call", () => { /* lifecycle observed; arguments deliberately ignored */ });
  pi.on("tool_result", () => { /* lifecycle observed; execution-end owns bounded evidence */ });
  pi.on("before_agent_start", (event) => { evidence.add("prompt", event.prompt); });
  pi.on("message_start", () => { /* lifecycle observed; no content retained here */ });
  pi.on("message_update", () => { /* streaming content deliberately ignored */ });
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role === "assistant") evidence.add("assistant", message.content);
  });

  pi.on("session_shutdown", () => {
    persist();
    scheduler.dispose();
    summarizer.dispose();
    scheduler = makeScheduler();
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    evidence.clear(); normalizer.clear();
    currentContext?.ui.setStatus("semantic-overview", undefined);
    currentContext = undefined; started = false;
  });

  function subscribeSubagents(): void {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    for (const channel of SUBAGENT_CHANNELS) {
      unsubscribers.push(pi.events.on(channel, (raw) => {
        if (!config.enabled) return;
        if (channel === "subagents:completed") evidence.add("subagent", (raw as Record<string, unknown> | null)?.result);
        if (channel === "subagents:failed") evidence.add("subagent", (raw as Record<string, unknown> | null)?.error);
        if (channel === "subagents:created") evidence.add("subagent", (raw as Record<string, unknown> | null)?.description);
        if (channel === "subagents:steered") evidence.add("subagent", (raw as Record<string, unknown> | null)?.message);
        const event = normalizeSubagentEvent(channel, raw, normalizer);
        if (event) ingestNormalized(event, channel === "subagents:completed" || channel === "subagents:failed" || channel === "subagents:steered");
      }));
    }
  }
}
