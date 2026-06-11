/// <reference types="bun-types" />

// Render integration for the external-recall snapshot (Tasks 6).
//
// Invariants this test guards:
//   1. A "done" snapshot already persisted before materializeM0 is baked INTO
//      m[0] as a sibling <external-memory> block (project + global slices).
//   2. Profile slice lines merge INTO <user-profile>, NOT into the external block.
//   3. No snapshot → no <external-memory> block, marker externalRecallHash is "".
//   4. Late arrival (snapshot lands AFTER m[0] is materialized) routes to the
//      m[1] <external-memory> delta on the next cache-busting pass; m[0] does
//      NOT rematerialize (mustMaterialize stays false).
//   5. After a HARD fold (next materialize), the delta disappears and the
//      snapshot is fully baked into m[0].
//   6. Recalled items get NO fake <memory id=…> markup — plain "- content" lines.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    type CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    clearInjectionCache,
    injectM0M1,
    type M0HardSignals,
    type M0M1RenderOptions,
    type M0M1State,
    materializeM0,
    mustMaterialize,
    renderM1,
} from "./inject-compartments";

const SESSION_ID = "ses_ext_recall";
const PROJECT_PATH = "/tmp/test-ext-recall-project";
const PROJECT_DIRECTORY = "/tmp/test-ext-recall-project-dir";

let db: Database;
const tempDirs: string[] = [];

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    // v31 (external recall columns) is required so seedRecallSnapshot can
    // UPDATE the recall columns. Without migrations, readExternalRecallSnapshot
    // catches the missing-column error and behaves as "never started".
    runMigrations(d);
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-ext-recall-test-"));
    tempDirs.push(dir);
    return dir;
}

function compartment(seq: number, title: string, body: string): CompartmentInput {
    return {
        sequence: seq,
        startMessage: seq,
        endMessage: seq,
        startMessageId: `m${seq}`,
        endMessageId: `m${seq}`,
        title,
        content: body,
        p1: body,
    };
}

const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    toolSetHash: "tools-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

function seedRecallSnapshot(
    dbInstance: Database,
    sessionId: string,
    snapshot: {
        project?: Array<{ content: string; category?: string }>;
        profile?: Array<{ content: string; category?: string }>;
        global?: Array<{ content: string; category?: string }>;
    },
): void {
    dbInstance
        .prepare(
            "UPDATE session_meta SET external_recall_state = ?, external_recall_json = ?, external_recall_at = ? WHERE session_id = ?",
        )
        .run("done", JSON.stringify(snapshot), Date.now(), sessionId);
}

