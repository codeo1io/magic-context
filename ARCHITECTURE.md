# Architecture

## Key-files v6 architecture

Key files are project-scoped, not session-scoped. The Dreamer aggregates primary-session read history, asks an AFT-enabled subagent to produce one stitched content block per chosen file, validates the single-file contract, then commits rows into `project_key_files`. The plugin computes each row's `content_hash` from disk at commit time; unreadable files use the `"<missing>"` sentinel and start with `stale_reason = 'missing'`.

Every replacement commit runs under `BEGIN IMMEDIATE`, verifies the Dreamer lease with a pure read, deletes/reinserts the project's rows, and bumps `project_key_files_version` in the same transaction. System-prompt injection caches `{value, version}` per session and recomputes only on first access, cache-bust, or version mismatch, preserving prompt-cache byte stability while allowing OpenCode and Pi to invalidate each other through the shared SQLite version row.

Injection renders only stored DB content. Disk drift queues a CAS-protected stale update and never changes the bytes already being rendered; stale writes do not bump the version because they do not affect `<key-files>` output. Subagent sessions skip before the version lookup so subagents never poison or consume key-files context.

> All `src/` paths below are relative to `packages/plugin/` — the published npm package.

## Pattern Overview

**Overall:** Use a plugin-driven orchestration pattern centered on `@opencode-ai/plugin` entrypoints in `src/index.ts`.

**Key Characteristics:**
- Route all OpenCode integration through thin adapters in `src/plugin/` and keep feature logic in `src/hooks/`, `src/features/`, and `src/tools/`.
- Use SQLite-backed durable state from `src/features/magic-context/storage*.ts` for tags, pending ops, compartments (v2: with `p1`–`p4` tiers, `importance`, `episode_type`, `p1_embedding`, `legacy` flag), `compartment_events`, memories, m[0]/m[1] snapshot markers + `m0_mutation_log` + `project_state` epoch counter, dreamer queue state, message-history index (FTS-backed), git-commit index, key-file pinning state, todo-state snapshots, subagent invocation/work metrics, and per-session cache-stability watermarks (`cleared_reasoning_through_tag`, `stripped_placeholder_ids`, `todo_synthetic_*`). (v2: `session_facts` is vestigial — facts are promoted memories.)
- Use hidden subagents from `src/agents/*.ts` (`historian`, `historian-editor`, `dreamer`, `sidekick`) plus prompt builders in `src/features/magic-context/dreamer/task-prompts.ts`, `src/features/magic-context/sidekick/agent.ts`, `src/features/magic-context/sidekick/core.ts`, and `src/hooks/magic-context/compartment-prompt.ts`.
- Replay all persistent message mutations (reasoning clearing, structural-noise stripping, placeholder stripping, merged-assistant reasoning stripping, processed-image stripping, system-injected stripping, caveman compression, synthetic-todowrite injection) on every transform pass — including defer passes — so the wire shape stays byte-identical and Anthropic prompt cache survives.
- Select the SQLite backend at runtime in `src/shared/sqlite.ts` — `bun:sqlite` under Bun, `node:sqlite` (`DatabaseSync`, built-in) under Node (Pi) and Electron (Desktop, Electron 41 → Node 24.14.1). The non-Bun branch wraps `DatabaseSync` to add a savepoint-aware `transaction()` shim and translate the `readonly`→`readOnly` constructor option; everything else (named params, ATTACH, `run()` result shape) is identical. No native module, no prebuild, nothing to download.

## Layers

**Plugin bootstrap:**
- Purpose: Register the plugin, load config, wire agents, hooks, commands, tools, and the RPC server.
- Location: `src/index.ts`
- Contains: Plugin factory, config-warning surface, hidden agent registration, conflict detection (DCP/OMO/auto-compaction), auto-update checker startup, RPC server start, dream-schedule timer start.
- Depends on: `src/config/index.ts`, `src/plugin/`, `src/features/builtin-commands/commands.ts`, `src/shared/model-requirements.ts`, `src/shared/rpc-server.ts`, `src/shared/conflict-detector.ts`, `src/hooks/auto-update-checker/`.
- Used by: Bun build output at `dist/index.js` and OpenCode plugin loading.

**Plugin adapters:**
- Purpose: Keep OpenCode-facing handlers small and delegate real work.
- Location: `src/plugin/event.ts`, `src/plugin/messages-transform.ts`, `src/plugin/tool-registry.ts`, `src/plugin/hooks/create-session-hooks.ts`, `src/plugin/rpc-handlers.ts`, `src/plugin/dream-timer.ts`, `src/plugin/conflict-warning-hook.ts`
- Contains: Hook wrappers, tool registration, per-session hook construction, RPC endpoint handlers, dream-timer lifecycle, conflict-warning delivery.
- Depends on: `src/hooks/magic-context/`, `src/tools/`, `src/features/magic-context/`, `src/shared/rpc-*`.
- Used by: `src/index.ts`.

**Magic-context runtime:**
- Purpose: Execute message transforms, lifecycle hooks, nudging, compaction reactions, command handling, historian coordination, auto-search, and todo-state synthesis.
- Location: `src/hooks/magic-context/`
- Contains: Transform pipeline (`transform.ts`), postprocess phase (`transform-postprocess-phase.ts`), event handlers, command handlers, system-prompt hashing & adjunct injection, compartment runners (incremental / recomp / partial-recomp), deterministic decay rendering (`decay-curve.ts` + `decay-render.ts`, shared with Pi — replaces the removed LLM compressor), strip-and-replay logic, nudge generation & placement, note nudges & visibility tracking, auto-search hint runner, synthetic-todowrite injection (B7 in postprocess), historian-state temp-file offload.
- Depends on: `src/features/magic-context/`, `src/shared/`, `src/agents/magic-context-prompt.ts`.
- Used by: `src/plugin/hooks/create-session-hooks.ts` and `src/plugin/event.ts`.

**Core feature services:**
- Purpose: Encapsulate reusable stateful services behind pure or narrow APIs.
- Location: `src/features/magic-context/`
- Contains: Storage access (`storage*.ts`), scheduler (`scheduler.ts`), tagger (legacy entrypoint via `tagger.ts`; shared logic in `src/shared/tag-transcript.ts`), compaction detection (`compaction.ts`), compaction-marker writer (`compaction-marker.ts`), memory system (`memory/`), dreamer runtime (`dreamer/`), sidekick support (`sidekick/`), key-files pinning (`key-files/`), git-commit indexer (`git-commits/`), message-index FTS pipeline (`message-index.ts`, `message-index-async.ts`), unified search (`search.ts`), overflow detection (`overflow-detection.ts`), schema migrations (`migrations.ts`), tool-definition tokens measurement (`tool-definition-tokens.ts`), user-memory pipeline (`user-memory/`).
- Depends on: `src/shared/` (sqlite, harness, logger, jsonc-parser, model-requirements, embedding helpers).
- Used by: `src/hooks/magic-context/`, `src/plugin/tool-registry.ts`, and `src/index.ts`.

**Tool surface:**
- Purpose: Expose agent tools with validated schemas and storage-backed execution.
- Location: `src/tools/ctx-reduce/`, `src/tools/ctx-expand/`, `src/tools/ctx-note/`, `src/tools/ctx-memory/`, `src/tools/ctx-search/`
- Contains: Tool definitions, argument schemas, action gating (incl. dreamer-only actions in `ctx_memory`), user-facing result formatting.
- Depends on: `src/features/magic-context/` and `src/hooks/magic-context/read-session-chunk.ts`.
- Used by: `src/plugin/tool-registry.ts`.

**Configuration and shared utilities:**
- Purpose: Centralize config parsing, defaults, path resolution, logging, SDK normalization, RPC transport, runtime SQLite selection, conflict detection, fallback-chain resolution, and harness-aware behavior.
- Location: `src/config/` and `src/shared/`
- Contains: Zod schemas, config merging with field-level fallback (`src/config/index.ts`), data-path helpers (`src/shared/data-path.ts`), buffered file logger (`src/shared/logger.ts`), JSONC parser (`src/shared/jsonc-parser.ts`), models.dev cache (`src/shared/models-dev-cache.ts`), embedding provider plumbing under `src/features/magic-context/memory/`, RPC server/client/utils/notifications (`src/shared/rpc-*`), SQLite backend selector (`src/shared/sqlite.ts`), harness identifier (`src/shared/harness.ts`), tag-transcript primitive shared with Pi (`src/shared/tag-transcript.ts`), model-fallback chain resolver (`src/shared/resolve-fallbacks.ts`), subagent runner (`src/shared/subagent-runner.ts`, Pi-only), OpenCode-compaction detector (`src/shared/opencode-compaction-detector.ts`), conflict detector/fixer (`src/shared/conflict-detector.ts`, `src/shared/conflict-fixer.ts`), bounded-session-map (`src/shared/bounded-session-map.ts`).
- Depends on: Node built-ins and Zod.
- Used by: All other layers.

**TUI plugin entry:**
- Purpose: Render Magic Context sidebar and `/ctx-status` / `/ctx-recomp` dialogs inside OpenCode's TUI.
- Location: `src/tui/index.tsx`, `src/tui/slots/`, `src/tui/data/`, `src/tui/types/`
- Contains: TUI command-palette registrations (with dual-path support for `api.keymap.registerLayer` and legacy `api.command.register`), sidebar slot composition, RPC-backed data layer reading from the server plugin.
- Depends on: `src/shared/rpc-client.ts`, `src/shared/rpc-types.ts`, `src/shared/rpc-notifications.ts`.
- Used by: OpenCode TUI loads `./tui` via `package.json` `exports`; ships raw TypeScript source (not bundled into `dist/index.js`).

