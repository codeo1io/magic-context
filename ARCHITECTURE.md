# Architecture

> All `src/` paths are relative to `packages/plugin/` (the published npm package). File **locations** live in `STRUCTURE.md`; this document explains how the pieces fit and — above all — the invariants that keep the Anthropic prompt cache stable. When in doubt about transform behavior, read "Transform pass mechanics" below before touching code.

## Overview

Magic Context is an `@opencode-ai/plugin` (entry `src/index.ts`) that rewrites the message array and system prompt on every LLM call to keep a long session inside the context window without losing history. Core tenets:

- **Thin adapters, real logic separated.** OpenCode-facing handlers live in `src/plugin/`; feature logic in `src/hooks/magic-context/` (runtime), `src/features/magic-context/` (services), `src/tools/` (agent tools).
- **Durable SQLite state**, never ephemeral — if storage is unavailable the plugin fails closed rather than silently letting the prompt grow past the provider limit. DB at `~/.local/share/cortexkit/magic-context/context.db`, shared cross-harness (OpenCode + Pi); session-scoped tables carry a `harness` discriminator, project-scoped tables (memories, git commits) are shared.
- **Replay-everything for cache stability.** Every persistent message mutation (reasoning clearing, structural-noise / placeholder / image / merged-assistant stripping, caveman compression, synthetic-todowrite, drop placeholders) is re-applied deterministically on EVERY transform pass — including defer passes — so the wire bytes stay byte-identical and the provider prompt cache survives.
- **Hidden subagents** (`historian`, `historian-editor`, `dreamer`, `sidekick`) do the heavy LLM work out of band; the transform itself does no LLM calls.
- **Runtime SQLite backend** (`src/shared/sqlite.ts`): `bun:sqlite` under Bun, `node:sqlite` (`DatabaseSync`) under Node (Pi) and Electron (Desktop). The non-Bun branch adds a savepoint-aware `transaction()` shim and `readonly`→`readOnly` mapping; otherwise identical. No native module, no prebuild.
- **Pi parity:** `packages/pi-plugin/` mirrors OpenCode semantics, importing shared core from `@magic-context/core`. Intentional divergences are tracked in `packages/pi-plugin/PARITY.md`.

## Layers

- **Bootstrap** (`src/index.ts`): load config, register hidden agents + hooks + tools, start RPC server, dream-timer, auto-update checker; detect conflicting plugins (DCP / OMO / OpenCode auto-compaction) and disable the runtime if any is active.
- **Adapters** (`src/plugin/`): hook wrappers, tool registry, RPC handlers, dream-timer lifecycle, per-session hook construction.
- **Runtime** (`src/hooks/magic-context/`): the transform pipeline, postprocess phase, event/command handlers, system-prompt injection, compartment runners, decay rendering, strip-and-replay, nudges, m[0]/m[1] injection.
- **Feature services** (`src/features/magic-context/`): storage, scheduler, tagger, memory, dreamer, sidekick, key-files, git-commit + message FTS indexes, unified search, overflow detection, migrations.
- **Tools** (`src/tools/`): `ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_memory`, `ctx_search`.
- **Config + shared** (`src/config/`, `src/shared/`): Zod config (deep-merge raw JSONC before validation; invalid leaves fall back to defaults with warnings, never disable the plugin), logger, data paths, SQLite selector, harness id, RPC transport, conflict detector, tag-transcript primitive (shared with Pi).
- **TUI** (`src/tui/`): sidebar + `/ctx-status` / `/ctx-recomp` dialogs, RPC-backed; shipped as raw TS via the `./tui` export (not bundled into `dist/index.js`).
- **CLI** (`packages/cli/`, separate `@cortexkit/magic-context` package): `npx` setup / doctor / migrate wizard.

<!-- mc:protected START — hand-authored cache-stability core. The dreamer's maintain-docs task MUST NOT edit, reword, reorder, trim, or drop anything between mc:protected START and mc:protected END; carry it forward byte-for-byte on any rewrite. Only a human edits this region, deliberately. -->

## Transform pass mechanics

This is the heart of the system and the part most easily gotten wrong. A "transform pass" is one invocation of `experimental.chat.messages.transform` (`src/hooks/magic-context/transform.ts`), wrapped defensively in `src/plugin/messages-transform.ts` (transient `SQLITE_BUSY` → return messages unmodified so the prompt loop always proceeds). OpenCode fires it once per LLM round-trip (per step within a turn).

