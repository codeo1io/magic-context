# Codebase Structure

> All paths below are relative to `packages/plugin/` — the published npm package.

## Key-files v6 locations

- `packages/plugin/src/features/magic-context/key-files/project-key-files.ts` — project-scoped storage helpers, version helpers, orphan GC, hashing.
- `packages/plugin/src/features/magic-context/key-files/read-history.ts` — primary-session read aggregation and range coalescing.
- `packages/plugin/src/features/magic-context/key-files/identify-key-files.ts` — Dreamer prompt, validator, and atomic commit path.
- `packages/plugin/src/features/magic-context/key-files/aft-availability.ts` — OpenCode/Pi AFT configuration detection.
- `packages/plugin/src/hooks/magic-context/key-files-block.ts` — versioned injection cache and stale-update flushing shared by OpenCode and Pi.
- `packages/dashboard/src/components/SessionViewer/SessionViewer.tsx` — read-only key-files panel in session detail.

## Directory Layout

```text
[project-root]/
├── src/                    # Plugin source code
├── scripts/                # Local maintenance and debugging scripts
├── docs/                   # Design references for major subsystems
├── dist/                   # Build output from `bun run build`
├── .github/workflows/      # CI and release automation
├── README.md               # Package overview and usage guide
├── CONFIGURATION.md        # Config reference for `magic-context.jsonc`
└── package.json            # Package metadata and Bun scripts
```

## Directory Purposes

**`src/`:**
- Purpose: Keep all runtime, tool, config, and integration code.
- Contains: TypeScript source files and co-located `*.test.ts` files.
- Key files: `src/index.ts`, `src/plugin/tool-registry.ts`, `src/hooks/magic-context/hook.ts`

**CLI (lives in a sibling package):**
- Purpose: Provide the unified, harness-aware setup/doctor wizard for OpenCode and Pi.
- Location: `packages/cli/src/` — published as `@cortexkit/magic-context`. Invoked as `npx @cortexkit/magic-context@latest <subcommand>`.
- Contains: Command implementations (`packages/cli/src/commands/`), per-harness adapters (`packages/cli/src/adapters/`), shared prompt/path utilities (`packages/cli/src/lib/`).
- History: prior to v0.16.1 each plugin shipped its own `opencode-magic-context` / `pi-magic-context` bin. Those were collapsed into the unified `magic-context` bin; this `packages/plugin/` tree no longer contains a `src/cli/` directory.

**`src/agents/`:**
- Purpose: Define hidden agent identifiers and shared agent prompt helpers.
- Contains: Agent-name constants and prompt-building helpers.
- Key files: `src/agents/dreamer.ts`, `src/agents/historian.ts` (declares `HISTORIAN_AGENT` and `HISTORIAN_EDITOR_AGENT`), `src/agents/sidekick.ts`, `src/agents/magic-context-prompt.ts`

**`src/config/`:**
- Purpose: Parse and validate plugin configuration.
- Contains: Config loaders, re-exports, and Zod schemas.
- Key files: `src/config/index.ts`, `src/config/schema/magic-context.ts`, `src/config/schema/agent-overrides.ts`

**`src/plugin/`:**
- Purpose: Adapt internal services to OpenCode plugin interfaces.
- Contains: Hook wrappers, tool registry setup, RPC handlers, dream-timer lifecycle, conflict-warning delivery, per-session hook construction.
- Key files: `src/plugin/messages-transform.ts`, `src/plugin/event.ts`, `src/plugin/tool-registry.ts`, `src/plugin/hooks/create-session-hooks.ts`, `src/plugin/rpc-handlers.ts`, `src/plugin/dream-timer.ts`, `src/plugin/conflict-warning-hook.ts`

**`src/hooks/`:**
- Purpose: Hold hook implementations and hook-specific helpers.
- Contains: The `magic-context` runtime, the auto-update checker, and small shared hook helpers like `is-anthropic-provider.ts`.
- Key files: `src/hooks/magic-context/hook.ts`, `src/hooks/magic-context/transform.ts`, `src/hooks/magic-context/transform-postprocess-phase.ts`, `src/hooks/magic-context/strip-content.ts`, `src/hooks/auto-update-checker/checker.ts`