**CLI (separate package):**
- Purpose: Provide a unified, harness-aware interactive setup/doctor wizard runnable via `npx` outside of OpenCode/Pi, plus session migration between harnesses.
- Location: `packages/cli/src/` (NOT in `packages/plugin/`; the per-plugin CLI bins were collapsed into one shared package in v0.16.1).
- Contains: Setup/doctor/migrate commands (`packages/cli/src/commands/`), harness adapters for OpenCode and Pi (`packages/cli/src/adapters/`), shared prompt/path utilities (`packages/cli/src/lib/`).
- Depends on: `@clack/prompts`, Node built-ins; no dependency on plugin runtime layers.
- Used by: Published as `@cortexkit/magic-context` on npm; invoked as `npx @cortexkit/magic-context@latest <subcommand>`.

## Data Flow

**Plugin startup:**
1. Load and merge config from `src/config/index.ts` — prefer project-root `magic-context.jsonc`, then `.opencode/magic-context.*`, then user config. Invalid leaf fields fall back to defaults with collected warnings rather than disabling the whole plugin.
2. Detect conflicts via `detectConflicts()` (DCP, OMO context-management hooks, OpenCode auto-compaction/prune). When any conflict is active, disable the full Magic Context runtime and send an ignored startup-warning message to the user's active session via `sendConflictWarning()`.
3. Start the RPC server (`MagicContextRpcServer` on localhost; ephemeral port published to `session_meta` for TUI plugin discovery).
4. Start the auto-update checker hook (`src/hooks/auto-update-checker/`) — fires once per plugin process from `chat.message`, with on-disk cross-process dedup via `getMagicContextStorageDir()/last-update-check.json`.
5. Start the dream-schedule timer (`src/plugin/dream-timer.ts`) — singleton per process; immediate startup tick + 15-minute interval; iterates every registered project directory.
6. Build session hooks in `src/plugin/hooks/create-session-hooks.ts` — create the tagger, scheduler, and compaction handler.
7. Register tools in `src/plugin/tool-registry.ts` — open the SQLite database (runtime-selected backend), initialize embeddings (lazy), and expose `ctx_reduce` (gated by `ctx_reduce_enabled`), `ctx_expand`, `ctx_note`, `ctx_memory` (with full action set; dreamer-only actions enforced at runtime by inspecting `toolContext.agent`), and `ctx_search`.
8. Register OpenCode entrypoints in `src/index.ts` — bind message transforms, system-prompt transform, event hooks, command hooks, and hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`).

**Session transform pipeline:**
1. Enter `createMagicContextHook()` in `src/hooks/magic-context/hook.ts` — open persistent storage, set up in-memory maps (`injectionCache`, `liveSessionState`, etc.), and create the transform.
2. The outer wrapper in `src/plugin/messages-transform.ts` catches `SQLITE_BUSY`/`SQLITE_LOCKED` transient errors and other failures, persisting a short summary to `session_meta.last_transform_error` and returning unmodified messages on failure so OpenCode's prompt loop always proceeds (issue #23).
3. Run the transform from `src/hooks/magic-context/transform.ts` — tag messages, load session state, prepare compartment injection, and schedule deferred work. On every pass (including defer), replay persisted reasoning clearing using `replayClearedReasoning()` and `replayStrippedInlineThinking()` from `src/hooks/magic-context/strip-content.ts`; replay caveman compression via `replayCavemanCompression()` and `stripReasoningFromMergedAssistants()` (Anthropic-only); replay stripped placeholders and structural noise. The merged-assistant reasoning strip and the empty-content sentinel handling are provider-aware (Anthropic-specific vs. generic).
4. Run postprocessing in `src/hooks/magic-context/transform-postprocess-phase.ts` — apply pending ops, heuristic cleanup (including the ≥85% tiered emergency drop), reasoning cleanup, stale reduce-call cleanup, compartment rendering, deferred-note nudges, **synthetic-todowrite injection (B7)**, and auto-search hint generation. Stripped placeholder message IDs are read from `stripped_placeholder_ids` in `session_meta` (via `src/features/magic-context/storage-meta-persisted.ts`) and replayed on every pass; the persisted set is updated when new empty shells are detected on cache-busting passes only.
5. Persist session state through storage helpers exported by `src/features/magic-context/storage.ts`.

**Boundary execution:**
- Scheduler `execute` decisions are deferred when the latest assistant turn is still mid-tool-use, unless a bypass applies. The gate lives in `src/hooks/magic-context/boundary-execution.ts`: base `defer` always stays `defer`; base `execute` with no bypass becomes `defer` + a CAS-protected `session_meta.deferred_execute_state` flag when mid-turn.
- The goal is cache stability: avoid mutating tool/history/reasoning state in the middle of a multi-step assistant turn, because that would rebuild message bytes and bust provider prompt-cache writes while the turn is still accumulating tool calls.
- Bypass reasons are deliberately narrow: `force-materialize` at ≥85% usage (including overflow recovery already folded into percentage), `explicit-bust` when `historyRefreshSessions` is set (paired-producer invariant: every producer also signals pending materialization), and `subagent` (one parent-turn lifetime). No config knob controls this behavior.
- Draining uses a re-peek-and-drain pattern. The early gate may set a durable flag with `setDeferredExecutePendingIfAbsent`; the end of postprocess only re-peeks and CAS-clears with `clearDeferredExecutePendingIfMatches` after execute-gated work completed successfully on that pass. Success means the shared execute try-block reached its success point, not that any mutation count was non-zero.
- Pi mirrors OpenCode semantics in `packages/pi-plugin/src/context-handler.ts`: it uses the same decision module, `isMidTurnPi`, the same `deferred_execute_state` CAS helpers, and drains after dropped-placeholder stripping but before token accounting. For the same scheduler/base/bypass/mid-turn input, OpenCode and Pi must produce the same effective execute/defer decision.

**m[0]/m[1] history layout (v2 — the cache-stability core):** the compacted history is rendered into TWO synthetic message slots instead of one, so the large stable prefix survives steady-state working sessions. Implemented in `inject-compartments.ts` (`renderM0`, `renderM1`, `materializeM0`, `mustMaterialize`) and mirrored in `inject-compartments-pi.ts`.
- **m[0] — cumulative baseline.** Holds `<project-docs>`, baseline `<user-profile>`, and the decay-rendered compartment history as of the last materialization. Treated like a frozen prefix (analogous to `system[0]`): it does NOT change on routine turns, so its prompt-cache bytes persist.
- **m[1] — volatile delta.** Holds everything added *since* the last m[0] materialization: `<key-files>`, new user-profile additions, **new memories** (read via the `maxMemoryId` watermark `id > cachedM0MaxMemoryId`), and the newest compartments (rendered at full tier 1). When there's nothing new it renders a minimal placeholder (m[1] must never be fully empty for Anthropic cache-breakpoint structure).
 - **Materialization decision (`mustMaterialize`) — organized around the bust taxonomy.** The taxonomy IS the organizing principle of this function, so the trigger list and the m[0]/m[1] contract can never silently disagree (they did once: "new compartment sequence" was wrongly listed as an m[0] trigger, which folded m[0] on every routine historian publish and busted the prompt-cache prefix below the execute threshold). m[0] re-materializes ONLY for **HARD** events, in two classes:
    - **Provider-side cache eviction** (the Anthropic cache was already dead, so folding m[1] into m[0] is "free"): model/provider change (`cachedM0ModelKey`), system-prompt-hash change (`cachedM0SystemHash`), and idle>TTL (`cacheExpired`, self-consuming via `lastResponseTime > cachedM0MaterializedAt`). Note: tool-set hash change (`cachedM0ToolSetHash`) was removed from the HARD trigger list because the signal is process-global and produced false-positive folds.
   - **Genuine m[0] CONTENT change** (the rendered baseline bytes differ): first render, `cached_m1_missing`, `project_memory_epoch` change (dashboard / external mutation), pending m[0] mutations (`max_mutation_id` — structural compartment delete/merge/recomp), project-docs hash change, upgrade-state change.
   - **Deliberately NOT triggers:** **new compartment sequence** (the canonical m[1] delta — `renderM1`'s `readNewCompartments(seq > cachedM0Seq)`, folds into m[0] only on the next HARD bust), **`project_user_profile_version`** (additive user-profile rides the m[1] `<new-user-profile>` delta), and **`maxMemoryId`** (additive memory writes surface in m[1] via the watermark). Triggering on any of these would bust m[0] on routine background work and defeat the whole design. `session_facts` version is retired (facts are memories now).
- **Memory mutations route through m[1] (supersede-delta), not the epoch (v2.0).** In-session `ctx_memory` mutations — both additive (`write`/`promote`) and non-additive (`update`/`delete`/`archive`/`merge`) — deliberately do NOT bump `project_memory_epoch`. Additive writes surface in m[1] via the `maxMemoryId` watermark; non-additive mutations record a `memory_mutation_log` row that renders in m[1] as a `<memory-updates>` delta (stale rows linger in the frozen m[0] baseline until reconciled). Both are reconciled into m[0] on the next natural hard bust. The epoch IS bumped — forcing an immediate m[0] re-materialize — only by **dashboard** memory mutations (an external editor cannot otherwise signal a running session) and by `/ctx-session-upgrade` memory migration.
 - **Cache-bust taxonomy (SOFT+ / SOFT / HARD).** **SOFT+** = a defer pass with nothing new: m[0] AND m[1] replay byte-identical (the whole `system+m[0]+m[1]` prefix stays cached; only the conversation tail moves where ctx_reduce/age drops land). **SOFT** = an exec / cache-busting pass: m[1] re-renders (new compartments, memories, user-profile surface as deltas) while m[0] stays byte-identical (`system+m[0]` stays cached, busts at m[1]). **HARD** = a `mustMaterialize` trigger: m[0] re-materializes, folding m[1] into the new decayed baseline and resetting m[1] to the placeholder (everything rebuilds — but "for free" because the provider cache was already dead). Decay re-tiering happens ONLY on a HARD fold (a SOFT pass must never re-tier — that would change m[0] bytes). A **pressure backstop** refold (the "or due to pressures" path) fires on a cache-busting pass when no natural HARD bust has arrived but the volatile m[1] delta has grown large — gated by the m[1]/m[0] size ratio (with a small-m[0] floor) OR an absolute m[1] token cap (≈20% of the history budget, which bounds the marathon-session case the ratio floor would otherwise miss) OR a large memory-mutation count. `applyMarkersToState` updates ALL root `state.cachedM0*` fields post-materialize so the next pass sees the new baseline (the guard against an infinite re-materialize loop). `/ctx-flush` is a SOFT event (it drives m[1] soft-refresh + heuristics via the refresh sets, not an m[0] fold).
- **`m0_mutation_log` + `project_state`.** The mutation log carries m[0]-affecting deltas for m[1]; `project_state.project_memory_epoch` is the cross-process invalidation counter bumped by **dashboard** memory mutations and by `/ctx-session-upgrade` migration (in-session `ctx_memory` mutations use the `memory_mutation_log` supersede-delta path instead — see the m[1] memory-mutation note above).

**System-prompt adjunct injection:**
- The `experimental.chat.system.transform` hook in `src/hooks/magic-context/system-prompt-hash.ts` injects only the **Magic Context agent guidance text** (when `system_prompt_injection.enabled=true` and the active agent isn't matched by `skip_signatures`) plus the frozen `Today's date:` line into the system-prompt array.
- **v2 adjunct relocation:** `<project-docs>`, `<user-profile>`, and `<key-files>` are NO LONGER injected into the system prompt. They moved into the message stream so the system prompt stays maximally cache-stable: `<project-docs>` (root `ARCHITECTURE.md` + `STRUCTURE.md` when `dreamer.inject_docs=true`) and the **baseline** `<user-profile>` (active user memories when `dreamer.user_memories.enabled=true`) render into **m[0]** (the stable cumulative baseline via `renderM0`); `<key-files>` (when `dreamer.pin_key_files.enabled=true`) and **new** user-profile additions render into **m[1]** (the volatile delta via `renderM1`). key-files is intentionally m[1]-resident (never folds into m[0]) because a future cron-style Dreamer will refresh it frequently. See the "m[0]/m[1] history layout" flow below.
- Adjunct content is cached in memory and only re-read on cache-busting passes, so doc edits don't trigger mid-session cache busts.
- The `Today's date:` line is frozen per session via `stickyDateBySession` and updated only on cache-busting passes — prevents midnight date flips from causing spurious rebuilds.
- The reasoning-clearing watermark (`cleared_reasoning_through_tag` column in `session_meta`) is a persisted integer so clearing survives across OpenCode message rebuilds.
- Magic Context skips system-prompt injection entirely for OpenCode's internal `title`, `summary`, and `compaction` agent prompts (signature-detected) so small-model utility calls don't get the full Magic Context prompt.

