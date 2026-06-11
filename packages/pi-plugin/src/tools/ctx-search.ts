/**
 * Pi-side wrapper for the `ctx_search` tool.
 *
 * The core search logic in `unifiedSearch()` is harness-agnostic — it operates
 * over the shared SQLite store. The pi-plugin only needs to:
 *
 *   1. Translate the LLM-provided arguments into the search options shape.
 *   2. Resolve session ID and project identity from the Pi extension context.
 *   3. Format results for the LLM the same way the OpenCode plugin does.
 *
 * `ctx_expand` is now registered alongside (see `./ctx-expand.ts`) — Pi
 * sessions are JSONL files, but the shared `readSessionChunk` reads
 * via the `RawMessageProvider` registry, so Pi just registers its own
 * provider for the duration of an expand call.
 */

import { basename } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type UnifiedSearchResult,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { CTX_SEARCH_DESCRIPTION } from "@magic-context/core/tools/ctx-search/constants";
import { type Static, Type } from "typebox";

const DEFAULT_LIMIT = 10;

const ParamsSchema = Type.Object({
	query: Type.String({
		description:
			"Search query. Matches against memory content, git commit messages, and raw user/assistant message text.",
	}),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum results to return (default: 10)",
		}),
	),
	sources: Type.Optional(
		Type.Array(
			Type.Union([
				Type.Literal("memory"),
				Type.Literal("message"),
				Type.Literal("git_commit"),
				Type.Literal("external"),
			]),
			{
				description:
					'Optional. Restrict to specific sources. Examples: ["git_commit"] for "when did we change X", ["memory"] for naming conventions, ["message"] for "did we discuss this earlier", ["git_commit","message"] for regression hunts, ["external"] for long-term knowledge from past sessions. Omit for a broad search across all enabled sources.',
			},
		),
	),
});

type CtxSearchParams = Static<typeof ParamsSchema>;

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit))
		return DEFAULT_LIMIT;
	return Math.max(1, Math.floor(limit));
}

function formatAge(committedAtMs: number): string {
	const ageMs = Date.now() - committedAtMs;
	if (ageMs < 0) return "future";
	const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
	if (days <= 0) return "today";
	if (days === 1) return "1d ago";
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months === 1) return "1mo ago";
	if (months < 12) return `${months}mo ago`;
	const years = Math.floor(days / 365);
	return years === 1 ? "1y ago" : `${years}y ago`;
}

function formatResult(result: UnifiedSearchResult, index: number): string {
	if (result.source === "memory") {
		// `source=` attributes a foreign workspace member's memory to its origin
		// project (parity with OpenCode ctx-search/tools.ts); empty for own-project.
		const source = result.sourceName ? ` source=${result.sourceName}` : "";
		return [
			`[${index}] [memory] score=${result.score.toFixed(2)} id=${result.memoryId} category=${result.category}${source} match=${result.matchType}`,
			result.content,
		].join("\n");
	}

	if (result.source === "git_commit") {
		return [
			`[${index}] [git_commit] score=${result.score.toFixed(2)} sha=${result.shortSha} ${formatAge(result.committedAtMs)} match=${result.matchType}`,
			result.content,
		].join("\n");
	}

	if (result.source === "compartment") {
		return [
			`[${index}] [message] score=${result.score.toFixed(2)} compartment_id=${result.compartmentId} range=${result.startOrdinal}-${result.endOrdinal} match=${result.matchType} title=${result.title}`,
			result.snippet ? `Snippet: ${result.snippet}` : result.content,
		].join("\n");
	}

	if (result.source === "external") {
		const categoryPart = result.category ? ` category=${result.category}` : "";
		return [
			`[${index}] [external] score=${result.score.toFixed(2)}${categoryPart}`,
			result.content,
		].join("\n");
	}

	const expandStart = Math.max(1, result.messageOrdinal - 3);
	const expandEnd = result.messageOrdinal + 3;
	return [
		`[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} range=${expandStart}-${expandEnd} role=${result.role}`,
		result.content,
	].join("\n");
}

function formatSearchResults(
	query: string,
	results: UnifiedSearchResult[],
): string {
	if (results.length === 0) {
		return `No results found for "${query}" across memories, git commits, message history, or external knowledge.`;
	}
	const bodyParts = results.map((result, index) =>
		formatResult(result, index + 1),
	);
	if (
		results.some(
			(result) =>
				result.source === "message" || result.source === "compartment",
		)
	) {
		bodyParts.push(
			"Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.",
		);
	}
	const body = bodyParts.join("\n\n");
	return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${body}`;
}

export interface CtxSearchToolDeps {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	gitCommitsEnabled?: boolean;
}

export function createCtxSearchTool(
	deps: CtxSearchToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_search",
		label: "Magic Context: Search",
		// Single source of truth: core's CTX_SEARCH_DESCRIPTION (which documents
		// the external source) — Pi no longer carries a drifted inline copy.
		description: CTX_SEARCH_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxSearchParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			const query = params.query?.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "Error: 'query' is required." }],
					details: undefined,
					isError: true,
				};
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const projectIdentity = resolveProjectIdentity(ctx.cwd);
			await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			const memoryEnabled =
				snapshot?.features.memoryEnabled ?? deps.memoryEnabled;
			const embeddingEnabled = snapshot
				? snapshot.enabled || snapshot.gitCommitEnabled
				: deps.embeddingEnabled;
			const gitCommitsEnabled =
				snapshot?.gitCommitEnabled ?? deps.gitCommitsEnabled ?? false;

			// Only search message history up to the last compartment boundary —
			// anything after that (the live tail, including the current turn) is
			// still in context and already visible to the agent. When NO compartment
			// exists yet, the historian hasn't scrolled anything out of context, so
			// the boundary is 0: every indexed message (ordinals are 1-based) is in
			// the live tail and must be excluded. A negative sentinel here would mean
			// "search everything" and leak the current prompt back to the agent — the
			// exact opposite of the intent (issue #131).
			const lastCompartmentEnd = getLastCompartmentEndMessage(
				deps.db,
				sessionId,
			);
			const messageOrdinalCutoff =
				lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

			// Hard-filter memories already rendered in <session-history>.
			const visibleMemoryIds = getVisibleMemoryIds(deps.db, sessionId);

			const results = await unifiedSearch(
				deps.db,
				sessionId,
				projectIdentity,
				query,
				{
					limit: normalizeLimit(params.limit),
					memoryEnabled,
					embeddingEnabled,
					embedQuery: async (text, signal) => {
						const result = await embedTextForProject(
							projectIdentity,
							text,
							signal,
							"query",
						);
						return result?.vector ?? null;
					},
					isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
					maxMessageOrdinal: messageOrdinalCutoff,
					gitCommitsEnabled,
					sources: params.sources,
					visibleMemoryIds,
					// Explicit agent search → literal-probe multi-query recall
					// (parity with OpenCode's ctx_search). Pi auto-search leaves
					// this off to protect its latency budget.
					explicitSearch: true,
					// External bank resolution: basename is the human-readable
					// label the engine uses as a bank template parameter, NOT a
					// key. Project identity is the key.
					projectName: ctx.cwd ? basename(ctx.cwd) : undefined,
				},
			);

			return {
				content: [{ type: "text", text: formatSearchResults(query, results) }],
				details: undefined,
			};
		},
	};
}