**`src/tui/`:**
- Purpose: Render Magic Context sidebar and `/ctx-status` / `/ctx-recomp` dialogs inside OpenCode's TUI.
- Contains: TUI entrypoint, sidebar slot composition, RPC-backed data layer, type declarations.
- Key files: `src/tui/index.tsx` (registered via `./tui` export in `package.json`), `src/tui/slots/`, `src/tui/data/`, `src/tui/types/`
- Notes: Ships as raw TypeScript source, not bundled into `dist/index.js`. Loaded by OpenCode TUI via `tui.json` configuration.

**`src/features/`:**
- Purpose: Group reusable subsystem logic by feature.
- Contains: Magic-context services (storage, scheduler, tagger, search, message-index, overflow detection, compaction markers), dreamer runtime, sidekick support, memory system, user-memory pipeline, key-files pinning, git-commit indexer, tool-definition token measurement, schema migrations, built-in commands, **external memory backend (Hindsight)**, **skill-memory (per-skill motor memory)**.
- Key subdirs: `src/features/magic-context/dreamer/`, `src/features/magic-context/memory/`, `src/features/magic-context/sidekick/`, `src/features/magic-context/user-memory/`, `src/features/magic-context/key-files/`, `src/features/magic-context/git-commits/`, `src/features/magic-context/skill-memory/`, `src/features/builtin-commands/`
- Key files: `src/features/magic-context/storage-db.ts`, `src/features/magic-context/storage.ts` (barrel), `src/features/magic-context/migrations.ts`, `src/features/magic-context/message-index.ts`, `src/features/magic-context/search.ts`, `src/features/magic-context/overflow-detection.ts`, `src/features/magic-context/dreamer/runner.ts`, `src/features/magic-context/memory/storage-memory.ts`, `src/features/magic-context/memory/external-memory.ts` (external-memory facade: init/tee/recall/remove/upsert), `src/features/magic-context/memory/external-memory-provider.ts` (engine-agnostic neutral types + `ExternalMemoryBackend` interface, mirrors the `EmbeddingProvider` pattern), `src/features/magic-context/memory/external-memory-hindsight.ts` (Hindsight impl: bank resolution, retain/recall/remove/mental-models, circuit breaker, SSRF guard), `src/features/magic-context/memory/external-recall.ts` (session-start orchestrator: 3-slice fan-out + dedup + trim + persist-before-settle), `src/features/magic-context/memory/external-recall-read.ts` (snapshot read + marker hash for m[0]), `src/features/magic-context/skill-memory/{frontmatter,provenance,storage,recall}.ts`, `src/features/magic-context/user-memory/storage-user-memory.ts`, `src/features/builtin-commands/commands.ts`

**`src/tools/`:**
- Purpose: Define the agent-facing tool surface.
- Contains: One directory per tool with constants, types, implementation, and tests. Seven tools: `ctx-reduce`, `ctx-expand`, `ctx-note`, `ctx-memory`, `ctx-search`, `ctx-skill-note`, `ctx-skill-recall`. The two `ctx_skill_*` tools share the `recallSkillMemoryBlock` core with the transparent after-hook path.
- Key files: `src/tools/ctx-reduce/tools.ts`, `src/tools/ctx-expand/tools.ts`, `src/tools/ctx-note/tools.ts`, `src/tools/ctx-memory/tools.ts`, `src/tools/ctx-search/tools.ts`, `src/tools/ctx-skill-note/tools.ts`, `src/tools/ctx-skill-recall/tools.ts`

**`src/shared/`:**
- Purpose: Keep cross-feature utilities small and dependency-light.
- Contains: Logging, path helpers, JSONC parsing, model helpers, runtime-detected SQLite backend (`bun:sqlite` / `node:sqlite`), harness identification, RPC server/client/types/utils/notifications, conflict detection & fixer, OpenCode compaction detector, fallback chain resolver, models.dev cache, tag-transcript primitive shared with Pi, model-suggestion-retry helper, subagent runner (Pi-only).
- Key files: `src/shared/logger.ts`, `src/shared/data-path.ts`, `src/shared/jsonc-parser.ts`, `src/shared/sqlite.ts`, `src/shared/rpc-server.ts`, `src/shared/rpc-client.ts`, `src/shared/conflict-detector.ts`, `src/shared/model-suggestion-retry.ts`, `src/shared/resolve-fallbacks.ts`, `src/shared/harness.ts`, `src/shared/tag-transcript.ts`