**Note nudge trigger gating:**
- Three triggers can fire a note-nudge: historian publication, commit detection (text-based heuristic in `tag-messages.ts`), and `todowrite` calls where ALL todo items have a terminal status (`completed` or `cancelled`). Intermediate todowrite calls during active work do not trigger the nudge.
- The `tool.execute.after` handler in `src/hooks/magic-context/hook-handlers.ts` captures the current todo state into `session_meta.last_todo_state` on EVERY todowrite call (independent of the nudge trigger) — this snapshot drives synthetic-todowrite injection (see below).
- A 15-minute cooldown plus visibility-aware suppression prevents the same note from re-surfacing too aggressively. Suppression releases as soon as a prior `ctx_note(read)` result is no longer visible in transformed messages.

**Sticky-injection multi-anchor persistence:**
- Deferred-note nudges and auto-search hints are cache-sensitive user-message mutations. Once either feature appends text to a user message, the exact bytes must replay on every later request until that message leaves the visible window.
- `session_meta.note_nudge_anchors` stores append-only `{messageId,text}` entries; `session_meta.auto_search_hint_decisions` stores append-only per-message decisions (`hint` with `text`, or `no-hint` with a reason). Both columns are stable-JSON arrays and are written with bounded CAS retries so sibling OpenCode/Pi processes do not lose appends.
- `transform-postprocess-phase.ts` replays all note-nudge anchors and positive auto-search decisions on every pass, including defer passes. Fresh note-nudge delivery and fresh auto-search hint appends mutate the wire only after the corresponding CAS write succeeds; CAS exhaustion skips the current wire append and retries on the next pass.
- Pruning is storage-only and runs only on cache-busting passes or explicit `message.removed` events. Missing-target replay is a no-op, so pruning never changes bytes for messages still present in the provider-visible window.
- Pi uses real `SessionEntry.id` values from `collectMessageEntryIdsStrict` for new durable anchors. If strict entry-id resolution fails, Pi still replays existing anchors but skips new durable writes and pruning for that pass; note-nudge triggers remain pending so the next strict-success pass can deliver without dropping the nudge.

**Synthetic-todowrite (todo retention across cache busts):**
1. `tool.execute.after` captures normalized todo state into `session_meta.last_todo_state` on every real `todowrite` call (capture is pure DB write — no message mutation, cache-safe).
2. On a cache-busting transform pass, B7 in `transform-postprocess-phase.ts` reads `last_todo_state`, computes `mc_synthetic_todo_${sha256(stateJson)[:16]}`, and either idempotently re-injects (when the call_id matches the persisted one) or fresh-injects a synthetic `tool_use`/`tool_result` pair into the latest assistant message. The injection point is AFTER tagging and applyPendingOperations so the synthetic part is never tagged or targeted by `ctx_reduce` / heuristic cleanup.
3. On defer passes, B7 rebuilds from the PERSISTED snapshot (`todo_synthetic_state_json` column), NOT from the current `last_todo_state`. This keeps wire bytes identical to the prior cache-bust pass even when the agent has called `todowrite` since — preserving Anthropic prompt cache.
4. The persisted triple `(call_id, anchor_message_id, state_json)` lives in `session_meta`. Legacy rows from pre-stateJson builds (call_id and anchor populated, state_json empty) self-heal on the next idempotent re-inject by backfilling state_json from the current `last_todo_state` under sha256 collision-resistance guarantees.

**Memory and search flow:**
1. Create, update, merge, archive, or list memories through `src/tools/ctx-memory/tools.ts`. The action schema exposes the full set (`write/delete/list/update/merge/archive`); primary-agent calls are runtime-gated to `write` and `delete` only by inspecting `toolContext.agent`.
2. Store canonical records in `src/features/magic-context/memory/storage-memory.ts` and sync full-text search through the FTS triggers created in `src/features/magic-context/storage-db.ts`.
3. Generate and store embeddings through `src/features/magic-context/memory/embedding.ts` and `src/features/magic-context/memory/storage-memory-embeddings.ts`. Three embedding paths: immediate best-effort write on `ctx_memory` mutations; periodic batch sweep via the dream timer (every 15 min, drains projects in descending recency); lazy fallback inside `ctx_search`. Local embeddings use `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` runtime-loaded with a cross-process model-load lock and heartbeat (`embedding-local.ts`).
4. `ctx_search` (`src/tools/ctx-search/`) provides a unified search surface over project memories, raw user/assistant message history (FTS-backed via `src/features/magic-context/message-index.ts`), indexed git commits (via `src/features/magic-context/git-commits/`), and (explicit-only) an **`external`** source for the long-term memory backend (see **External-memory flow** below). (v2 note: `session_facts` is no longer a render source or a durable fact store — historian facts are promoted to project memories, so fact-derived knowledge is searchable via the `memory` source. `session_facts` rows are vestigial and never rendered.) Raw-message hits are filtered to ordinals strictly before the last compartment boundary so the live tail (already in context) isn't returned.
5. Inject cached project memories into `<session-history>` through `src/hooks/magic-context/inject-compartments.ts`. Memories already visible in the rendered `<session-history>` are hard-filtered from `ctx_search` results via persisted `session_meta.memory_block_ids`.

**External-memory flow (tee + recall + corrective propagation):** engine-agnostic external backend (Hindsight) that holds curated memories OUT of the project and recalls them BACK once per session. The local SQLite store is the source of truth; the external store is a long-term companion. Two bank scopes — `project` (one bank per project, template `mc-{name}-{id8}`) and `main` (one shared bank for profile + global). Document identity is `mc:<scopeKey>:<category>:<hash>`, derived from normalized content — idempotent re-retains upsert on the server, so retries never duplicate.

1. **Tee on write** — every curated memory creation passes through `teeToExternalBackend()` in `src/features/magic-context/memory/external-memory.ts` (fire-and-forget, never blocks the local write, never throws). Three creation points call it, each gated by `retain_sources`:
   - `ctx_memory(write)` and `ctx_memory(update)` in `src/tools/ctx-memory/tools.ts` → `source: "agent"`. A `scope: "global"` write lands in the main bank with origin provenance; project scope lands in the project bank.
   - Fact promotion from historian output in `src/features/magic-context/memory/promotion.ts` → `source: "historian"`.
   - User-memory promotion in the dreamer (`src/features/magic-context/user-memory/review-user-memories.ts`) → `source: "dreamer"`.
