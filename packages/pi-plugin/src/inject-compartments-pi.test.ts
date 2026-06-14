import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	archiveMemory,
	getMemoriesByProject,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getCompartments,
	queueMemoryMutation,
	setProjectState,
} from "@magic-context/core/features/magic-context/storage";
import {
	getActiveUserMemories,
	insertUserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	injectM0M1Pi,
	materializeM0Pi,
	materializeM0PiWithRetry,
	mustMaterializePi,
	renderM0Pi,
	renderM1Pi,
} from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

function user(text: string, timestamp = 1) {
	return { role: "user" as const, content: text, timestamp };
}

function assistant(callIds: string[], text = "") {
	return {
		role: "assistant" as const,
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...callIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: {},
			})),
		],
		timestamp: 1,
	};
}

function result(toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text: `out-${toolCallId}` }],
		isError: false,
		timestamp: 1,
	};
}

describe("workspace memory sharing", () => {
	it("filters foreign categories consistently in Pi m[0] and status counts", () => {
		const db = createTestDb();
		const dir = mkdtempSync(join(tmpdir(), "mc-pi-share-"));
		try {
			db.exec(`
				INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
				VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			insertMemory(db, {
				projectPath: "git:own",
				category: "NAMING",
				content: "own naming remains visible",
			});
			insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "foreign constraint is shared",
			});
			insertMemory(db, {
				projectPath: "git:foreign",
				category: "NAMING",
				content: "foreign naming is hidden",
			});
			const state = {
				sessionId: "pi-share",
				projectIdentity: "git:own",
				projectDirectory: dir,
			};

			const m0 = renderM0Pi(state, db, "");
			expect(m0).toContain("own naming remains visible");
			expect(m0).toContain("foreign constraint is shared");
			expect(m0).not.toContain("foreign naming is hidden");

			const messages = [userMessage("hello")];
			const result = injectM0M1Pi(state, db, messages);
			expect(result.memoryCount).toBe(2);
			expect(textOf(messages[0])).toContain("foreign constraint is shared");
			expect(textOf(messages[0])).not.toContain("foreign naming is hidden");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("trimPiMessagesToBoundary", () => {
	it("sweeps non-contiguous toolResults whose assistant toolCall was trimmed", () => {
		const messages = [
			assistant(["call-a"]),
			user("interleaved"),
			result("call-a"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "u1", "r", "u2"],
			"a",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect((messages[0] as { content: string }).content).toBe("interleaved");
	});

	it("sweeps split multi-toolCall results after an intervening user", () => {
		const messages = [
			assistant(["call-a", "call-b"]),
			user("gap"),
			result("call-a"),
			result("call-b"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "gap", "ra", "rb", "keep"],
			"a",
		);

		expect(removed).toBe(3);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("sweeps kept assistant toolCalls when their toolResult was trimmed", () => {
		const messages = [
			user("old"),
			result("call-a"),
			assistant(["call-a"]),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["u", "r", "a", "keep"],
			"r",
		);

		expect(removed).toBe(3);
		expect(messages).toEqual([user("keep")]);
	});

	it("resolves a synth-user-* cutoff to the underlying real toolResult entry id", () => {
		// A compartment ending on a folded-toolResult boundary carries
		// endMessageId = `synth-user-<realToolResultEntryId>`. The live array has
		// no message with that synthetic id — only the real toolResult (entry id
		// "tr-real"). Pre-fix, the cutoff never matched and NOTHING was trimmed
		// (history duplicated -> overflow). The fix strips the prefix and matches
		// the real toolResult, then the orphan sweep removes its paired assistant.
		const messages = [
			assistant(["call-a"]),
			result("call-a"),
			assistant([], "next turn"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "tr-real", "a2", "keep"],
			"synth-user-tr-real",
		);

		// toolResult "tr-real" (cutoff) + its paired assistant "call-a" (orphan
		// sweep) are removed; the later turn + keep survive.
		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
		expect((messages[1] as { content: string }).content).toBe("keep");
	});

	it("returns 0 (no spurious trim) when a synth-user-* cutoff has no matching real entry", () => {
		const messages = [assistant(["call-a"]), user("keep")];
		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "keep"],
			"synth-user-nonexistent",
		);
		expect(removed).toBe(0);
		expect(messages.length).toBe(2);
	});

	it("does not over-remove a later kept tool pair that reuses a trimmed callId", () => {
		const messages = [
			assistant(["reused"]),
			result("reused"),
			user("between turns"),
			assistant(["reused"]),
			result("reused"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a1", "r1", "u1", "a2", "r2", "u2"],
			"a1",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect((messages[3] as { content: string }).content).toBe("keep");
	});

	it("renders frozen compartment and user-profile snapshots without m[0]/m[1] duplication", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-frozen-cp-profile-"));
		try {
			const state = piState("ses-pi-frozen-cp-profile", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Frozen",
					content: "U: old turn\nold compartment body",
				},
			]);
			insertUserMemory(db, "old profile memory", []);
			const frozenCompartments = getCompartments(db, state.sessionId);
			const frozenUserProfile = getActiveUserMemories(db);

			appendCompartments(db, state.sessionId, [
				{
					sequence: 2,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-2",
					endMessageId: "entry-2",
					title: "Concurrent",
					content: "U: new turn\nnew compartment body",
				},
			]);
			insertUserMemory(db, "new profile memory", []);

			const m0 = renderM0Pi(
				state,
				db,
				"",
				1,
				[],
				frozenCompartments,
				frozenUserProfile,
			);
			const m1 = renderM1Pi(state, db, {
				maxCompartmentSeq: 1,
				maxMemoryId: 0,
				maxMutationId: 0,
				maxMemoryMutationId: 0,
				projectMemoryEpoch: 0,
				projectUserProfileVersion: 0,
				projectDocsHash: "",
				sessionFactsVersion: 0,
				materializedAt: 0,
				upgradeState: "",
				lastBaselineEndMessageId: "entry-1",
			});

			expect(m0).toContain("old compartment body");
			expect(m0).toContain("old profile memory");
			expect(m0).not.toContain("new compartment body");
			expect(m0).not.toContain("new profile memory");
			expect(m1).toContain("new compartment body");
			expect(m1).not.toContain("old compartment body");
			expect(m1).not.toContain("old profile memory");
		} finally {
			closeQuietly(db);
		}
	});
});

function piState(sessionId: string, cwd: string) {
	return {
		sessionId,
		projectIdentity: resolveProjectIdentity(cwd),
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
	};
}

describe("injectM0M1Pi memory feature gate", () => {
	it("does NOT render project memories into m[0]/m[1] when memoryEnabled=false", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-memgate-"));
		try {
			const base = piState("ses-pi-memgate", cwd);
			// A compartment (history) MUST still render — only memory is gated.
			appendCompartments(db, base.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);
			insertMemory(db, {
				projectPath: base.projectIdentity,
				category: "ARCHITECTURE",
				content: "SECRET project memory must not leak when disabled",
				sourceType: "historian",
			});

			// memoryEnabled=false → memory suppressed, compartments retained.
			const disabledState = { ...base, memoryEnabled: false };
			const off = [userMessage("hello", 10)];
			injectM0M1Pi(disabledState, db, off as never, undefined, true);
			const offM0 = textOf(off[0] as never);
			expect(offM0).not.toContain("SECRET project memory");
			expect(offM0).not.toContain("<project-memory");
			expect(offM0).toContain("compartment body present");

			// Control: a fresh session with memoryEnabled left on DOES render it,
			// proving the gate (not some other filter) is responsible.
			const onState = piState("ses-pi-memgate-on", cwd);
			appendCompartments(db, onState.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);
			const on = [userMessage("hello", 10)];
			injectM0M1Pi(onState, db, on as never, undefined, true);
			expect(textOf(on[0] as never)).toContain("SECRET project memory");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi", () => {
	it("renders first-pass m[0] with no inner content and m[1] placeholder", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-"));
		try {
			const messages = [userMessage("hello", 10)];
			injectM0M1Pi(piState("ses-pi-empty", cwd), db, messages as never);

			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toBe(
				"<session-history-since>(no new content since last materialization)</session-history-since>",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("replays byte-stable cached m[0]/m[1] for identical state", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-stable-"));
		try {
			const state = piState("ses-pi-stable", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never);

			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes m[0] when a LEGACY compartment appears (upgrade_state HARD flip)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-compartment-"));
		try {
			const state = piState("ses-pi-compartment", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			expect(textOf(first[0] as never)).not.toContain("Compacted setup");

			// A LEGACY compartment (no p1 tier → legacy=1) flips upgrade_state
			// "ready"→"legacy", which is a genuine HARD trigger (the session now
			// needs /ctx-session-upgrade). This is NOT the new-compartment path — a
			// v2 compartment (with p1) is a SOFT m[1] delta and does NOT re-
			// materialize m[0] (see the SOFT-delta test below). Asserting the legacy
			// HARD path here keeps the upgrade-detection contract pinned.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never, ["entry-1"]);

			// m[0] re-materialized and now carries the compartment (title always
			// renders; body present because the U: line keeps it at P3).
			expect(textOf(second[0] as never)).toContain('title="Setup"');
			expect(textOf(second[0] as never)).toContain("Compacted setup");
			expect(textOf(second[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("SOFT pass: new v2 compartment surfaces in m[1] WITHOUT re-materializing m[0], raw messages trimmed", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-soft-delta-"));
		try {
			const state = piState("ses-pi-soft-delta", cwd);
			// First v2 compartment (p1 present → legacy=0, upgrade_state stays
			// "ready"). Materialize the m[0] baseline.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "First",
					content: "U: first turn\nfirst compartment body",
					p1: "U: first turn\nfirst compartment body",
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, ["entry-0"]);
			expect(r0.m0Materialized).toBe(true);
			const baselineM0 = textOf(firstPass[0] as never);
			expect(baselineM0).toContain("first compartment body");

			// Historian publishes a SECOND v2 compartment (the delta). This is the
			// exact scenario the taxonomy fix targets: it MUST ride m[1], not fold
			// m[0].
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Delta",
					content: "U: second turn\nsecond compartment body",
					p1: "U: second turn\nsecond compartment body",
				},
			]);

			// Cache-busting pass (history refresh): recomputeM1ThisPass=true.
			const secondPass = [
				userMessage("covered-0", 10), // entry-0 → already baseline
				userMessage("covered-1", 11), // entry-1 → new compartment, must trim
				userMessage("keep", 12), // live tail → must survive
			];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-0", "entry-1", "keep"],
				true,
			);

			// (a) m[0] NOT re-materialized — SOFT, not HARD.
			expect(r1.m0Materialized).toBe(false);
			// (b) m[0] bytes byte-identical to the baseline (the whole point of the
			// split: the stable prefix stays cached).
			const m0 = textOf(secondPass[0] as never);
			expect(m0).toBe(baselineM0);
			expect(m0).not.toContain("second compartment body");
			// (c) new compartment surfaces in m[1].
			expect(textOf(secondPass[1] as never)).toContain(
				"second compartment body",
			);
			// (d) raw messages through the new compartment boundary (entry-1) are
			// trimmed (no duplication) while the live tail survives.
			expect(r1.skippedVisibleMessages).toBe(2);
			expect(textOf(secondPass[secondPass.length - 1] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with NULL required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-marker-"));
		try {
			const state = piState("ses-pi-null-marker", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const second = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, second as never);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(textOf(second[0] as never)).toContain("<session-history>");
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps legacy cached max seq 0 when a real seq-0 compartment exists", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-legacy-zero-real-"));
		try {
			const state = piState("ses-pi-legacy-zero-real", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Seq Zero",
					content: "U: first turn\nseq zero body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, ["entry-0"]);

			// Legacy rows persisted 0 both for empty snapshots and for a real seq-0
			// baseline. With a compartment present, 0 is unambiguous and must remain
			// the cached watermark, not be reinterpreted as the empty -1 sentinel.
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never, ["entry-0"]);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toContain("seq zero body");
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("normalizes legacy cached max seq 0 to empty only with zero compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-legacy-zero-empty-"));
		try {
			const state = piState("ses-pi-legacy-zero-empty", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = 0 WHERE session_id = ?",
			).run(state.sessionId);

			expect(getCompartments(db, state.sessionId)).toHaveLength(0);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with any partial required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-partial-marker-"));
		try {
			const state = piState("ses-pi-partial-marker", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_materialized_at = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes instead of reusing cached m[0] when compartment boundary is NULL", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-boundary-"));
		try {
			const state = piState("ses-pi-null-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Boundary",
					content: "U: boundary turn\nboundary body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, ["entry-0"]);
			db.prepare(
				"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const messages = [userMessage("covered", 10), userMessage("keep", 11)];
			const result = injectM0M1Pi(state, db, messages as never, [
				"entry-0",
				"keep",
			]);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("reuses cached m[0] (no rematerialize loop) when the compartment is legitimately boundaryless", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-boundary-"));
		try {
			const state = piState("ses-pi-empty-boundary", cwd);
			// A compartment with EMPTY end_message_id is a legitimate state (schema
			// default ''; OpenCode degrades to no-trim). Materialize persists a null
			// boundary for it — which must NOT then be treated as stale-cache and
			// force a rematerialize every pass.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "",
					endMessageId: "",
					title: "Boundaryless",
					content: "U: turn\nbody",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, []);

			// Cached boundary is null (the compartment has no usable end id), and the
			// LIVE snapshot is also boundaryless → cache is valid, not stale.
			expect(mustMaterializePi(state, db).value).toBe(false);

			// And a second injection pass reuses the cache (no materialize) and
			// degrades to no-trim rather than looping.
			const pass1Messages = [userMessage("hello", 10)];
			const result1 = injectM0M1Pi(state, db, pass1Messages as never, []);
			expect(result1.m0Materialized).toBe(false);
			expect(result1.skippedVisibleMessages).toBe(0);

			const pass2Messages = [userMessage("hello", 10)];
			const result2 = injectM0M1Pi(state, db, pass2Messages as never, []);
			expect(result2.m0Materialized).toBe(false);
			expect(result2.m0Reason).toBeNull();

			// Cache-stability invariant: a boundaryless session must render
			// BYTE-IDENTICAL m[0]/m[1] across consecutive reuse passes (no
			// materialize-vs-reuse oscillation). Compare the actual injected
			// synthetic-prefix text, not just the materialized flag.
			expect(textOf(pass2Messages[0] as never)).toBe(
				textOf(pass1Messages[0] as never),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries instead of losing seq-0 compartment published during materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-seq0-race-"));
		try {
			const state = piState("ses-pi-seq0-race", cwd);
			const originalExec = db.exec.bind(db);
			let injectedRace = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedRace) {
					injectedRace = true;
					appendCompartments(db, state.sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 1,
							startMessageId: "entry-0",
							endMessageId: "entry-0",
							title: "First",
							content: "U: first turn\nseq zero body",
						},
					]);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const { m0, snapshotMarkers } = materializeM0PiWithRetry(state, db);

			expect(injectedRace).toBe(true);
			expect(snapshotMarkers.maxCompartmentSeq).toBe(0);
			expect(m0).toContain("seq zero body");
		} finally {
			closeQuietly(db);
		}
	});

	it("trims against the frozen cached boundary instead of live rewritten compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-frozen-boundary-"));
		try {
			const state = piState("ses-pi-frozen-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-end",
					endMessageId: "old-end",
					title: "Frozen",
					content: "U: old turn\nfrozen body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE compartments SET end_message_id = ? WHERE session_id = ? AND sequence = 0",
			).run("too-far", state.sessionId);

			const messages = [
				userMessage("old visible", 10),
				userMessage("must stay", 11),
				userMessage("keep", 12),
			];
			const result = injectM0M1Pi(state, db, messages as never, [
				"old-end",
				"too-far",
				"keep",
			]);

			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("must stay");
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE error exposes only SQLITE_BUSY code", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-code-"));
		try {
			const state = piState("ses-pi-begin-busy-code", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy Code",
					content: "U: busy code turn\nbusy code fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					const error = new Error("writer unavailable") as Error & {
						code: string;
					};
					error.code = "SQLITE_BUSY";
					throw error;
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
			expect(textOf(messages[1] as never)).not.toContain(
				"busy code fallback body",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE is busy", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-"));
		try {
			const state = piState("ses-pi-begin-busy", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy",
					content: "U: busy turn\nbusy fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					throw new Error("SQLITE_BUSY: database is locked");
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
			expect(textOf(messages[1] as never)).not.toContain("busy fallback body");
		} finally {
			closeQuietly(db);
		}
	});

	it("replays byte-identical m[1] on defer and surfaces additive memory on next cache-busting pass", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-additive-stable-"));
		try {
			const state = piState("ses-pi-m1-additive-stable", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "large baseline",
					content: "baseline ".repeat(300),
				},
			]);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Large baseline memory. ".repeat(300),
				sourceType: "historian",
			});
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			const initialM1 = textOf(first[1] as never);

			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "New additive memory appears only after a bust.",
				sourceType: "agent",
			});

			const deferOne = [userMessage("defer one", 11)];
			injectM0M1Pi(state, db, deferOne as never, undefined, false);
			const deferTwo = [userMessage("defer two", 12)];
			injectM0M1Pi(state, db, deferTwo as never, undefined, false);

			expect(textOf(deferOne[1] as never)).toBe(initialM1);
			expect(textOf(deferTwo[1] as never)).toBe(initialM1);
			expect(initialM1).not.toContain("New additive memory");

			const bust = [userMessage("bust", 13)];
			injectM0M1Pi(state, db, bust as never, undefined, true);
			expect(textOf(bust[1] as never)).toContain("<new-memories>");
			expect(textOf(bust[1] as never)).toContain(
				"New additive memory appears only after a bust.",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("renders archive removals for m0-resident memory only on cache-busting pass and replays them on defer", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-archive-delta-"));
		try {
			const state = piState("ses-pi-m1-archive-delta", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "large baseline",
					content: "baseline ".repeat(300),
				},
			]);
			const memory = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Baseline memory to remove from m0. ".repeat(300),
				sourceType: "historian",
			});
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);

			db.transaction(() => {
				archiveMemory(db, memory.id);
				queueMemoryMutation(db, {
					projectPath: state.projectIdentity,
					mutationType: "archive",
					targetMemoryId: memory.id,
					queuedAt: 10,
				});
			})();

			const defer = [userMessage("defer", 11)];
			injectM0M1Pi(state, db, defer as never, undefined, false);
			expect(textOf(defer[1] as never)).not.toContain("<memory-updates>");

			const bust = [userMessage("bust", 12)];
			injectM0M1Pi(state, db, bust as never, undefined, true);
			const m1 = textOf(bust[1] as never);
			expect(m1).toContain("<memory-updates>");
			expect(m1).toContain(
				"These memories changed since the snapshot below — trust these:",
			);
			expect(m1).toContain(`<removed id="${memory.id}"/>`);

			const deferAfterBust = [userMessage("defer after bust", 13)];
			injectM0M1Pi(state, db, deferAfterBust as never, undefined, false);
			expect(textOf(deferAfterBust[1] as never)).toBe(m1);
		} finally {
			closeQuietly(db);
		}
	});

	it("skips memory mutation deltas for memories trimmed out of m0", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-trimmed-delta-"));
		try {
			const state = {
				...piState("ses-pi-m1-trimmed-delta", cwd),
				injectionBudgetTokens: 1,
			};
			const memory = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "This memory is too large for a one-token m0 budget.",
				sourceType: "historian",
			});
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			queueMemoryMutation(db, {
				projectPath: state.projectIdentity,
				mutationType: "update",
				targetMemoryId: memory.id,
				newContent: "Updated but not resident.",
				queuedAt: 10,
			});

			const bust = [userMessage("bust", 11)];
			injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(textOf(bust[1] as never)).not.toContain("<memory-updates>");
			expect(textOf(bust[1] as never)).not.toContain(
				"Updated but not resident.",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("reconcile rematerialization advances the memory mutation cursor and omits memory-updates", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-reconcile-delta-"));
		try {
			const state = piState("ses-pi-m1-reconcile-delta", cwd);
			const memory = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Old baseline content.",
				sourceType: "historian",
			});
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			db.prepare(
				"UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
			).run("Reconciled content.", "reconciled-hash", Date.now(), memory.id);
			queueMemoryMutation(db, {
				projectPath: state.projectIdentity,
				mutationType: "update",
				targetMemoryId: memory.id,
				newContent: "Reconciled content.",
				queuedAt: 10,
			});
			setProjectState(db, state.projectIdentity, { projectMemoryEpoch: 1 });

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(result.m0Materialized).toBe(true);
			expect(textOf(bust[0] as never)).toContain("Reconciled content.");
			expect(textOf(bust[1] as never)).not.toContain("<memory-updates>");
		} finally {
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS rolls back and replays a sibling cached m1 on marker mismatch", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_max_memory_id = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						Buffer.from(
							`<session-history>${"baseline ".repeat(300)}</session-history>`,
							"utf8",
						),
						99,
						Buffer.from("sibling cached m1", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[1] as never)).toBe("sibling cached m1");
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS rejects byte-different m[0] even when non-doc markers match", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-bytes-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas-bytes", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			const siblingM0 = Buffer.from(
				`<session-history>${"byte mismatch ".repeat(300)}</session-history>`,
				"utf8",
			);
			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						siblingM0,
						Buffer.from("sibling cached pi m1 byte mismatch", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[0] as never)).toBe(siblingM0.toString("utf8"));
			expect(textOf(bust[1] as never)).toBe(
				"sibling cached pi m1 byte mismatch",
			);
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS treats docs-hash-only marker drift as a match", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-docs-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas-docs", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			const baselineM0 = textOf(first[0] as never);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Pi docs-hash-only CAS delta memory",
				sourceType: "agent",
			});
			let changedDocsMarker = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !changedDocsMarker) {
					changedDocsMarker = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_project_docs_hash = ? WHERE session_id = ?",
					).run("docs-only-marker-drift", state.sessionId);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(changedDocsMarker).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[0] as never)).toBe(baselineM0);
			expect(textOf(bust[1] as never)).toContain(
				"Pi docs-hash-only CAS delta memory",
			);
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});
});

describe("renderM0Pi sibling-block layout (OpenCode parity)", () => {
	it("renders <project-memory> as a SIBLING after </session-history>, not nested inside it", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-siblings-"));
		try {
			const state = piState("ses-pi-siblings", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "The widget service owns rendering.",
				sourceType: "historian",
			});

			const m0 = renderM0Pi(state, db);

			// The <session-history> wrapper must close BEFORE <project-memory>
			// opens — they are siblings (matches OpenCode renderM0). A nested
			// layout (project-memory inside session-history) is the bug this
			// guards against: it would put different bytes on the wire than
			// OpenCode for identical state.
			const historyClose = m0.indexOf("</session-history>");
			const memoryOpen = m0.indexOf("<project-memory>");
			expect(historyClose).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(historyClose);
			// Compartment body lives INSIDE <session-history>; memory does NOT.
			const historyBlock = m0.slice(
				m0.indexOf("<session-history>"),
				historyClose,
			);
			expect(historyBlock).toContain("Compacted setup");
			expect(historyBlock).not.toContain("widget service");
		} finally {
			closeQuietly(db);
		}
	});

	it("materializeM0Pi binds maxMemoryId watermark to the rendered memory set", () => {
		// Regression for the round-7 HIGH: the persisted maxMemoryId watermark must
		// equal the max id of the memories actually rendered into m[0]. If it were
		// read separately (lower), a memory present in m[0] could also satisfy
		// "id > watermark" and render again in m[1] — duplicated across the split.
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-watermark-"));
		try {
			const state = piState("ses-pi-watermark", cwd);
			for (const content of [
				"The widget service owns rendering.",
				"Orders flow through an async queue.",
				"Sessions use stateless JWT.",
			]) {
				insertMemory(db, {
					projectPath: state.projectIdentity,
					category: "ARCHITECTURE",
					content,
					sourceType: "historian",
				});
			}
			const maxId = getMemoriesByProject(db, state.projectIdentity, [
				"active",
				"permanent",
			]).reduce((m, x) => (x.id > m ? x.id : m), 0);

			const { snapshotMarkers } = materializeM0Pi(state, db);

			expect(maxId).toBeGreaterThan(0);
			expect(snapshotMarkers.maxMemoryId).toBe(maxId);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("mustMaterializePi — SOFT/HARD taxonomy (parity with OpenCode)", () => {
	const baseHard = {
		systemHash: "sys-v1",
		modelKey: "anthropic/opus",
		cacheExpired: false,
		lastResponseTime: 0,
	};

	function compartment(seq: number, body: string) {
		return {
			sequence: seq,
			startMessage: seq,
			endMessage: seq,
			startMessageId: `entry-${seq}`,
			endMessageId: `entry-${seq}`,
			title: `T${seq}`,
			content: body,
			p1: body,
		};
	}

	it("does NOT materialize m[0] on a new compartment (it rides m[1])", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-newcomp-"));
		try {
			const state = {
				...piState("ses-pi-tax-newcomp", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			// Publish a new compartment — the routine historian publish.
			appendCompartments(db, state.sessionId, [compartment(1, "Bravo")]);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a model change folds m[0]", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-"));
		try {
			const state = {
				...piState("ses-pi-tax-model", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const switched = {
				...state,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			expect(mustMaterializePi(switched, db)).toEqual({
				value: true,
				reason: "model_change",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a system-hash change folds m[0]", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-sys-"));
		try {
			const state = {
				...piState("ses-pi-tax-sys", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			expect(mustMaterializePi(changed, db)).toEqual({
				value: true,
				reason: "system_hash",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("an empty current HARD signal is never treated as a change", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-empty-"));
		try {
			const state = {
				...piState("ses-pi-tax-empty", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const unknown = {
				...state,
				hardSignals: {
					systemHash: "",
					modelKey: "",
					cacheExpired: false,
					lastResponseTime: 0,
				},
			};
			expect(mustMaterializePi(unknown, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT materialize m[0] on a project docs hash change", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-docs-soft-"));
		try {
			const state = {
				...piState("ses-pi-tax-docs-soft", cwd),
				hardSignals: baseHard,
			};
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi docs\n");
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				undefined,
				true,
			);

			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# New Pi docs\n");

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("folds current project docs on the next natural HARD materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-docs-hard-"));
		try {
			const state = {
				...piState("ses-pi-tax-docs-hard", cwd),
				hardSignals: baseHard,
			};
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi architecture\n");
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			expect(textOf(first[0] as never)).toContain("Old Pi architecture");

			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# Updated Pi architecture\nFresh Pi docs folded on hard bust.\n",
			);
			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const second = [userMessage("hi again", 11)];
			const result = injectM0M1Pi(
				changed,
				db,
				second as never,
				undefined,
				true,
			);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("system_hash");
			expect(textOf(second[0] as never)).toContain("Updated Pi architecture");
			expect(textOf(second[0] as never)).toContain(
				"Fresh Pi docs folded on hard bust.",
			);
			expect(textOf(second[0] as never)).not.toContain("Old Pi architecture");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi external m[1] delta pressure-refold exclusion (cache parity)", () => {
	// RED-GREEN regression for Finding #1: a large external-recall delta in m[1]
	// must NEVER trigger the pressure-refold backstop. The fix subtracts
	// externalDeltaTokens + wrapper overhead from the pressure comparison so
	// late recall "must NEVER cause a fold" (parity with OpenCode injectM0M1).
	//
	// Setup: materialize m[0] with a small compartment (m[0] tokens ≈ small).
	// Then seed a large external recall snapshot whose token count exceeds
	// 15% of m[0] tokens. On a cache-busting pass the pressure math must
	// exclude the external delta and NOT call materializeM0PiWithRetry.
	//
	// RED (without fix): m1PressureTokens = m1Tokens (no subtraction) →
	//   large delta crosses the 15% ratio → materializeM0PiWithRetry called →
	//   m[0] bytes change → test FAILS.
	// GREEN (with fix): m1PressureTokens = m1Tokens - externalDeltaTokens -
	//   wrapper → ratio not crossed → no refold → m[0] bytes unchanged → PASSES.

	it("large external m[1] delta does NOT trigger pressure refold (m[0] bytes stable)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-ext-pressure-"));
		try {
			const state = piState("ses-pi-ext-pressure", cwd);

			// Materialize m[0] with a compartment large enough to clear the
			// M0_DRIFT_RATIO_FLOOR_TOKENS=500 gate (so the ratio test can fire).
			// ~600 tokens of body content ensures m[0] > 500 tokens.
			const m0Body = "word ".repeat(600); // ~600 tokens
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Large",
					content: `U: large turn\n${m0Body}`,
					p1: `U: large turn\n${m0Body}`,
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, ["entry-0"], true);
			expect(r0.m0Materialized).toBe(true);
			const baselineM0 = textOf(firstPass[0] as never);
			const baselineM0Bytes = baselineM0.length;

			// Seed a large external recall snapshot AFTER m[0] was materialized.
			// The snapshot hash differs from the m[0] baseline hash (which is "")
			// so the delta will be rendered into m[1]. Make it large enough to
			// exceed 15% of m[0] tokens (m[0] is small, so even a moderate delta
			// crosses the ratio without the fix).
			// ~200 tokens of content — well above 15% of m[0] (~600 tokens).
			// Without the fix, this delta alone would cross the ratio and trigger
			// a refold. With the fix, it is subtracted from m1PressureTokens.
			const largeContent = "word ".repeat(200); // ~200 tokens
			db.prepare(
				"UPDATE session_meta SET external_recall_state = ?, external_recall_json = ?, external_recall_at = ? WHERE session_id = ?",
			).run(
				"done",
				JSON.stringify({
					project: [{ content: largeContent }],
					profile: [],
					global: [],
				}),
				Date.now(),
				state.sessionId,
			);

			// Cache-busting pass: recomputeM1ThisPass=true. The external delta
			// will be rendered into m[1]. The pressure backstop must NOT fire.
			const secondPass = [userMessage("hello", 11)];
			const r1 = injectM0M1Pi(state, db, secondPass as never, ["entry-0"], true);

			// (a) m[0] NOT re-materialized — external delta must not trigger refold.
			expect(r1.m0Materialized).toBe(false);
			// (b) m[0] bytes byte-identical to the baseline (cache-stable).
			const m0After = textOf(secondPass[0] as never);
			expect(m0After.length).toBe(baselineM0Bytes);
			expect(m0After).toBe(baselineM0);
			// (c) m[1] contains the external delta.
			expect(textOf(secondPass[1] as never)).toContain(largeContent);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("Pi external m[1] delta includes profile slice (Finding #2)", () => {
	// Regression: Pi's m[1] delta previously called renderExternalMemoryBlock
	// (project+global only), dropping profile-slice items. The fix uses
	// renderExternalMemoryDelta (project+global+profile), matching OpenCode.

	it("profile-slice item from recall snapshot appears in Pi m[1] external delta", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-ext-profile-delta-"));
		try {
			const state = piState("ses-pi-ext-profile", cwd);

			// Materialize m[0] first (no external recall yet).
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, [], true);
			expect(r0.m0Materialized).toBe(true);

			// Seed an external recall snapshot with a profile-slice item AFTER
			// m[0] was materialized. The snapshot hash differs from the m[0]
			// baseline hash (which is ""), so the delta will be rendered into m[1].
			const profileItem = "user prefers concise answers";
			db.prepare(
				"UPDATE session_meta SET external_recall_state = ?, external_recall_json = ?, external_recall_at = ? WHERE session_id = ?",
			).run(
				"done",
				JSON.stringify({
					project: [],
					profile: [{ content: profileItem }],
					global: [],
				}),
				Date.now(),
				state.sessionId,
			);

			// Cache-busting pass: the external delta must include the profile item.
			const secondPass = [userMessage("hello", 11)];
			injectM0M1Pi(state, db, secondPass as never, [], true);

			// m[1] must contain the profile-slice item.
			const m1Text = textOf(secondPass[1] as never);
			expect(m1Text).toContain(profileItem);
			// m[0] must NOT contain it (profile merges into <user-profile> at next
			// HARD fold, not into the external block at m[0]).
			expect(textOf(secondPass[0] as never)).not.toContain(profileItem);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});
