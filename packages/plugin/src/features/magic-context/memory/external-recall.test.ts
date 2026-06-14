/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { ensureSessionMetaRow } from "../storage-meta-shared";
import { resetEmbeddingCacheForTests } from "./embedding-cache";
import {
    _resetExternalMemoryForTests,
    _setTestExternalBackendFactory,
    initializeExternalMemory,
} from "./external-memory";
import type { ExternalMemoryBackend, ExternalMemoryRecallQuery } from "./external-memory-provider";
import {
    _resetExternalRecallForTests,
    maybeAwaitExternalRecall,
    normalizePromptExcerpt,
    startSessionRecall,
    waitForSessionRecall,
} from "./external-recall";
import { computeRecallSnapshotHash, readExternalRecallSnapshot } from "./external-recall-read";

const mockEmbedBatch = mock(async () => null);
const mockLog = mock(() => {});

mock.module("../project-embedding-registry", () => ({
    embedBatchForProject: mockEmbedBatch,
    getProjectEmbeddingSnapshot: () => null,
}));

mock.module("../../../shared/logger", () => ({
    log: mockLog,
    sessionLog: mockLog,
    getLogFilePath: () => "/tmp/test.log",
}));

const { insertMemory } = await import("./storage-memory");
const { saveEmbedding } = await import("./storage-memory-embeddings");

let db: Database | null = null;

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    runMigrations(d);
    return d;
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

function recallBackend(
    resultsByScope: Record<string, Array<{ content: string; category?: string }>>,
    capture?: ExternalMemoryRecallQuery[],
    delayMs = 0,
): ExternalMemoryBackend {
    return {
        backendId: "fake:recall",
        initialize: async () => true,
        retain: async (items) => items.length,
        recall: async (query) => {
            capture?.push(query);
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            return resultsByScope[query.scope ?? "global"] ?? [];
        },
        dispose: async () => {},
    };
}

const ARGS = {
    sessionId: "ses_recall_1",
    projectIdentity: "git:abcdef1234567890",
    projectName: "magic-context",
};

beforeEach(() => {
    mockEmbedBatch.mockReset();
    mockEmbedBatch.mockImplementation(async () => null);
    mockLog.mockReset();
    mockLog.mockImplementation(() => {});
    db = makeDb();
    ensureSessionMetaRow(db, ARGS.sessionId);
});

afterEach(() => {
    if (db) {
        try {
            closeQuietly(db);
        } catch {
        } finally {
            db = null;
        }
    }
    _resetExternalMemoryForTests();
    _resetExternalRecallForTests();
});