**`scripts/`:**
- Purpose: Support local inspection and maintenance outside the plugin runtime.
- Contains: Bun scripts for dumps, tails, embedding backfill, semantic-search testing, schema generation, calibration, benchmarking, and version sync.
- Key files: `scripts/context-dump.ts`, `scripts/tail-view.ts`, `scripts/backfill-embeddings.ts`, `scripts/build-schema.ts`, `scripts/benchmark-tag-queries.ts`, `scripts/benchmark-message-fts.ts`

**`docs/`:**
- Purpose: Keep longer-lived subsystem design references and animation assets separate from root operational docs.
- Contains: `MEMORY-DESIGN.md` (memory subsystem design notes), plus `animation*/` subdirectories holding Remotion projects and renders for the README animation, and `archive/` for retired design documents.
- Key files: `docs/MEMORY-DESIGN.md`, `docs/animation/`

## Key File Locations

**Entry Points:**
- `src/index.ts`: Register the plugin, hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`), hooks, commands, tools, RPC server, dream-schedule timer, and the auto-update checker.
- `src/tui/index.tsx`: Register TUI command-palette entries and the sidebar slot for OpenCode TUI.
- `packages/cli/src/index.ts`: Unified setup/doctor/migrate entry for the separate `@cortexkit/magic-context` package.

**Configuration:**
- `src/config/index.ts`: Load and merge config files with field-level fallback for invalid leaves; collect warnings rather than disable the plugin.
- `src/config/schema/magic-context.ts`: Define defaults and schema rules.
- `src/config/schema/agent-overrides.ts`: Define overridable built-in agents.
- `assets/magic-context.schema.json`: Generated JSON schema, kept in sync via `scripts/build-schema.ts` and `scripts/release.sh`.

**Core Logic:**
- `src/hooks/magic-context/transform.ts`: Run the turn transform; orchestrate tagging, replay paths, prepareCompartmentInjection, and downstream postprocess hand-off. Also fires `startSessionRecall()` on the first message (Pi mirror: `packages/pi-plugin/src/context-handler.ts`).
- `src/hooks/magic-context/transform-postprocess-phase.ts`: Apply pending ops, heuristic cleanup, deferred-note nudges, **synthetic-todowrite injection (B7)**, and auto-search hints.
- `src/hooks/magic-context/hook.ts`: Compose runtime services.
- `src/hooks/magic-context/strip-content.ts`: Strip and replay reasoning, inline thinking, structural noise, dropped placeholders, merged-assistant reasoning, processed images, and system-injected messages.
- `src/hooks/magic-context/caveman.ts`: Experimental age-tier text compression for primary sessions with `ctx_reduce_enabled=false`.
- `src/hooks/magic-context/todo-view.ts`: Build the deterministic synthetic todowrite tool part and compute its hash-based `call_id`.
- `src/hooks/magic-context/skill-tool-definition.ts`: `injectSkillIntentParam` — adds an optional `intent` parameter to the `skill` tool's schema via the `tool.definition` hook (Effect-Schema strips it before the skill runs; the before-hook captures it pre-validation).
- `src/hooks/magic-context/inject-compartments.ts`: m[0]/m[1] history layout — `renderM0`/`renderM1`/`materializeM0`/`mustMaterialize`, plus `<external-memory source="hindsight">` block render (`renderExternalMemoryBlock` / `renderExternalMemoryDelta`) and the `M0SnapshotMarkers.externalRecallHash` carried marker (mirrored in Pi's `inject-compartments-pi.ts`).
- `src/hooks/magic-context/decay-curve.ts`: Council-validated deterministic tier-decay math (half-life, log-cost tier boundaries, budget pressure).
- `src/hooks/magic-context/decay-render.ts`: Shared OpenCode+Pi compartment renderer built on the decay curve (replaces the removed LLM compressor).
- `src/hooks/magic-context/compartment-runner-incremental.ts`: v2 historian publish path — bounded reference blocks, tiered/scored compartments, faithful per-chunk facts, discard-last, events + `p1_embedding` on publish.
- `src/hooks/magic-context/reference-retrieval.ts` (+ `reference-seeds.generated.ts`): 4 rotating seed compartments + last-6 recency references for the historian prompt.
- `src/hooks/magic-context/historian-prompt.generated.ts`: Generated v8.7.3 historian system prompt (source: `.alfonso/.../historian-prompt-v8.7.3.md`; re-exported via `compartment-prompt.ts`).
- `src/hooks/magic-context/hook-handlers.ts` (skill-memory branches): `createToolExecuteBeforeHook` (stashes per-callID `intent` in a bounded closure map), `maybeInjectSkillMemory` (appends the `<skill-memory>` block to `output.output` BEFORE the Channel-1 nudge), and the `createToolExecuteAfterHook` branch that parses the `Base directory` line + reads `SKILL.md` from disk to populate the session-scoped `SkillLoadRegistry`.
- `src/features/magic-context/memory/memory-migration.ts`: `/ctx-session-upgrade` 9-cat→5-cat memory re-eval (active-only, permanent-safe, epoch-bumping).
- `src/features/magic-context/memory/external-memory.ts`: External-memory facade — `initializeExternalMemory`, `teeToExternalBackend`, `recallFromExternalBackend`, `removeFromExternalBackend`, `mentalModelsFromExternalBackend`, `upsertToExternalBackend`, `getExternalMemoryStatus`. Re-exported from `src/features/magic-context/memory/index.ts`.
- `src/features/magic-context/memory/external-memory-provider.ts`: Engine-agnostic neutral types (`ExternalMemoryRetainItem`, `ExternalMemoryRecallQuery`, `ExternalMemoryRemoveItem`, `ExternalMemoryMentalModelQuery`) and the `ExternalMemoryBackend` interface (mirrors the `EmbeddingProvider` pattern; HindsightMemoryBackend is the implementation).
- `src/features/magic-context/memory/external-memory-hindsight.ts`: Hindsight impl — bank resolution (`resolveBankForScope` with `mc-{name}-{id8}` project-bank template + main bank), `documentIdFor` (`mc:<scopeKey>:<category>:<hash>`, idempotent), retain/recall/remove/mental-models/fetchFailedRetainCount over `/v1/default/banks/...`, circuit breaker (3 fails/60s → open 5min → half-open probe), SSRF guard via `embedding-ssrf.ts`, `redirect: "error"`, 422 never-retry, 10s fetch timeout.
- `src/features/magic-context/memory/external-recall.ts`: Session-start orchestrator — `startSessionRecall` (idempotent, fire-once per session; in-flight map + `pending` row deadlock guard) → 3-slice fan-out (project / profile / global) with mental-models fast path → `dedupAndTrim` (cosine ≥ `dedup_threshold` + hash fallback against local memories + active user memories; per-slice sort + token-trim) → `persistRecallState` writes `external_recall_state` / `external_recall_json` BEFORE the in-flight promise settles. Also `waitForSessionRecall` (Promise.race with timeout) and `maybeAwaitExternalRecall` (the A-path: block only when the first m[0] render is imminent and the cache is already cold).
- `src/features/magic-context/memory/external-recall-read.ts`: `readExternalRecallSnapshot` (sanitizeSlice validates per-item to fail safe on corrupted rows), `readExternalRecallHash`, `computeRecallSnapshotHash` (deterministic 16-char SHA-256 prefix of the JSON-serialized snapshot).
- `src/features/magic-context/skill-memory/frontmatter.ts`: Minimal YAML frontmatter parser for the per-skill `skill-memory:` block — returns `null` (inert) when absent or malformed; a bad config in one skill cannot break other skills.
- `src/features/magic-context/skill-memory/provenance.ts`: `parseSkillProvenance` (cross-platform `fileURLToPath` parser for the `Base directory for this skill: file:///...` line), `deriveSkillTier` / `deriveSkillSource` (path-based classification), and the session-scoped `SkillLoadRegistry` (`Map<sessionId:skillId, {resolvedPath, tier, skillSource, frontmatterConfig, loadedAt}>` — NOT persisted, cleaned in `onSessionDeleted`).
- `src/features/magic-context/skill-memory/storage.ts`: `skill_memory` table CRUD — `insertSkillMemoryNote` (UNIQUE-violation on duplicate returns null so callers can `bumpHitCount`), `getSkillMemoryNotes` (window-function flat ranking for P1), `findExistingNote`, `bumpHitCount`. The `UNIQUE(skill_id, tier, project_identity, normalized_hash)` constraint plus the `idx_skill_memory_lookup` and `idx_skill_memory_fts_prep` indexes live in migration v37.
- `src/features/magic-context/skill-memory/recall.ts`: `recallSkillMemoryBlock` — the shared recall+format core (used by BOTH the transparent after-hook AND `ctx_skill_recall`). `flatRecall` does P1's recency × hit_count greedy-fill; `buildSkillMemoryBlock` formats the `<skill-memory>` XML with the `ctx_skill_note` write-back footer. Lives in the feature layer to avoid a tools→hooks layering violation.
- `src/tools/ctx-skill-note/tools.ts`: `ctx_skill_note` — write-back tool. Hard gate rejects `kind: "general"` (general observations belong in `ctx_memory`). Exact-dedup on `normalized_hash` (reuses `computeNormalizedHash` from `memory/normalize-hash.ts`) bumps `hit_count`. Resolves `(skill_id, tier, project_identity, resolved_path)` from the session-scoped `SkillLoadRegistry`.
- `src/tools/ctx-skill-recall/tools.ts`: `ctx_skill_recall` — explicit recall companion. Registry-first resolution (exact, free, no disk I/O when the skill was loaded this session) with a cold-start disk fallback walking opencode's real `discoverSkills()` order (project dirs first — they shadow global). Returns distinct messages for SKILL.md-not-found vs disabled vs cold-start-no-notes.
- `src/features/magic-context/storage-db.ts`: Create durable storage; run versioned migrations; resolve runtime SQLite backend.
- `src/features/magic-context/storage-meta-persisted.ts`: Read and write per-session persisted scalars and JSON blobs.
- `src/features/magic-context/migrations.ts`: Versioned schema migrations v1–v38 (`LATEST_SUPPORTED_VERSION` in `storage-db.ts` must track the highest; `schema-version-fence.test.ts` asserts they stay in lockstep). v37 adds the `skill_memory` table; v38 adds `external_recall_json` / `external_recall_state` / `external_recall_at` and the `cached_m0_external_recall_hash` m[0] marker.
- `src/features/magic-context/message-index.ts`: FTS-backed raw-message index for `ctx_search`.
- `src/features/magic-context/search.ts`: Unified retrieval over memories, raw messages, git commits, and (explicit-only) the external long-term memory backend (`SearchSource += "external"`; `searchExternal` runs project + main bank in parallel, content-hash-dedups, drops hits already in the session's `<external-memory>` block, respects a 5s `AbortSignal`).
- `src/tools/ctx-memory/tools.ts`: W2 correctives (Pi mirror: `packages/pi-plugin/src/tools/ctx-memory.ts`) — `write` tees to external, `update` remove-then-tee cascade, `archive` batched remove, `merge` no-op, `verify` (dreamer-only) verbatim re-upsert. Also adds `scope: "global"` which routes ONLY to the external main bank with origin provenance and no local row.
- `src/config/project-security.ts`: `stripUnsafeProjectConfigFields()` — strips `memory.external` (alongside `auto_update`, `sqlite`, hidden-agent escalation fields) from project config so a repo cannot redirect the endpoint or read a user's personal memory store.
- **Pi mirror (`packages/pi-plugin/src/`):** `context-handler.ts` fires `startSessionRecall`; `inject-compartments-pi.ts` renders the `<external-memory>` block (project slice baked into m[0], profile slice appended to the `<user-profile>` block, global slice as a separate block — mirrors OpenCode); `tools/ctx-memory.ts` and `tools/ctx-search.ts` carry the same external + W2 + `SearchSource` plumbing. Pi no longer carries a drifted inline copy of the external code — it imports from `@magic-context/core/...` (the shared core package, which mirrors the OpenCode source path).

**Tests:** Co-locate tests with source as `src/**/*.test.ts`, for example `src/hooks/magic-context/hook.test.ts`, `src/tools/ctx-memory/tools.test.ts`, and `src/features/magic-context/migrations-v11.test.ts`. End-to-end coverage lives in the separate `packages/e2e-tests/` workspace.

## Naming Conventions

**Files:** Use kebab-case for multiword module files and reserve `index.ts` for barrel exports or package entry modules: `transform-postprocess-phase.ts`, `storage-memory.ts`, `compartment-runner-historian.ts`, `index.ts`.

**Test co-location:** Test files use the `.test.ts` suffix and sit next to the source they cover. Migration tests use a `migrations-v<N>.test.ts` convention.

**Directories:** Group by feature first, then by tool or subsystem name: `src/features/magic-context/dreamer/`, `src/features/magic-context/key-files/`, `src/tools/ctx-memory/`, `src/hooks/magic-context/`.

## Where to Add New Code

**New CLI command:** add it in `packages/cli/src/commands/` (the unified `@cortexkit/magic-context` package) and wire it from `packages/cli/src/index.ts`.

**New OpenCode hook adapter:** add the adapter in `src/plugin/` and keep the runtime logic in `src/hooks/magic-context/`.

**New magic-context transform or event helper:** add it under `src/hooks/magic-context/` and wire it through `src/hooks/magic-context/hook.ts`.

**New tool:** add `src/tools/[tool-name]/`, export it from the tool entry, and register it in `src/plugin/tool-registry.ts`. Remember to wire conditional schema narrowing for primary-vs-dreamer-only actions inside `tools.ts` if the tool has restricted actions.

**New built-in slash command:** add the command definition in `src/features/builtin-commands/commands.ts` and handle execution in `src/hooks/magic-context/command-handler.ts`. If the command needs a native TUI dialog, also push a notification via `pushNotification()` in `src/plugin/rpc-handlers.ts` and consume it in `src/tui/index.tsx`.

**New feature service:** add it under `src/features/magic-context/[feature-area]/` (preferred for cohesive subsystems like the message index, git-commits, key-files, user-memory) or as a focused single-file module under `src/features/magic-context/` when it stays small.

**New hidden agent:** add the agent constant in `src/agents/[agent-name].ts`, add prompt text near the owning feature (e.g. `src/features/magic-context/dreamer/task-prompts.ts`, `src/hooks/magic-context/compartment-prompt.ts`), and register it from `src/index.ts` via `buildHiddenAgentConfig`.

**New schema migration:** add a new versioned entry in `src/features/magic-context/migrations.ts` (next version number after the current highest) and add a co-located `migrations-v<N>.test.ts`. **Bump `LATEST_SUPPORTED_VERSION` in `storage-db.ts` to the new version** — it is the schema-fence ceiling, and a stale value makes the DB refuse to open after the migration applies (real bug caught during v2 work). Update the fresh-DB schema in `storage-db.ts` so new installs start at the latest shape without needing migration replay. Add `ensureColumn()` calls in `storage-db.ts` initialization for new columns so upgraded DBs catch up reliably even if a migration row is lost. If the new table/column is session-scoped, add it to `clearSession()` so it doesn't leak orphaned rows on session deletion.

**New RPC endpoint:** register the handler in `src/plugin/rpc-handlers.ts`, declare types in `src/shared/rpc-types.ts`, and consume from TUI via `src/tui/data/` modules.

**Shared utility:** add it in `src/shared/` only when at least two subsystems use it. Cross-runtime utilities (Bun/Node/Electron) belong here so the SQLite backend selector and harness identification stay in one place.

**Tests:** add a co-located `*.test.ts` file beside the implementation you change. For end-to-end coverage across OpenCode/Pi sessions, add scenarios under `packages/e2e-tests/tests/`.