### Pass lifecycle (in order)
1. Resolve usage + scheduler decision (`execute` vs `defer`).
2. Emergency overflow recovery if ≥95%.
3. Compartment trigger check (off the in-memory `args.messages` tail — no `opencode.db` read steady-state); fire the historian async if eligible.
4. Prepare compartment injection (decide m[0]/m[1] materialization).
5. Tag messages; replay dropped-status, caveman, reasoning, placeholder, image strips.
6. Compartment phase: inject the `<session-history>` (m[0]/m[1]) into `message[0]`.
7. **Postprocess** (`transform-postprocess-phase.ts`): the mutation gates — pending-op drain, heuristic cleanup, nudges, synthetic-todowrite, auto-search.

### Pass taxonomy (every pass is exactly one)
- **SOFT+ (defer / `cache_hit`):** nothing new. m[0] AND m[1] replay byte-identical; the entire `system + m[0] + m[1]` prefix stays cached. Only the conversation tail moves (where `ctx_reduce`/age drops land, themselves replayed deterministically). The steady state — most passes are this.
- **SOFT (cache-busting):** m[1] re-renders (new compartments / memories / user-profile surface as deltas) while m[0] stays byte-identical. `system + m[0]` stays cached; the cache busts at the m[1] breakpoint. Driven by an execute pass, `/ctx-flush`, or a deferred-history drain.
- **HARD (m[0] fold):** `mustMaterialize` fires → m[0] re-materializes, folding m[1] into the new decayed baseline and resetting m[1] to a placeholder. The whole prefix rebuilds — but "for free" because the provider cache key was already dead (see HARD triggers in "m[0]/m[1] cache layout"). **Decay re-tiering happens ONLY on a HARD fold** — a SOFT pass must never re-tier (that would change m[0] bytes).

### The mutation gates (the part to get right)
Pending-op drain and heuristic cleanup are each gated by the same shape in `transform-postprocess-phase.ts`:
```
shouldApplyPendingOps / shouldRunHeuristics =
  (execute || materializationRequested || forceMaterialization || m0HardFoldThisPass)  // BUST clause: is this pass busting anyway?
  && (!compartmentRunning || emergencyBypassCompartmentGate)                            // VETO clause: is the historian mid-run?
```
- **BUST clause** — only mutate (drop tools, run heuristics) on a pass that is *already* busting the prefix, so the mutation rides that one bust instead of causing its own. `m0HardFoldThisPass` is the fold-exec signal (an advisory `mustMaterialize` call earlier in postprocess).
- **VETO clause — `compartmentRunning`** — block mutation while the historian is summarizing the tail, so we don't change the bytes it's reading mid-run. Bypassed by `emergencyBypassCompartmentGate`.
- **`emergencyBypassCompartmentGate`** bypasses the veto when `forceMaterialization` (≥85%) **OR `m0HardFoldThisPass`** — i.e. a hard fold drains pending ops + runs heuristics even while the historian runs, because the prefix is busting regardless (see "drain into the known bust" invariant). This is safe per the disjoint-DB model below; Pi already does this (`context-handler.ts`).

### Load-bearing invariants (memorize these)
1. **A HARD bust means the prefix is already gone → drain EVERYTHING into it. Never "defer" a hard bust.** This pass IS the fold; there is no later fold to wait for. Deferring the drain only produces a second, avoidable bust ~one turn later. (The `compartmentRunning` veto must therefore yield to a hard fold — the fold-exec bypass.)
2. **A defer (SOFT+) pass must replay byte-identical.** Any first-application of a strip/drop on a defer pass changes tail bytes and busts the whole prefix after it. Watermark-gated strips (placeholders, images, stale-`ctx_reduce`) use a **frozen-id replay** pattern: detect-and-freeze the affected ids only on cache-busting passes, replay the frozen set on every pass. There is exactly ONE drop placeholder string, `[dropped §N§]`, a pure function of tag id — never re-derive bytes from mutated content (that caused repeated cache catastrophes).
3. **Deferred work rides the next bust cycle; it never forces its own.** Historian publishes, compaction-marker moves, and queued drops accumulate while m[1] replays frozen, and materialize together on the next genuine bust (execute / hard fold / flush). A historian publish does NOT bust the cache — between busts every pass is `cache_hit`.
4. **Boundary execution defers mid-turn.** `execute` decisions become `defer` while the latest assistant turn is mid-tool-use (CAS-flag `deferred_execute_state`), so we don't rewrite bytes while a turn is still accumulating tool calls. Bypasses: ≥85% force, explicit-bust, subagent. Drained re-peek-and-clear at end of postprocess.