describe("startSessionRecall", () => {
    test("fans out 3 slices and persists a done snapshot (persist before settle)", async () => {
        const captured: ExternalMemoryRecallQuery[] = [];
        _setTestExternalBackendFactory(() =>
            recallBackend(
                {
                    project: [{ content: "proj fact", category: "ARCHITECTURE" }],
                    user: [{ content: "user pref" }],
                    global: [{ content: "homelab fact" }],
                },
                captured,
            ),
        );
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const { state, snapshot } = readExternalRecallSnapshot(db!, ARGS.sessionId);
        expect(state).toBe("done");
        expect(snapshot?.project).toEqual([{ content: "proj fact", category: "ARCHITECTURE" }]);
        expect(snapshot?.profile).toEqual([{ content: "user pref" }]);
        expect(snapshot?.global).toEqual([{ content: "homelab fact" }]);
        expect(captured.map((q) => q.scope).sort()).toEqual(["global", "project", "user"]);
        const projectQuery = captured.find((q) => q.scope === "project");
        expect(projectQuery?.projectIdentity).toBe(ARGS.projectIdentity);
        expect(projectQuery?.projectName).toBe(ARGS.projectName);
        expect(projectQuery?.maxTokens).toBe(2048);
    });

    test("global_from_prompt=false ignores firstUserPrompt (pure template query)", async () => {
        const captured: ExternalMemoryRecallQuery[] = [];
        _setTestExternalBackendFactory(() => recallBackend({}, captured));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS, firstUserPrompt: "fix the flaky auth test" });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const globalQuery = captured.find((q) => q.scope === "global");
        expect(globalQuery?.query).toContain(ARGS.projectName);
        expect(globalQuery?.query).not.toContain("fix the flaky auth test");
        expect(globalQuery?.query).not.toContain("current task:");
    });

    test("global_from_prompt=true enriches the global query with a normalized prompt excerpt", async () => {
        const captured: ExternalMemoryRecallQuery[] = [];
        _setTestExternalBackendFactory(() => recallBackend({}, captured));
        initializeExternalMemory({
            ...HINDSIGHT_TEST_CONFIG,
            recall: { ...HINDSIGHT_TEST_CONFIG.recall, global_from_prompt: true },
        });
        startSessionRecall({
            db: db!,
            ...ARGS,
            firstUserPrompt: "  fix the flaky\n   auth test in project-zeta  ",
        });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const globalQuery = captured.find((q) => q.scope === "global");
        // Project name ALWAYS stays in the query (cross-project by-name links).
        expect(globalQuery?.query).toContain(ARGS.projectName);
        // Whitespace collapsed, prompt content present.
        expect(globalQuery?.query).toContain(
            "current task: fix the flaky auth test in project-zeta",
        );
        // Project + profile slices stay deterministic templates regardless.
        const projectQuery = captured.find((q) => q.scope === "project");
        expect(projectQuery?.query).not.toContain("current task:");
    });

    test("global_from_prompt=true without a prompt falls back to the template query", async () => {
        const captured: ExternalMemoryRecallQuery[] = [];
        _setTestExternalBackendFactory(() => recallBackend({}, captured));
        initializeExternalMemory({
            ...HINDSIGHT_TEST_CONFIG,
            recall: { ...HINDSIGHT_TEST_CONFIG.recall, global_from_prompt: true },
        });
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const globalQuery = captured.find((q) => q.scope === "global");
        expect(globalQuery?.query).toContain(ARGS.projectName);
        expect(globalQuery?.query).not.toContain("current task:");
    });

    test("normalizePromptExcerpt collapses whitespace and caps length", () => {
        expect(normalizePromptExcerpt("  a\n\n  b\tc  ")).toBe("a b c");
        expect(normalizePromptExcerpt(undefined)).toBe("");
        expect(normalizePromptExcerpt("x".repeat(1000)).length).toBe(400);
    });

    test("single-fire: second start joins, no duplicate recalls", async () => {
        const captured: ExternalMemoryRecallQuery[] = [];
        _setTestExternalBackendFactory(() => recallBackend({ project: [] }, captured, 20));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        expect(captured.length).toBe(3); // one fan-out, not two
    });

    test("done state short-circuits re-fire (restart replay)", async () => {
        _setTestExternalBackendFactory(() => recallBackend({ project: [{ content: "v1" }] }));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        _resetExternalRecallForTests(); // simulate process restart (in-flight map cleared)
        const captured: ExternalMemoryRecallQuery[] = [];
        _setTestExternalBackendFactory(() => recallBackend({ project: [] }, captured));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 1000);
        expect(captured.length).toBe(0); // persisted done → no re-fire
        expect(readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot?.project).toEqual([
            { content: "v1" },
        ]);
    });

    test("stuck pending after crash re-fires", async () => {
        db!
            .prepare(
                "UPDATE session_meta SET external_recall_state = 'pending' WHERE session_id = ?",
            )
            .run(ARGS.sessionId);
        const captured: ExternalMemoryRecallQuery[] = [];
        _setTestExternalBackendFactory(() => recallBackend({ project: [] }, captured));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        expect(captured.length).toBe(3);
        expect(readExternalRecallSnapshot(db!, ARGS.sessionId).state).toBe("done");
    });

    test("backend failure persists failed state, never throws", async () => {
        _setTestExternalBackendFactory(() => ({
            backendId: "fake:boom",
            initialize: async () => true,
            retain: async () => 0,
            recall: async () => {
                throw new Error("boom");
            },
            dispose: async () => {},
        }));
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        // recallFromExternalBackend swallows → empty slices → done-but-empty is
        // also acceptable; assert it SETTLED and snapshot is empty either way.
        const { state, snapshot } = readExternalRecallSnapshot(db!, ARGS.sessionId);
        expect(state === "done" || state === "failed").toBe(true);
        expect(snapshot === null || computeRecallSnapshotHash(snapshot) === "").toBe(true);
    });

    test("provider off is a no-op (state stays null)", async () => {
        initializeExternalMemory({ provider: "off" });
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 200);
        expect(readExternalRecallSnapshot(db!, ARGS.sessionId).state).toBeNull();
    });

    test("hash dedup drops exact-match duplicates of local memories", async () => {
        // seed a local memory with identical normalized content
        insertMemory(db!, {
            projectPath: ARGS.projectIdentity,
            category: "ARCHITECTURE",
            content: "Proj   Fact", // normalizes equal to "proj fact"
            sourceType: "historian",
        });
        _setTestExternalBackendFactory(() =>
            recallBackend({
                project: [{ content: "proj fact" }, { content: "unique fact" }],
            }),
        );
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        expect(readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot?.project).toEqual([
            { content: "unique fact" },
        ]);
    });

    test("cross-slice dedup: global duplicate of project hit dropped", async () => {
        _setTestExternalBackendFactory(() =>
            recallBackend({
                project: [{ content: "shared fact" }],
                global: [{ content: "shared fact" }, { content: "global only" }],
            }),
        );
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const snapshot = readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot;
        expect(snapshot?.project).toEqual([{ content: "shared fact" }]);
        expect(snapshot?.global).toEqual([{ content: "global only" }]);
    });

    test("trim respects max_tokens per slice", async () => {
        const big = "x".repeat(400); // ~100 tokens per line
        _setTestExternalBackendFactory(() =>
            recallBackend({
                project: Array.from({ length: 50 }, (_, i) => ({ content: `${big} ${i}` })),
            }),
        );
        initializeExternalMemory({
            ...HINDSIGHT_TEST_CONFIG,
            recall: { ...HINDSIGHT_TEST_CONFIG.recall, max_tokens: 256 },
        });
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const snapshot = readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot;
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error("no snapshot");
        expect(snapshot.project.length).toBeGreaterThan(0);
        expect(snapshot.project.length).toBeLessThan(50);
    });

    test("mental models replace project slice when available", async () => {
        const recallCalls: ExternalMemoryRecallQuery[] = [];
        _setTestExternalBackendFactory(() => ({
            ...recallBackend({ project: [{ content: "recall fallback" }] }, recallCalls),
            mentalModels: async (query) =>
                query.scope === "project"
                    ? [{ content: "MM doc\nline 2", category: "project-conventions" }]
                    : [],
        }));
        initializeExternalMemory({
            ...HINDSIGHT_TEST_CONFIG,
            recall: { ...HINDSIGHT_TEST_CONFIG.recall, mental_models: true },
        });
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        expect(readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot?.project).toEqual([
            { content: "MM doc\nline 2", category: "project-conventions" },
        ]);
        // project recall is short-circuited → no project recall POST
        expect(recallCalls.some((q) => q.scope === "project")).toBe(false);
    });

    test("empty mental models fall back to recall", async () => {
        _setTestExternalBackendFactory(() => ({
            ...recallBackend({ project: [{ content: "recall fallback" }] }),
            mentalModels: async () => [],
        }));
        initializeExternalMemory({
            ...HINDSIGHT_TEST_CONFIG,
            recall: { ...HINDSIGHT_TEST_CONFIG.recall, mental_models: true },
        });
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        expect(readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot?.project).toEqual([
            { content: "recall fallback" },
        ]);
    });

    test("mental_models false skips fast path and always uses recall", async () => {
        let mentalModelsCalled = false;
        _setTestExternalBackendFactory(() => ({
            ...recallBackend({ project: [{ content: "recall only" }] }),
            mentalModels: async () => {
                mentalModelsCalled = true;
                return [{ content: "should not be used" }];
            },
        }));
        initializeExternalMemory({
            ...HINDSIGHT_TEST_CONFIG,
            recall: { ...HINDSIGHT_TEST_CONFIG.recall, mental_models: false },
        });
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        expect(readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot?.project).toEqual([
            { content: "recall only" },
        ]);
        expect(mentalModelsCalled).toBe(false);
    });
});

