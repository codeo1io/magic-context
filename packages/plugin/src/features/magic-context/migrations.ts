import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { ensureColumn, healAllNullColumns } from "./storage-db";
import { bumpEpochsForWorkspaceMemberSet } from "./workspaces";

/**
 * Versioned migration framework for magic-context's SQLite database.
 *
 * Each migration is a function that runs inside a transaction.
 * Migrations are applied sequentially on startup — skipping any
 * that have already run. This handles multi-version jumps cleanly
 * (e.g. upgrading from 0.4 to 0.7 runs all intermediate migrations).
 *
 * To add a new migration:
 * 1. Append a new entry to the MIGRATIONS array
 * 2. The version number is the array index + 1
 * 3. The migration runs in a transaction — if it throws, it rolls back
 */

interface Migration {
    version: number;
    description: string;
    up: (db: Database) => void;
}

function tableExists(db: Database, name: string): boolean {
    return Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name),
    );
}

function columnExists(db: Database, table: string, column: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === column);
}

export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        description: "Merge session_notes + smart_notes into unified notes table",
        up: (db: Database) => {
            // Create the unified notes table
            db.exec(`
				CREATE TABLE IF NOT EXISTS notes (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					type TEXT NOT NULL DEFAULT 'session',
					status TEXT NOT NULL DEFAULT 'active',
					content TEXT NOT NULL,
					session_id TEXT,
					project_path TEXT,
					surface_condition TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					last_checked_at INTEGER,
					ready_at INTEGER,
					ready_reason TEXT
				);
				CREATE INDEX IF NOT EXISTS idx_notes_session_status ON notes(session_id, status);
				CREATE INDEX IF NOT EXISTS idx_notes_project_status ON notes(project_path, status);
				CREATE INDEX IF NOT EXISTS idx_notes_type_status ON notes(type, status);
			`);

            // Migrate session_notes → notes (type='session', status='active')
            const hasSessionNotes = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_notes'",
                )
                .get();
            if (hasSessionNotes) {
                db.exec(`
					INSERT INTO notes (type, status, content, session_id, created_at, updated_at)
					SELECT 'session', 'active', content, session_id, created_at, created_at
					FROM session_notes
				`);
            }

            // Migrate smart_notes → notes (type='smart', preserve status)
            const hasSmartNotes = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_notes'")
                .get();
            if (hasSmartNotes) {
                db.exec(`
					INSERT INTO notes (type, status, content, session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason)
					SELECT 'smart', status, content, created_session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason
					FROM smart_notes
				`);
            }

            // Drop old tables only after verifying row counts match
            if (hasSessionNotes) {
                const sourceCount = (
                    db.prepare("SELECT COUNT(*) as c FROM session_notes").get() as { c: number }
                ).c;
                const migratedCount = (
                    db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'session'").get() as {
                        c: number;
                    }
                ).c;
                if (migratedCount >= sourceCount) {
                    db.exec("DROP TABLE session_notes");
                } else {
                    throw new Error(
                        `session_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`,
                    );
                }
            }
            if (hasSmartNotes) {
                const sourceCount = (
                    db.prepare("SELECT COUNT(*) as c FROM smart_notes").get() as { c: number }
                ).c;
                const migratedCount = (
                    db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'smart'").get() as {
                        c: number;
                    }
                ).c;
                if (migratedCount >= sourceCount) {
                    db.exec("DROP TABLE smart_notes");
                } else {
                    throw new Error(
                        `smart_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`,
                    );
                }
            }
        },
    },
    {
        version: 2,
        description: "Add plugin_messages table for TUI ↔ server communication",
        up: (db: Database) => {
            db.exec(`
				CREATE TABLE IF NOT EXISTS plugin_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					direction TEXT NOT NULL,
					type TEXT NOT NULL,
					payload TEXT NOT NULL DEFAULT '{}',
					session_id TEXT,
					created_at INTEGER NOT NULL,
					consumed_at INTEGER
				);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_direction_consumed
					ON plugin_messages(direction, consumed_at);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_created
					ON plugin_messages(created_at);
			`);
        },
    },
    {
        version: 3,
        description: "Add user_memory_candidates and user_memories tables",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS user_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    source_compartment_start INTEGER,
                    source_compartment_end INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_umc_created ON user_memory_candidates(created_at);

                CREATE TABLE IF NOT EXISTS user_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    promoted_at INTEGER NOT NULL,
                    source_candidate_ids TEXT DEFAULT '[]',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_um_status ON user_memories(status);
            `);
        },
    },
    {
        version: 4,
        description: "Add git_commits + git_commit_embeddings + git_commits_fts tables",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS git_commits (
                    sha TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    short_sha TEXT NOT NULL,
                    message TEXT NOT NULL,
                    author TEXT,
                    committed_at INTEGER NOT NULL,
                    indexed_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_git_commits_project_time
                    ON git_commits(project_path, committed_at DESC);

                CREATE TABLE IF NOT EXISTS git_commit_embeddings (
                    sha TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL,
                    model_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    -- FK-cascade audit (v12): git_commit_embeddings.sha -> git_commits.sha
                    -- uses ON DELETE CASCADE, so SQLite PRAGMA foreign_keys must be ON on
                    -- every connection and v12 cleans historical orphan rows.
                    FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
                    sha UNINDEXED,
                    project_path UNINDEXED,
                    message,
                    tokenize = 'porter unicode61'
                );

                -- Mirror writes into FTS. We intentionally rebuild FTS rows on
                -- every INSERT OR REPLACE so amended commits or re-indexed
                -- messages update cleanly.
                CREATE TRIGGER IF NOT EXISTS git_commits_fts_insert
                AFTER INSERT ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = NEW.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_delete
                AFTER DELETE ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_update
                AFTER UPDATE OF message, project_path ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;
            `);
        },
    },
    {
        version: 5,
        description: "One-shot heal of NULL session_meta columns",
        // Previous releases ran healNullTextColumns/healNullIntegerColumns/
        // healMissingMemoryBlockIds on every plugin startup — ~25 no-op UPDATE
        // statements per launch, each acquiring a write lock for zero rows on
        // DBs that had already been healed.
        //
        // Moving the heal into the versioned migration system means it runs
        // exactly once: on the v4 → v5 upgrade for existing users, and as part
        // of first-boot schema setup for brand-new DBs (fresh DBs have no NULL
        // columns to heal — the heals are best-effort and short-circuit cheaply
        // when there's nothing to fix, so running v5 on a fresh DB is a no-op).
        //
        // Future schema changes that ADD new columns to session_meta should
        // add a follow-up heal migration if those columns risk NULL on
        // pre-existing rows. ensureColumn() in initializeDatabase() is still
        // the source of truth for column existence; this migration only fixes
        // legacy NULL data.
        up: (db: Database) => {
            healAllNullColumns(db);
        },
    },
    {
        version: 6,
        description: "Heal session_meta.counter drift below MAX(tag_number)",
        // Tagger counter and tags.tag_number can diverge for several reasons,
        // most of them now fixed:
        //   - Pre-v0.15.7 the outer db.transaction in tagMessages would
        //     rollback ALL tag inserts in a pass on a single UNIQUE collision,
        //     leaving inner-savepoint tag inserts already committed but the
        //     counter upsert undone. Net effect: max(tag_number) > counter.
        //   - Multi-process bursts could hit similar races even though tag
        //     numbers were per-session.
        //   - Pre-v0.15.7 ON CONFLICT counter upsert used `excluded.counter`
        //     unconditionally (non-monotonic), so any low writer could undo
        //     a higher writer's update.
        //
        // Once divergence existed, the old initFromDb early-returned when the
        // session was already known in memory, so the counter could never
        // self-heal: every assignTag would propose `counter + 1`, which often
        // collided with a tag_number an old writer had already claimed, and
        // the old recovery (lookup by message_id) returned null for new
        // messages and threw — cascading into the cache-bust loop we shipped
        // a fix for in v0.15.7.
        //
        // This one-shot heal brings every divergent session back into sync.
        // Cheap (one indexed scan over tags + one targeted UPDATE per
        // affected session) and idempotent — a fresh DB or already-healed DB
        // updates zero rows.
        up: (db: Database) => {
            db.prepare(
                `UPDATE session_meta
                 SET counter = (
                     SELECT MAX(tag_number)
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                 )
                 WHERE EXISTS (
                     SELECT 1
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                       AND tags.tag_number > session_meta.counter
                 )`,
            ).run();
        },
    },
    {
        version: 7,
        description: "Add harness column to notes table for cross-harness sharing",
        // The unified `notes` table was created by migration v1. As of
        // plugin v0.16+ we share `~/.local/share/cortexkit/magic-context/`
        // between OpenCode and Pi, so every session-scoped table needs to
        // record which harness wrote each row. All other session-scoped
        // tables get the column via ensureColumn() in initializeDatabase()
        // (which runs before this migration). `notes` is the only table
        // initializeDatabase() can't touch — it doesn't exist yet at that
        // point because v1 creates it. So we ALTER TABLE here.
        //
        // SQLite physically backfills NOT NULL DEFAULT on existing rows,
        // so all pre-v0.16 notes transparently become harness='opencode'.
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name?: string }>;
            if (!cols.some((c) => c.name === "harness")) {
                db.exec("ALTER TABLE notes ADD COLUMN harness TEXT NOT NULL DEFAULT 'opencode'");
            }
        },
    },
    {
        version: 8,
        description: "Add partial indexes on tags(session_id, tag_number) for active and dropped",
        // Hot-path optimization. The existing index
        // `idx_tags_session_tag_number ON tags(session_id, tag_number)`
        // covers `WHERE session_id = ?` but not the `status = ?` predicate,
        // so SQLite's planner falls back to scanning every tag in a session
        // (~50k rows on long-lived sessions) for the active-only and
        // dropped-only queries that run on every transform pass.
        //
        // Partial indexes restrict the index to rows matching the WHERE
        // clause, so:
        //   - `getActiveTagsBySession` becomes an index-only scan over the
        //     active rows (typically <1% of total tags),
        //   - `getMaxDroppedTagNumber` becomes a single backward index seek.
        //
        // Benchmarked at ~110× speedup on a 49k-tag session (67ms → 0.6ms
        // for the combined per-pass workload). See
        // `packages/plugin/scripts/benchmark-tag-queries.ts`.
        //
        // ANALYZE is run after creation so the planner has stats for the
        // new indexes the first time it sees a query against this DB.
        up: (db: Database) => {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tags_active_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'active';

                CREATE INDEX IF NOT EXISTS idx_tags_dropped_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'dropped';
            `);
            db.exec("ANALYZE tags;");
        },
    },
    {
        version: 9,
        description: "Persist tool_definition_measurements across plugin restarts",
        // The `tool.definition` plugin hook fires once per tool per
        // `ToolRegistry.tools()` call and produces our per-tool token
        // measurements. Pre-v9 these measurements lived only in an
        // in-process Map, so a plugin restart wiped them and the sidebar's
        // "Tool Defs" segment showed 0 tokens until the next chat.message
        // fired the hook chain again.
        //
        // Persisting to SQLite lets us repopulate the in-memory store at
        // openDatabase() time, so the sidebar shows the correct value
        // immediately after restart. Composite primary key matches the
        // in-memory keying (provider/model/agent/tool) so re-recording the
        // same key is a single INSERT OR REPLACE that updates the token
        // count and recorded_at without growing the table.
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS tool_definition_measurements (
                    provider_id TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    tool_id TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    recorded_at INTEGER NOT NULL,
                    PRIMARY KEY (provider_id, model_id, agent_name, tool_id)
                );
            `);
        },
    },
    {
        version: 10,
        description: "Add tool_owner_message_id column to tags + composite identity indexes",
        // Tag-owner identity fix (plan v3.3.1). Pre-v10 tool tags were
        // keyed solely by (session_id, callID), but OpenCode generates
        // callIDs per-turn rather than per-session. When two assistant
        // turns produce a tool with the same internal counter (e.g.
        // `read:32`), the tagger looked up the existing row by callID
        // and bound the new occurrence to the original tag — replaying
        // the original tag's drop status onto fresh content. Wire-level
        // failures on Kimi/Moonshot followed because the resulting
        // assistant message had reasoning_content stripped but no
        // accompanying tool_use blocks.
        //
        // Persistent identity for tool tags becomes the triple
        // (session_id, callID, tool_owner_message_id). Existing rows get
        // NULL owner; the runtime lazy-adopts them on first observation
        // (one-shot adoption per orphan, defense-in-depth) and a
        // separate backfill pass populates owner from the OpenCode DB
        // (primary correctness mechanism).
        //
        // The partial UNIQUE index prevents duplicate composite identity
        // rows once owner is populated. The lookup index accelerates
        // the lazy-adoption NULL fallback path.
        //
        // SQLite metadata-only ALTER (~5ms on 353MB DB).
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "tool_owner_message_id")) {
                db.exec("ALTER TABLE tags ADD COLUMN tool_owner_message_id TEXT DEFAULT NULL");
            }
            db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_tool_composite
                ON tags(session_id, message_id, tool_owner_message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;

                CREATE INDEX IF NOT EXISTS idx_tags_tool_null_owner
                ON tags(session_id, message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NULL;
            `);
        },
    },
    {
        version: 11,
        description: "Add todo state synthesis columns to session_meta",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // Snapshot of the most recent todowrite call's args.todos, written
            // by hook-handlers.ts on tool.execute.after. Source of truth for
            // synthetic injection on cache-busting passes.
            if (!cols.some((c) => c.name === "last_todo_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN last_todo_state TEXT DEFAULT ''");
            }
            // Synthetic call_id of the most recently injected todowrite tool
            // part. Deterministic (sha256 of the snapshot JSON) — recorded so
            // defer-pass replay can verify byte-shape stability.
            if (!cols.some((c) => c.name === "todo_synthetic_call_id")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_call_id TEXT DEFAULT ''",
                );
            }
            // Assistant message ID where the synthetic todowrite tool part is
            // anchored. Used by defer-pass replay to land at the exact same
            // message; if the anchor message disappears from the visible
            // window, the next cache-busting pass re-anchors.
            if (!cols.some((c) => c.name === "todo_synthetic_anchor_message_id")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_anchor_message_id TEXT DEFAULT ''",
                );
            }
            // Snapshot JSON of the todos as they existed at the moment we
            // injected. Defer-pass replay rebuilds the synthetic part from
            // THIS persisted state, not from `last_todo_state`. This keeps
            // T0-cache-bust → T1-defer prefix bytes identical even when a
            // real `todowrite` mutates `last_todo_state` between T0 and T1
            // (defer passes never refresh content; the next cache-busting
            // pass adopts the new state).
            if (!cols.some((c) => c.name === "todo_synthetic_state_json")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_state_json TEXT DEFAULT ''",
                );
            }
        },
    },
    {
        version: 12,
        description: "Clean orphan rows from FK-cascade embedding tables",
        up: (db: Database) => {
            const hasTable = (name: string): boolean =>
                Boolean(
                    db
                        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
                        .get(name),
                );

            const memoryEmbeddings = hasTable("memory_embeddings")
                ? db
                      .prepare(
                          `DELETE FROM memory_embeddings
                           WHERE memory_id NOT IN (SELECT id FROM memories)`,
                      )
                      .run().changes
                : 0;
            log(`[migrations] v12 cleaned ${memoryEmbeddings} orphan memory_embeddings row(s)`);

            const gitCommitEmbeddings = hasTable("git_commit_embeddings")
                ? db
                      .prepare(
                          `DELETE FROM git_commit_embeddings
                           WHERE sha NOT IN (SELECT sha FROM git_commits)`,
                      )
                      .run().changes
                : 0;
            log(
                `[migrations] v12 cleaned ${gitCommitEmbeddings} orphan git_commit_embeddings row(s)`,
            );
        },
    },
    {
        version: 13,
        description: "Add pending_compaction_marker_state column for deferred marker drain",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // CAS blob storing the deferred compaction-marker payload between
            // background publish (compartment-runner-incremental) and the
            // next consuming pass (transform-postprocess-phase). Intentionally
            // declared WITHOUT `DEFAULT ''` so absence is signalled as SQL
            // NULL — see `getSessionsWithPendingMarker` / `healNullTextColumns`
            // contracts in storage-db.ts. Plan v6 §3.
            if (!cols.some((c) => c.name === "pending_compaction_marker_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN pending_compaction_marker_state TEXT");
            }
        },
    },
    {
        version: 14,
        description: "Add project-scoped key files and version counter",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS project_key_files (
                    project_path           TEXT    NOT NULL,
                    path                   TEXT    NOT NULL,
                    content                TEXT    NOT NULL,
                    content_hash           TEXT    NOT NULL,
                    local_token_estimate   INTEGER NOT NULL,
                    generated_at           INTEGER NOT NULL,
                    generated_by_model     TEXT,
                    generation_config_hash TEXT    NOT NULL,
                    stale_reason           TEXT,
                    PRIMARY KEY (project_path, path)
                );

                CREATE INDEX IF NOT EXISTS idx_project_key_files_project
                    ON project_key_files(project_path);
                CREATE INDEX IF NOT EXISTS idx_project_key_files_generated_at
                    ON project_key_files(project_path, generated_at);

                CREATE TABLE IF NOT EXISTS project_key_files_version (
                    project_path TEXT    PRIMARY KEY,
                    version      INTEGER NOT NULL DEFAULT 0
                );
            `);
        },
    },
    {
        version: 15,
        description: "Add deferred_execute_state column for boundary execution drain",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // CAS blob storing the deferred-execute payload between a mid-turn
            // scheduler execute decision and the next boundary pass that
            // successfully runs execute work. Intentionally declared WITHOUT
            // `DEFAULT ''` so absence is signalled as SQL NULL, matching
            // pending_compaction_marker_state. Excluded from null-heal lists.
            if (!cols.some((c) => c.name === "deferred_execute_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN deferred_execute_state TEXT");
            }
        },
    },
    {
        version: 16,
        description: "Add context-limit cache regression sentinels",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "observed_safe_input_tokens")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0",
                );
            }
            if (!cols.some((c) => c.name === "cache_alert_sent")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN cache_alert_sent INTEGER NOT NULL DEFAULT 0",
                );
            }
        },
    },
    {
        version: 17,
        description: "Multi-anchor JSON storage for note-nudge and auto-search-hint persistence",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "note_nudge_anchors")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN note_nudge_anchors TEXT NOT NULL DEFAULT '[]'",
                );
            }
            if (!cols.some((c) => c.name === "auto_search_hint_decisions")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]'",
                );
            }

            // Backfill legacy single-anchor note-nudge state into the append-only
            // multi-anchor column. The NULL arm is required for upgraded rows that
            // predate the NOT NULL default (§3).
            db.exec(`
                UPDATE session_meta
                SET note_nudge_anchors = json_array(
                    json_object(
                        'messageId', note_nudge_sticky_message_id,
                        'text', note_nudge_sticky_text
                    )
                )
                WHERE COALESCE(note_nudge_sticky_text, '') != ''
                  AND COALESCE(note_nudge_sticky_message_id, '') != ''
                  AND (note_nudge_anchors IS NULL OR note_nudge_anchors = '[]')
            `);

            db.exec(`
                UPDATE session_meta SET note_nudge_anchors = '[]'
                WHERE note_nudge_anchors IS NULL
            `);
            db.exec(`
                UPDATE session_meta SET auto_search_hint_decisions = '[]'
                WHERE auto_search_hint_decisions IS NULL
            `);
        },
    },
    {
        version: 18,
        description: "Add pending_pi_compaction_marker_state column for Pi deferred marker drain",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // Pi-native compaction marker queue. Intentionally declared
            // WITHOUT a DEFAULT so SQL NULL remains the absence sentinel,
            // matching pending_compaction_marker_state and excluded from
            // healNullTextColumns.
            if (!cols.some((c) => c.name === "pending_pi_compaction_marker_state")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN pending_pi_compaction_marker_state TEXT",
                );
            }
        },
    },
    {
        version: 19,
        description: "Add compartment state lease table",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_state_lease (
                    session_id TEXT PRIMARY KEY NOT NULL,
                    holder_id TEXT NOT NULL,
                    acquired_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_compartment_state_lease_expires
                    ON compartment_state_lease(expires_at);
            `);
        },
    },
    {
        version: 20,
        description: "Add subagent invocation token accounting",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS subagent_invocations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL,
                    subagent TEXT NOT NULL,
                    task TEXT,
                    provider_id TEXT,
                    model_id TEXT,
                    started_at INTEGER NOT NULL,
                    ended_at INTEGER,
                    status TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    parent_invocation_id INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_sai_session_started
                    ON subagent_invocations(session_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_sai_subagent
                    ON subagent_invocations(subagent, started_at DESC);
            `);
        },
    },
    {
        version: 21,
        description: "Add session lifetime work metrics",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "new_work_tokens")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN new_work_tokens INTEGER NOT NULL DEFAULT 0",
                );
            }
            if (!cols.some((c) => c.name === "total_input_tokens")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0",
                );
            }
        },
    },
    {
        version: 22,
        description: "v2.0 cache architecture schema foundation",
        up: (db: Database) => {
            const hasSessionMetaTable = tableExists(db, "session_meta");
            const hasCompartmentsTable = tableExists(db, "compartments");
            const hasMemoriesTable = tableExists(db, "memories");

            if (hasSessionMetaTable) {
                ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
                ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
                ensureColumn(
                    db,
                    "session_meta",
                    "cached_m0_project_user_profile_version",
                    "INTEGER",
                );
                ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
                ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
                ensureColumn(db, "session_meta", "upgrade_reminded_at", "INTEGER");
            }

            if (hasCompartmentsTable) {
                // v2 paraphrase tiers (model B: dedicated columns, not XML-in-content).
                // Deviation from plan §3.4 (tiers-in-content) — see .alfonso/audits/v2-completeness/AUDIT.md.
                ensureColumn(db, "compartments", "p1", "TEXT");
                ensureColumn(db, "compartments", "p2", "TEXT");
                ensureColumn(db, "compartments", "p3", "TEXT");
                ensureColumn(db, "compartments", "p4", "TEXT");
                ensureColumn(db, "compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
                ensureColumn(db, "compartments", "episode_type", "TEXT");
                ensureColumn(db, "compartments", "p1_embedding", "BLOB");
                ensureColumn(db, "compartments", "p1_embedding_model_id", "TEXT");
                ensureColumn(db, "compartments", "legacy", "INTEGER NOT NULL DEFAULT 0");
            }

            const hasRecompCompartmentsTable = tableExists(db, "recomp_compartments");
            if (hasRecompCompartmentsTable) {
                // Tiers must round-trip through recomp staging or /ctx-recomp re-degrades v2 compartments to v1.
                ensureColumn(db, "recomp_compartments", "p1", "TEXT");
                ensureColumn(db, "recomp_compartments", "p2", "TEXT");
                ensureColumn(db, "recomp_compartments", "p3", "TEXT");
                ensureColumn(db, "recomp_compartments", "p4", "TEXT");
                ensureColumn(
                    db,
                    "recomp_compartments",
                    "importance",
                    "INTEGER NOT NULL DEFAULT 50",
                );
                ensureColumn(db, "recomp_compartments", "episode_type", "TEXT");
            }

            if (hasMemoriesTable) {
                ensureColumn(db, "memories", "importance", "INTEGER");
            }

            db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS project_state (
                    project_path TEXT PRIMARY KEY,
                    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
                    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS m0_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    mutation_type TEXT NOT NULL CHECK (mutation_type IN (
                        'compartment_delete',
                        'compartment_merge',
                        'recomp_boundary_change',
                        'compartment_upgrade'
                    )),
                    target_id INTEGER,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session
                    ON m0_mutation_log(session_id);

                CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
                    old_project_path TEXT PRIMARY KEY,
                    new_project_path TEXT NOT NULL,
                    rekeyed_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS v22_backfill_failures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    table_name TEXT NOT NULL,
                    row_id INTEGER NOT NULL,
                    raw_project_path TEXT NOT NULL,
                    error_class TEXT NOT NULL CHECK (error_class IN (
                        'not_git_repo',
                        'git_missing',
                        'git_timeout',
                        'permission_denied',
                        'unknown'
                    )),
                    error_message TEXT,
                    failed_at INTEGER NOT NULL,
                    UNIQUE(table_name, row_id)
                );
            `);

            if (hasCompartmentsTable) {
                db.exec(`
                    INSERT OR IGNORE INTO schema_migrations_meta (key, value)
                    SELECT 'v22_legacy_compartment_boundary', CAST(COALESCE(MAX(id), 0) AS TEXT)
                    FROM compartments
                `);

                const boundaryRow = db
                    .prepare(
                        "SELECT value FROM schema_migrations_meta WHERE key = 'v22_legacy_compartment_boundary'",
                    )
                    .get() as { value: string } | undefined;
                const compartmentBoundary = Number.parseInt(boundaryRow?.value ?? "0", 10);
                db.prepare("UPDATE compartments SET legacy = 1 WHERE legacy = 0 AND id <= ?").run(
                    Number.isFinite(compartmentBoundary) ? compartmentBoundary : 0,
                );
            } else {
                db.prepare(
                    "INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES ('v22_legacy_compartment_boundary', '0')",
                ).run();
            }

            db.prepare(
                "INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES ('v22_legacy_memory_backfill', 'pending')",
            ).run();
        },
    },
    {
        version: 23,
        description: "v2 compartment events storage (causal_incident / trajectory_correction)",
        up: (db: Database) => {
            // Historian-extracted events. Stored, not rendered, in v2.0 — a corpus
            // for a future dreamer cross-session aggregation/steering feature.
            // Parsed kind-agnostically: `kind` = element name, `fields_json` =
            // child elements as JSON, so new event kinds/fields need no migration.
            db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    compartment_id INTEGER,
                    kind TEXT NOT NULL,
                    at_compartment INTEGER,
                    fields_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode'
                );
                CREATE INDEX IF NOT EXISTS idx_compartment_events_session
                    ON compartment_events(session_id);
            `);
        },
    },
    {
        version: 24,
        description: "historian_runs metrics (per-run quality/cost telemetry)",
        up: (db: Database) => {
            // Per historian invocation: input chunk range, output shape
            // (compartments / facts / events / importance), run kind, and
            // success/failure — for debugging, quality analysis, and the
            // productization/training-data roadmap. Tokens + model come from the
            // FK-linked subagent_invocations row (subagent_invocation_id).
            db.exec(`
                CREATE TABLE IF NOT EXISTS historian_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    subagent_invocation_id INTEGER,
                    run_kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    failure_reason TEXT,
                    chunk_start_ordinal INTEGER,
                    chunk_end_ordinal INTEGER,
                    unprocessed_from INTEGER,
                    compartments_produced INTEGER NOT NULL DEFAULT 0,
                    compartment_id_min INTEGER,
                    compartment_id_max INTEGER,
                    facts_emitted INTEGER NOT NULL DEFAULT 0,
                    facts_by_category_json TEXT,
                    events_emitted INTEGER NOT NULL DEFAULT 0,
                    importance_min INTEGER,
                    importance_max INTEGER,
                    importance_avg REAL,
                    discarded_last INTEGER NOT NULL DEFAULT 0,
                    legacy INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_historian_runs_session
                    ON historian_runs(session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_historian_runs_status
                    ON historian_runs(status, created_at DESC);
            `);
        },
    },
    {
        version: 25,
        description: "pi_stable_id_scheme session_meta column (Pi message-id cutover gate)",
        up: (db: Database) => {
            // Pi-only: tracks which message stable-id scheme a session's persisted
            // tags/source_contents/caveman/placeholder state were keyed under. NULL/0
            // = legacy index-based pi-msg-* ids; >=1 = real-SessionEntry-id scheme.
            // When a session's stored scheme < PI_STABLE_ID_SCHEME, Pi forces one
            // execute+materialize cutover pass (re-tag + re-drop + placeholder
            // rediscovery) then stamps the new scheme. OpenCode never reads/writes
            // it. Guarded ADD COLUMN: session_meta already exists; SQLite sets
            // existing rows to NULL (treated as scheme 0), not the DEFAULT.
            const rows = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            if (!rows.some((row) => row.name === "pi_stable_id_scheme")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN pi_stable_id_scheme INTEGER");
            }
        },
    },
    {
        version: 26,
        description: "memory mutation log and atomic m[1] cache columns",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS memory_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    mutation_type TEXT NOT NULL CHECK (mutation_type IN (
                        'archive',
                        'delete',
                        'update',
                        'superseded'
                    )),
                    target_memory_id INTEGER NOT NULL,
                    superseded_by_id INTEGER,
                    category TEXT,
                    new_content TEXT,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
                    ON memory_mutation_log(project_path, id);
            `);
            ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
            ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_max_memory_mutation_id", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
            ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
            ensureColumn(db, "session_meta", "cached_m1_bytes", "BLOB");
            ensureColumn(db, "session_meta", "last_observed_model_key", "TEXT");
            ensureColumn(db, "session_meta", "memory_block_cache", "TEXT DEFAULT ''");
            ensureColumn(db, "session_meta", "memory_block_count", "INTEGER DEFAULT 0");
            ensureColumn(db, "session_meta", "memory_block_ids", "TEXT DEFAULT ''");
            db.prepare(
                `UPDATE session_meta SET
                    cached_m0_bytes = NULL,
                    cached_m1_bytes = NULL,
                    cached_m0_project_memory_epoch = NULL,
                    cached_m0_project_user_profile_version = NULL,
                    cached_m0_max_compartment_seq = NULL,
                    cached_m0_max_memory_id = NULL,
                    cached_m0_max_mutation_id = NULL,
                    cached_m0_max_memory_mutation_id = NULL,
                    cached_m0_project_docs_hash = NULL,
                    cached_m0_materialized_at = NULL,
                    cached_m0_session_facts_version = NULL,
                    cached_m0_upgrade_state = NULL,
                    memory_block_cache = '',
                    memory_block_count = 0,
                    memory_block_ids = ''`,
            ).run();
        },
    },
    {
        version: 27,
        description: "tags.entry_fingerprint for Pi fallback-tag adoption",
        up: (db: Database) => {
            // Pi tags the in-flight (newest) message under an unstable
            // pi-msg-${index} fallback id, then its real SessionEntry id one
            // pass later — re-tagging it and drifting its §N§ prefix. The
            // fingerprint (computed from the raw message: responseId + ts +
            // role + toolCallId + firstTextHash) lets the next pass find the
            // fallback tag and migrate its message_id in place, keeping the
            // tag_number (hence §N§ and all per-tag state) stable. Nullable:
            // OpenCode never writes it (real id on pass 1), so its rows stay
            // NULL and adoption never fires.
            //
            // Guard on the tags table existing: in production tags is created
            // (migration v1) long before this runs, but partial test fixtures
            // that stamp a mid-ladder version without a tags table must not
            // throw here (ensureColumn's ALTER + the CREATE INDEX both require
            // the table). A DB with no tags table has nothing to index.
            const hasTags = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tags' LIMIT 1")
                .get();
            if (!hasTags) return;
            ensureColumn(db, "tags", "entry_fingerprint", "TEXT");
            db.exec(
                `CREATE INDEX IF NOT EXISTS idx_tags_pi_adopt
                    ON tags(session_id, entry_fingerprint)
                    WHERE type='message' AND entry_fingerprint IS NOT NULL`,
            );
        },
    },
    {
        version: 28,
        description: "Add git commit sweep coordinator lease/cooldown table",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS git_sweep_coordinator (
                    project_path TEXT PRIMARY KEY,
                    lease_holder TEXT,
                    lease_expires_at INTEGER,
                    last_swept_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_lease_expires
                    ON git_sweep_coordinator(lease_expires_at);
                CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_last_swept
                    ON git_sweep_coordinator(last_swept_at);
            `);
        },
    },
    {
        version: 29,
        description: "Add anchor_ordinal to notes (traceback to the conversation tail)",
        up: (db: Database) => {
            // The notes table is created by migration v1, so the column add lives
            // in a migration (initializeDatabase runs before runMigrations, so an
            // ensureColumn there would precede the table on a fresh DB). Nullable:
            // pre-existing notes keep NULL, which renders without an anchor.
            //
            // Guard on table existence: in the real openDatabase flow `notes`
            // always exists by here (v1 creates it). But isolated migration
            // tests seed a partial schema at a high version (skipping v1), so a
            // bare ALTER would throw "no such table" — skip cleanly in that case.
            const notesExists = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
                .get();
            if (!notesExists) {
                return;
            }
            const columns = db.prepare("PRAGMA table_info(notes)").all() as Array<{
                name?: string;
            }>;
            if (!columns.some((column) => column.name === "anchor_ordinal")) {
                db.exec("ALTER TABLE notes ADD COLUMN anchor_ordinal INTEGER");
            }
        },
    },
    {
        version: 30,
        description: "HARD-bust m[0] markers: cached system/tool-set/model identity",
        up: (db: Database) => {
            // New persisted markers so the materialization decision can detect
            // provider-side cache-eviction events (system-block change, tools-block
            // change, model switch) and fold m[1] into m[0] "for free" when the
            // cache was already dead. Stored alongside the existing cached_m0_*
            // markers on session_meta.
            //
            // Guard on session_meta existence: in production session_meta is
            // created (migration v1) long before this runs, but partial test
            // fixtures seed a minimal schema at a high version (skipping v1), so a
            // bare ensureColumn/UPDATE would throw "no such table".
            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;
            ensureColumn(db, "session_meta", "cached_m0_system_hash", "TEXT");
            ensureColumn(db, "session_meta", "cached_m0_tool_set_hash", "TEXT");
            ensureColumn(db, "session_meta", "cached_m0_model_key", "TEXT");
            // Clear the existing m[0]/m[1] cache once: pre-v30 cached rows have no
            // HARD markers, so the new cachedRowMatchesState identity check would
            // treat them as a permanent mismatch. A one-time clear forces a clean
            // re-materialize on the first pass after upgrade (costs one bust, which
            // a restart already incurs), after which the markers populate normally.
            const columns = new Set(
                (
                    db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>
                ).map((column) => column.name),
            );
            if (columns.has("cached_m0_bytes")) {
                db.prepare(
                    `UPDATE session_meta SET
                        cached_m0_bytes = NULL,
                        cached_m1_bytes = NULL,
                        cached_m0_materialized_at = NULL,
                        cached_m0_system_hash = NULL,
                        cached_m0_tool_set_hash = NULL,
                        cached_m0_model_key = NULL`,
                ).run();
            }
        },
    },
    {
        version: 31,
        description:
            "Nudge redesign: Channel 1 cadence (last_nudge_undropped) + Channel 2 ceiling lease " +
            "(channel2_nudge_state); zero legacy ctx_reduce-nudge sticky/anchor state (startup heal)",
        up: (db: Database) => {
            // Channel 1 (in-turn tool-output nudge) cadence watermark, and Channel 2
            // (synthetic-user-message ceiling) one-shot lease state. Both replace the
            // deleted rolling/iteration/sticky ctx_reduce-nudge paths, whose persisted
            // state (sticky_turn_reminder_*, nudge_anchor_*) is now inert — no code
            // reads it — but we zero it so an upgraded session can never replay a stale
            // anchor (the Bust-B mechanism the redesign removes).
            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;
            ensureColumn(db, "session_meta", "last_nudge_undropped", "INTEGER DEFAULT 0");
            ensureColumn(db, "session_meta", "channel2_nudge_state", "TEXT DEFAULT ''");
            const columns = new Set(
                (
                    db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>
                ).map((column) => column.name),
            );
            // Startup heal: blank the retired ctx_reduce-nudge anchor columns. Guarded
            // per-column so a fixture that seeded a partial schema doesn't throw.
            if (columns.has("sticky_turn_reminder_text")) {
                db.prepare(
                    `UPDATE session_meta SET
                        sticky_turn_reminder_text = '',
                        sticky_turn_reminder_message_id = '',
                        nudge_anchor_message_id = '',
                        nudge_anchor_text = ''`,
                ).run();
            }
        },
    },
    {
        version: 32,
        description:
            "Protected tail boundary state, usage resolver fields, recovery escape, and drain quota",
        up: (db: Database) => {
            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;
            ensureColumn(
                db,
                "session_meta",
                "prior_boundary_ordinal",
                "INTEGER NOT NULL DEFAULT 1",
            );
            ensureColumn(
                db,
                "session_meta",
                "protected_tail_policy_version",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "protected_tail_drain_window_started_at",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "protected_tail_drain_tokens",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "recovery_no_eligible_head_count",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "force_emergency_bypass_window_start",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "force_emergency_bypass_used",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "last_usage_context_limit",
                "INTEGER NOT NULL DEFAULT 0",
            );
            db.prepare(
                "UPDATE session_meta SET prior_boundary_ordinal = 1 WHERE prior_boundary_ordinal IS NULL OR prior_boundary_ordinal < 1",
            ).run();
            db.prepare(
                "UPDATE session_meta SET protected_tail_policy_version = 0 WHERE protected_tail_policy_version IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET protected_tail_drain_window_started_at = 0 WHERE protected_tail_drain_window_started_at IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET protected_tail_drain_tokens = 0 WHERE protected_tail_drain_tokens IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET recovery_no_eligible_head_count = 0 WHERE recovery_no_eligible_head_count IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET force_emergency_bypass_window_start = 0 WHERE force_emergency_bypass_window_start IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET force_emergency_bypass_used = 0 WHERE force_emergency_bypass_used IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET last_usage_context_limit = 0 WHERE last_usage_context_limit IS NULL",
            ).run();
        },
    },
    {
        version: 33,
        description: "Compartment chunk embeddings for semantic message-history search",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    window_index INTEGER NOT NULL DEFAULT 0,
                    start_ordinal INTEGER NOT NULL,
                    end_ordinal INTEGER NOT NULL,
                    chunk_hash TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    dims INTEGER NOT NULL,
                    vector BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(compartment_id, window_index)
                );
                CREATE INDEX IF NOT EXISTS idx_cce_session
                    ON compartment_chunk_embeddings(session_id);
                CREATE INDEX IF NOT EXISTS idx_cce_project_model
                    ON compartment_chunk_embeddings(project_path, model_id);
            `);
        },
    },

    {
        version: 34,
        description: "workspace tables and m[0] workspace fingerprint cache reset",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workspace_members (
                    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    project_path TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    display_path TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (workspace_id, project_path)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique
                    ON workspace_members(project_path);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name
                    ON workspace_members(workspace_id, display_name);
            `);

            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;

            ensureColumn(db, "session_meta", "cached_m0_workspace_fingerprint", "TEXT");
            const columns = new Set(
                (
                    db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>
                ).map((column) => column.name),
            );
            const clears: Array<[string, string | number | null]> = [
                ["cached_m0_bytes", null],
                ["cached_m1_bytes", null],
                ["cached_m0_project_memory_epoch", null],
                ["cached_m0_workspace_fingerprint", null],
                ["cached_m0_project_user_profile_version", null],
                ["cached_m0_max_compartment_seq", null],
                ["cached_m0_max_memory_id", null],
                ["cached_m0_max_mutation_id", null],
                ["cached_m0_max_memory_mutation_id", null],
                ["cached_m0_project_docs_hash", null],
                ["cached_m0_materialized_at", null],
                ["cached_m0_session_facts_version", null],
                ["cached_m0_upgrade_state", null],
                ["cached_m0_system_hash", null],
                ["cached_m0_tool_set_hash", null],
                ["cached_m0_model_key", null],
                ["cached_m0_last_baseline_end_message_id", null],
                ["memory_block_cache", ""],
                ["memory_block_ids", ""],
                ["memory_block_count", 0],
            ];
            const setClauses: string[] = [];
            const values: Array<string | number | null> = [];
            for (const [column, value] of clears) {
                if (!columns.has(column)) continue;
                setClauses.push(`${column} = ?`);
                values.push(value);
            }
            if (setClauses.length > 0) {
                db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")}`).run(...values);
            }
        },
    },

    {
        version: 35,
        description: "workspace per-category share defaults and epoch refresh",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
                );
            `);
            if (!columnExists(db, "workspaces", "share_categories")) {
                db.exec(
                    `ALTER TABLE workspaces ADD COLUMN share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'`,
                );
            }
            db.prepare(
                `UPDATE workspaces
                    SET share_categories = '["CONSTRAINTS"]'
                  WHERE share_categories IS NULL OR share_categories = ''`,
            ).run();

            if (!tableExists(db, "workspace_members")) return;
            const rows = db
                .prepare(
                    `SELECT DISTINCT project_path AS identity
                       FROM workspace_members
                      WHERE project_path IS NOT NULL AND project_path <> ''
                      ORDER BY project_path ASC`,
                )
                .all() as Array<{ identity?: unknown }>;
            const identities = rows
                .map((row) => (typeof row.identity === "string" ? row.identity : ""))
                .filter((identity) => identity.length > 0);
            if (identities.length > 0) {
                bumpEpochsForWorkspaceMemberSet(db, identities, Date.now());
            }
        },
    },

    {
        version: 36,
        description: "session project ownership map for compartment chunk backfill scoping",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS session_projects (
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    project_path TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, harness)
                );
                CREATE INDEX IF NOT EXISTS idx_session_projects_project
                    ON session_projects(project_path);
            `);
            // Seed ownership for sessions that were ALREADY chunk-embedded before
            // this table existed, so their compartments stay visible to the
            // project-scoped backfill/count JOINs (a fresh table would otherwise
            // hide every pre-v36 embedded session until re-observed). The only
            // trustworthy pre-existing source is compartment_chunk_embeddings
            // itself, which already carries (session_id, harness, project_path).
            // NOTE: compartments has no project_path column — do not read from it.
            // Seed ONLY unambiguous sessions (a single distinct project_path);
            // skip any session whose chunks are split across projects (the
            // pre-scope bug) so the heal path, not a coin-flip, decides its owner.
            // Guarded on the source table existing — it is created at v33, so any
            // real upgrade has it, but a partial/older fixture might not.
            const hasChunkTable = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='compartment_chunk_embeddings'",
                )
                .get();
            if (hasChunkTable) {
                db.exec(`
                    INSERT OR IGNORE INTO session_projects (session_id, harness, project_path, updated_at)
                    SELECT session_id, harness, MIN(project_path), 0
                    FROM compartment_chunk_embeddings
                    GROUP BY session_id, harness
                    HAVING COUNT(DISTINCT project_path) = 1;
                `);
            }
        },
    },

    {
        version: 37,
        description: "Add skill_memory table for per-skill cross-session recall",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS skill_memory (
                  id              INTEGER PRIMARY KEY AUTOINCREMENT,
                  skill_id        TEXT NOT NULL,
                  resolved_path   TEXT NOT NULL,
                  tier            TEXT NOT NULL CHECK(tier IN ('project', 'global')),
                  skill_source    TEXT CHECK(skill_source IN (
                                    'opencode-project', 'opencode-global',
                                    'claude-skills', 'agents-skills'
                                  )),
                  project_identity TEXT NOT NULL,
                  intent          TEXT NOT NULL,
                  intent_embedding BLOB,
                  embedding_model_version TEXT,
                  kind            TEXT NOT NULL CHECK(kind IN ('gotcha', 'discovery', 'fix', 'workflow')),
                  delta           TEXT NOT NULL,
                  tags            TEXT,
                  hit_count       INTEGER NOT NULL DEFAULT 0,
                  pinned          INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
                  normalized_hash TEXT NOT NULL,
                  created_at      INTEGER NOT NULL,
                  last_used_at    INTEGER,
                  UNIQUE(skill_id, tier, project_identity, normalized_hash)
                );

                CREATE INDEX IF NOT EXISTS idx_skill_memory_lookup
                  ON skill_memory(skill_id, tier, project_identity, last_used_at DESC);

                CREATE INDEX IF NOT EXISTS idx_skill_memory_fts_prep
                  ON skill_memory(skill_id, tier, project_identity, kind);
            `);
        },
    },

    {
        // Was v31 on the pre-v0.23 external-memory-backend branch; renumbered
        // to v33 pre-v0.24-rebase, then to v37 when upstream v0.24 shipped its
        // own v33/34/35/36, then to v38 when skill_memory took v37.
        // The body is ensureColumn-idempotent, so a dev DB that already ran it
        // under an old number re-applies harmlessly.
        version: 38,
        description: "External memory v2: session recall snapshot + m[0] recall marker",
        up: (db: Database) => {
            // session_meta existence guard — see v30's comment (partial test fixtures).
            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;
            // Per-session external recall snapshot (post-dedup, post-trim) — the
            // frozen content every render replays for byte stability.
            ensureColumn(db, "session_meta", "external_recall_json", "TEXT");
            ensureColumn(db, "session_meta", "external_recall_state", "TEXT");
            ensureColumn(db, "session_meta", "external_recall_at", "INTEGER");
            // m[0] marker: hash of the external content baked into the cached m[0]
            // ('' = none). NOT a mustMaterialize trigger — drives only the m[1]
            // <external-memory> delta comparison. No cache-clear needed: the
            // cachedRowMatchesState comparison normalizes NULL and '' to equal.
            ensureColumn(db, "session_meta", "cached_m0_external_recall_hash", "TEXT");
        },
    },
    {
        version: 39,
        description: "Skill-memory P2: delta_embedding column + skill_memory_fts FTS5 vtable",
        up: (db: Database) => {
            // skill_memory is migration-only (created by v37); ALTER is safe here.
            if (!columnExists(db, "skill_memory", "delta_embedding")) {
                db.exec(`ALTER TABLE skill_memory ADD COLUMN delta_embedding BLOB;`);
            }

            // FTS5 over (intent, delta), content-linked to skill_memory — mirrors memories_fts.
            db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS skill_memory_fts USING fts5(
                  intent,
                  delta,
                  content='skill_memory',
                  content_rowid='id',
                  tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS skill_memory_ai AFTER INSERT ON skill_memory BEGIN
                  INSERT INTO skill_memory_fts(rowid, intent, delta) VALUES (new.id, new.intent, new.delta);
                END;

                CREATE TRIGGER IF NOT EXISTS skill_memory_ad AFTER DELETE ON skill_memory BEGIN
                  INSERT INTO skill_memory_fts(skill_memory_fts, rowid, intent, delta) VALUES ('delete', old.id, old.intent, old.delta);
                END;

                CREATE TRIGGER IF NOT EXISTS skill_memory_au AFTER UPDATE ON skill_memory BEGIN
                  INSERT INTO skill_memory_fts(skill_memory_fts, rowid, intent, delta) VALUES ('delete', old.id, old.intent, old.delta);
                  INSERT INTO skill_memory_fts(rowid, intent, delta) VALUES (new.id, new.intent, new.delta);
                END;
            `);

            // Backfill the FTS index for any existing skill_memory rows. External-content FTS5 tables
            // expose content rowids immediately, so a `NOT IN (SELECT rowid FROM …_fts)` guard is a no-op;
            // the 'rebuild' command is the correct way to (re)populate an external-content index.
            db.exec(`INSERT INTO skill_memory_fts(skill_memory_fts) VALUES('rebuild');`);
        },
    },
];

/**
 * Highest version in the MIGRATIONS array. `LATEST_SUPPORTED_VERSION` in
 * storage-db.ts (the schema-fence ceiling) MUST equal this — a stale ceiling
 * makes the DB refuse to open after the new migration applies (a real bug the
 * project hit during v2 work). A unit test asserts the two stay in lockstep.
 */
export const LATEST_MIGRATION_VERSION: number = MIGRATIONS.reduce(
    (max, m) => Math.max(max, m.version),
    0,
);

function ensureMigrationsTable(db: Database): void {
    db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			description TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		)
	`);
}

function getCurrentVersion(db: Database): number {
    const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as {
        version: number | null;
    } | null;
    return row?.version ?? 0;
}

/**
 * Detect the specific case where a sibling process already committed the
 * same `schema_migrations` row we're about to insert. Two OpenCode/Pi
 * instances starting concurrently can both read `MAX(version)=N` before
 * either commits. The first commits v(N+1); the second's transaction body
 * runs `migration.up()` (a no-op now that the schema change already
 * landed), then hits PRIMARY KEY conflict on the
 * `INSERT INTO schema_migrations` row.
 *
 * Without this guard the plugin fail-closes and the second instance
 * refuses to start. With it, we recognize "sibling beat us to it",
 * re-read the version, and continue from the next pending migration.
 *
 * Important: only PRIMARY KEY conflicts on `schema_migrations` are
 * swallowed. Any other failure (CREATE TABLE, ALTER TABLE, data heal,
 * etc.) surfaces normally and fail-closes per contract.
 */
export function isSiblingMigrationConflict(db: Database, error: unknown, version: number): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: unknown }).code;
    if (code !== "SQLITE_CONSTRAINT_PRIMARYKEY" && code !== "SQLITE_CONSTRAINT_UNIQUE") {
        return false;
    }
    // Distinguish "PRIMARY KEY conflict on schema_migrations(version)"
    // from any other UNIQUE/PK collision the migration body could surface.
    // SQLite's better-sqlite3 binding includes the constraint in the
    // message, e.g. "UNIQUE constraint failed: schema_migrations.version".
    const msg = error.message;
    if (!msg.includes("schema_migrations")) return false;
    if (!msg.toLowerCase().includes("version")) return false;
    // Final guard: confirm the row is actually present now. If something
    // else somehow produced this error shape without the row landing, we
    // want to fall through to fail-closed.
    const confirmed = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
    return confirmed != null;
}

