import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { loadConfig, PRESETS } from "./config.js";
import { EvidenceBuffer } from "./evidence.js";
import { correlatedSubagentIdFromTool, EventNormalizer, explicitSubagentResultStatus, normalizeSubagentEvent, stableToken } from "./normalizer.js";
import { parseSnapshot, serializeSnapshot, restoreFromBranch, SNAPSHOT_ENTRY } from "./persistence.js";
import { collectRebuildEvidence } from "./rebuild.js";
import { applyPatch, reduceEvent, createGraph } from "./reducer.js";
import { SingleFlightScheduler } from "./scheduler.js";
import { showOverviewSettings } from "./settings.js";
import { GraphStore } from "./store.js";
import { resolveModel, SemanticSummarizer } from "./summarizer.js";
import { OverviewComponent } from "./tui.js";
import type { EventKind, NormalizedEvent, OverviewConfig, PresetName } from "./types.js";

const SUBAGENT_CHANNELS = [
  "subagents:created", "subagents:started", "subagents:completed",
  "subagents:failed", "subagents:compacted", "subagents:steered",
] as const;

export const OVERVIEW_SUBCOMMANDS = [
  { name: "settings", description: "Configure the overview and choose an exact Pi model" },
  { name: "rules", description: "Edit session-level macro emphasis rules" },
  { name: "update", description: "Queue a semantic milestone update" },
  { name: "rebuild", description: "Preview and confirm a clean schema-v2 rebuild" },
  { name: "status", description: "Show overview and resolved model status" },
  { name: "help", description: "Show overview subcommands" },
] as const;