### Disjoint-DB safety model
Mutating while the historian runs is safe because the two databases are disjoint on the read/write side:
- The historian reads **raw** OpenCode messages from **`opencode.db`** (read-only) for its chunk.
- Drops + heuristics mutate **`context.db`** (`tags` / `pending_ops`) and the in-memory outgoing wire only.
- The historian's in-flight snapshot is validated by `computeRawRangeFingerprint`, which hashes **raw content only** (ids, part types, content lengths) — never tag/drop state — so a concurrent drop can't invalidate it.
- Its post-publish `queueDropsForCompartmentalizedMessages` is idempotent against already-dropped tags.

## m[0]/m[1] cache layout

The compacted history renders into TWO synthetic `user`-role message slots at the head, so the large stable prefix survives steady-state work. `inject-compartments.ts` (`renderM0` / `renderM1` / `materializeM0` / `mustMaterialize`), mirrored in `inject-compartments-pi.ts`. Both slots prepend with `synthetic: true` parts so they don't count toward OpenCode's title-generation gate.

- **m[0] — cumulative baseline (frozen, like `system[0]`).** Holds `<project-docs>` (root `ARCHITECTURE.md` + `STRUCTURE.md`), baseline `<user-profile>`, and the decay-rendered compartment history as of the last materialization. Does NOT change on routine turns.
- **m[1] — volatile delta.** Holds everything added since the last m[0] materialization: `<key-files>`, new user-profile additions, new memories (via the `maxMemoryId` watermark), `<memory-updates>` supersede deltas, and the newest compartments at full tier. Renders a minimal placeholder when empty (never fully empty — Anthropic cache-breakpoint structure).

**`mustMaterialize` (HARD fold) triggers — organized around the bust taxonomy** so the trigger list and the m[0]/m[1] contract can never silently disagree:
- *Provider-side cache eviction* (the cache is already dead, so folding is free): model/provider change (`cachedM0ModelKey`), system-prompt-hash change (`cachedM0SystemHash`), idle > TTL (`cacheExpired`, self-consuming via `lastResponseTime > cachedM0MaterializedAt`).
- *Genuine m[0] content change* (baseline bytes differ): first render, `cached_m1_missing`, `project_memory_epoch` change (dashboard / external mutation), pending m[0] mutations (`max_mutation_id` — structural compartment delete/merge/recomp), upgrade-state change.
- **Deliberately NOT triggers** (these are m[1] deltas — triggering would bust m[0] on routine background work and defeat the design): **new compartment sequence**, `project_user_profile_version`, `maxMemoryId`, **project-docs-hash change** (docs edits fold in on the next natural hard bust, never on their own), and **tool-set-hash change** (process-global, false positives).
- **Pressure backstop refold:** on a cache-busting pass, if no natural HARD bust has arrived but m[1] has grown large — gated by the m[1]/m[0] size ratio (with a small-m[0] floor) OR an absolute m[1] token cap (~20% of history budget) OR a large memory-mutation count.
- `applyMarkersToState` updates ALL `state.cachedM0*` fields post-materialize (guards against an infinite re-materialize loop). `/ctx-flush` is SOFT (drives m[1] refresh + heuristics, not an m[0] fold).

