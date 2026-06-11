/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { replaceAllCompartmentState } from "../features/magic-context/compartment-storage";
import { insertMemory } from "../features/magic-context/memory";
import {
    _resetExternalMemoryForTests,
    _setTestExternalBackendFactory,
    initializeExternalMemory,
} from "../features/magic-context/memory/external-memory";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { runMigrations } from "../features/magic-context/migrations";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { createLiveSessionState } from "../hooks/magic-context/live-session-state";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../shared/models-dev-cache";
import { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { buildSidebarSnapshot, buildStatusDetail } from "./rpc-handlers";
import { resetSidebarSnapshotCache } from "./sidebar-snapshot-cache";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

afterEach(() => {
    resetSidebarSnapshotCache();
    clearModelsDevCache();
    _resetExternalMemoryForTests();
});

describe("buildSidebarSnapshot — memory tokens fallback (bug #1)", () => {
    test("computes memoryTokens on-demand when memory_block_cache is empty but memory_block_count > 0", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-1";
            // Resolve a project identity that getMemoriesByProject will key on.
            // Using process.cwd() as the directory matches what the production
            // call site does (the RPC handler receives the user's directory).
            const directory = process.cwd();
            const projectIdentity = resolveProjectIdentity(directory);

            // Insert a few memories under this project so renderMemoryBlock has
            // real content to tokenize. Without these, the on-demand render
            // returns an empty block and tokens stay at 0.
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "USER_DIRECTIVES",
                content: "Always use Bun for builds",
                sourceSessionId: sessionId,
            });
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ENVIRONMENT",
                content:
                    "OpenCode source lives at ~/Work/OSS/opencode (cloned for cross-reference, not a workspace package).",
                sourceSessionId: sessionId,
            });

            // Seed session_meta with the regression-trigger shape:
            //   memory_block_cache = ''  (cleared by historian/recomp/etc.)
            //   memory_block_count > 0  (preserved across cache busts)
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 50000, 25, 5000, '', 2)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                directory,
                undefined,
                4000, // injection budget tokens, matching default config
            );

            // The bug: memoryTokens used to be 0 here because the fallback path
            // wasn't implemented. After the fix, it should be > 0 because we
            // render the memory block on-demand from the memories table.
            expect(snapshot.memoryBlockCount).toBe(2);
            expect(snapshot.memoryTokens).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("falls back to 0 when cache is empty AND memory_block_count is 0 (truly nothing to render)", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-2";
            const directory = process.cwd();

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 0, 0, 0, '', 0)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, 4000);
            expect(snapshot.memoryBlockCount).toBe(0);
            expect(snapshot.memoryTokens).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("memory bucket measures the <project-memory> slice ACTUALLY in m[0] (v2 wire), not memory_block_cache", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-3";
            const directory = process.cwd();
            // m[0] carries the real v2 render (id/category/importance attributes).
            const m0 =
                "<session-history>\n</session-history>\n\n" +
                '<project-memory>\n  <memory id="1" category="ARCHITECTURE" importance="50">a durable architectural fact about the system</memory>\n</project-memory>';
            // memory_block_cache holds the LEGACY v1 shape — must be IGNORED for
            // the token bucket now (it under-counts the real injected cost).
            const v1Cache = "<project-memory>\n- a durable architectural fact\n</project-memory>";

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count, cached_m0_bytes
                ) VALUES (?, 50000, 25, 5000, ?, 1, ?)`,
            ).run(sessionId, v1Cache, Buffer.from(m0, "utf8"));

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, 4000);
            expect(snapshot.memoryBlockCount).toBe(1);
            // Tokens come from the m[0] v2 slice, which is heavier than the v1
            // cache shape (has id/category/importance attributes).
            const v2SliceTokens = snapshot.memoryTokens;
            expect(v2SliceTokens).toBeGreaterThan(0);
            // The v2 slice is strictly larger than the v1 cache shape would yield.
            expect(
                estimateTokens(m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0] ?? ""),
            ).toBe(v2SliceTokens);
            expect(v2SliceTokens).toBeGreaterThan(estimateTokens(v1Cache));
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — context limit", () => {
    test("populates contextLimit from the active session model", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-context-limit";
            const directory = process.cwd();
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 80000, 40, 5000, '', 0)`,
            ).run(sessionId);
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "test-provider",
                                    models: {
                                        "test-model": { limit: { context: 200_000 } },
                                    },
                                },
                            ],
                        },
                    }),
                },
            });
            const live = createLiveSessionState();
            live.liveModelBySession.set(sessionId, {
                providerID: "test-provider",
                modelID: "test-model",
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, live, 4000);

            expect(snapshot.contextLimit).toBe(200_000);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — history token reuse (council audit bg_51106601 #1)", () => {
    test("sets historyBlockTokens from compartmentTokens only (facts retired in v2)", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-history-tokens";
            const directory = process.cwd();

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, conversation_tokens
                ) VALUES (?, 50000, 25, 5000, 0)`,
            ).run(sessionId);
            replaceAllCompartmentState(
                db,
                sessionId,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "msg-1",
                        endMessageId: "msg-4",
                        title: "Setup",
                        content: "User configured the project and installed dependencies.",
                    },
                    {
                        sequence: 1,
                        startMessage: 5,
                        endMessage: 8,
                        startMessageId: "msg-5",
                        endMessageId: "msg-8",
                        title: "Implementation",
                        content: "Assistant implemented the requested performance fix.",
                    },
                ],
                [
                    { category: "preference", content: "Use Bun for plugin commands." },
                    { category: "environment", content: "The workspace is a git repository." },
                ],
            );

            const detail = await buildStatusDetail(db, sessionId, directory);

            // v2: facts are retired as a render source (promoted to memories), so
            // factTokens is 0 and the history block is compartments only — facts
            // no longer contribute to rendered <session-history> bytes.
            expect(detail.compartmentTokens).toBeGreaterThan(0);
            expect(detail.factTokens).toBe(0);
            expect(detail.historyBlockTokens).toBe(detail.compartmentTokens);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — external memory section", () => {
    test("provider off → externalMemory is null", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-ext-off";
            db.prepare(
                "INSERT INTO session_meta (session_id, last_input_tokens, last_context_percentage) VALUES (?, 0, 0)",
            ).run(sessionId);
            initializeExternalMemory({ provider: "off" });
            const detail = await buildStatusDetail(db, sessionId, process.cwd());
            expect(detail.externalMemory).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("provider on, fake backend exposes fetchFailedRetainCount → detail surfaces the count", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-ext-on";
            db.prepare(
                "INSERT INTO session_meta (session_id, last_input_tokens, last_context_percentage) VALUES (?, 0, 0)",
            ).run(sessionId);
            _setTestExternalBackendFactory(() => ({
                backendId: "fake:ext-status",
                initialize: async () => true,
                retain: async () => 0,
                dispose: async () => {},
                _getCircuitState: () => "closed",
                fetchFailedRetainCount: async () => 3,
            }));
            initializeExternalMemory({
                provider: "hindsight",
                endpoint: "http://10.0.0.1:8889",
                project_bank: "mc-{name}-{id8}",
                main_bank: "main-memory",
                retain_sources: ["historian", "agent", "dreamer"],
                tags: ["user:test"],
                recall: {
                    enabled: true,
                    timeout_ms: 3000,
                    max_tokens: 2048,
                    dedup_threshold: 0.85,
                    global_tags: ["user:test"],
                    global_from_prompt: false,
                    search: true,
                    mental_models: true,
                    profile_mental_models: ["user-preferences"],
                },
            });
            const detail = await buildStatusDetail(db, sessionId, process.cwd());
            expect(detail.externalMemory).not.toBeNull();
            expect(detail.externalMemory?.provider).toBe("hindsight");
            expect(detail.externalMemory?.endpoint).toBe("http://10.0.0.1:8889");
            expect(detail.externalMemory?.circuitState).toBe("closed");
            expect(detail.externalMemory?.failedRetainCount).toBe(3);
        } finally {
            closeQuietly(db);
        }
    });

    test("provider on, backend has no fetchFailedRetainCount hook → failedRetainCount null", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-ext-noop";
            db.prepare(
                "INSERT INTO session_meta (session_id, last_input_tokens, last_context_percentage) VALUES (?, 0, 0)",
            ).run(sessionId);
            _setTestExternalBackendFactory(() => ({
                backendId: "fake:ext-noop",
                initialize: async () => true,
                retain: async () => 0,
                dispose: async () => {},
            }));
            initializeExternalMemory({
                provider: "hindsight",
                endpoint: "http://10.0.0.1:8889",
                project_bank: "mc-{name}-{id8}",
                main_bank: "main-memory",
                retain_sources: ["historian", "agent", "dreamer"],
                tags: ["user:test"],
                recall: {
                    enabled: true,
                    timeout_ms: 3000,
                    max_tokens: 2048,
                    dedup_threshold: 0.85,
                    global_tags: ["user:test"],
                    global_from_prompt: false,
                    search: true,
                    mental_models: true,
                    profile_mental_models: ["user-preferences"],
                },
            });
            const detail = await buildStatusDetail(db, sessionId, process.cwd());
            expect(detail.externalMemory).not.toBeNull();
            expect(detail.externalMemory?.failedRetainCount).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
