# pi-semantic-overview

A passive Pi extension that turns main-agent and optional `@tintinweb/pi-subagents` lifecycle evidence into a compact executive milestone timeline. It observes work; it does not schedule agents, enforce a workflow, expose chain of thought, or turn tool activity into a task list.

## Install

```sh
pi install git:github.com/Gabry848/pi-semantic-overview
```

For local development:

```sh
pi install /absolute/path/to/pi-semantic-overview
```

Pi 0.84.2 or newer is required. Subagent support is optional and uses that package's public lifecycle event bus.

## Use

- `/overview` or `Ctrl+Shift+O`: open the centered 94% × 94% overlay.
- `/overview-update`: queue a semantic synthesis pass.
- `/overview-rebuild`: prepare a bounded schema-v2 rebuild, show a concrete preview, and ask before replacement.
- `/overview-settings`: change the session preset, model, thinking level, cadence, or enabled state.
- `/overview-rules`: edit session-level emphasis preferences.
- `/overview-status`: show mode and visible milestone count.

Overlay controls:

- Up/down: move through the executive timeline, including detached branches.
- Left/right: follow incoming/outgoing semantic relationships.
- Ctrl+up/down: pan manually.
- Tab: move between agents.
- Enter: open variable-length milestone detail; Enter or Escape returns.
- `g`, `a`, `b`: timeline, agents, and issues views.
- `u`: queue an update.
- `q` or Escape: close.

## Executive layout

The primary view is a mostly vertical timeline of 2–12 concrete main milestones when meaningful evidence exists. Milestones use visible circle/junction connectors, multiline titles, and concrete summary cards. An empty clean view is preferred to invented history.

The right board is global and selection-independent:

- **DONE**: completed milestones
- **NOW**: active milestones
- **ISSUES**: blockers, blocked work, and failed outcomes
- **NEXT**: committed pending milestones

The board and timeline are projections of the same semantic graph; there is no separate TODO state.

Subagents render as detached parallel branches. A delegation leaves the main line while that line continues vertically. Explicit intermediate main-agent checks can rejoin the branch more than once, and an explicit final integration uses a stronger connector. Multiple branches are supported. Timing, completion, or vague correlation alone never creates a rejoin.

## Milestone detail

Enter opens meaningful content only, with no fixed section padding, no generic type fallback, and scrolling for long milestones. Detail length follows the available information.

Main milestones may include:

- objective
- **PASSAGGI SVOLTI**: numbered observable macro actions, each with its concrete result when supported
- overall result
- current work, concern, and next step

Subagent milestones may include:

- mandate
- **PASSAGGI SVOLTI**
- **CONTROLLI DEL MAIN**, including repeated intermediate checks and final integration
- contribution to the workflow
- branch state, concern, and next step

The public detail does not show revision counters, durations, tool metrics, prompts, raw activity, or other technical telemetry.

## Schema v2 and semantic revisions

Schema v2 stores branch-aware snapshots through `pi.appendEntry`. Semantic revisions advance only when a validated semantic patch changes milestones, agents, or relationships. Turns, tools, retries, compactions, and observation events remain telemetry and do not create public milestones or increment semantic revision.

The patch contract supports:

- stable node updates and additions
- atomic `consolidateNodes` and `supersedeNodes`
- explicit `checkBranch` and `integrateBranch`
- ordinary semantic edges and agent upserts

Patches require an exact semantic base revision. Stale model output is rejected rather than blindly rebased. New milestones require a genuine outcome, decision, blocker, delegation, direction change, verification, integration, or handoff. At the 12-main-milestone cap, consolidation must happen before another addition.

Old records are retained as superseded history where practical but do not render. V1 snapshots are read safely: generic/restricted nodes are removed, legacy telemetry revisions are discarded, concrete public history is bounded to at most ten main milestones, and malformed or cyclic data falls back to a clean graph. A successful legacy migration is immediately persisted as v2 so it is not repeated on every restart.

## Rebuild behavior

`/overview-rebuild` reads only bounded compaction/branch summaries and recent visible user/assistant text from the active branch. It excludes tool results, thinking, tool arguments, and custom private state.

When a configured model is available:

1. Pi asks before sending the bounded excerpts.
2. The model produces a private candidate graph under the same validation and privacy contract.
3. Pi shows the candidate main-milestone titles.
4. Pi replaces the current view only after a second confirmation.

When the model is off, unavailable, or returns an invalid candidate, Pi offers to start an empty schema-v2 view rather than inventing history.

## Structured semantic content

Every public node requires a concrete title/action. Optional fields support objective, mandate, summary, outcome, rationale, numbered macro steps, evidence claims, current work, concern, next step, contribution, and subagent checkpoints through branch edges.

Privacy validation is recursive. Unsafe optional strings, list items, results, claims, notes, or macro steps are dropped. An unsafe or generic required title excludes the node from the public projection; it is never replaced by a `Restricted activity` card.

## Configuration

Configuration merges defaults, preset, global file, trusted project file, CLI flags, then session overrides.

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

Presets: `executive`, `balanced`, `technical-macro`, `blockers`, `delegation`.

Model values:

- `inherit`: active Pi model
- `provider/model`: specific configured model
- `off`: no overview model calls; telemetry remains passive and the public view stays clean until validated semantic data exists

CLI flags: `--overview-model`, `--overview-preset`, `--overview-disabled`.

Project configuration is ignored unless Pi trusts the project. Natural-language rules are untrusted emphasis preferences and cannot weaken privacy or patch validation.

## Privacy and model cost

Public graph data, snapshots, overlay content, and board content never intentionally contain prompt text, assistant transcripts, tool arguments, tool output, code, paths, filenames, commands, package identifiers, secrets, or chain of thought. Exact six-word copies from currently held sensitive evidence are rejected.

The extension may hold a small bounded buffer of visible user/assistant text in memory. Raw tool results, subagent mandates, subagent results, private steering instructions, and child transcripts are not retained in this buffer. With a model enabled, the bounded visible excerpts are sent for semantic synthesis and cleared after a durable exact-revision result (or a valid no-change result). They are never persisted by this package. `inherit` uses Pi's active provider; choosing `provider/model` is an explicit choice to use that configured provider. Set `model` to `off` to prevent all overview model calls.

Synthesis is serial and single-flight. Periodic requests follow `everyTurns`; key events are coalesced. Branch/tree changes abort and invalidate in-flight synthesis so an old-branch patch cannot land on the new branch. Semantic state is appended before it becomes visible in memory. Prompts are valid JSON-oriented and hard-bounded. Normal provider charges apply.

## Limitations

- This is a semantic observer, not a workflow engine.
- Model-off mode does not invent milestones from tool names or lifecycle events.
- Rebuild quality depends on available compaction/recent visible evidence and configured model quality.
- Conservative privacy checks can omit benign optional text or whole nodes.
- Narrow terminals prioritize the timeline; the side-by-side global board appears at wider sizes.
- Subagent visibility depends on lifecycle events emitted by the installed subagent package. The extension does not read child transcript files. Automatic check/integration connectors require an explicit successful `get_subagent_result` response with a recognized status and an unambiguous pair of semantic milestones.

## Development

```sh
npm install
npm run check
```

Tests cover the 104-node/74-generic/329-revision legacy case, 500-event telemetry isolation, recursive privacy, migration, stale patches, consolidation and caps, cycles, bounded rebuild evidence, global board stability, variable detail, terminal width, and parallel branches with two checks plus final integration.

## License

MIT