/**
 * Run all pending migrations sequentially.
 * Each migration runs in its own transaction — if it fails, only that migration rolls back.
 * Already-applied migrations are skipped.
 *
 * Multi-instance race tolerance: when two plugin processes start against
 * the same shared DB, both can read the same MAX(version) before either
 * commits. The first wins; the second's INSERT into schema_migrations
 * fails with a PRIMARY KEY conflict. We catch that specific case and
 * resume from the next pending migration. All other migration errors
 * still fail-close per the existing contract.
 */
export function runMigrations(db: Database): void {
    ensureMigrationsTable(db);

    let currentVersion = getCurrentVersion(db);
    let pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
        return;
    }

    log(
        `[migrations] current schema version: ${currentVersion}, applying ${pendingMigrations.length} migration(s)`,
    );

    let migrationIndex = 0;
    while (migrationIndex < pendingMigrations.length) {
        const migration = pendingMigrations[migrationIndex];
        try {
            db.transaction(() => {
                migration.up(db);
                db.prepare(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                ).run(migration.version, migration.description, Date.now());
            })();
            log(`[migrations] applied v${migration.version}: ${migration.description}`);
            migrationIndex += 1;
        } catch (error) {
            if (isSiblingMigrationConflict(db, error, migration.version)) {
                // Sibling process committed this version between our
                // MAX(version) read and our INSERT. Re-read the version
                // and rebuild the pending list — the sibling may have
                // applied multiple migrations while we were preparing
                // this one.
                log(
                    `[migrations] v${migration.version} already applied by sibling instance — resuming with re-read version`,
                );
                const reReadVersion = getCurrentVersion(db);
                if (reReadVersion <= currentVersion) {
                    // Defensive: sibling-conflict shape detected but
                    // version didn't actually advance. Treat as a real
                    // failure to avoid an infinite loop on a malformed
                    // error.
                    log(
                        `[migrations] FAILED v${migration.version}: sibling-conflict shape but version not advanced (${reReadVersion} <= ${currentVersion}) — failing closed`,
                    );
                    throw new Error(
                        `Migration v${migration.version} failed: sibling conflict reported but version did not advance. Database may need manual repair.`,
                    );
                }
                currentVersion = reReadVersion;
                pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);
                migrationIndex = 0;
                continue;
            }
            log(
                `[migrations] FAILED v${migration.version}: ${migration.description} — ${error instanceof Error ? error.message : String(error)}`,
            );
            throw new Error(
                `Migration v${migration.version} failed: ${error instanceof Error ? error.message : String(error)}. Database may need manual repair.`,
            );
        }
    }

    log(`[migrations] schema version now: ${MIGRATIONS[MIGRATIONS.length - 1].version}`);
}