function buildOptions(): M0M1RenderOptions {
    return {
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State,
        projectPath: PROJECT_PATH,
        projectDirectory: PROJECT_DIRECTORY,
        historyBudgetTokens: 98_000,
        isCacheBustingPass: true,
        hardSignals: BASE_HARD,
    };
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("external recall in m[0]/m[1]", () => {
    test("done snapshot before first materialize bakes <external-memory> into m[0]", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "ext proj fact" }],
            profile: [{ content: "ext user pref" }],
            global: [{ content: "ext homelab fact" }],
        });
        const result = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        // project + global slices in <external-memory>
        expect(result.m0Text).toContain('<external-memory source="hindsight">');
        expect(result.m0Text).toContain("- ext proj fact");
        expect(result.m0Text).toContain("- ext homelab fact");
        // profile merges into <user-profile>, NOT into the external block
        const userProfileStart = result.m0Text.indexOf("<user-profile>");
        const userProfileEnd = result.m0Text.indexOf("</user-profile>");
        expect(userProfileStart).toBeGreaterThanOrEqual(0);
        expect(userProfileEnd).toBeGreaterThan(userProfileStart);
        const userProfileSection = result.m0Text.slice(userProfileStart, userProfileEnd);
        expect(userProfileSection).toContain("- ext user pref");
        const externalBlockStart = result.m0Text.indexOf("<external-memory");
        const externalBlockEnd = result.m0Text.indexOf("</external-memory>");
        const externalBlockSection = result.m0Text.slice(externalBlockStart, externalBlockEnd);
        expect(externalBlockSection).not.toContain("ext user pref");
        // no fake <memory id=…> markup for recalled items
        expect(result.m0Text).not.toMatch(/<memory[^>]*id="[^"]*"[^>]*>ext (proj|homelab|user) /);
        // marker is set
        expect(result.snapshotMarkers.externalRecallHash).not.toBe("");
    });

    test("no snapshot → no external block, marker empty", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const result = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        expect(result.m0Text).not.toContain("<external-memory");
        expect(result.snapshotMarkers.externalRecallHash).toBe("");
    });

    test("late arrival: snapshot lands after materialize → m[1] delta, no m[0] rematerialize, m[0] bytes stable", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // First materialize with no snapshot.
        const first = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        expect(first.m0Text).not.toContain("<external-memory");
        expect(first.snapshotMarkers.externalRecallHash).toBe("");
        const baselineM0Bytes = first.m0Bytes;

        // Snapshot lands AFTER m[0] is materialized. The fact that recall is
        // now "done" must NOT bust m[0] (mustMaterialize stays false).
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "late fact" }],
            profile: [],
            global: [],
        });
        // Mirror the production decision flow: re-hydrate state from the DB
        // and ask mustMaterialize.
        const stateForDecision = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state: stateForDecision,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: BASE_HARD,
        });
        // Settled recall alone does NOT flip mustMaterialize — late recall rides m[1].
        expect(decision.value).toBe(false);

        // The m[1] delta on the next soft-refresh carries the late snapshot.
        const m1 = renderM1(buildOptions(), first.snapshotMarkers, first.renderedMemoryIds);
        expect(m1).toContain("<external-memory");
        expect(m1).toContain("- late fact");

        // Byte-stability: the cached m[0] baseline is unchanged after the late
        // snapshot lands. The Anthropic prompt-cache prefix MUST stay intact.
        const row = db
            .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?")
            .get(SESSION_ID) as { cached_m0_bytes: Buffer | Uint8Array | null } | null;
        const persisted = row?.cached_m0_bytes ? Buffer.from(row.cached_m0_bytes) : null;
        expect(persisted?.equals(baselineM0Bytes)).toBe(true);
    });

    test("BLOCKING: a LARGE late recall delta does NOT trigger a pressure refold (recall is not a bust trigger)", () => {
        // Regression for the BLOCKING finding: the m[1] drift triggers (ratio
        // and absolute cap) were computed from the full m1Text — a large
        // late-arrival recall delta could therefore CAUSE a pressure refold
        // that would not otherwise fire. Spec invariant: late recall must
        // NEVER cause a fold. We exclude the external delta from the pressure
        // math, so the backstop only fires for GENUINE non-recall drift.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // Tiny baseline m[0] + small history budget so the absolute cap is
        // easy to exceed if measured against the full m1Text. Mirror the
        // m0m1-taxonomy.test.ts "pressure backstop" fixture for headroom.
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Ax")]);
        const first = injectM0M1({
            ...buildOptions(),
            projectDirectory,
            historyBudgetTokens: 60,
        });
        expect(first.decision.reason).toBe("first_render");
        const baselineM0Bytes = first.m0Bytes;

        // Seed a LARGE late recall snapshot — 30 project items of ~200 chars.
        // 30 * 200 = ~6000 chars / ~1500 tokens, which dwarfs the 60-token
        // history budget × 0.2 absolute cap (12 tokens). With the bug, this
        // would trip the absolute cap and force a refold.
        const big = "x".repeat(200);
        const bigRecall = {
            project: Array.from({ length: 30 }, (_, i) => ({
                content: `${big} ${i}`,
            })),
            profile: [],
            global: [],
        };
        seedRecallSnapshot(db, SESSION_ID, bigRecall);

        // Cache-busting pass with no HARD signal — the only trigger that
        // COULD refold is the pressure backstop. mustMaterialize returns
        // false (recall is not a HARD trigger).
        const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
        const result = injectM0M1({
            ...buildOptions(),
            state,
            projectDirectory,
            historyBudgetTokens: 60,
            isCacheBustingPass: true,
            hardSignals: BASE_HARD,
        });

        // No refold: m[0] bytes are byte-identical to the pre-recall baseline.
        expect(result.m0RematerializedThisPass).toBe(false);
        const row = db
            .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?")
            .get(SESSION_ID) as { cached_m0_bytes: Buffer | Uint8Array | null } | null;
        const persisted = row?.cached_m0_bytes ? Buffer.from(row.cached_m0_bytes) : null;
        expect(persisted?.equals(baselineM0Bytes)).toBe(true);
        // m[1] still carries the late delta (the model sees it this pass).
        expect(result.m1Text).toContain("<external-memory");
        expect(result.m1Text).toContain("xxx"); // the big token
    });

    test("inverse: with the SAME setup, GENUINE non-external m[1] drift DOES trigger the pressure backstop", () => {
        // Proves the BLOCKING fix did not disable the backstop for genuine
        // drift. Same shape as the m0m1-taxonomy.test.ts "pressure backstop"
        // test, exercised here to keep the two adjacent so a future refactor
        // of the recall exclusion doesn't accidentally widen it.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Ax")]);
        const first = injectM0M1({
            ...buildOptions(),
            projectDirectory,
            historyBudgetTokens: 60,
        });
        expect(first.decision.reason).toBe("first_render");

        // Append several compartments → m[1] grows past 20% of the 60-token
        // history budget via genuine non-external drift (new compartments).
        appendCompartments(db, SESSION_ID, [
            compartment(1, "B", "Bravo delta with enough words to consume tokens"),
            compartment(2, "C", "Charlie delta with more words again to consume more tokens"),
            compartment(3, "D", "Delta delta even more words here for tokens and tokens"),
        ]);
        const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
        const folded = injectM0M1({
            ...buildOptions(),
            state,
            projectDirectory,
            historyBudgetTokens: 60,
            isCacheBustingPass: true,
            hardSignals: BASE_HARD,
        });
        // The absolute-cap backstop folded m[1] into m[0] this pass.
        expect(folded.m0RematerializedThisPass).toBe(true);
        expect(folded.m1Text).toBe(
            "<session-history-since>(no new content since last materialization)</session-history-since>",
        );
    });

    test("BLOCKING-residual: sibling-replay path does NOT pressure-refold on replayed m[1] bytes (even if those bytes contain a large external delta)", () => {
        // Residual of the BLOCKING finding: the softRefresh sibling-adoption
        // path (row-mismatch → adopt sibling's cached m[1]) used to return
        // m1Recomputed=true unconditionally, so the pressure backstop would
        // run on REPLAYED bytes. If the sibling's m[1] happened to contain a
        // large late external delta, the backstop could fold it into m[0] —
        // i.e. late recall could still trigger a refold via the sibling path.
        //
        // Setup:
        //   1. Materialize m[0] with no recall → DB row is small.
        //   2. Manually overwrite DB cached_m1_bytes with a sibling's m[1]
        //      that contains a LARGE <external-memory> delta (a frozen
        //      "sibling already settled recall" scenario).
        //   3. Mutate the in-memory state so cachedRowMatchesState returns
        //      false on a marker that is NOT a mustMaterialize trigger
        //      (cachedM0MaxCompartmentSeq — new compartments are an m[1] delta,
        //      not a HARD bust signal). This forces softRefreshCachedM1 into
        //      the sibling-adoption branch without also firing mustMaterialize.
        //   4. Call injectM0M1 with isCacheBustingPass=true and a tiny
        //      historyBudgetTokens (so the absolute cap is easy to exceed if
        //      the backstop runs on replayed bytes).
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Ax")]);
        const baseline = injectM0M1({
            ...buildOptions(),
            projectDirectory,
            historyBudgetTokens: 60,
        });
        expect(baseline.decision.reason).toBe("first_render");
        const baselineM0Bytes = baseline.m0Bytes;

        // Overwrite the DB's cached m[1] with a sibling's m[1] containing a
        // large external delta block. The backstop, if it ran on these
        // replayed bytes, would trip the absolute cap and force a refold.
        const bigRecallBlock =
            `<external-memory source="hindsight">\n` +
            Array.from({ length: 200 }, (_, i) => `- ${"y".repeat(200)} ${i}`).join("\n") +
            `\n</external-memory>`;
        const siblingM1 = `<session-history-since>\n${bigRecallBlock}\n</session-history-since>`;
        db.prepare("UPDATE session_meta SET cached_m1_bytes = ? WHERE session_id = ?").run(
            Buffer.from(siblingM1, "utf8"),
            SESSION_ID,
        );

        // Force a row mismatch on a marker that does not affect
        // materialization correctness OR fire mustMaterialize. We pick
        // cachedM0MaxCompartmentSeq — it is in cachedRowMatchesState (so
        // softRefresh takes the sibling-adoption path) but is deliberately
        // NOT a mustMaterialize trigger (new compartments are an m[1] delta,
        // not a fold signal — see the comment in mustMaterialize). This
        // isolates the test to the pressure-backstop behavior we want to
        // guard, without any HARD trigger firing.
        const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
        state.cachedM0MaxCompartmentSeq = 999_999;

        // Cache-busting pass with no HARD signal — only the pressure backstop
        // could refold, and only IF the sibling-replay path still sets
        // m1Recomputed=true. The fix marks sibling replay recomputed=false.
        const result = injectM0M1({
            ...buildOptions(),
            state,
            projectDirectory,
            historyBudgetTokens: 60,
            isCacheBustingPass: true,
            hardSignals: BASE_HARD,
        });

        // No refold: the backstop must skip replayed sibling bytes.
        expect(result.m0RematerializedThisPass).toBe(false);
        const row = db
            .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?")
            .get(SESSION_ID) as { cached_m0_bytes: Buffer | Uint8Array | null } | null;
        const persisted = row?.cached_m0_bytes ? Buffer.from(row.cached_m0_bytes) : null;
        expect(persisted?.equals(baselineM0Bytes)).toBe(true);
        // The model still sees the recall this pass (replayed from sibling).
        expect(result.m1Text).toContain("<external-memory");
        expect(result.m1Text).toContain("yyy"); // the big token
    });

    test("HARD fold reconciles: after re-materialize, delta disappears", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "late fact" }],
            profile: [],
            global: [],
        });
        const second = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        // Now baked into m[0] AND no longer in the m[1] delta (the
        // markers.externalRecallHash matches the persisted hash).
        expect(second.m0Text).toContain("- late fact");
        const m1 = renderM1(buildOptions(), second.snapshotMarkers, second.renderedMemoryIds);
        expect(m1).not.toContain("<external-memory");
    });

    test("snapshot block renders AFTER <project-memory>", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // Seed a memory so <project-memory> exists in the render.
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "local fact",
            importance: 50,
            sourceType: "historian",
        });
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "ext proj fact" }],
            profile: [],
            global: [{ content: "ext homelab fact" }],
        });
        const result = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        const projectMemoryIdx = result.m0Text.indexOf("<project-memory>");
        const externalIdx = result.m0Text.indexOf("<external-memory");
        expect(projectMemoryIdx).toBeGreaterThanOrEqual(0);
        expect(externalIdx).toBeGreaterThan(projectMemoryIdx);
    });

    test("external block carries preamble and renders multi-line items verbatim", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        seedRecallSnapshot(db, SESSION_ID, {
            project: [{ content: "Doc line 1\nDoc line 2" }, { content: "single fact" }],
            profile: [],
            global: [],
        });
        const result = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        // Preamble appears as the first content line of the block.
        expect(result.m0Text).toContain("Background knowledge from past sessions");
        // Multi-line item renders VERBATIM, with blank-line separators around it.
        expect(result.m0Text).toContain("Doc line 1\nDoc line 2");
        // Single-line items keep the "- " list prefix.
        expect(result.m0Text).toContain("- single fact");
    });

    test("external block is omitted when all recalled items are empty", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        seedRecallSnapshot(db, SESSION_ID, {
            project: [],
            profile: [],
            global: [],
        });
        const result = materializeM0({
            ...buildOptions(),
            projectDirectory,
        });
        expect(result.m0Text).not.toContain("<external-memory");
    });
});