**Memory mutations route through m[1], not the epoch.** In-session `ctx_memory` mutations do NOT bump `project_memory_epoch`: additive writes surface via the `maxMemoryId` watermark; non-additive (`update`/`archive`/`merge`) record a `memory_mutation_log` row rendered as a `<memory-updates>` delta. Both reconcile into m[0] on the next natural hard bust. The epoch is bumped only by **dashboard** mutations and `/ctx-session-upgrade` migration (an external editor can't otherwise signal a running session).

<!-- mc:protected END -->

## Historian compartment flow (produce → store → render)

The long-history pipeline. Tiered compartments + deterministic decay renderer (replaced the v1 flat-compartment + LLM-compressor model).

1. **Trigger** (`compartment-trigger.ts`): threshold-relative pressure (`context_limit × execute_threshold × 5%`, clamped 5k–50k), commit clusters, and TC-chunked unsummarized-tail size (`≥ triggerBudget × 3`), while protecting the live tail. Runs off the in-memory tail (zero `opencode.db` reads steady-state); hands the resolved boundary snapshot to the runner so the historian sees exactly what the fire decision saw.
2. **Produce** (`compartment-runner-incremental.ts`): runs the historian subagent on the raw chunk above the last compartment boundary with a **bounded** prompt (no full state dump) — 4 rotating seed compartments + the last 6 persisted compartments + the project-memory block for fact dedup. Emits each compartment with 4 paraphrase tiers (`p1` verbose → `p4` anchor-only), an `importance` (decay-rate semantics), an `episode_type`, a `<facts>` block in the 5-category taxonomy, and an `<events>` block.
3. **Parse + validate**: `parseCompartmentOutput` + `validateHistorianOutput` (contiguous, non-overlapping ranges, correct `unprocessed_from`).
4. **Discard-last boundary healing**: if the historian consumed to the chunk edge with weak lookahead, the last (lookahead-free) compartment is not persisted; the next run re-reads it at the head with full lookahead. Guarded by progress (`k≥2`) and emergency-disabled.
5. **Store**: publish transaction appends compartments with tier columns. Promotable facts promote to project memory (exact-dedup); `user_observations` stored only when `dreamer.user_memories.enabled` (privacy gate). Events → `compartment_events`. Compartment-chunk embeddings generated on publish (memory-gated). Publish defers a compaction-marker move (see Subsystems) and signals a deferred history refresh — it does NOT force a bust.
6. **Render (decay)**: `decay-render.ts` (shared OpenCode + Pi) picks one tier per compartment via `decay-curve.ts`: half-life `H = H50·2^((I−50)/D)/max(p,0.10)` (`H50=24`, `D=25`), log-cost tier boundaries `[0.201,0.729,1.322,2.587]`, budget pressure `p` once per pass. Older / lower-importance / higher-pressure compartments demote oldest-first; past the archive boundary they render P4/self-close or drop. Self-tunes as the context window changes — no LLM call. Legacy (pre-v2) rows render P3 (if they carry a `U:` line) else P4.
7. **Recomp / upgrade**: `/ctx-recomp` rebuilds compartment structure from raw history (emits NO facts — preserves curated memories). `/ctx-session-upgrade` runs full recomp + a once-per-project 9→5-category memory migration (`active` only, `permanent` untouched, bumps the epoch).

## Protected-tail boundary

`protected-tail-boundary.ts` decides, per pass, which prefix of the raw tail is eligible for the historian and which suffix stays protected — from true-raw token sizes (not user-turn counts), so sparse-user-turn sessions can't deadlock the historian (#132). Boundary anchors at `lastCompartmentEnd + 1`; token target `N` capped at `0.40 × usable` (ABS_CAP 96k); a live-prompt floor keeps it from crossing the newest meaningful user message on routine (<80%) passes. **Open tool arcs** (a tool invocation with no result in the window) only hold the boundary back when **recent** (≥ the size-walk start = the live window); a stale/interrupted open arc older than that is compactable — otherwise one dead `running` tool call at the eligible-head edge would freeze the historian indefinitely. The trigger/runner share a content-stable range fingerprint for cross-view staleness validation.

## Memory, search & embeddings

- **Memories** (`memory/storage-memory.ts`): project-scoped durable knowledge in the 5-category taxonomy (PROJECT_RULES / ARCHITECTURE / CONSTRAINTS / CONFIG_VALUES / NAMING), with FTS + vector side tables. `ctx_memory` exposes write/archive/update/merge/list; `list` is dreamer-only; primary agents may only mutate their own project's memories (workspace-shared categories aside).
- **Unified search** (`search.ts`): one query embedding dispatched across memories, raw message history (FTS via `message-index.ts`), indexed git commits, and compartment-chunk embeddings. Hard-filters memories already visible in `<session-history>` and raw-message hits newer than the last compartment boundary (already in context).
- **Embeddings**: vectors stored as plain SQLite BLOBs, scanned in-memory via `Float32Array` cosine (sqlite-vec rejected — `bun:sqlite` can't load extensions + write-amplification). Provider resolved per-project; a substitution guard rejects a served model that doesn't match the requested one. Compartment-chunk embedding is on-demand via `/ctx-embed` (auto-drains the active session once per process; resilient retry with circuit-break; chunk-window config folds into chunk identity so it doesn't invalidate memory/commit vectors).
- **Workspaces** (`workspaces` / `workspace_members`): a project belongs to at most one workspace; member sessions read the union of members' memories (repo-attributed), gated per-category by `share_categories`. A `cached_m0_workspace_fingerprint` (sorted identity+epoch+categories hash) detects membership/policy changes for a single hard fold on change.

## Dreamer

Background maintenance, one worker at a time. Eligible projects detected on `message.updated` (12h cooldown), enqueued by a process-wide 15-min timer, serialized by a DB lease (TTL + renewal). Each task spawns one child session (`dreamer/runner.ts`); model resolved through the fallback chain. Tasks: consolidate, verify, archive-stale, improve, maintain-docs, plus optional user-memory review / smart-note evaluation / key-file identification (config-gated). A circuit breaker aborts after 3 consecutive identical failures. Queue rows are project-scoped (a host only dequeues projects it has loaded).

## Other subsystems

- **Synthetic-todowrite**: `tool.execute.after` captures todo state to `last_todo_state` (pure DB write). On a cache-busting pass, postprocess injects a synthetic `tool_use`/`tool_result` pair (call_id = `mc_synthetic_todo_<sha256(state)[:16]}`) into the latest assistant message, AFTER tagging so it's never dropped. Defer passes rebuild from the persisted `state_json` for byte-identity.
- **ctx_reduce nudges**: Channel 1 appends a `<system-reminder>` to tool outputs in `tool.execute.after` (persisted to OpenCode's DB → replays for free). Channel 2 delivers a one-shot synthetic-user ceiling nudge at step boundaries via the live-server client (`promptAsync` with `synthetic: true`). Both gate on `ctx_reduce` actually being in the session's tool allow-list. Trigger math: severity over the working window, `reclaimable ≥ usable/3`, protected tags excluded.
- **Tiered emergency drop (≥85%)**: target-headroom eviction down to `fixedFloor + 0.30 × (ceiling − fixedFloor)`, tools oldest-first across tiers (T3 misc → T2 edit/search → T1 navigation), newest-20% recency reserve on T1/T2. `floorTags` (full active set, for floor accounting) vs `tags` (droppable candidates). `last_emergency_input_sample` is the idempotence latch. The newest-20 dropped tool calls keep a `[dropped §N§]` skeleton (the `tool_use` survives, output replaced) so provider tool-pairing holds; older drops are fully removed.
- **Compaction markers**: inject an OpenCode-compatible compaction boundary so `filterCompacted` stops at the historian's last compartment, shrinking the transform-input array. The marker move is **deferred** from historian publish into the next materializing pass (one bust covers both the `<session-history>` rebuild and the boundary advance); CAS-guarded, restart-safe.
- **Content stripping** (`strip-content.ts`, `caveman.ts`, `sentinel.ts`): stateless strip functions + deterministic in-place sentinel replacement + persisted watermarks. Provider-aware: empty-content sentinels only stay empty for providers that accept them (`modelAcceptsEmptyContent`); others get a `[dropped]` placeholder (e.g. Copilot/Bedrock break tool adjacency on empty parts — #135).
- **Message / git-commit indexes**: FTS5 raw-message index maintained outside the search hot path (async reconciliation + live `message.updated` events); HEAD-only non-merge git-commit corpus populated by the dream timer.
- **System-prompt injection** (`system-prompt-hash.ts`): injects only the Magic Context guidance text + a frozen `Today's date:` line (per-session sticky, updated only on cache-busting passes). Adjunct blocks (`<project-docs>` / `<user-profile>` / `<key-files>`) are NOT here — they moved into m[0]/m[1] so the system prompt stays maximally cache-stable. Skipped entirely for OpenCode's internal `title`/`summary`/`compaction` agents and for hidden child sessions (detected by the `magic-context-` title prefix).
- **TUI ↔ server RPC**: localhost server on an ephemeral port (published to `session_meta`); the TUI plugin reads all data via RPC (no direct SQLite, avoids lock contention).

## Storage & migrations

`storage-db.ts` creates the schema and runs versioned migrations (`migrations.ts`, currently v1–v36). `LATEST_SUPPORTED_VERSION` is a schema fence — it MUST be bumped with every new migration (a unit test asserts it equals the highest migration), and a stale value makes the DB refuse to open after the migration applies. `ensureColumn()` + `healAllNullColumns()` backfill upgraded DBs even if a migration row is lost. New session-scoped tables must be added to `clearSession()`. A bulletproof `MAGIC_CONTEXT_TEST_DATA_DIR` guard keeps the test suite off the live DB (running `bun test` once migrated a live DB and fail-closed running binaries). SQLite binds must use SPREAD positional args, never the array form (`bun:sqlite` binds a lone array positionally; `node:sqlite` reads it as named params and throws).

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
| `§N§` prefix injection + `ctx_reduce` tool | ✓ | ✗ | ✓ (if `ctx_reduce` available) |
| Historian / compartments / decay / m[0]m[1] | ✓ | ✓ | ✗ |
| Channel 1 nudge | ✓ | ✗ | ✓ |
| Channel 2 nudge | ✓ | ✗ | ✓ |
| Synthetic-todowrite / auto-search | ✓ | ✓ | ✗ |
| Heuristic tool drops at execute | ✓ once/turn | ✓ once/turn | ✓ every execute pass |
| 85% force-materialize / 95% block | ✓ | ✓ | ✗ (overflow path only) |
| Caveman text compression | ✗ | opt-in | ✗ |

Subagents run heuristic drops on every execute pass (no once-per-turn guard) because a long subagent run is effectively one parent turn and would otherwise starve; they have no provider-cache reuse to protect.

## Error handling

Fail **closed** when storage is unavailable (better to disable than silently overflow the prompt). Fail **open** in per-turn handlers (log and skip). Wrap the outer transform so transient `SQLITE_BUSY`/`SQLITE_LOCKED` never crash the prompt loop (#23). `overflow-detection.ts` parses provider context-overflow errors (Anthropic / OpenAI / Copilot) and persists the detected limit so later passes use the lower value. Subagent model fallback (`model-suggestion-retry.ts`) iterates the chain on retryable failures; abort/timeout/context-overflow short-circuit. Hidden agents carry a `steps`/`maxSteps` cap and are aborted via `session.abort` on timeout so a weak local model can't loop forever (#154).

## Tag identity


**Provider error parsing:** `src/features/magic-context/overflow-detection.ts` parses provider-specific context-overflow errors (Anthropic, OpenAI, GitHub Copilot) and persists the detected limit to `session_meta.detected_context_limit` so subsequent passes use the lower value. `needs_emergency_recovery` is set for primary sessions; subagents skip emergency-recovery state because they don't consume that path.

**Subagent model fallback:** `promptSyncWithModelSuggestionRetry` in `src/shared/model-suggestion-retry.ts` iterates the resolved fallback chain (user-configured `fallback_models` or builtin chain) on retryable failures. Abort, timeout, and context-overflow errors short-circuit the chain — those won't succeed on a different model and the caller's emergency-recovery path handles them. Suggestion retry ("did you mean X?") runs inside each attempt.

## Cross-Cutting Concerns

**Logging:** Use buffered file logging from `src/shared/logger.ts` and write to the temp-file path returned by `getLogFilePath()`. Per-session logs use `sessionLog(sessionId, message)`; module-level logs use `log(message)`. Heavy logging batches to disk to avoid blocking the transform path.

**Caching:** Use deferred reductions, cached memory-block injection, per-session TTL tracking, per-tag cached token counts (computed once on tag insert), persisted reminder-replay state, per-session live injection cache, persisted system-prompt hash, and persisted todo-snapshot replay state — all coordinated through `src/hooks/magic-context/` and `src/features/magic-context/storage-meta-*.ts`.

**Storage:** Use the SQLite database created by `src/features/magic-context/storage-db.ts` under the cortexkit data directory resolved by `src/shared/data-path.ts` (`~/.local/share/cortexkit/magic-context/context.db` on Linux/macOS, XDG-equivalent on Windows). Legacy OpenCode-plugin-folder DBs are migrated forward on first boot. The same DB is shared cross-harness between OpenCode and Pi; session-scoped tables include a `harness` discriminator (`'opencode'` / `'pi'`) while project-scoped tables (memories, git commits) are shared.

**Schema migrations:** `src/features/magic-context/migrations.ts` declares versioned migrations v1–v37 (`LATEST_SUPPORTED_VERSION = 37` in `storage-db.ts` is the schema-fence ceiling and MUST be bumped with every new migration; a unit test — `schema-version-fence.test.ts` — asserts `LATEST_SUPPORTED_VERSION === LATEST_MIGRATION_VERSION` so the two can't drift). Notable: v10 `tool_owner_message_id` (composite tool-tag identity); v11 `todo_synthetic_*` (synthetic-todowrite); v12 orphan `memory_embeddings` cleanup; v13 `pending_compaction_marker_state` (deferred-marker drain); v14 project-scoped key files + version counter; v15 `deferred_execute_state` (boundary execution); v16 context-limit cache sentinels; v17 multi-anchor note-nudge/auto-search JSON storage; v18 `pending_pi_compaction_marker_state`; v19 compartment-state lease table; v20 subagent invocation token accounting; v21 session lifetime work metrics; **v22 the v2.0 cache-architecture foundation (m[0]/m[1] split tables, `project_state` epoch counter, plus per-compartment `p1`–`p4` tier columns, `importance`, `episode_type`, `p1_embedding`, and `legacy` flag); v23 `compartment_events` (historian-extracted causal_incident / trajectory_correction, stored-not-rendered in v2.0); v24 `historian_runs` telemetry (per-run chunk range, compartment/fact/event counts, importance min/max/avg, status + failure reason, FK to `subagent_invocations`); v25 `pi_stable_id_scheme` (Pi stable-id cutover watermark); v26 `memory_mutation_log` + `cached_m1_bytes` (memory supersede-delta — non-additive in-session memory mutations render as an m[1] `<memory-updates>` delta instead of bumping the project epoch, plus the frozen-m[1]-bytes cache column); v27 `tags.entry_fingerprint` (Pi fallback-tag adoption); v28 `git_sweep_coordinator` (lease/cooldown for cross-process git-commit sweeps); v29 `notes.anchor_ordinal` (note→conversation-tail traceback); v30 `cached_m0_system_hash` / `cached_m0_tool_set_hash` / `cached_m0_model_key` (HARD-bust m[0] markers — provider-side cache-eviction detection for the materialization taxonomy; the migration clears the m[0]/m[1] cache once so pre-v30 rows re-materialize cleanly); v31 ctx_reduce-nudge state (`last_nudge_undropped`, `channel2_nudge_state`, `last_emergency_input_sample` + startup heal zeroing legacy sticky/anchor nudge state); v32 protected-tail v3 boundary state + per-tag cached token counts (`tags.token_count` / `input_token_count` / `reasoning_token_count` — computed once on tag insert, summed for sidebar/boundary/nudge math); v33 `compartment_chunk_embeddings` table for cross-session semantic search across compartment windows; v34 `workspaces` / `workspace_members` tables plus `cached_m0_workspace_fingerprint` m[0] marker (with a one-shot m[0]/m[1] cache reset so pre-v34 rows re-materialize cleanly); v35 `workspaces.share_categories` default + epoch refresh for existing members; v36 `session_projects` ownership map + seed for pre-v36 embedded sessions; **v37 the external-memory v2 unified-read foundation: per-session `external_recall_json` / `external_recall_state` / `external_recall_at` columns on `session_meta` (the frozen post-dedup, post-trim snapshot every render replays for byte stability) and the `cached_m0_external_recall_hash` m[0] marker (a carried marker that drives the m[1] `<external-memory>` delta comparison only — deliberately NOT a `mustMaterialize` trigger; the migration is `ensureColumn`-idempotent so a dev DB that ran it under the pre-rename v31 number re-applies harmlessly).** Migration runner uses `schema_migrations` table with version-ordered execution and sibling-startup race protection (duplicate-insert is tolerated).

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
