# pi-semantic-overview

A passive, standalone Pi extension that turns free-running main-agent and `@tintinweb/pi-subagents` lifecycle telemetry into a live macro-level semantic graph. It observes work; it does not schedule work, enforce a workflow, expose chain-of-thought, or change agent behavior.

## Install

```sh
pi install git:github.com/Gabry848/pi-semantic-overview
```

After a future npm release, `pi install npm:pi-semantic-overview` will also be available.

For local development:

```sh
pi install /absolute/path/to/pi-semantic-overview
```

The package requires Pi 0.84.2 or newer. Subagent support is optional; when `@tintinweb/pi-subagents` is present, its public lifecycle event bus is observed.

## Use

- `/overview` opens a centered, tall 78% × 90% overlay with a primarily vertical workflow.
- `Ctrl+Shift+O` opens the same overlay.
- `/overview-settings` changes session-level preset, model, thinking level, cadence, or enabled state.
- `/overview-rules` edits natural-language emphasis rules for the current session.
- `/overview-update` queues an immediate semantic update without blocking the main agent.
- `/overview-status` reports mode and graph size.

Overlay controls:

- Up/down: follow the vertical macro workflow
- Left/right: follow incoming or outgoing semantic relationships
- Ctrl+up/down: manual vertical pan
- Tab: next agent
- Enter on any block: open its executive focus view; Enter or Escape returns
- `g`, `a`, `b`: graph, agents, and blockers views
- `u`: queue semantic update
- `q` or Escape: close

The deterministic reducer always works, including with the model disabled or unavailable. It maintains stable per-agent fallback phases rather than turning each tool, turn, compaction, or observation cycle into a new block.

Semantic model updates reconcile evidence against the whole graph. Updating or enriching the current macro phase is the default; a new block is reserved for a genuine phase transition, decision, delegation, blocker, revision, integration, or handoff. The executive focus view provides richer purpose, state, relationships, and outcome context without exposing micro steps or raw activity.

## Configuration

Configuration is merged in this order: defaults, preset, global file, trusted project file, CLI flags, then session overrides.

- Global: `~/.pi/agent/semantic-overview.json`
- Trusted project: `.pi/semantic-overview.json`

```json
{
  "enabled": true,
  "preset": "balanced",
  "model": "inherit",
  "thinking": "low",
  "everyTurns": 4,
  "maxEvidenceItems": 12,
  "maxEvidenceChars": 600,
  "customRules": "Emphasize decisions and verification."
}
```

Presets are `executive`, `balanced`, `technical-macro`, `blockers`, and `delegation`.

Model values:

- `inherit`: use the active Pi model
- `provider/model`: use a specific configured model
- `off`: deterministic graph only, with no overview model requests

Thinking values are `low`, `medium`, or `high`. CLI flags are `--overview-model`, `--overview-preset`, and `--overview-disabled`.

Project configuration is ignored unless Pi considers the project trusted. Invalid values fall back to safe defaults. Natural-language rules affect granularity and emphasis only; they are treated as untrusted preferences and cannot weaken privacy rules.

## Privacy model

The extension separates private ephemeral evidence from public graph data.

Public graph, overlay, and persisted custom entries never intentionally contain prompt text, assistant text, tool arguments, tool output, commands, paths, code, or raw subagent descriptions/results/errors. Public text is rejected or replaced when it contains code fences/backticks, likely paths or filenames, shell commands, secrets, transcript-like wording, or an exact six-word sequence copied from currently held sensitive evidence. The TUI receives only a public projection.

To improve semantic summaries, the extension may hold a small, bounded set of excerpts in process memory. When a semantic model is enabled, **ephemeral-content sends those bounded excerpts to the configured model provider**. Excerpts are cleared after the request that consumed them and are never written by this package to session persistence. Set `model` to `off` to prevent these model requests.

Snapshots are sanitized and written only through `pi.appendEntry`; they do not enter model context. Restore scans only the current session branch.

`@tintinweb/pi-subagents` controls which child lifecycle events are emitted. Its nested/child telemetry can be limited by that package, so the overview may show only top-level subagents. This package does not read child transcript files or persisted raw subagent records.

## Model cost

Deterministic event reduction has no model cost. With a model enabled, requests happen every `everyTurns` completed turns and after key events such as failures, completion, steering, or compaction. Scheduling is serial and single-flight; bursts are coalesced. Prompts and evidence are bounded, but normal provider input/output charges still apply. Use a larger cadence, `low` thinking, or `model: "off"` to control cost.

## Persistence and branching

The graph is non-destructive at the semantic level: model patches normally enrich and transition existing macro nodes in place, and may append nodes/edges only for genuine new phases. They cannot delete or replace graph state. Duplicate active phases for the same agent and semantic type are rejected in favor of updating the existing node. Stale, malformed, unsafe, cyclic, or illegal patches are rejected. Sanitized snapshots follow Pi session branches and are restored from the current branch after reload or tree navigation.

## Limitations

- This is a macro observer, not a workflow engine or task manager.
- Tool classification is heuristic and intentionally does not inspect arguments.
- No chain-of-thought access is claimed or attempted; only ordinary lifecycle telemetry and bounded visible content excerpts are used.
- Semantic labels may be coarse, especially in deterministic mode.
- Provider availability, authentication, or malformed model JSON causes a safe fallback to deterministic mode.
- The overlay is designed for terminals at least 64 columns wide.
- Privacy detection is conservative and may replace benign text with a restricted label.
- Subagent event coverage depends on the installed `@tintinweb/pi-subagents` version and its telemetry policy.

## Development

```sh
npm install
npm run check
```

Tests cover stable macro reconciliation, reducer transitions, stale patches, duplicate active phases, deduplication, cycles, privacy sentinels, classifier/normalizer behavior, scheduler single-flight behavior, persistence, subagent correlation, vertical TUI layout/navigation, and executive focus behavior.

## License

MIT
