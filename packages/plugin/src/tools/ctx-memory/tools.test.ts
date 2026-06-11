import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import {
    getMemoriesByProject,
    getMemoryById,
    getMemoryMutationsForRender,
    getProjectState,
    insertMemory,
    normalizeStoredProjectPath,
} from "../../features/magic-context";
import {
    _resetExternalMemoryForTests,
    _setTestExternalBackendFactory,
    initializeExternalMemory,
} from "../../features/magic-context/memory/external-memory";
import type {
    ExternalMemoryBackend,
    ExternalMemoryRemoveItem,
    ExternalMemoryRetainItem,
} from "../../features/magic-context/memory/external-memory-provider";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

mock.module("../../features/magic-context/memory/embedding", () => ({
    embedText: async (_text: string) => null,
    isEmbeddingEnabled: () => true,
    getEmbeddingModelId: () => "mock:model",
}));

const { createCtxMemoryTools } = await import("./tools");

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE IF NOT EXISTS memories
        (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path            TEXT    NOT NULL,
            category                TEXT    NOT NULL,
            content                 TEXT    NOT NULL,
            normalized_hash         TEXT    NOT NULL,
            source_session_id       TEXT,
            source_type             TEXT    DEFAULT 'historian',
            seen_count              INTEGER DEFAULT 1,
            retrieval_count         INTEGER DEFAULT 0,
            first_seen_at           INTEGER NOT NULL,
            created_at              INTEGER NOT NULL,
            updated_at              INTEGER NOT NULL,
            last_seen_at            INTEGER NOT NULL,
            last_retrieved_at       INTEGER,
            status                  TEXT    DEFAULT 'active',
            expires_at              INTEGER,
            verification_status     TEXT    DEFAULT 'unverified',
            verified_at             INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from             TEXT,
            metadata_json           TEXT,
            UNIQUE (project_path, category, normalized_hash)
        );

        CREATE TABLE IF NOT EXISTS memory_embeddings
        (
            memory_id INTEGER PRIMARY KEY REFERENCES memories (id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id  TEXT
        );

        CREATE TABLE IF NOT EXISTS project_state
        (
            project_path                 TEXT PRIMARY KEY,
            project_memory_epoch         INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at                   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_mutation_log
        (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path     TEXT NOT NULL,
            mutation_type    TEXT NOT NULL,
            target_memory_id INTEGER NOT NULL,
            superseded_by_id INTEGER,
            category         TEXT,
            new_content      TEXT,
            queued_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
            ON memory_mutation_log(project_path, id);

        CREATE TABLE IF NOT EXISTS workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            share_categories TEXT
        );

        CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            project_path TEXT NOT NULL,
            display_name TEXT NOT NULL,
            display_path TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, project_path)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(project_path);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name ON workspace_members(workspace_id, display_name);

        CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
            old_project_path TEXT PRIMARY KEY,
            new_project_path TEXT NOT NULL,
            rekeyed_at INTEGER NOT NULL
        );

        CREATE
        VIRTUAL
        TABLE IF
        NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
        END;
    `);
    return db;
}

const toolContext = (sessionID = "ses-memory", agent = "general") =>
    ({ sessionID, agent, directory: "/repo/project" }) as never;

function getProjectMemoryEpoch(db: Database, projectPath: string): number {
    return getProjectState(db, normalizeStoredProjectPath(projectPath))?.projectMemoryEpoch ?? 0;
}

function getMutationRows(db: Database, projectPath: string, renderedMemoryIds: number[]) {
    return getMemoryMutationsForRender(
        db,
        normalizeStoredProjectPath(projectPath),
        0,
        renderedMemoryIds,
    );
}

const HINDSIGHT_TEST_CONFIG = {
    provider: "hindsight" as const,
    endpoint: "http://10.0.0.1:8889",
    project_bank: "mc-{name}-{id8}",
    main_bank: "main-memory",
    retain_sources: ["historian", "agent", "dreamer"] as ("historian" | "agent" | "dreamer")[],
    tags: [] as string[],
    recall: {
        enabled: true,
        timeout_ms: 3000,
        max_tokens: 2048,
        dedup_threshold: 0.85,
        global_tags: [] as string[],
        global_from_prompt: false,
        search: true,
        mental_models: false,
        profile_mental_models: ["user-preferences"],
    },
};

interface ExternalBackendCapture {
    retains: ExternalMemoryRetainItem[][];
    removes: ExternalMemoryRemoveItem[][];
}

function captureBackend(): ExternalBackendCapture {
    const capture: ExternalBackendCapture = { retains: [], removes: [] };
    _setTestExternalBackendFactory(
        (): ExternalMemoryBackend => ({
            backendId: "fake:test",
            initialize: async () => true,
            retain: async (items) => {
                capture.retains.push([...items]);
                return items.length;
            },
            remove: async (items) => {
                capture.removes.push([...items]);
                return items.length;
            },
            dispose: async () => {},
        }),
    );
    initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
    return capture;
}

function captureTee(): ExternalMemoryRetainItem[][] {
    return captureBackend().retains;
}

afterAll(() => {
    mock.restore();
});

describe("createCtxMemoryTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxMemoryTools>;

    beforeEach(() => {
        db = createTestDb();
        tools = createCtxMemoryTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
        });
    });

    afterEach(() => {
        closeQuietly(db);
        _resetExternalMemoryForTests();
    });

    describe("#given write action", () => {
        it("creates a new memory with agent source type", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Always run bun test before shipping.",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(result).toContain("Saved memory [ID:");
            expect(memories).toHaveLength(1);
            expect(memories[0]?.sourceType).toBe("agent");
            expect(memories[0]?.sourceSessionId).toBe("ses-memory");
            expect(memories[0]?.category).toBe("USER_DIRECTIVES");
        });

        it("does not bump project memory epoch for additive writes", async () => {
            const identity = normalizeStoredProjectPath("/repo/project");

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Prefer compact diffs.",
                },
                toolContext(),
            );

            expect(result).toContain("Saved memory");
            expect(getProjectState(db, identity)).toBeNull();
        });

        it("returns error when content is missing", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("'content' is required");
        });

        it("returns error when category is missing", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "Remember this.",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("'category' is required");
        });

        it("returns error for unknown category", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "UNKNOWN_CATEGORY",
                    content: "Remember this.",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("Unknown memory category");
        });

        it("always uses project scope for writes", async () => {
            await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_PREFERENCES",
                    content: "Keep answers dense.",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(memories).toHaveLength(1);
            expect(memories[0]?.projectPath).toBe("/repo/project");
        });

        it("tees to external backend with project scope", async () => {
            const calls = captureTee();

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "agent fact",
                    category: "ARCHITECTURE",
                },
                toolContext(),
            );

            expect(result).toContain("Saved memory");
            await Bun.sleep(10);

            expect(calls.length).toBe(1);
            expect(calls[0]?.[0]).toMatchObject({
                content: "agent fact",
                category: "ARCHITECTURE",
                scope: "project",
                sourceType: expect.any(String),
            });
        });

        it("scope 'global' tees to the main bank with NO local row, carrying origin provenance", async () => {
            const calls = captureTee();

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "Homelab reverse proxy lives on 10.1.1.5 (caddy).",
                    category: "ARCHITECTURE",
                    scope: "global",
                },
                toolContext(),
            );
            await Bun.sleep(10);

            expect(result).toContain("Queued global memory");
            expect(result).not.toContain("Saved memory [ID:");
            // No local row — globals live only in the external store.
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
            expect(calls.length).toBe(1);
            // Origin provenance rides along (origin-* tags + context at the
            // engine layer) while scope stays "global" → main-bank routing.
            expect(calls[0]?.[0]).toMatchObject({
                content: "Homelab reverse proxy lives on 10.1.1.5 (caddy).",
                category: "ARCHITECTURE",
                scope: "global",
                projectIdentity: "/repo/project",
            });
        });

        it("scope 'global' errors (and stays local-row-free) when no external backend is configured", async () => {
            // No captureBackend() call → provider stays "off".
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "orphan global fact",
                    category: "ARCHITECTURE",
                    scope: "global",
                },
                toolContext(),
            );

            expect(result).toContain("Error: scope 'global' requires an external memory backend");
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
        });

        it("scope 'project' (explicit) behaves exactly like the default", async () => {
            const calls = captureTee();

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "explicit project fact",
                    category: "ARCHITECTURE",
                    scope: "project",
                },
                toolContext(),
            );
            await Bun.sleep(10);

            expect(result).toContain("Saved memory [ID:");
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(1);
            expect(calls[0]?.[0]).toMatchObject({ scope: "project" });
        });

        it("does NOT tee when memory already exists", async () => {
            const calls = captureTee();

            await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "dup",
                    category: "ARCHITECTURE",
                },
                toolContext(),
            );
            await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "dup",
                    category: "ARCHITECTURE",
                },
                toolContext(),
            );
            await Bun.sleep(10);

            expect(calls.length).toBe(1);
        });
    });

    describe("#given archive action by a PRIMARY agent", () => {
        // archive is now a primary action (it replaced the redundant `delete`
        // alias). A primary agent — no DREAMER_AGENT context — must be able to
        // soft-remove a memory it sees in the injected project-memory block.
        it("archives the memory by ID", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy parser fails on malformed XML.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id] },
                toolContext(),
            );
            const updated = getMemoryById(db, memory.id);

            expect(result).toContain("Archived memory");
            expect(updated?.status).toBe("archived");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                { mutationType: "archive", targetMemoryId: memory.id },
            ]);
        });

        it("archives a batch of memories in one call, all-or-nothing", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale issue one.",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale issue two.",
            });

            const batch = await tools.ctx_memory.execute(
                { action: "archive", ids: [first.id, second.id], reason: "obsolete" },
                toolContext(),
            );
            expect(batch).toContain(`Archived memories [ID: ${first.id}, ${second.id}]`);
            expect(getMemoryById(db, first.id)?.status).toBe("archived");
            expect(getMemoryById(db, second.id)?.status).toBe("archived");

            // A bad id anywhere in the batch must archive NOTHING.
            const third = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Still active.",
            });
            const failed = await tools.ctx_memory.execute(
                { action: "archive", ids: [third.id, 99_999] },
                toolContext(),
            );
            expect(failed).toContain("Error");
            expect(getMemoryById(db, third.id)?.status).toBe("active");
        });

        it("rejects archived memories with the same inactive-memory error used by update and merge", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Already curated away.",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [archived.id] },
                toolContext(),
            );

            expect(result).toContain("restore it before archiving");
            expect(getMemoryById(db, archived.id)?.status).toBe("archived");
            expect(getMutationRows(db, "/repo/project", [archived.id])).toHaveLength(0);
        });

        it("rejects a non-integer archive id without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Still active.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id, memory.id + 0.5] },
                toolContext(),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        });

        it("rejects malformed archive ids without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Malformed id should not archive this.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id, memory.id + 0.5] },
                toolContext(),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        });

        it("returns error when ID is missing", async () => {
            const result = await tools.ctx_memory.execute({ action: "archive" }, toolContext());

            expect(result).toContain("Error");
            expect(result).toContain("'ids' must contain at least one integer memory ID");
        });

        it("returns error when memory not found", async () => {
            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [999] },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("was not found");
        });
    });

    describe("#given list action", () => {
        it("returns a formatted memory table", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before shipping.",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Do not use npm in this repo.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "list", limit: 10 },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Found 2 active memories");
            expect(result).toContain("CATEGORY");
            expect(result).toContain("Always run bun test before shipping.");
            expect(result).toContain("Do not use npm in this repo.");
        });
    });

    it("archives a foreign workspace memory under the target identity", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const memory = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "KNOWN_ISSUES",
            content: "Foreign issue is visible through workspace.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [memory.id] },
            toolContext(),
        );

        expect(result).toContain("Archived memory");
        expect(getMemoryById(db, memory.id)?.status).toBe("archived");
        expect(getMemoryMutationsForRender(db, "/repo/foreign", 0, [memory.id])).toHaveLength(1);
    });

    it("REFUSES to archive a foreign memory in a NON-shared category", async () => {
        // Workspace shares only CONSTRAINTS. A foreign member's ARCHITECTURE
        // memory is invisible in the render — the tool must not mutate it either.
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "ARCHITECTURE",
            content: "Foreign architecture detail not shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [foreignHidden.id] },
            toolContext(),
        );

        expect(result).not.toContain("Archived memory");
        expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
    });

    it("still archives a foreign memory in a SHARED category", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign constraint shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [foreignShared.id] },
            toolContext(),
        );

        expect(result).toContain("Archived memory");
        expect(getMemoryById(db, foreignShared.id)?.status).toBe("archived");
    });

    it("always allows mutating OWN-project memory regardless of share categories", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE", // own project, non-shared category — still mutable
            content: "Own architecture detail.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [own.id] },
            toolContext(),
        );

        expect(result).toContain("Archived memory");
        expect(getMemoryById(db, own.id)?.status).toBe("archived");
    });

    it("REFUSES a PRIMARY merge that pulls in a foreign memory in a NON-shared category", async () => {
        // merge MUST gate on the same own/foreign-by-category visibility as
        // update/archive: a primary agent cannot consolidate a foreign member's
        // memory it can't even see in its rendered context.
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE",
            content: "Own architecture detail A.",
        });
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "ARCHITECTURE",
            content: "Foreign architecture detail not shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignHidden.id],
                content: "Merged architecture detail.",
                category: "ARCHITECTURE",
            },
            toolContext(),
        );

        expect(result).toContain(`Memory with ID ${foreignHidden.id} was not found`);
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
    });

    it("allows a PRIMARY merge of a foreign memory in a SHARED category", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONSTRAINTS",
            content: "Own constraint A.",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign constraint shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignShared.id],
                content: "Merged shared constraint.",
                category: "CONSTRAINTS",
            },
            toolContext(),
        );

        expect(result).not.toContain("was not found");
        expect(getMemoryById(db, own.id)?.status).toBe("archived");
        expect(getMemoryById(db, foreignShared.id)?.status).toBe("archived");
    });

    describe("#given update action", () => {
        it("updates a foreign workspace memory with duplicate checks and mutations under the target identity", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Use the shared formatter.",
            });
            const foreign = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "USER_DIRECTIVES",
                content: "Old foreign directive.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [foreign.id],
                    content: "Use the shared formatter.",
                },
                toolContext(),
            );

            expect(result).toContain(`Updated memory [ID: ${foreign.id}]`);
            expect(getMemoryById(db, foreign.id)?.content).toBe("Use the shared formatter.");
            const ownMutations = getMemoryMutationsForRender(db, "/repo/project", 0, [foreign.id]);
            const foreignMutations = getMemoryMutationsForRender(db, "/repo/foreign", 0, [
                foreign.id,
            ]);
            expect(ownMutations).toHaveLength(0);
            expect(foreignMutations).toHaveLength(1);
            expect(foreignMutations[0]?.projectPath).toBe("/repo/foreign");
        });

        it("updates memory content and invalidates stale embeddings", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`Updated memory [ID: ${memory.id}]`);
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=10m");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                {
                    mutationType: "update",
                    targetMemoryId: memory.id,
                    category: "CONFIG_DEFAULTS",
                    newContent: "cache_ttl=10m",
                },
            ]);
        });

        it("normalizes legacy raw project paths before queueing the mutation", async () => {
            const rawProjectPath = "/legacy/raw-project";
            const projectIdentity = normalizeStoredProjectPath(rawProjectPath);
            const legacyTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => projectIdentity,
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            const memory = insertMemory(db, {
                projectPath: rawProjectPath,
                category: "CONFIG_DEFAULTS",
                content: "timeout=5s",
            });

            const result = await legacyTools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "timeout=10s",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`Updated memory [ID: ${memory.id}]`);
            expect(getProjectState(db, projectIdentity)).toBeNull();
            expect(getProjectState(db, rawProjectPath)).toBeNull();
            expect(getMutationRows(db, projectIdentity, [memory.id])).toMatchObject([
                { mutationType: "update", targetMemoryId: memory.id, newContent: "timeout=10s" },
            ]);
        });

        it("rejects malformed update ids without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id + 0.5],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
        });

        it("rejects archived or superseded memories for primary-agent update", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(memory.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toBe(
                `Error: Memory with ID ${memory.id} is archived or superseded; restore it before updating.`,
            );
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
            expect(getMemoryById(db, memory.id)?.status).toBe("archived");
        });

        it("rolls back content updates when queueing the mutation fails", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            db.exec("DROP TABLE memory_mutation_log");

            let thrown: unknown;
            try {
                await tools.ctx_memory.execute(
                    {
                        action: "update",
                        ids: [memory.id],
                        content: "cache_ttl=10m",
                    },
                    toolContext("ses-dreamer", DREAMER_AGENT),
                );
            } catch (error) {
                thrown = error;
            }

            expect(String(thrown)).toContain("memory_mutation_log");
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
        });
    });

    describe("#given merge action", () => {
        it("creates a canonical merged memory and archives source memories", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts in this repo",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Merged memories");
            const activeMemories = getMemoriesByProject(db, "/repo/project");
            expect(activeMemories).toHaveLength(1);
            expect(activeMemories[0]?.content).toBe("Use bun for all scripts in this repository.");
            expect(getMemoryById(db, first.id)?.status).toBe("archived");
            expect(getMemoryById(db, second.id)?.status).toBe("archived");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [first.id, second.id])).toMatchObject([
                {
                    mutationType: "superseded",
                    targetMemoryId: first.id,
                    supersededById: activeMemories[0]?.id,
                },
                {
                    mutationType: "superseded",
                    targetMemoryId: second.id,
                    supersededById: activeMemories[0]?.id,
                },
            ]);
        });

        it("queues an update row when an existing canonical memory content changes", async () => {
            const canonical = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const duplicate = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [canonical.id, duplicate.id],
                    content: "USE BUN FOR SCRIPTS",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`canonical memory [ID: ${canonical.id}]`);
            expect(getMemoryById(db, canonical.id)?.content).toBe("USE BUN FOR SCRIPTS");
            expect(
                getMutationRows(db, "/repo/project", [canonical.id, duplicate.id]),
            ).toMatchObject([
                {
                    mutationType: "superseded",
                    targetMemoryId: duplicate.id,
                    supersededById: canonical.id,
                },
                {
                    mutationType: "update",
                    targetMemoryId: canonical.id,
                    newContent: "USE BUN FOR SCRIPTS",
                },
            ]);
        });

        it("rejects a PRIMARY-agent merge that includes another project's memory", async () => {
            const own = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const foreign = insertMemory(db, {
                projectPath: "/repo/other-project",
                category: "CONSTRAINTS",
                content: "Use bun for build scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [own.id, foreign.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-primary", "general"),
            );

            // Cross-identity merge is dreamer-only; a primary agent must not
            // be able to mutate another project's memories. Same opaque
            // "not found" reply as update/archive (no existence oracle).
            expect(result).toBe(`Error: Memory with ID ${foreign.id} was not found.`);
            expect(getMemoryById(db, own.id)?.status).toBe("active");
            expect(getMemoryById(db, foreign.id)?.status).toBe("active");
            expect(getMutationRows(db, "/repo/other-project", [foreign.id])).toHaveLength(0);
        });

        it("rejects archived or superseded memories for primary-agent merge", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const active = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [archived.id, active.id],
                    content: "Use bun for scripts",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toBe(
                `Error: Memory with ID ${archived.id} is archived or superseded; restore it before merging.`,
            );
            expect(getMemoryById(db, archived.id)?.status).toBe("archived");
            expect(getMemoryById(db, active.id)?.status).toBe("active");
        });

        it("keeps dreamer able to curate archived memories during merge", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const active = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [archived.id, active.id],
                    content: "Use bun for scripts",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`canonical memory [ID: ${archived.id}]`);
            expect(getMemoryById(db, archived.id)?.status).toBe("active");
            expect(getMemoryById(db, active.id)?.status).toBe("archived");
        });

        it("rejects malformed or duplicate merge ids", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for tests",
            });

            const malformed = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id + 0.5],
                    content: "Use bun for all scripts.",
                },
                toolContext("ses-primary", "general"),
            );
            const duplicate = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, first.id],
                    content: "Use bun for scripts.",
                },
                toolContext("ses-primary", "general"),
            );

            expect(malformed).toContain("integer memory IDs");
            expect(duplicate).toContain("distinct memory IDs");
            expect(getMemoryById(db, first.id)?.status).toBe("active");
            expect(getMemoryById(db, second.id)?.status).toBe("active");
        });

        it("queues superseded rows under each affected project identity when merging across identities", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            const third = insertMemory(db, {
                projectPath: "/repo/project-b",
                category: "CONSTRAINTS",
                content: "Use bun for build scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id, third.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Merged memories");
            expect(getProjectMemoryEpoch(db, "/repo/project-a")).toBe(0);
            expect(getProjectMemoryEpoch(db, "/repo/project-b")).toBe(0);
            expect(getMutationRows(db, "/repo/project-a", [first.id, second.id])).toMatchObject([
                { mutationType: "superseded", targetMemoryId: first.id },
                { mutationType: "superseded", targetMemoryId: second.id },
            ]);
            expect(getMutationRows(db, "/repo/project-b", [third.id])).toMatchObject([
                { mutationType: "superseded", targetMemoryId: third.id },
            ]);
        });
    });

    describe("#given archive action", () => {
        it("archives the memory and stores the archive reason in metadata", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Old issue entry",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    ids: [memory.id],
                    reason: "Removed subsystem no longer exists",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Archived memory");
            expect(getMemoryById(db, memory.id)?.metadataJson).toContain(
                "Removed subsystem no longer exists",
            );
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                { mutationType: "archive", targetMemoryId: memory.id },
            ]);
        });
    });

    describe("#given disabled memory", () => {
        it("returns disabled message for all actions", async () => {
            const disabledTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
            });

            const results = await Promise.all([
                disabledTools.ctx_memory.execute(
                    { action: "write", category: "USER_DIRECTIVES", content: "x" },
                    toolContext(),
                ),
                disabledTools.ctx_memory.execute({ action: "archive", ids: [1] }, toolContext()),
            ]);

            expect(results).toEqual([
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
            ]);
        });
    });

    describe("#given restricted actions", () => {
        // Primary set = write/archive/update/merge. Only `list` is dreamer-only.
        const PRIMARY_ACTIONS = ["write", "archive", "update", "merge"] as const;

        it("rejects sidekick ctx_memory calls even if the tool is exposed", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Sidekick should not be able to write this.",
                },
                toolContext("ses-sidekick", SIDEKICK_AGENT),
            );

            expect(result).toBe("Error: ctx_memory is not available to the sidekick agent.");
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
        });

        it("keeps the dreamer-only `list` action in the schema so OpenCode can deliver it to execute", () => {
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const actionSchema = primaryTools.ctx_memory.args.action as unknown as {
                safeParse: (value: unknown) => { success: boolean };
            };

            // The shared schema must still accept `list` (the runtime gate, not
            // the schema, blocks it for primary agents).
            expect(actionSchema.safeParse("list").success).toBe(true);
            expect(actionSchema.safeParse("merge").success).toBe(true);
        });

        it("rejects the dreamer-only `list` action for primary-agent tool instances", async () => {
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const result = await primaryTools.ctx_memory.execute({ action: "list" }, toolContext());

            expect(result).toContain("not allowed");
        });

        it("allows primary agents to use archive/update/merge (no longer dreamer-only)", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale fact the agent spotted mid-session.",
            });
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            // archive by a primary agent (no dreamer context) must succeed.
            const result = await primaryTools.ctx_memory.execute(
                { action: "archive", ids: [memory.id] },
                toolContext(),
            );

            expect(result).toContain("Archived memory");
        });

        it("allows dreamer sessions to use the dreamer-only `list` action on the shared tool", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Keep replies concise.",
            });
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const result = await primaryTools.ctx_memory.execute(
                { action: "list" },
                toolContext("ses-dream", "dreamer"),
            );

            expect(result).toContain("Found 1 active memory");
        });
    });

    describe("#given corrective propagation to external backend", () => {
        function extractMemoryId(result: string): number {
            const match = result.match(/\[ID:\s*(\d+)\]/);
            if (!match) throw new Error(`could not parse memory id from: ${result}`);
            return Number.parseInt(match[1]!, 10);
        }

        it("batch archive propagates ONE batched remove covering every archived row", async () => {
            const capture = captureBackend();
            const firstId = extractMemoryId(
                await tools.ctx_memory.execute(
                    { action: "write", category: "ARCHITECTURE", content: "doomed fact" },
                    toolContext(),
                ),
            );
            const secondId = extractMemoryId(
                await tools.ctx_memory.execute(
                    { action: "write", category: "ARCHITECTURE", content: "second doomed fact" },
                    toolContext(),
                ),
            );

            const archiveResult = await tools.ctx_memory.execute(
                { action: "archive", ids: [firstId, secondId] },
                toolContext(),
            );

            expect(archiveResult).toContain("Archived memories");
            await Bun.sleep(10);
            // ONE batched remove call carrying BOTH pre-mutation rows.
            expect(capture.removes.length).toBe(1);
            const removed = capture.removes[0] ?? [];
            expect(removed.map((item) => item.content).sort()).toEqual([
                "doomed fact",
                "second doomed fact",
            ]);
            expect(removed.every((item) => item.scope === "project")).toBe(true);
        });

        it("archive action propagates remove to external backend", async () => {
            const capture = captureBackend();
            const writeResult = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "PROJECT_RULES",
                    content: "stale fact",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );
            const id = extractMemoryId(writeResult);

            const archiveResult = await tools.ctx_memory.execute(
                { action: "archive", ids: [id], reason: "subsystem removed" },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(archiveResult).toContain("Archived memory");
            await Bun.sleep(10);
            expect(capture.removes.length).toBe(1);
            expect(capture.removes[0]?.[0]?.content).toBe("stale fact");
            expect(capture.removes[0]?.[0]?.category).toBe("PROJECT_RULES");
        });

        it("update action removes old content and tees new content", async () => {
            const capture = captureBackend();
            const writeResult = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "CONFIG_VALUES",
                    content: "old wording",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );
            const id = extractMemoryId(writeResult);
            // Wait for the write's retain to land before counting subsequent calls.
            await Bun.sleep(10);
            capture.retains.length = 0;
            capture.removes.length = 0;

            const updateResult = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [id],
                    content: "new wording",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(updateResult).toContain("Updated memory");
            await Bun.sleep(10);
            // Old content removed from external (the document identity derives
            // from the original content hash; without the remove, the new retain
            // would create a duplicate document).
            expect(capture.removes.length).toBe(1);
            expect(capture.removes[0]?.[0]?.content).toBe("old wording");
            // Corrected content teed as a new document.
            const teed = capture.retains.flat();
            expect(teed.some((item) => item.content === "new wording")).toBe(true);
        });

        it("verify action sets verification status and upserts verbatim", async () => {
            const capture = captureBackend();
            const writeResult = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "PROJECT_RULES",
                    content: "true fact",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );
            const id = extractMemoryId(writeResult);
            await Bun.sleep(10);
            capture.retains.length = 0;
            capture.removes.length = 0;

            const verifyResult = await tools.ctx_memory.execute(
                { action: "verify", ids: [id] },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(verifyResult).toContain("Verified memory");
            // The local row's verification_status flipped.
            expect(getMemoryById(db, id)?.verificationStatus).toBe("verified");
            await Bun.sleep(10);
            // Verbatim re-retain = same document_id = server-side upsert — the
            // single retain should contain the EXACT unchanged content plus
            // verifiedAt metadata. No remove is fired (the document is current).
            const upserted = capture.retains.flat();
            expect(upserted.length).toBe(1);
            expect(upserted[0]?.content).toBe("true fact");
            expect(typeof upserted[0]?.verifiedAt).toBe("number");
            expect(capture.removes.length).toBe(0);
        });

        it("merge does NOT propagate to external backend (canonical rewrite is local-only)", async () => {
            const capture = captureBackend();
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "use bun",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "use bun for everything",
            });
            await Bun.sleep(10);
            capture.retains.length = 0;
            capture.removes.length = 0;

            const mergeResult = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id],
                    content: "use bun for all the things",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(mergeResult).toContain("Merged memories");
            await Bun.sleep(10);
            // Merge is a local canonical rewrite — no external retain, no remove.
            // v1 rule: the canonical document was never externally re-teed.
            expect(capture.removes.length).toBe(0);
            expect(capture.retains.length).toBe(0);
        });

        it("verify rejects non-dreamer agents", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "primary-only memory",
            });

            // Primary agent tool with default allowedActions = ["write","delete"].
            // "verify" is a dreamer-only action and the action is not in
            // allowedActions → rejected with the "not allowed" error.
            const result = await tools.ctx_memory.execute(
                { action: "verify", id: 1 },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("not allowed");
        });
    });
});
