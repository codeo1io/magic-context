import { describe, expect, it, spyOn } from "bun:test";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxSearchTool } from "./ctx-search";

describe("createCtxSearchTool", () => {
	it("prints ctx_expand ranges and footer for message search hits", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "message",
						content: "prior conversation detail",
						score: 0.87,
						messageOrdinal: 12,
						role: "user",
						matchType: "fts",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-1",
				{ query: "prior detail", sources: ["message"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("ordinal=12 range=9-15 role=user");
			expect(text).toContain(
				"Use ctx_expand(start, end) with the range from any message result above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("formats external results with the external label, score, and optional category", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "external",
						content: "long-term recall from another session",
						score: 0.81,
					},
					{
						source: "external",
						content: "another long-term recall",
						score: 0.6,
						category: "ARCHITECTURE",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-2",
				{ query: "long-term", sources: ["external"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			// Bare external hit (no category) — category segment is omitted.
			expect(text).toContain("[1] [external] score=0.81");
			expect(text).toContain("long-term recall from another session");
			// Category-bearing external hit — segment included.
			expect(text).toContain("[2] [external] score=0.60 category=ARCHITECTURE");
			// No message-ordinal leakage from the old fallback path.
			expect(text).not.toContain("ordinal=undefined");
			expect(text).not.toContain("range=NaN");
			// External results must NOT trigger the ctx_expand footer.
			expect(text).not.toContain("Use ctx_expand");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("forwards projectName (basename of cwd) to unifiedSearch for external bank resolution", async () => {
		const db = createTestDb();
		let capturedOptions: { projectName?: string; explicitSearch?: boolean } =
			{};
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async (_db, _sessionId, _projectPath, _query, options) => {
				capturedOptions = {
					projectName: options.projectName,
					explicitSearch: options.explicitSearch,
				};
				return [];
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			await tool.execute(
				"call-3",
				{ query: "anything" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", "/some/repo/my-project") as never,
			);

			expect(capturedOptions.explicitSearch).toBe(true);
			expect(capturedOptions.projectName).toBe("my-project");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});