export default function semanticOverview(pi: ExtensionAPI) {
  let config: OverviewConfig = {
    enabled: true, preset: "balanced", model: "inherit", thinking: "low", everyTurns: 4,
    maxEvidenceItems: 12, maxEvidenceChars: 600, customRules: PRESETS.balanced.customRules,
  };
  let sessionOverrides: Partial<OverviewConfig> = {};
  let currentContext: ExtensionContext | undefined;
  let lastStatus = "clean deterministic view";
  let started = false;
  let semanticEpoch = 0;
  let unsubscribers: Array<() => void> = [];
  const pendingSubagentChecks = new Map<string, string>();
  const normalizer = new EventNormalizer();
  const evidence = new EvidenceBuffer(config.maxEvidenceItems, config.maxEvidenceChars);
  const store = new GraphStore(createGraph());

  const summarizer = new SemanticSummarizer({
    getGraph: () => store.get(),
    setGraph: (graph) => commitGraph(graph),
    getScope: () => `${semanticEpoch}:${currentContext?.sessionManager.getSessionId() ?? "none"}`,
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
      onError: () => { lastStatus = "semantic synthesis unavailable"; updateFooter(); },
    });
  }

  function updateFooter(): void {
    const ctx = currentContext;
    if (!ctx?.hasUI) return;
    if (!config.enabled) ctx.ui.setStatus("semantic-overview", undefined);
    else ctx.ui.setStatus("semantic-overview", ctx.ui.theme.fg("dim", `overview:${config.preset}`));
  }

  function commitGraph(graph: ReturnType<typeof store.get>): boolean {
    if (!started || !currentContext) return false;
    try {
      const snapshot = serializeSnapshot(graph);
      pi.appendEntry(SNAPSHOT_ENTRY, snapshot);
      store.set(graph);
      return true;
    } catch {
      lastStatus = "snapshot rejected";
      updateFooter();
      return false;
    }
  }

  function resetBranchScope(): void {
    semanticEpoch++;
    scheduler.invalidate();
    summarizer.dispose();
    evidence.clear();
    normalizer.clear();
    pendingSubagentChecks.clear();
  }

  function ingest(kind: EventKind, raw: unknown, options: { key?: boolean; agentId?: string; timestamp?: number } = {}): void {
    if (!config.enabled) return;
    const event = normalizer.normalize(kind, raw, options.timestamp ?? Date.now(), options.agentId ?? "main");
    ingestNormalized(event, options.key ?? false);
  }

  function ingestNormalized(event: NormalizedEvent, key = false): void {
    const before = store.get();
    const after = reduceEvent(before, event);
    if (after !== before) store.set(after); // Telemetry presence is in-memory and never appends a snapshot.
    if (key) scheduler.onKeyEvent();
  }

  function recordExplicitSubagentCheck(agentId: string, toolCallId: string, final: boolean): void {
    const graph = store.get();
    const chooseUnambiguous = (agentIdToMatch: string) => {
      const candidates = graph.nodes.filter((node) => node.agentId === agentIdToMatch && !node.supersededBy);
      const active = candidates.filter((node) => node.status === "active");
      return active.length === 1 ? active[0] : candidates.length === 1 ? candidates[0] : undefined;
    };
    const branchNode = chooseUnambiguous(agentId);
    const mainNode = chooseUnambiguous("main");
    if (!branchNode || !mainNode) return;
    const op = final ? "integrateBranch" as const : "checkBranch" as const;
    try {
      const next = applyPatch(graph, {
        baseRevision: graph.semanticRevision,
        operations: [{ op, id: `e:${final ? "integrate" : "check"}:${stableToken(toolCallId)}`, branchNodeId: branchNode.id, mainNodeId: mainNode.id }],
      });
      commitGraph(next);
    } catch { /* Ambiguous or cyclic correlations remain unconnected by design. */ }
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
        onRebuild: () => {
          done(undefined);
          queueMicrotask(() => { void rebuildOverview(ctx); });
        },
        getStatus: () => lastStatus,
      }),
      { overlay: true, overlayOptions: { width: "94%", maxHeight: "94%", minWidth: 76, anchor: "center" } },
    );
  }

  pi.registerFlag("overview-model", { type: "string", description: "Semantic overview model: inherit, provider/model, or off" });
  pi.registerFlag("overview-preset", { type: "string", description: "Semantic overview preset" });
  pi.registerFlag("overview-disabled", { type: "boolean", description: "Disable semantic overview", default: false });

  pi.registerShortcut(Key.ctrlShift("o"), { description: "Open semantic overview", handler: showOverlay });
  pi.registerCommand("overview", {
    description: "Open or configure semantic overview (settings, rules, update, rebuild, status)",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null;
      const matches = OVERVIEW_SUBCOMMANDS
        .filter((command) => command.name.startsWith(prefix.toLowerCase()))
        .map((command) => ({ value: command.name, label: command.name, description: command.description }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) return showOverlay(ctx);
      if (command === "settings") return configureSession(ctx);
      if (command === "rules") return editRules(ctx);
      if (command === "update") {
        scheduler.force();
        if (ctx.hasUI) ctx.ui.notify("Semantic update queued", "info");
        return;
      }
      if (command === "rebuild") return rebuildOverview(ctx);
      if (command === "status") return showStatus(ctx);
      if (command === "help") {
        if (ctx.hasUI) ctx.ui.notify(OVERVIEW_SUBCOMMANDS.map((item) => `/overview ${item.name} — ${item.description}`).join("\n"), "info");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(`Unknown overview command "${args.trim()}". Use /overview help.`, "warning");
    },
  });

  async function editRules(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) return;
    const rules = await ctx.ui.editor("Semantic overview rules", config.customRules);
    if (rules === undefined) return;
    sessionOverrides.customRules = rules.slice(0, 1000);
    await reloadConfig(ctx);
    ctx.ui.notify("Overview rules updated; hard privacy rules remain enforced", "info");
  }

  function showStatus(ctx: ExtensionCommandContext): void {
    const graph = store.get();
    const visible = graph.nodes.filter((node) => !node.supersededBy).length;
    const resolved = resolveModel(ctx, config.model);
    const resolvedText = resolved ? `${resolved.provider}/${resolved.id}` : config.model === "off" ? "off" : "unavailable";
    const authText = resolved ? (ctx.modelRegistry.hasConfiguredAuth(resolved) ? "authenticated" : "missing auth") : "";
    if (ctx.hasUI) ctx.ui.notify(
      `Overview ${config.enabled ? "enabled" : "disabled"}; ${visible} visible milestones; configured model ${config.model}; resolved model ${resolvedText}${authText ? ` (${authText})` : ""}; ${lastStatus}`,
      "info",
    );
  }

  async function rebuildOverview(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const waitForIdle = "waitForIdle" in ctx && typeof ctx.waitForIdle === "function" ? ctx.waitForIdle.bind(ctx) : undefined;
    if (waitForIdle) await waitForIdle();
    const source = collectRebuildEvidence(ctx.sessionManager.getBranch());
    const maySend = summarizer.isModelAvailable();
    if (maySend) {
      const approved = await ctx.ui.confirm(
        "Prepare semantic rebuild preview?",
        `This sends a bounded set of ${source.length} compaction/recent visible excerpts to the configured model. Tool results and thinking are excluded. Nothing is replaced yet.`,
      );
      if (!approved) return;
      const preview = await summarizer.previewRebuild(source, ctx.sessionManager.getSessionId());
      if (preview) {
        const titles = preview.nodes.filter((node) => node.agentId === "main" && !node.supersededBy).map((node, index) => `${index + 1}. ${node.title}`).join("\n");
        const replace = await ctx.ui.confirm("Replace overview with this preview?", titles || "The preview is a clean view with no invented milestones.");
        if (!replace) return;
        if (!commitGraph(preview)) {
          ctx.ui.notify("The rebuild preview could not be persisted; the current overview was kept", "warning");
          return;
        }
        lastStatus = "schema v2 rebuild applied";
        ctx.ui.notify("Semantic overview rebuilt", "info");
        return;
      }
      ctx.ui.notify(lastStatus.includes("rejected") || lastStatus.includes("unavailable")
        ? `A valid private rebuild preview could not be produced: ${lastStatus}`
        : "A valid private rebuild preview could not be produced", "warning");
    }
    const clean = await ctx.ui.confirm(
      "Start a clean schema-v2 view?",
      "The semantic model is off, unavailable, or did not return a valid private preview. This replaces the current overview with an empty v2 view rather than inventing history.",
    );
    if (!clean) return;
    const cleanGraph = createGraph(ctx.sessionManager.getSessionId());
    if (!commitGraph(cleanGraph)) {
      ctx.ui.notify("The clean overview could not be persisted; the current overview was kept", "warning");
      return;
    }
    lastStatus = "clean schema v2 view";
    ctx.ui.notify("Started a clean semantic overview", "info");
  }

  async function configureSession(ctx: ExtensionCommandContext): Promise<void> {
    const changes = await showOverviewSettings(ctx, config);
    if (!changes) return;
    const previousModel = config.model;
    sessionOverrides = { ...sessionOverrides, ...changes };
    // Fence and abort any in-flight call so a response from the previous model/provider cannot land.
    semanticEpoch++;
    summarizer.dispose();
    scheduler.invalidate();
    await reloadConfig(ctx);
    const resolved = resolveModel(ctx, config.model);
    const resolvedText = resolved ? `${resolved.provider}/${resolved.id}` : config.model;
    lastStatus = resolved && ctx.modelRegistry.hasConfiguredAuth(resolved)
      ? `configured model ready (${resolvedText})`
      : config.model === "off" ? "clean deterministic view" : `configured model unavailable (${resolvedText})`;
    updateFooter();
    ctx.ui.notify(`Semantic overview session settings updated · model ${config.model} → ${resolvedText}`, "info");
    if (config.enabled && config.model !== "off" && previousModel !== config.model) scheduler.force();
  }

  pi.on("session_start", async (event, ctx) => {
    resetBranchScope();
    currentContext = ctx;
    started = false;
    await reloadConfig(ctx);
    const branch = ctx.sessionManager.getBranch();
    const restored = restoreFromBranch(branch, ctx.sessionManager.getSessionId());
    store.set(restored);
    const migratedLegacy = hasLegacyOverview(branch);
    started = true;
    if (migratedLegacy) {
      commitGraph(restored);
      lastStatus = restored.nodes.length === 0 ? "legacy noise removed; run /overview rebuild" : `legacy view consolidated to ${restored.nodes.length} milestones`;
      if (ctx.hasUI) ctx.ui.notify(restored.nodes.length === 0
        ? "Legacy overview noise was removed. Run /overview rebuild to reconstruct useful executive milestones."
        : `Legacy overview was consolidated to ${restored.nodes.length} concrete milestones and persisted as schema v2.`, "info");
    }
    ingest("session.started", { status: event.reason });
    subscribeSubagents();
    updateFooter();
  });

  pi.on("session_before_switch", () => resetBranchScope());
  pi.on("session_before_fork", () => resetBranchScope());
  pi.on("session_before_compact", () => {});
  pi.on("session_before_tree", () => resetBranchScope());
  pi.on("session_info_changed", () => {});
  pi.on("session_compact", (event) => ingest("session.compacted", event, { key: true }));
  pi.on("session_tree", (event, ctx) => {
    resetBranchScope();
    store.set(restoreFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()));
    ingest("session.tree", event, { key: true });
  });
  pi.on("agent_start", (event) => ingest("agent.started", event));
  pi.on("agent_end", (event) => {
    const failed = event.messages.some((message) => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"));
    ingest("agent.completed", { isError: failed }, { key: true });
  });
  pi.on("agent_settled", () => { if (config.model === "off") lastStatus = "clean deterministic view"; updateFooter(); });
  pi.on("turn_start", (event) => ingest("turn.started", event, { timestamp: event.timestamp }));
  pi.on("turn_end", (event) => { ingest("turn.completed", event); scheduler.onTurn(); });
  pi.on("tool_execution_start", (event) => {
    const correlatedAgentId = correlatedSubagentIdFromTool(event.toolName, event.args);
    if (correlatedAgentId) pendingSubagentChecks.set(event.toolCallId, correlatedAgentId);
    ingest("tool.started", event);
  });
  pi.on("tool_execution_update", () => {});
  pi.on("tool_execution_end", (event) => {
    if (event.isError) evidence.add("tool", "A tool execution failed during the current milestone; no raw result was retained.");
    const correlatedAgentId = pendingSubagentChecks.get(event.toolCallId);
    pendingSubagentChecks.delete(event.toolCallId);
    if (correlatedAgentId && !event.isError) {
      const resultStatus = explicitSubagentResultStatus(event.result);
      if (resultStatus) {
        const final = resultStatus === "completed" || resultStatus === "steered";
        const relation = final ? "consumed the explicit final result from" : `checked explicit ${resultStatus} progress from`;
        evidence.add("subagent", `The main agent ${relation} background branch ${correlatedAgentId}.`);
        recordExplicitSubagentCheck(correlatedAgentId, event.toolCallId, final);
        scheduler.onKeyEvent();
      }
    }
    ingest("tool.completed", event, { key: event.isError });
  });
  pi.on("tool_call", () => {});
  pi.on("tool_result", () => {});
  pi.on("before_agent_start", (event) => { evidence.add("prompt", event.prompt); });
  pi.on("message_start", () => {});
  pi.on("message_update", () => {});
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role === "assistant") evidence.add("assistant", message.content);
  });

  pi.on("session_shutdown", () => {
    scheduler.dispose();
    summarizer.dispose();
    scheduler = makeScheduler();
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    evidence.clear(); normalizer.clear(); pendingSubagentChecks.clear();
    currentContext?.ui.setStatus("semantic-overview", undefined);
    currentContext = undefined; started = false;
  });

  function hasLegacyOverview(entries: readonly unknown[]): boolean {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== "custom" || record.customType !== SNAPSHOT_ENTRY) continue;
      const data = record.data as Record<string, unknown> | undefined;
      try { parseSnapshot(data); return data?.schemaVersion === 1; } catch { continue; }
    }
    return false;
  }

  function subscribeSubagents(): void {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    for (const channel of SUBAGENT_CHANNELS) {
      unsubscribers.push(pi.events.on(channel, (raw) => {
        if (!config.enabled) return;
        const event = normalizeSubagentEvent(channel, raw, normalizer);
        if (event && channel === "subagents:created") evidence.add("subagent", `Background branch ${event.agentId} was explicitly delegated; its private mandate was not retained.`);
        if (event && channel === "subagents:completed") evidence.add("subagent", `Background branch ${event.agentId} completed; completion alone does not imply integration.`);
        if (event && channel === "subagents:failed") evidence.add("subagent", `Background branch ${event.agentId} failed; its private error was not retained.`);
        if (event && channel === "subagents:steered") evidence.add("subagent", `Background branch ${event.agentId} received new direction; the private instruction was not retained.`);
        if (event) ingestNormalized(event, channel === "subagents:completed" || channel === "subagents:failed" || channel === "subagents:steered");
      }));
    }
  }
}