2. **Recall once per session** — `startSessionRecall()` in `external-recall.ts` is fired from the transform hot path on the first message (`src/hooks/magic-context/transform.ts`; Pi mirror in `packages/pi-plugin/src/context-handler.ts`). It dispatches THREE slices in parallel via `Promise.all`:
   - **Project slice** (project bank) — query template `"project rules, architecture decisions, configuration, constraints, conventions for {projectName}"`. With `recall.mental_models: true` (default), tries the Hindsight mental-models GET first and falls back to a full recall when the bank has no MMs.
   - **Profile slice** (main bank, `scope: "user"`) — query `"user preferences, working style, communication habits"`. Same MM fast path; gated by `recall.profile_mental_models` (default `["user-preferences"]`).
   - **Global slice** (main bank, `scope: "global"`) — pure full recall, query template `"infrastructure, environment, tooling, gotchas, and conventions relevant to working on {projectName}"` (optionally enriched with the session's first user prompt excerpt when `recall.global_from_prompt: true`). Optionally tag-filtered by `recall.global_tags`.
3. **Semantic dedup at recall completion (once)** — `dedupAndTrim()` in `external-recall.ts` runs after the three slices resolve. For each recalled item: drop if its normalized hash matches any local memory or active user memory, OR if its cosine similarity to any local vector (filtered to the same embedding model) is ≥ `recall.dedup_threshold` (default 0.85). The first two slices prefer project over global on cross-slice duplicates. Each surviving slice is then sorted (deterministic) and trimmed to `recall.max_tokens` per slice (default 2048). Embedding failures fall back to hash-only dedup, never crash the recall.
4. **Persist BEFORE settle** — `runSessionRecall()` writes the resulting snapshot to `session_meta.external_recall_state` (`pending` → `done` / `failed`) and `session_meta.external_recall_json` BEFORE the in-flight promise resolves. A `pending` row with no in-flight promise (process died mid-recall) is re-fired as the deadlock guard. The transform's A-path (`maybeAwaitExternalRecall()`) blocks on the in-flight promise only when the first m[0] render is imminent and the cache is already cold; once an m[0] is cached, late results ride the m[1] delta instead.
5. **Render into m[1] only — never m[0]** — `renderExternalMemoryBlock()` and `renderExternalMemoryDelta()` in `inject-compartments.ts` produce the `<external-memory source="hindsight">` block (preamble + `- content` lines for single-line items + verbatim multi-line MM documents separated by blank lines; NO `<memory id=…>` shape, NO category annotation). The settled snapshot bakes into m[0] on the next HARD materialization (it never forces one — see cache-safety below). Late arrivals after m[0] has cached render into m[1] as `<external-memory>` delta. Pi mirrors the same flow in `packages/pi-plugin/src/inject-compartments-pi.ts`. The external block is NOT charged to the history budget nor the local memory budget — it is bounded solely by `recall.max_tokens` × 3 slices.
6. **W2 — Corrective propagation (write-side consistency).** Each local `ctx_memory` mutation that removes a fact from the local store (or rewrites it) propagates to the external store fire-and-forget after the local commit, so the external view never carries a fact the local store has retired:
   - `archive` → `removeFromExternalBackend()` with the ORIGINAL row content (document_id derives from the original content hash).
   - `update` → `removeFromExternalBackend()` for the OLD content, then `teeToExternalBackend()` for the new content. Same `document_id` for the new content means a future `update` re-retain upserts cleanly.
   - `verify` (dreamer-only) → `upsertToExternalBackend()` verbatim with the existing `document_id` — server-side upsert refreshes Hindsight's `mentioned_at` recency, zero duplicate risk. `verifiedAt` rides along in metadata. Verification status is NOT rendered in memory lines, so the cached m[0]/m[1] bytes are unaffected.
   - `merge` → no external call: the engine's domain. The local supersede path queues a `memory_mutation_log` row that renders in m[1] as a `<memory-updates>` delta.
   - User-memory W2 (`src/features/magic-context/user-memory/review-user-memories.ts`) mirrors the same archive/update corrective remove pattern for the dreamer promotion path.
7. **`ctx_search` external source (explicit-only).** `unifiedSearch()` in `src/features/magic-context/search.ts` adds `"external"` to `SearchSource`. Two parallel recalls per search: project bank (`scope: "project"`) and main bank (`scope: "global"`), merged + content-hash-deduped against each other. Activated ONLY when `options.explicitSearch === true` (the auto-search hot path that fires on every user prompt NEVER hits it) and `recall.search !== false`. Latency bound: shared 5s `AbortSignal`, tighter than the backend's 10s fetch timeout. Hindsight relevance order is preserved; external source boost is **1.0**, below the local `memory` boost (1.3) so a verified local fact outranks an external consolidated rewrite. Hits already visible in the session's injected `<external-memory>` block are dropped by content-hash. Sidekick reaches the external store automatically (it only uses `ctx_search`).
8. **m[0] cache-safety — `cached_m0_external_recall_hash` is a carried marker, NOT a HARD bust trigger.** The marker is stored on every m[0] materialize (`session_meta.cached_m0_external_recall_hash`, mirrors `M0SnapshotMarkers.externalRecallHash` in `inject-compartments.ts`) and is read on every pass for the m[1] delta comparison only. It deliberately does NOT enter the `mustMaterialize` trigger list — a fresh external recall (a different snapshot hash) does NOT force an m[0] refold. External recall is not a materialization driver; the m[0] prefix survives external-recall changes, riding the same m[1] delta channel as new compartments, new memories, and user-profile additions. Pressure-driven refolds still happen on the same HARD triggers (provider cache eviction, genuine m[0] CONTENT change, pressure backstop with external tokens explicitly subtracted from the m[1] size budget).
9. **Security (user-config-only block).** The entire `memory.external` block is stripped from project-level config by `stripUnsafeProjectConfigFields()` in `src/config/project-security.ts` — a cloned repo cannot redirect the endpoint or exfiltrate a user's personal memory store by editing `magic-context.jsonc` (parallel to the `auto_update` and `sqlite` user-only rules). The Hindsight impl adds a circuit breaker (3 failures in 60s → open 5min → half-open probe), SSRF guard via `embedding-ssrf.ts`, `redirect: "error"` on every fetch, and a never-retry 422 handling. The bearer token is read from the user config and never logged.

**Message-history indexing:**
- `src/features/magic-context/message-index.ts` maintains an FTS5-backed index of raw user/assistant messages keyed by `(session_id, ordinal, message_id, role, text)`.
- Index maintenance runs OUTSIDE the search hot path: async startup reconciliation processes ordinals above the `last_indexed_ordinal` watermark; live event indexing fires from `message.updated` events; `searchMessages()` is a pure FTS query with no freshness check.
- The reconciliation watermark is per-session; revert-aware cleanup runs on `message.removed` events.

**Git-commit indexing:**
- `src/features/magic-context/git-commits/indexer.ts` reads HEAD-only non-merge commits via `git log` (NUL-byte-free format separator `\x1f`), bounded by `experimental.git_commit_indexing.{since_days, max_commits}`.
- Embeddings are generated through the same embedding provider chain as memories.
- Indexing fires from the dream-timer startup tick and periodic interval; manual `/ctx-dream` does NOT trigger commit indexing.

**Historian compartment flow (v2 — produce → store → render):** the core long-history pipeline. v2 replaced the v1 model (flat compartments + separate LLM compressor + REPLACE-the-whole-fact-list) with tiered compartments + a deterministic decay renderer + faithful per-chunk facts.

1. **Trigger** — threshold-relative pressure (`context_limit × execute_threshold × 5%`, clamped 5k–50k), commit clusters, and unsummarized-tail size, while protecting the live tail (`compartment-trigger.ts`).
2. **Produce** — `compartment-runner-incremental.ts` runs the historian subagent on the raw chunk above the last compartment boundary, using the generated v8.7.3 prompt (`historian-prompt.generated.ts`, re-exported via `compartment-prompt.ts`). The prompt's input is **bounded** (no `<existing_state>` dump): `buildReferenceBlocks` (`reference-retrieval.ts`) supplies **4 rotating band-spanning seed compartments** (from the curated 60-seed corpus, `reference-seeds.generated.ts`) + **the last 6 persisted compartments** (recency continuity, full 4-tier) + the project-memory block for fact dedup. Historian emits each compartment with 4 paraphrase tiers (`p1` verbose → `p4` anchor-only/self-close), an `importance` score (decay-rate semantics), an `episode_type`, a `<facts>` block in the **5-category world taxonomy** (PROJECT_RULES / ARCHITECTURE / CONSTRAINTS / CONFIG_VALUES / NAMING), and an `<events>` block (causal_incident / trajectory_correction).
3. **Parse + validate** — `parseCompartmentOutput` extracts tiers/importance/episode_type, scopes fact extraction to the `<facts>` block (so 5-cat tags inside `<events>` or compartment bodies aren't misread), and extracts events kind-agnostically. `validateHistorianOutput` enforces contiguous, non-overlapping ranges with a correct `unprocessed_from`.
4. **Discard-last boundary healing** — if historian consumed to the chunk edge with weak lookahead (`chunk.endIndex − lastCompartment.endMessage <= 2`) and emitted ≥2 compartments and it's not an emergency pass, the **last** (provisional, lookahead-free) compartment is NOT persisted; the next run re-reads its raw range at the head with full lookahead. Guards: `k≥2` (progress) and emergency-disabled (max pressure relief).
5. **Store** — publish transaction appends compartments with their tier columns. **Faithful facts:** historian emits only the current chunk's facts (no REPLACE of `session_facts`); promotable facts are promoted to project memory (exact-dedup), and `user_observations` are stored as candidates **only when `dreamer.user_memories.enabled`** (privacy gate). `p1_embedding` is computed on publish (fire-and-forget, memory-gated) as the substrate for `ctx_search` + future dreamer cross-linking. Events are inserted into `compartment_events` (anchored to durable compartment ids; discarded-tail events filtered out). `ensureProjectRegistered` runs before promotion/embedding regardless of discard-last.
6. **Render (decay)** — `decay-render.ts` (shared OpenCode + Pi) selects a tier per compartment via the council-validated `decay-curve.ts` formula: effective half-life `H = H50·2^((I−50)/D) / max(p, 0.10)` (`H50=24`, `D=25`), log-cost tier boundaries `[0.201, 0.729, 1.322, 2.587]`, with budget pressure `p` computed once per pass from `natural_cost / history_budget`. Older / lower-importance / higher-pressure compartments demote oldest-first; past the archive boundary they render at P4/self-close or drop. Legacy (pre-v2) compartments render P3 if they carry a `U:` line else P4 (degraded mode, nudging `/ctx-session-upgrade`). The renderer adapts automatically when the model's context (and thus history budget) grows or shrinks — no LLM rewrite needed.
7. **Recomp / upgrade** — `/ctx-recomp` rebuilds compartments structurally from raw history (does NOT emit facts — user memories may be hand-curated). `/ctx-session-upgrade` runs full recomp (rebuilds legacy → v2 tiered) plus a once-per-project memory migration (9-cat → 5-cat re-eval via a transient historian-model prompt; `active` memories only, `permanent` untouched; bumps `project_memory_epoch`).

**Dreamer flow:**
1. Detect eligible projects during `message.updated` handling in `src/hooks/magic-context/hook.ts` (debounced per-project, 12-hour cooldown).
2. Enqueue projects on a schedule through `src/features/magic-context/dreamer/scheduler.ts` and `src/features/magic-context/dreamer/queue.ts`. Queue rows are project-scoped — each host (OpenCode or Pi instance) only dequeues work for projects it has loaded.
3. Serialize dream runs with the lease in `src/features/magic-context/dreamer/lease.ts` (2-minute TTL with periodic renewal during long tasks).
4. Spawn one child session per task from `src/features/magic-context/dreamer/runner.ts` using prompts from `src/features/magic-context/dreamer/task-prompts.ts`. Each successful run also writes a row to `dream_runs` for dashboard visibility.
5. Tasks include the configured maintenance suite (consolidate, verify, archive-stale, improve, maintain-docs) plus optional post-task phases: user-memory candidate review (when `dreamer.user_memories.enabled`), smart-note evaluation (when pending smart notes exist), and key-file identification (when `dreamer.pin_key_files.enabled`).
6. A circuit breaker aborts remaining tasks and post-task phases after 3 consecutive identical-error failures, surfacing as a synthetic `circuit-breaker` task entry. Skips on AbortError and lease-loss errors.
7. Each subagent prompt call iterates the resolved model fallback chain (`dreamer.fallback_models` → builtin chain) via `promptSyncWithModelSuggestionRetry`. Abort/timeout/context-overflow short-circuits the chain so caller emergency-recovery still fires.

**Command augmentation flow:**
1. Register `/ctx-status`, `/ctx-flush`, `/ctx-recomp`, `/ctx-aug`, and `/ctx-dream` in `src/features/builtin-commands/commands.ts`.
2. Intercept command execution in `src/hooks/magic-context/command-handler.ts`.
3. `/ctx-status` and `/ctx-recomp` route through the RPC server when TUI is connected (showing native TUI dialogs) and through ignored-message notifications otherwise (Desktop/Web).
4. `/ctx-recomp` accepts an optional `<start>-<end>` range — partial recomp snaps the requested range to enclosing compartment boundaries and only rebuilds that span.
5. `/ctx-aug` runs sidekick augmentation from `src/features/magic-context/sidekick/agent.ts`; the augmentation result is appended to the user's prompt (not injected at `message[0]`) before submission.
6. `/ctx-dream` enqueues an immediate-runtime dream request, force-clearing stale started rows past the lease TTL window.

## Key Abstractions

**Magic Context hook:**
- Purpose: Own the runtime state for one plugin instance.
- Location: `src/hooks/magic-context/hook.ts`, `src/hooks/magic-context/index.ts`
- Pattern: Composition root that returns OpenCode hook handlers.

**Tool registry:**
- Purpose: Gate tool availability by config and persistent-storage readiness.
- Location: `src/plugin/tool-registry.ts`
- Pattern: Registry builder with conditional feature exposure.

**Memory store:**
- Purpose: Keep project-scoped durable knowledge searchable and mergeable.
- Location: `src/features/magic-context/memory/storage-memory.ts`, `src/features/magic-context/memory/storage-memory-fts.ts`, `src/features/magic-context/memory/storage-memory-embeddings.ts`
- Pattern: SQLite repository plus FTS and embedding side tables.

**Unified search:**
- Purpose: Cross-source retrieval over memories, raw message history, git commits, and (explicit-only) the external long-term memory backend, with deterministic source ranking and embedding dedup across paths.
- Location: `src/features/magic-context/search.ts`
- Pattern: Single embedding-per-query dispatched across all enabled sources; visible-memory hard-filter; sources opt-in via tool argument. The `external` source fires TWO parallel recalls (project bank + main bank) merged + content-hash-deduped, but ONLY when the caller passes `explicitSearch: true` — the auto-search hot path (every user-prompt hint) is gated to never hit it.

**Tiered compartments (v2):**
- Purpose: Store each compartment with 4 paraphrase tiers (`p1` verbose → `p4` anchor-only) plus `importance` (decay-rate) and `episode_type`, so the renderer can pick fidelity per compartment at render time with no LLM call.
- Location: schema in `migrations.ts` v22 + `storage-db.ts`; parse in `compartment-prompt`/`parseCompartmentOutput`; prompt in `historian-prompt.generated.ts`; references in `reference-retrieval.ts` (+ `reference-seeds.generated.ts`).
- Pattern: `content` mirrors `p1`; tiers stored as raw-text columns (not XML-in-content); `legacy` flag marks pre-v2 rows for degraded rendering. All 4 write paths (incremental append, recomp promote, partial-recomp preserve, staging round-trip) preserve tier fields.

**Decay rendering (replaces the LLM compressor):**
- Purpose: Deterministically choose a render tier per compartment from age, importance, and live history-budget pressure — self-tuning as the model's context window changes, with zero LLM cost.
- Location: `src/hooks/magic-context/decay-curve.ts` (validated formula + tier boundaries), `src/hooks/magic-context/decay-render.ts` (shared OpenCode + Pi renderer).
- Pattern: Exponential half-life `H = H50·2^((I−50)/D)/max(p,0.10)` (`H50=24`, `D=25`); log-cost tier thresholds `[0.201,0.729,1.322,2.587]`; budget pressure computed once per pass; oldest-first demotion; archive/self-close past the last boundary. Council-validated invariants (monotonicity, finite demotion, O(budget) cost) locked by `decay-curve.test.ts`.

**Compartment events (v2, stored-not-rendered):**
- Purpose: Persist historian-extracted `causal_incident` / `trajectory_correction` events as a corpus for future dreamer aggregation; never rendered into the prompt in v2.0.
- Location: `compartment_events` table (migration v23); `insertCompartmentEvents` / `getCompartmentEvents`.
- Pattern: Anchored to durable compartment ids (`at_compartment` → id at publish); discarded-tail events filtered; cleared on session deletion.

**Message-history index:**
- Purpose: FTS-backed raw user/assistant message search outside the transform hot path.
- Location: `src/features/magic-context/message-index.ts`, `src/features/magic-context/message-index-async.ts`
- Pattern: Async reconciliation + live event indexing + pure-query reads.

**Git-commit index:**
- Purpose: Per-project HEAD-only commit corpus for `ctx_search` integration.
- Location: `src/features/magic-context/git-commits/`
- Pattern: NUL-free git log reader + FTS index + embedding side table; populated by dream timer.

**Dream queue and lease:**
- Purpose: Run at most one dream worker at a time and survive restarts.
- Location: `src/features/magic-context/dreamer/queue.ts`, `src/features/magic-context/dreamer/lease.ts`, `src/features/magic-context/dreamer/storage-dream-state.ts`, `src/features/magic-context/dreamer/storage-dream-runs.ts`
- Pattern: SQLite-backed queue plus cooperative lease lock plus durable run-history table.

**Key-files pinning:**
- Purpose: Inject up to N project files into the system prompt as `<key-files>` content for the active session.
- Location: `src/features/magic-context/key-files/identify-key-files.ts`, `src/features/magic-context/key-files/read-stats.ts`, `src/features/magic-context/key-files/storage-key-files.ts`
- Pattern: Per-session selection by Dreamer; budget-bound rendering; symlink-safe realpath check.

**User memory pipeline:**
- Purpose: Extract user behavioral observations from historian output (the v2 `<user_observations>` block), collect candidates, and promote recurring patterns to stable global user memories.
- Location: `src/features/magic-context/user-memory/storage-user-memory.ts`, `src/features/magic-context/user-memory/review-user-memories.ts`
- Pattern: Historian extracts candidates **only when `dreamer.user_memories.enabled`** (privacy gate, enforced post-commit best-effort on both harnesses); dreamer reviews with a multi-session recurrence gate and promotes; the baseline set renders into m[0] `<user-profile>` (new promotions into m[1]). user_memories are globally scoped (no `project_path`).

**TUI ↔ server RPC:**
- Purpose: Localhost RPC for sidebar data, status/recomp dialogs, and TUI-action consumption.
- Location: `src/shared/rpc-server.ts`, `src/shared/rpc-client.ts`, `src/shared/rpc-utils.ts`, `src/shared/rpc-types.ts`, `src/shared/rpc-notifications.ts`, `src/plugin/rpc-handlers.ts`
- Pattern: Server publishes ephemeral port; TUI plugin polls for state and pushes notifications via the message queue.

**Plugin message bus (legacy):**
- Purpose: Historical SQLite-backed TUI ↔ server bus, retained for migration compatibility.
- Location: `src/features/magic-context/plugin-messages.ts`
- Pattern: Vestigial — superseded by RPC. Module remains for forward-compat with older TUI plugin versions that may still poll it; no active runtime callers in current code.

**Compaction markers (deferred drain, plan v6):**
- Purpose: Inject OpenCode-compatible compaction boundaries into the message table so `filterCompacted` stops at historian's last compartment boundary, shrinking the transform-input array. Marker movement is deferred from historian publish into the next materializing transform pass so a single cache-bust cycle covers both the `<session-history>` rebuild AND the marker boundary advance.
- Location: `src/features/magic-context/compaction-marker.ts`, `src/hooks/magic-context/compaction-marker-manager.ts`, `src/features/magic-context/storage-meta-persisted.ts` (pending blob helpers).
- Pattern: Historian incremental runner writes the prospective new boundary (`{ordinal, endMessageId, publishedAt}`) into `session_meta.pending_compaction_marker_state` in the same transaction that publishes new compartments. The next consuming transform pass that drains `deferredHistoryRefreshSessions` calls `applyDeferredCompactionMarker(...)`, which validates the pending target against the latest stored compartment via `getCompartmentsByEndMessageId(...)` plus an OpenCode-message existence check via `getOpenCodeMessageById(...)`, then sequences `removeCompactionMarker` → `injectCompactionMarker`. Returns a tagged `MarkerUpdateOutcome` (`applied` | `already-current` | `stale-skip` | `retryable-failure`); only `retryable-failure` preserves the deferred-history signal so the next pass retries. CAS-clear (`clearPendingCompactionMarkerStateIf`) on success guards against publish/drain races within and across processes. Eager paths (`/ctx-flush`, `/ctx-recomp`) call the marker manager directly and CAS-clear any stale pending blob. Restart-safe: hook init calls `getSessionsWithPendingMarker(...)` to rehydrate deferred sets so the next pass after restart still drains. `event-handler` CAS-clears pending state on `session.compacted` (provider already advanced the boundary) and on `session.deleted` via cascade. Raw-history readers strip `summary=true` / `finish="stop"` rows to preserve original ordinals. Stable feature, default `compaction_markers: true` since v0.16.x; deferred drain since v0.19 (plan v6).

**Auto-update checker:**
- Purpose: Self-update the cached `@latest` plugin install once per plugin process — OpenCode's plugin cache no longer auto-updates.
- Location: `src/hooks/auto-update-checker/checker.ts`, `src/hooks/auto-update-checker/cache.ts`, `src/hooks/auto-update-checker/constants.ts`
- Pattern: Fires from plugin init with on-disk cross-process dedup; rewrites the install-directory dependency entry + `bun.lock` (or runs `npm install` under OpenCode's npm-managed cache).

**Agent prompt pack:**
- Purpose: Keep hidden-agent identities and prompt text isolated from runtime wiring.
- Location: `src/agents/dreamer.ts`, `src/agents/historian.ts` (declares `HISTORIAN_AGENT` and `HISTORIAN_EDITOR_AGENT`), `src/agents/sidekick.ts`, `src/agents/magic-context-prompt.ts`
- Pattern: Constants plus prompt builders.

**Content stripping and replay:**
- Purpose: Strip reasoning, inline thinking, placeholder shells, structural noise, processed images, merged-assistant reasoning, system-injected stripping, and caveman compression from messages, and replay those operations on every transform pass to maintain stable message content across OpenCode's message rebuilds.
- Location: `src/hooks/magic-context/strip-content.ts`, `src/hooks/magic-context/caveman.ts`, `src/hooks/magic-context/caveman-cleanup.ts`, `src/hooks/magic-context/sentinel.ts`
- Pattern: Stateless strip functions plus deterministic in-place sentinel replacement (preserves message-part array shape across passes); paired with persisted watermarks (`cleared_reasoning_through_tag`, `stripped_placeholder_ids`, `tags.caveman_depth`) read from `session_meta` and `tags`. Several strips are provider-aware: `stripReasoningFromMergedAssistants` runs only for `anthropic`; whole-message empty-sentinel writes a `[dropped]` placeholder for non-Anthropic providers so openai-compatible providers don't see empty assistant messages.

**Protected-tail boundary (v3):**
- Purpose: Decide, per pass, which prefix of the raw tail is eligible for the historian and which suffix stays protected — from true-raw token sizes instead of user-turn counts, so sparse-user-turn sessions can't deadlock the historian (issue #132).
- Location: `src/hooks/magic-context/protected-tail-boundary.ts` (resolver), `src/hooks/magic-context/read-session-true-raw-tokens.ts` (ordinal-keyed token index, fed by cached per-tag token counts with live-tokenize fallback), `src/hooks/magic-context/compartment-trigger.ts` (trigger consumption).
- Pattern: Boundary offset anchors at `lastCompartmentEnd + 1`; token target `N` capped at `0.40 × usable`; pure function of (messages, usage, budget) — no persisted high-watermark (backward relaxation is the #132 fix). The trigger runs in the transform off the in-memory `args.messages` tail (zero opencode.db reads steady-state; the resolved snapshot is handed to the runner so the historian sees exactly what the fire decision saw), with content-stable range fingerprints for cross-view staleness validation.

**ctx_reduce nudges (Channel 1 / Channel 2):**
- Purpose: Keep the agent reducing its own context without cache-busting mutations — Channel 1 appends a `<system-reminder>` to tool outputs in `tool.execute.after` (persisted to OpenCode's DB, so the bytes are durable and replay for free); Channel 2 delivers a one-shot synthetic-user ceiling nudge near the execute threshold via the live-server client on step-boundary `message.updated` events (mid-turn "tool-calls" and final "stop") — the queued message lands at the next step so the agent is warned while the pile is still growing.
- Location: `src/hooks/magic-context/ctx-reduce-nudge.ts` (shared math: severity, `reclaimable ≥ usable/3` trigger), `src/hooks/magic-context/hook-handlers.ts` (Channel 1 injection), `src/hooks/magic-context/channel2-delivery.ts` (Channel 2 lease + delivery), `packages/pi-plugin/src/ctx-reduce-nudge-pi.ts` (Pi mirror: `tool_result` mutation + `agent_end` followUp).
- Pattern: Channel-1 baselines (per-session, in-memory) carry the measurement (`tailToolTokens`, `usableTokens`) the triggers evaluate; Channel 2 uses a cross-process CAS lease (`channel2_nudge_state`: pending → claimed → delivered) with full-predicate revalidation at delivery — unknown baseline never delivers, stale predicate cancels to re-armable, only confirmed sends consume the one-per-session cap.

**Tiered emergency drop (≥85%):**
- Purpose: Replace need-blind routine tool drops with a target-headroom eviction at force-materialize pressure — reclaim down to `fixedFloor + 0.30 × (ceiling − fixedFloor)`, evicting tool outputs oldest-first across tiers (T3 misc → T2 edit/search → T1 navigation), with newest-20% recency reserves on T1/T2.
- Location: `src/hooks/magic-context/emergency-drop.ts` (pure planner), applied from `heuristic-cleanup.ts` / `heuristic-cleanup-pi.ts`.
- Pattern: Split tag sets — `floorTags` (FULL active live-window set, floor accounting) vs `tags` (tool-only `canDrop()` eviction candidates); `last_emergency_input_sample` is the idempotence latch (no re-drop until a fresh provider usage reading arrives).

**Caveman text compression (experimental):**
- Purpose: Apply oldest-first age-tier text compression to user/assistant text outside the protected tail when `ctx_reduce_enabled=false`.
- Location: `src/hooks/magic-context/caveman.ts`
- Pattern: Four tiers (ultra/full/lite/untouched) keyed by raw-ordinal age within the non-protected region. Persisted per-tag `caveman_depth` enables byte-identical replay; depth escalation always recomputes from `source_contents` to avoid lossy double compression.

**Synthetic todowrite injection:**
- Purpose: Inject a deterministic `tool_use`/`tool_result` pair so the agent sees current todo state through its native todowrite mental model, even when real todowrite tool calls have been dropped from the prefix.
- Location: `src/hooks/magic-context/todo-view.ts` (renderer + hash), `src/hooks/magic-context/transform-postprocess-phase.ts` (B7 logic), `src/features/magic-context/storage-meta-persisted.ts` (state persistence)
- Pattern: Capture-path is pure DB write; cache-busting-pass injects fresh and persists `(call_id, anchor_message_id, state_json)`; defer-pass replays from persisted state_json for byte-identical wire bytes.

**Persisted session meta:**
- Purpose: Store per-session scalars and JSON blobs that must survive across transform passes and OpenCode restarts.
- Location: `src/features/magic-context/storage-meta-shared.ts`, `src/features/magic-context/storage-meta-persisted.ts`, `src/features/magic-context/storage-meta-session.ts`, `src/features/magic-context/storage-meta.ts`
- Pattern: `session_meta` SQLite table with `ensureColumn()` and versioned migrations; typed row interfaces with runtime guards; NULL coercion in `isSessionMetaRow()` so legacy rows don't trigger fallback-to-defaults on every read.

**Cache-busting signals (plan v6):**
- Purpose: Surface durable per-pass facts the postprocess phase uses to decide whether the v12 deferred-history drain, the deferred-marker drain, and the deferred-materialization drain are eligible to fire — without re-reading transform state.
- Location: `src/hooks/magic-context/cache-busting-signals.ts`, threaded into `RunPostTransformPhaseArgs` (`historyRebuiltThisPass`, `historyRefreshExplicitBeforePrepare`, `compartmentInjectionRebuiltFromDb`, `canConsumeDeferredLate`, `phaseJustAwaitedPublication`, etc.).
- Pattern: Captured at well-defined points in `transform.ts` (e.g. `historyRefreshExplicitBeforePrepare` is read immediately before `prepareCompartmentInjection`, not later) so concurrent transform passes don't clobber each other's signals. The drain decision (`historyWasConsumedThisPass`) combines `historyRebuiltThisPass && (canConsumeDeferredLate || phaseJustAwaitedPublication || explicitRebuildHappened) && materializationSatisfied`. Degraded-cache state (null-boundary rebuild) is tracked by `degradedCacheCountBySession` in postprocess; entry logs in `inject-compartments.ts` and a warning at `DEGRADE_CACHE_WARNING_THRESHOLD=10` consecutive degraded rebuilds.

**External memory backend (Hindsight):**
- Purpose: Hold curated project / user / global memories in an engine-agnostic external store so they survive across projects, harness restarts, and (in future) the user's whole fleet — with a once-per-session recall rendered into the context and explicit-only search reach. The local SQLite store remains the source of truth; the external store is a long-term companion.
- Location: `src/features/magic-context/memory/external-memory.ts` (init/tee/recall/remove/upsert facade), `src/features/magic-context/memory/external-memory-provider.ts` (engine-agnostic neutral types + `ExternalMemoryBackend` interface, mirrors the `EmbeddingProvider` pattern), `src/features/magic-context/memory/external-memory-hindsight.ts` (Hindsight impl — bank resolution, retain/recall/remove/mental-models/failed-retain, circuit breaker, SSRF guard), `src/features/magic-context/memory/external-recall.ts` (session-start orchestrator: 3-slice fan-out + dedup + trim + persist-before-settle), `src/features/magic-context/memory/external-recall-read.ts` (snapshot read + marker hash), `src/hooks/magic-context/inject-compartments.ts` (m[0]/m[1] render + `cachedM0ExternalRecallHash` marker), `src/tools/ctx-memory/tools.ts` and `src/features/magic-context/memory/promotion.ts` and `src/features/magic-context/user-memory/review-user-memories.ts` (write paths + W2 corrective propagation), `src/features/magic-context/search.ts` (explicit-only `external` source). Pi mirrors the same flow in `packages/pi-plugin/src/context-handler.ts`, `packages/pi-plugin/src/inject-compartments-pi.ts`, and the Pi ctx-search / ctx-memory tools.
- Pattern: Tee on every curated write (gated by `retain_sources`) → fire-and-forget, never blocks the local write. Recall fires once per session, fans out project / profile / global slices in parallel, semantic-dedups against local rows (cosine ≥ `dedup_threshold`, hash fallback), persists the snapshot to `session_meta` BEFORE the in-flight promise settles, and renders the `<external-memory source="hindsight">` block into m[1] only (the settled snapshot bakes into m[0] on the next HARD materialization — recall is not a materialization driver; `cached_m0_external_recall_hash` is a carried marker, never a HARD bust trigger). W2 correctives propagate archive/update/verify to the external store fire-and-forget after the local commit; `merge` is a no-op (engine's domain). Document identity `mc:<scopeKey>:<category>:<hash>` is content-derived → idempotent re-retains upsert on the server, retries never duplicate. Security: `memory.external` is user-config-only (stripped from project config by `stripUnsafeProjectConfigFields` in `src/config/project-security.ts`, parallel to `auto_update` / `sqlite`); Hindsight impl adds a circuit breaker (3 fails/60s → open 5min → half-open probe), SSRF guard, `redirect: "error"`, 422 never-retry, token never logged.

## Entry Points

**CLI entry:**
- Location: `packages/cli/src/index.ts` (separate `@cortexkit/magic-context` package).
- Triggers: Executed as the unified `magic-context` bin target via `npx @cortexkit/magic-context@latest <subcommand>`.
- Responsibilities: Detect installed harnesses (OpenCode, Pi) and dispatch `setup` / `doctor` / `migrate` flows; print usage on unknown commands.

**Plugin entry:**
- Location: `src/index.ts`
- Triggers: OpenCode loads the package entry declared in `package.json`.
- Responsibilities: Load config; surface config-warning toasts/ignored-messages; disable the plugin when conflicting plugins are detected (DCP, OMO context-management, OpenCode auto-compaction); register hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`); start RPC server; start auto-update checker; start dream-schedule timer; wire hooks, commands, and tools.

**TUI plugin entry:**
- Location: `src/tui/index.tsx` (separate `./tui` export from `package.json`).
- Triggers: OpenCode TUI loads the entry declared in `tui.json`.
- Responsibilities: Register Magic Context command-palette entries (with dual-path fallback for `api.keymap.registerLayer` vs legacy `api.command.register`); register sidebar slot; mount RPC-backed data layer.

**Message transform entry:**
- Location: `src/plugin/messages-transform.ts`
- Triggers: `experimental.chat.messages.transform`
- Responsibilities: Defensive wrapper around the magic-context hook's transform — catches transient `SQLITE_BUSY`/`SQLITE_LOCKED` errors and other failures, persists summary to `session_meta.last_transform_error`, and falls back to unmodified messages so OpenCode's prompt loop always proceeds.

**System-prompt transform entry:**
- Location: `src/hooks/magic-context/system-prompt-hash.ts`
- Triggers: `experimental.chat.system.transform`
- Responsibilities: Inject `<project-docs>`, `<user-profile>`, `<key-files>` adjunct blocks and Magic Context guidance text; persist `system_prompt_hash` for cache-stability decisions; skip injection for OpenCode's internal `title`/`summary`/`compaction` agents and any agents matched by user-configured `system_prompt_injection.skip_signatures`.

**Event entry:**
- Location: `src/plugin/event.ts`
- Triggers: OpenCode session and message lifecycle events.
- Responsibilities: Forward lifecycle events to the runtime event handler — `message.updated` (usage tracking, model drift detection, message-index live updates, Channel-2 ceiling-nudge delivery on step boundaries), `message.removed` (tag/index cleanup, anchor cleanup), `session.deleted` (full-session cleanup). The historian trigger decision no longer runs here — it lives in the transform, fed by the in-memory message tail (the event handler has no message array and the old per-streaming-delta DB read froze the event loop on large sessions).

**Tool entry:**
- Location: `src/plugin/tool-registry.ts`
- Triggers: Plugin initialization.
- Responsibilities: Open storage, normalize arg schemas, and expose the supported tool set.

**Tool definition entry:**
- Location: `src/index.ts` (`tool.definition` hook calls `recordToolDefinition`)
- Triggers: OpenCode `tool.definition` hook (per tool per flight).
- Responsibilities: Record tool description and parameter token counts per `(provider, model, agent, tool_id)` for sidebar token attribution, with content-fingerprint short-circuit to avoid re-measuring stable definitions.

**RPC server entry:**
- Location: `src/shared/rpc-server.ts` (started from `src/index.ts`)
- Triggers: Plugin initialization.
- Responsibilities: Bind localhost RPC server on ephemeral port; publish port via `session_meta` for TUI discovery; serve sidebar/status/recomp/notification endpoints registered by `src/plugin/rpc-handlers.ts`.

## Session Modes

Magic Context runs in three effective modes depending on `ctx_reduce_enabled` and whether the session is a subagent. The mode decides which of the heavier features (historian, nudges, prompt-adjunct injections) run for that session, while tag/drop/heuristic plumbing stays on everywhere so any subsequent manual or automated reduction still works.

| Feature | Primary + `ctx_reduce_enabled: true` | Primary + `ctx_reduce_enabled: false` | Subagents (any `ctx_reduce_enabled`) |
|---|---|---|---|
| Tag DB records | ✓ | ✓ | ✓ |
| `§N§` tag prefix injection in message text | ✓ | ✗ | ✗ |
| `ctx_reduce` tool | ✓ | ✗ | ✗ |
| Historian / compartments / decay rendering | ✓ | ✓ | ✗ |
| Compartment injection (`<session-history>`) | ✓ | ✓ | ✗ |
| `<project-docs>`, `<user-profile>`, `<key-files>` system-prompt blocks | ✓ | ✓ | ✗ |
| Channel 1 ctx_reduce nudge (tool-output `<system-reminder>`) | ✓ | ✗ | ✓ |
| Channel 2 ceiling nudge (synthetic-user, one-shot) | ✓ | ✗ | ✗ |
| Deferred-note nudges | ✓ | ✗ | ✗ |
| Synthetic-todowrite injection | ✓ | ✓ | ✗ |
| Auto-search hint | ✓ | ✓ | ✗ |
| Heuristic tool drops at execute threshold | ✓ (once per user turn) | ✓ (once per user turn) | ✓ (every execute pass — no once-per-turn guard) |
| Heuristic reasoning clearing | ✓ | ✓ | ✓ |
| 85 % force-materialization | ✓ | ✓ | ✗ |
| 95 % block + emergency recovery | ✓ | ✓ | ✗ (overflow handled via `overflow-detection.ts` only; no recovery flag persisted) |
| Experimental age-tier caveman text compression | ✗ | opt-in via `experimental.caveman_text_compression.enabled` | ✗ |

**Subagent rationale:** subagents are driven by a parent agent, have bounded lifetimes, and often run in parallel (council, historian, sidekick, dreamer child sessions). They still benefit from automatic heuristic drops on their own context at execute passes (running on EVERY execute pass, not once-per-turn — long-running subagents are effectively one parent turn, and they'd starve under the parent's once-per-turn gate), but turning on historian, nudges, or prompt-adjunct injections in each subagent would create redundant work and per-agent cache churn. Subagents that run into overflow fall back to the existing `overflow-detection.ts` path; the detected limit is recorded so future passes use the lower value, but no emergency-recovery flag is persisted because subagents don't consume that path.

**`ctx_reduce_enabled: false` rationale:** removes agent-facing reduction machinery (the tool itself, nudges asking the agent to use it, and `§N§` prefix injection the agent can't act on) while keeping the deterministic parts (historian, heuristic drops, compartment injection, memory, synthetic-todowrite). Users who want a fully automatic pipeline can opt in and optionally enable caveman age-tier compression to recover most of the win that manual `ctx_reduce` gives for long user / assistant text parts.

## Error Handling

**Strategy:** Fail closed when persistent storage is unavailable in `src/plugin/tool-registry.ts` and `src/hooks/magic-context/hook.ts` — the plugin disables itself rather than running with ephemeral state that would silently grow the prompt past provider limits. Fail open inside per-turn handlers by logging and skipping unsafe mutations. Wrap the outer message transform in `src/plugin/messages-transform.ts` so transient `SQLITE_BUSY`/`SQLITE_LOCKED` errors and other failures don't crash OpenCode's prompt loop (issue #23). Stop OpenCode command fallthrough with sentinel errors from `src/hooks/magic-context/command-handler.ts`.

**Provider error parsing:** `src/features/magic-context/overflow-detection.ts` parses provider-specific context-overflow errors (Anthropic, OpenAI, GitHub Copilot) and persists the detected limit to `session_meta.detected_context_limit` so subsequent passes use the lower value. `needs_emergency_recovery` is set for primary sessions; subagents skip emergency-recovery state because they don't consume that path.

**Subagent model fallback:** `promptSyncWithModelSuggestionRetry` in `src/shared/model-suggestion-retry.ts` iterates the resolved fallback chain (user-configured `fallback_models` or builtin chain) on retryable failures. Abort, timeout, and context-overflow errors short-circuit the chain — those won't succeed on a different model and the caller's emergency-recovery path handles them. Suggestion retry ("did you mean X?") runs inside each attempt.

## Cross-Cutting Concerns

**Logging:** Use buffered file logging from `src/shared/logger.ts` and write to the temp-file path returned by `getLogFilePath()`. Per-session logs use `sessionLog(sessionId, message)`; module-level logs use `log(message)`. Heavy logging batches to disk to avoid blocking the transform path.

**Caching:** Use deferred reductions, cached memory-block injection, per-session TTL tracking, per-tag cached token counts (computed once on tag insert), persisted reminder-replay state, per-session live injection cache, persisted system-prompt hash, and persisted todo-snapshot replay state — all coordinated through `src/hooks/magic-context/` and `src/features/magic-context/storage-meta-*.ts`.

**Storage:** Use the SQLite database created by `src/features/magic-context/storage-db.ts` under the cortexkit data directory resolved by `src/shared/data-path.ts` (`~/.local/share/cortexkit/magic-context/context.db` on Linux/macOS, XDG-equivalent on Windows). Legacy OpenCode-plugin-folder DBs are migrated forward on first boot. The same DB is shared cross-harness between OpenCode and Pi; session-scoped tables include a `harness` discriminator (`'opencode'` / `'pi'`) while project-scoped tables (memories, git commits) are shared.

**Schema migrations:** `src/features/magic-context/migrations.ts` declares versioned migrations v1–v38 (`LATEST_SUPPORTED_VERSION = 38` in `storage-db.ts` is the schema-fence ceiling and MUST be bumped with every new migration; a unit test — `schema-version-fence.test.ts` — asserts `LATEST_SUPPORTED_VERSION === LATEST_MIGRATION_VERSION` so the two can't drift). Notable: v10 `tool_owner_message_id` (composite tool-tag identity); v11 `todo_synthetic_*` (synthetic-todowrite); v12 orphan `memory_embeddings` cleanup; v13 `pending_compaction_marker_state` (deferred-marker drain); v14 project-scoped key files + version counter; v15 `deferred_execute_state` (boundary execution); v16 context-limit cache sentinels; v17 multi-anchor note-nudge/auto-search JSON storage; v18 `pending_pi_compaction_marker_state`; v19 compartment-state lease table; v20 subagent invocation token accounting; v21 session lifetime work metrics; **v22 the v2.0 cache-architecture foundation (m[0]/m[1] split tables, `project_state` epoch counter, plus per-compartment `p1`–`p4` tier columns, `importance`, `episode_type`, `p1_embedding`, and `legacy` flag); v23 `compartment_events` (historian-extracted causal_incident / trajectory_correction, stored-not-rendered in v2.0); v24 `historian_runs` telemetry (per-run chunk range, compartment/fact/event counts, importance min/max/avg, status + failure reason, FK to `subagent_invocations`); v25 `pi_stable_id_scheme` (Pi stable-id cutover watermark); v26 `memory_mutation_log` + `cached_m1_bytes` (memory supersede-delta — non-additive in-session memory mutations render as an m[1] `<memory-updates>` delta instead of bumping the project epoch, plus the frozen-m[1]-bytes cache column); v27 `tags.entry_fingerprint` (Pi fallback-tag adoption); v28 `git_sweep_coordinator` (lease/cooldown for cross-process git-commit sweeps); v29 `notes.anchor_ordinal` (note→conversation-tail traceback); v30 `cached_m0_system_hash` / `cached_m0_tool_set_hash` / `cached_m0_model_key` (HARD-bust m[0] markers — provider-side cache-eviction detection for the materialization taxonomy; the migration clears the m[0]/m[1] cache once so pre-v30 rows re-materialize cleanly); v31 ctx_reduce-nudge state (`last_nudge_undropped`, `channel2_nudge_state`, `last_emergency_input_sample` + startup heal zeroing legacy sticky/anchor nudge state); v32 protected-tail v3 boundary state + per-tag cached token counts (`tags.token_count` / `input_token_count` / `reasoning_token_count` — computed once on tag insert, summed for sidebar/boundary/nudge math); v33 `compartment_chunk_embeddings` table for cross-session semantic search across compartment windows; v34 `workspaces` / `workspace_members` tables plus `cached_m0_workspace_fingerprint` m[0] marker (with a one-shot m[0]/m[1] cache reset so pre-v34 rows re-materialize cleanly); v35 `workspaces.share_categories` default + epoch refresh for existing members; v36 `session_projects` ownership map + seed for pre-v36 embedded sessions; **v38 the external-memory v2 unified-read foundation: per-session `external_recall_json` / `external_recall_state` / `external_recall_at` columns on `session_meta` (the frozen post-dedup, post-trim snapshot every render replays for byte stability) and the `cached_m0_external_recall_hash` m[0] marker (a carried marker that drives the m[1] `<external-memory>` delta comparison only — deliberately NOT a `mustMaterialize` trigger; the migration is `ensureColumn`-idempotent so a dev DB that ran it under the pre-rename v31 number re-applies harmlessly).** Migration runner uses `schema_migrations` table with version-ordered execution and sibling-startup race protection (duplicate-insert is tolerated).

**Harness-aware behavior:** `src/shared/harness.ts` exposes `setHarness()`/`getHarness()` for the runtime to identify itself; production INSERTs into session-scoped tables tag rows with the current harness. Pi-specific session-resolution paths are skipped on OpenCode and vice versa.

**Project-config trust boundary:** `src/config/project-security.ts` `stripUnsafeProjectConfigFields()` strips privilege-escalation / exfiltration vectors from any repo-supplied (untrusted) project config BEFORE it merges over the trusted user config — shared by OpenCode and Pi so the boundary is identical cross-harness. Strips: `auto_update` (repos must not suppress plugin self-updates), `sqlite` (process-global PRAGMAs), `memory.external` (a repo must not redirect the long-term memory endpoint or read a user's personal memory store; only user-level config supplies the Hindsight endpoint/credentials), and the per-hidden-agent `prompt` / `permission` / `tools` / `system_prompt` fields (a repo must not reprogram the historian/dreamer/sidekick). A separate post-merge pass (`dropInheritedEmbeddingKeyOnRedirect`) drops the user's inherited `embedding.api_key` when the project redirected only the embedding endpoint without supplying its own key, to prevent exfiltration of the user's secret to a repository-chosen server.

## Tag Identity (v3.3.1+)

**Tag types:** `message`, `file`, `tool`. Each row in the `tags` table represents one source-content unit that can be tagged with `§N§` and dropped/truncated/replayed by the runtime.

**Identity composition by type:**

- **`message` and `file` tags:** identified by `(session_id, message_id)`. The `message_id` for these is a synthetic content id (`<msgId>:p<partIndex>` for text, `<msgId>:fileN` for files). These ids are globally unique within a session.

- **`tool` tags:** identified by `(session_id, message_id, tool_owner_message_id)` — a *composite* identity. For tool tags, `message_id` is the OpenCode-generated callID (e.g. `read:32`). Pre-v3.3.1 the runtime keyed tool tags by callID alone, but OpenCode reuses a callID counter per assistant turn — so two assistant turns that each invoke `read:32` produced the SAME callID for different invocations. The fix: include the *owning assistant message id* in the key so each invocation gets its own row.

**Schema enforcement:** schema migration v10 (`src/features/magic-context/migrations.ts`) adds `tool_owner_message_id` (`TEXT NULL`), a partial UNIQUE index `idx_tags_tool_composite` on `(session_id, message_id, tool_owner_message_id) WHERE type='tool' AND tool_owner_message_id IS NOT NULL`, and a partial lookup index `idx_tags_tool_null_owner` on `(session_id, message_id) WHERE type='tool' AND tool_owner_message_id IS NULL` to back lazy adoption.

**Helper API surface (`src/features/magic-context/storage-tags.ts`):**

- `getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId)`: composite-identity lookup.
- `getNullOwnerToolTag(db, sessionId, callId)`: find a legacy NULL-owner orphan to lazily adopt.
- `adoptNullOwnerToolTag(db, tagId, ownerMsgId)`: attempt to claim a NULL-owner row (NULL guard ensures first claim wins).
- `getPersistedToolOwnerNearestPrior(db, sessionId, callId, beforeMessageId)`: derive the most recent prior owner for a tool result whose invocation isn't in the visible window.
- `deleteToolTagsByOwner(db, sessionId, ownerMsgId)`: cascade delete on `message.removed`.

**Owner derivation (`src/hooks/magic-context/tag-messages.ts`):**

For each tool observation in a transform pass:

1. **Invocation parts** (`tool-invocation` / `tool_use`): owner = the message hosting the part.
2. **Result parts** (`tool` with output / `tool_result`): pop the FIFO queue of unpaired invocations for that callId; owner = the popped invocation's message id.
3. **Result-only window** (invocation compacted away): fall back to `getPersistedToolOwnerNearestPrior` for the most recent prior persisted owner; if none found, last-resort owner = the result's own message id.

The same logic mirrors in `src/hooks/magic-context/read-session-chunk.ts: getRawSessionTagKeysThrough` so the drop queue produces composite keys that match what the tagger persisted.

**Cleanup paths:**

- `deleteTagsByMessageId(db, sessionId, messageId)` (called from `event-handler.ts` on `message.removed`) deletes BOTH content-id-scoped tags (text/file on the removed message) AND owner-scoped tool tags (`tool_owner_message_id == messageId`).
- `applyHeuristicCleanup` keys both the tag-side index and fingerprint-side map by composite `<ownerMsgId>\x00<callId>`. The fingerprint VALUE includes ownerMsgId too, so cross-owner pairs with same `(toolName, args)` produce DISTINCT fingerprints and are NOT merged.

**Legacy NULL-owner handling:** rows written by pre-v3.3.1 plugin versions have `tool_owner_message_id = NULL`. The Layer B backfill (`src/features/magic-context/tool-owner-backfill.ts`) populates those rows from OpenCode's session DB on plugin upgrade (lease-based concurrency, batched commits). When backfill is skipped (no OpenCode DB attached) lazy adoption converts orphans to non-NULL on the next observation. Drop queue and heuristic cleanup gracefully fall back to bare-callId match for unbackfilled NULL-owner rows.