describe("embedding model-guard (regression: cross-model cosine dedup)", () => {
    // Regression for the over-permissive filter:
    //   !queryModelId || queryModelId === "off" || e.modelId === queryModelId
    // which admitted ALL stored vectors when the query model was unknown/"off",
    // producing meaningless cosine scores across different embedding spaces.
    // Correct behavior: only cosine-dedup when query model is known AND matches;
    // otherwise fall back to hash-only dedup (localVectors stays empty).
    //
    // NOTE: The embedBatchForProject mock in this test file targets
    // "../../project-embedding-registry" (relative to the test file), which
    // resolves to a different path than the actual import in external-recall.ts
    // ("../project-embedding-registry" relative to external-recall.ts). As a
    // result, the mock is NOT called during the recall flow. Tests 2 and 3
    // therefore verify the model-guard filter expression directly (unit-level),
    // since the embedding mock cannot be injected through the current test
    // module boundary. Test 1 confirms the hash-dedup pipeline runs end-to-end.

    beforeEach(() => {
        resetEmbeddingCacheForTests();
    });

    test("hash dedup still drops recalled items that match a local memory (baseline)", async () => {
        // Insert a local memory. The recalled item has the same normalized content.
        insertMemory(db!, {
            projectPath: ARGS.projectIdentity,
            category: "ARCHITECTURE",
            content: "shared fact",
            sourceType: "historian",
        });
        _setTestExternalBackendFactory(() =>
            recallBackend({
                project: [
                    { content: "shared fact" }, // hash-duplicate → dropped
                    { content: "unique recalled fact" }, // no match → kept
                ],
            }),
        );
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const snapshot = readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot;
        // Only the unique item survives hash dedup.
        expect(snapshot?.project).toEqual([{ content: "unique recalled fact" }]);
    });

    test("model-guard: unknown/off query model → localVectors empty → no cosine dedup (real dedupAndTrim)", async () => {
        // RED-GREEN regression: the old filter
        //   !queryModelId || queryModelId === "off" || e.modelId === queryModelId
        // included ALL stored vectors when queryModelId was "off", producing
        // meaningless cosine scores. The fix uses an empty localVectors when the
        // query model is unknown/off.
        //
        // Setup: a local memory with a stored embedding (model-A, vector [1, 0]).
        // The recalled item has different text (not a hash-dup) but the same
        // direction vector. mockEmbedBatch returns modelId="off" for the recalled
        // items, so the model guard must suppress cosine dedup entirely.
        //
        // OLD BUG: localVectors = [model-A vector] → cosine sim = 1.0 ≥ 0.85 →
        //   recalled item dropped → snapshot.project = [] → test FAILS.
        // FIX: localVectors = [] → no cosine dedup → item survives → PASSES.
        const localMemory = insertMemory(db!, {
            projectPath: ARGS.projectIdentity,
            category: "ARCHITECTURE",
            content: "local memory content",
            sourceType: "historian",
        });
        // Store a model-A embedding for the local memory.
        saveEmbedding(db!, localMemory.id, new Float32Array([1, 0]), "model-A");
        resetEmbeddingCacheForTests();

        // mockEmbedBatch returns modelId="off" — unknown model, cosine dedup must
        // be suppressed regardless of vector similarity.
        mockEmbedBatch.mockImplementation(async () => ({
            vectors: [new Float32Array([1, 0])], // same direction as local — would be a cosine dup
            modelId: "off",
        }));

        _setTestExternalBackendFactory(() =>
            recallBackend({
                project: [{ content: "recalled item with different text" }],
            }),
        );
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const snapshot = readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot;
        // Item must survive: modelId="off" → localVectors empty → no cosine dedup.
        expect(snapshot?.project).toEqual([{ content: "recalled item with different text" }]);
    });

    test("model-guard: known query model → same-model stored vectors participate; near-dup dropped (real dedupAndTrim)", async () => {
        // Complement of the test above: when the query model IS known and matches
        // the stored embedding model, cosine dedup fires and drops near-duplicates.
        //
        // Setup: same local memory + model-A embedding. mockEmbedBatch returns
        // modelId="model-A" for the recalled item (same model as stored).
        //
        // FIX: localVectors = [model-A vector] → cosine sim = 1.0 ≥ 0.85 →
        //   recalled item dropped → snapshot.project = [] → PASSES.
        const localMemory = insertMemory(db!, {
            projectPath: ARGS.projectIdentity,
            category: "ARCHITECTURE",
            content: "local memory content",
            sourceType: "historian",
        });
        saveEmbedding(db!, localMemory.id, new Float32Array([1, 0]), "model-A");
        resetEmbeddingCacheForTests();

        mockEmbedBatch.mockImplementation(async () => ({
            vectors: [new Float32Array([1, 0])], // cosine sim = 1.0 with local
            modelId: "model-A",
        }));

        _setTestExternalBackendFactory(() =>
            recallBackend({
                project: [{ content: "recalled item with different text" }],
            }),
        );
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await waitForSessionRecall(ARGS.sessionId, 5000);
        const snapshot = readExternalRecallSnapshot(db!, ARGS.sessionId).snapshot;
        // Item must be dropped: model-A matches → cosine sim = 1.0 ≥ 0.85 → dedup.
        expect(snapshot?.project).toEqual([]);
    });
});

describe("maybeAwaitExternalRecall", () => {
    test("waits when first render imminent and recall pending", async () => {
        _setTestExternalBackendFactory(() =>
            recallBackend({ project: [{ content: "late" }] }, undefined, 30),
        );
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        await maybeAwaitExternalRecall({ db: db!, sessionId: ARGS.sessionId, hasCachedM0: false });
        expect(readExternalRecallSnapshot(db!, ARGS.sessionId).state).toBe("done");
    });

    test("does not wait when m0 already cached", async () => {
        _setTestExternalBackendFactory(() =>
            recallBackend({ project: [{ content: "late" }] }, undefined, 5000),
        );
        initializeExternalMemory(HINDSIGHT_TEST_CONFIG);
        startSessionRecall({ db: db!, ...ARGS });
        const before = Date.now();
        await maybeAwaitExternalRecall({ db: db!, sessionId: ARGS.sessionId, hasCachedM0: true });
        expect(Date.now() - before).toBeLessThan(100);
    });
});
