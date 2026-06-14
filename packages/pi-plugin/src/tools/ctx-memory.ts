/**
 * Pi-side wrapper for the `ctx_memory` tool.
 *
 * Action surface mirrors OpenCode's `packages/plugin/src/tools/ctx-memory/tools.ts`.
 * Two tiers of actions:
 *
 *  Primary (for any agent that can call ctx_memory):
 *    - write: insert a new memory (or no-op + bump seenCount on dedup hit)
 *    - archive: soft-delete a memory (status = 'archived'), optional reason
 *    - update: rewrite a memory's content (recomputes normalized_hash + queues re-embed)
 *    - merge: combine N memories into one canonical, supersede the rest
 *
 *  Dreamer-only (gated on `allowDreamerActions: true`):
 *    - list: list active memories for the current project
 *
 * Allowlist gating mirrors OpenCode's `allowedActions` deps field. In OpenCode,
 * the dreamer subagent gets the full action surface because `toolContext.agent
 * === DREAMER_AGENT`. Pi has no agent identity inside child processes, so we
 * use an explicit flag (`--magic-context-dreamer-actions`) wired through the
 * subagent extension entry. Same effective behavior, different transport.
 *
 * Parity reference (OpenCode):
 *   - `tools/ctx-memory/types.ts` for action enum
 *   - `tools/ctx-memory/tools.ts` for handler logic
 *   - `plugin/tool-registry.ts` for the primary allowedActions (CTX_MEMORY_ACTIONS)
 *
 * Memories are project-scoped via `resolveProjectIdentity(ctx.cwd)` and stored
 * in the shared cortexkit DB, so a memory written from the pi-plugin is
 * immediately visible to OpenCode sessions on the same project (and vice
 * versa).
 */

import { basename } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	archiveMemory,
	getExternalMemoryStatus,
	getMemoriesByProject,
	getMemoryByHash,
	getMemoryById,
	insertMemory,
	type Memory,
	type MemoryCategory,
	mergeMemoryStats,
	removeFromExternalBackend,
	saveEmbedding,
	supersededMemory,
	teeToExternalBackend,
	updateMemoryContent,
	updateMemorySeenCount,
	updateMemoryVerification,
	upsertToExternalBackend,
	V2_MEMORY_CATEGORIES,
} from "@magic-context/core/features/magic-context/memory";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import type { ExternalMemoryRemoveItem } from "@magic-context/core/features/magic-context/memory/external-memory-provider";
import { computeNormalizedHash } from "@magic-context/core/features/magic-context/memory/normalize-hash";
import {
	normalizeStoredProjectPath,
	resolveProjectIdentity,
	storedPathBelongsToIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type ContextDatabase,
	queueMemoryMutation,
} from "@magic-context/core/features/magic-context/storage";
import {
	expandWorkspaceIdentitySetWithAliases,
	resolveStoredPathWorkspaceIdentity,
	resolveWorkspaceIdentitySet,
	resolveWorkspaceShareCategories,
	storedPathBelongsToWorkspace,
} from "@magic-context/core/features/magic-context/workspaces";
import { log } from "@magic-context/core/shared/logger";
import { CTX_MEMORY_DESCRIPTION } from "@magic-context/core/tools/ctx-memory/constants";
import { type Static, Type } from "typebox";

const DEFAULT_LIST_LIMIT = 10;

// Mirrors OpenCode CTX_MEMORY_DREAMER_ACTIONS. `delete` was removed — it was an
// exact alias of `archive` (both soft-archive); `archive` is the single
// soft-remove action. Primary agents get write/archive/update/merge on the
// memories they already see (with ids) in the injected project-memory block;
// `list` (bulk enumeration) and `verify` (dreamer-only verification) stay
// dreamer-only.
const ALL_ACTIONS = [
	"write",
	"archive",
	"update",
	"merge",
	"list",
	"verify",
] as const;
type CtxMemoryAction = (typeof ALL_ACTIONS)[number];

const DREAMER_ONLY_ACTIONS: ReadonlySet<CtxMemoryAction> = new Set([
	"list",
	"verify",
]);

const ParamsSchema = Type.Object({
	action: Type.Union(
		ALL_ACTIONS.map((a) => Type.Literal(a)),
		{ description: "What to do: write, update, archive, or merge" },
	),
	content: Type.Optional(
		Type.String({
			description:
				"The memory text — one standalone fact (required for write, update, merge)",
		}),
	),
	category: Type.Optional(
		Type.Union(
			V2_MEMORY_CATEGORIES.map((c) => Type.Literal(c)),
			{
				description:
					"What kind of fact this is (required for write; optional merge override)",
			},
		),
	),
	ids: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Target memory id(s) from <project-memory>: update takes exactly one, archive one or more, merge two or more",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Max results for list (default: 10)",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "Why the memory is being archived (optional, recommended)",
		}),
	),
	scope: Type.Optional(
		Type.Union([Type.Literal("project"), Type.Literal("global")], {
			description:
				'Write only. "project" (default): this project\'s memory store. "global": a cross-project fact stored ONLY in the external long-term memory backend — use when the fact is true regardless of which project you are in. Requires an external backend; recallable from the next session onward.',
		}),
	),
});

type CtxMemoryParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit))
		return DEFAULT_LIST_LIMIT;
	return Math.max(1, Math.floor(limit));
}

function formatMemoryList(memories: Memory[]): string {
	if (memories.length === 0) return "No active memories found.";

	const rows = memories.map((m) => ({
		id: String(m.id),
		category: m.category,
		status: m.status,
		updated: new Date(m.updatedAt).toISOString(),
		content: m.content.replace(/\s+/g, " ").trim(),
	}));
	const widths = {
		id: Math.max(2, ...rows.map((r) => r.id.length)),
		category: Math.max(8, ...rows.map((r) => r.category.length)),
		status: Math.max(6, ...rows.map((r) => r.status.length)),
		updated: Math.max(7, ...rows.map((r) => r.updated.length)),
	};
	const fmt = (r: (typeof rows)[number]) =>
		[
			r.id.padEnd(widths.id),
			r.category.padEnd(widths.category),
			r.status.padEnd(widths.status),
			r.updated.padEnd(widths.updated),
			r.content,
		].join(" | ");
	return [
		`Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
		"",
		...rows.map(fmt),
	].join("\n");
}

function isPrimaryMutableMemory(memory: Memory): boolean {
	return (
		(memory.status === "active" || memory.status === "permanent") &&
		memory.supersededByMemoryId === null
	);
}

function inactiveMemoryError(
	id: number,
	action: "updating" | "merging" | "archiving",
): string {
	return `Error: Memory with ID ${id} is archived or superseded; restore it before ${action}.`;
}

function queueEmbedding(args: {
	deps: CtxMemoryToolDeps;
	projectIdentity: string;
	memoryId: number;
	content: string;
}) {
	const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
	if (!snapshot?.enabled) return;
	void (async () => {
		try {
			const result = await embedTextForProject(
				args.projectIdentity,
				args.content,
			);
			if (!result) {
				log(
					`[magic-context-pi] embedding skipped for memory ${args.memoryId}: provider unavailable.`,
				);
				return;
			}
			saveEmbedding(args.deps.db, args.memoryId, result.vector, result.modelId);
			log(`[magic-context-pi] proactively embedded memory ${args.memoryId}.`);
		} catch (error) {
			log(
				`[magic-context-pi] embedding failed for memory ${args.memoryId}:`,
				error,
			);
		}
	})();
}

export interface CtxMemoryToolDeps {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	/** When true, the dreamer-only `list` action is exposed. Set by the subagent
	 *  extension entry when the parent passes `--magic-context-dreamer-actions`.
	 *  Default: false (primary set only: write/archive/update/merge). */
	allowDreamerActions?: boolean;
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const dreamerAllowed = deps.allowDreamerActions === true;
	const description = dreamerAllowed
		? `${CTX_MEMORY_DESCRIPTION}\n- list: enumerate stored memories (maintenance sessions).`
		: CTX_MEMORY_DESCRIPTION;

	return {
		name: "ctx_memory",
		label: "Magic Context: Memory",
		description,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxMemoryParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			// Gate dreamer-only actions on the allowlist flag. Mirrors
			// OpenCode's `if (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action))`.
			if (!dreamerAllowed && DREAMER_ONLY_ACTIONS.has(params.action)) {
				return err(
					`Error: Action '${params.action}' is not allowed in this context.`,
				);
			}

			const projectIdentity = resolveProjectIdentity(ctx.cwd);
			await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
			const workspaceIdentitySet = resolveWorkspaceIdentitySet(
				deps.db,
				projectIdentity,
			);
			const expandedWorkspace = expandWorkspaceIdentitySetWithAliases(
				deps.db,
				workspaceIdentitySet.identities,
			);
			const workspaceVisibleIdentities =
				workspaceIdentitySet.identities.length > 1
					? expandedWorkspace.expandedIdentities
					: workspaceIdentitySet.identities;
			const targetIdentityForStoredPath = (rawProjectPath: string) =>
				workspaceIdentitySet.identities.length > 1
					? (resolveStoredPathWorkspaceIdentity(
							rawProjectPath,
							workspaceIdentitySet.identities,
							expandedWorkspace.canonicalIdentityByStoredPath,
						) ?? normalizeStoredProjectPath(rawProjectPath))
					: normalizeStoredProjectPath(rawProjectPath);
			// The workspace's share-category policy, identical to the render path
			// (resolveWorkspaceRenderContextPi): null = share all categories.
			const toolShareCategories =
				workspaceIdentitySet.identities.length > 1
					? resolveWorkspaceShareCategories(deps.db, projectIdentity)
					: null;
			// Tool visibility MUST match render visibility, or the agent could
			// mutate (update/archive) a foreign workspace memory it can't even
			// see. Own-project memories: every category is mutable. Foreign member
			// memories: only when shared — shareCategories===null shares all, an
			// empty list shares none, otherwise only the listed categories.
			// Mirrors buildWorkspaceMemorySqlFilter's own/foreign split.
			const memoryVisibleToTool = (memory: Memory): boolean => {
				if (workspaceIdentitySet.identities.length <= 1) {
					return storedPathBelongsToIdentity(
						memory.projectPath,
						projectIdentity,
					);
				}
				if (
					!storedPathBelongsToWorkspace(
						memory.projectPath,
						workspaceIdentitySet.identities,
						workspaceVisibleIdentities,
						expandedWorkspace.canonicalIdentityByStoredPath,
					)
				) {
					return false;
				}
				const isOwn =
					targetIdentityForStoredPath(memory.projectPath) === projectIdentity;
				if (isOwn) return true;
				return (
					toolShareCategories === null ||
					toolShareCategories.includes(memory.category)
				);
			};
			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			if (
				snapshot
					? !snapshot.features.memoryEnabled
					: deps.memoryEnabled === false
			) {
				return err("Cross-session memory is disabled for this project.");
			}
			const sessionId = ctx.sessionManager.getSessionId();

		// Helper to build an ExternalMemoryRemoveItem from a memory row.
		// Identity derives from the original content hash + project identity,
		// so a corrective remove needs the row AS IT STOOD before mutation.
		const buildRemoveItem = (
			memory: { content: string; category: Memory["category"] },
			memProjectIdentity: string,
		): ExternalMemoryRemoveItem => ({
			content: memory.content,
			category: memory.category as MemoryCategory,
			scope: "project",
			projectIdentity: memProjectIdentity,
			...(ctx.cwd ? { projectName: basename(ctx.cwd) } : {}),
		});

		if (params.action === "write") {
			const content = params.content?.trim();
			if (!content)
				return err("Error: 'content' is required when action is 'write'.");

			const rawCategory = params.category;
			if (!rawCategory) {
				return err("Error: 'category' is required when action is 'write'.");
			}

			// Global scope: cross-project knowledge goes to the external
			// long-term store's main bank ONLY — no local row. Mirrors
			// OpenCode's ctx-memory/tools.ts global scope branch.
			if (params.scope === "global") {
				if (!getExternalMemoryStatus()) {
					return err(
						"Error: scope 'global' requires an external memory backend (memory.external) — none is configured. Use the default project scope instead.",
					);
				}
				void teeToExternalBackend("agent", [
					{
						content,
						category: rawCategory,
						scope: "global",
						projectIdentity,
						...(ctx.cwd ? { projectName: basename(ctx.cwd) } : {}),
						sourceType: dreamerAllowed ? "dreamer" : "agent",
						sessionId,
					},
				]);
				return ok(
					`Queued global memory in ${rawCategory} for the long-term store (origin: this project). It has no local ID; it surfaces via the session-start global recall slice and ctx_search source "external" from the next session onward.`,
				);
			}

			const existing = getMemoryByHash(
				deps.db,
				projectIdentity,
				rawCategory,
				computeNormalizedHash(content),
			);
			if (existing) {
				updateMemorySeenCount(deps.db, existing.id);
				return ok(
					`Memory already exists [ID: ${existing.id}] in ${rawCategory} (seen count incremented).`,
				);
			}

			const memory = insertMemory(deps.db, {
				projectPath: projectIdentity,
				category: rawCategory,
				content,
				sourceSessionId: sessionId,
				sourceType: dreamerAllowed ? "dreamer" : "agent",
			});

			queueEmbedding({ deps, projectIdentity, memoryId: memory.id, content });
			// Do NOT invalidate the m[0]/m[1] cache here. An additive write is a
			// supersede-delta operation: it surfaces in m[1] via the maxMemoryId
			// watermark (renderM1 reads memories with id > cachedM0MaxMemoryId) on
			// the next cache-busting pass, WITHOUT busting m[0]. Clearing the cache
			// re-materialized m[0] for every session (the call was global over
			// session_meta), defeating the whole additive/non-additive split and
			// busting unrelated projects. Matches OpenCode's write path, which
			// likewise does no cache invalidation.

			// Tee to external backend (project scope). Fire-and-forget; never
			// blocks the local write. Mirrors OpenCode's write tee.
			void teeToExternalBackend("agent", [
				{
					content,
					category: rawCategory,
					scope: "project",
					projectIdentity,
					...(ctx.cwd ? { projectName: basename(ctx.cwd) } : {}),
					sourceType: dreamerAllowed ? "dreamer" : "agent",
					sessionId,
				},
			]);

			return ok(`Saved memory [ID: ${memory.id}] in ${rawCategory}.`);
		}

			if (params.action === "list") {
				const limit = normalizeLimit(params.limit);
				const filtered = getMemoriesByProject(deps.db, projectIdentity);
				const category = params.category;
				const filtered2 = category
					? filtered.filter((m) => m.category === category)
					: filtered;
				return ok(formatMemoryList(filtered2.slice(0, limit)));
			}

			if (params.action === "update") {
				const updateIds = params.ids;
				if (
					!updateIds ||
					updateIds.length !== 1 ||
					!updateIds.every(Number.isInteger)
				) {
					return err(
						"Error: 'ids' must contain exactly one integer memory ID when action is 'update'.",
					);
				}
				const updateId = updateIds[0];
				const content = params.content?.trim();
				if (!content) {
					return err("Error: 'content' is required when action is 'update'.");
				}

				const memory = getMemoryById(deps.db, updateId);
				if (!memory || !memoryVisibleToTool(memory)) {
					return err(`Error: Memory with ID ${updateId} was not found.`);
				}
				if (!dreamerAllowed && !isPrimaryMutableMemory(memory)) {
					return err(inactiveMemoryError(updateId, "updating"));
				}

				const normalizedHash = computeNormalizedHash(content);
				const targetIdentity = targetIdentityForStoredPath(memory.projectPath);
				const duplicate = getMemoryByHash(
					deps.db,
					targetIdentity,
					memory.category,
					normalizedHash,
				);
				if (duplicate && duplicate.id !== memory.id) {
					return err(
						`Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
					);
				}

			deps.db.transaction(() => {
				updateMemoryContent(deps.db, memory.id, content, normalizedHash);
				queueMemoryMutation(deps.db, {
					projectPath: targetIdentity,
					mutationType: "update",
					targetMemoryId: memory.id,
					category: memory.category,
					newContent: content,
				});
			})();
			queueEmbedding({
				deps,
				projectIdentity: targetIdentity,
				memoryId: memory.id,
				content,
			});
			// W2 corrective propagation: drop the STALE external document (old
			// content hash) and tee the corrected fact as a new document. The
			// local row's content rewrite already happened in the transaction
			// above, so `memory.content` is still the OLD content and `content`
			// is the NEW content — both needed for the remove-then-tee cascade.
			// Mirrors OpenCode's update W2 path.
			void removeFromExternalBackend([buildRemoveItem(memory, targetIdentity)]);
			void teeToExternalBackend("agent", [
				{
					content,
					category: memory.category as MemoryCategory,
					scope: "project",
					projectIdentity: targetIdentity,
					...(ctx.cwd ? { projectName: basename(ctx.cwd) } : {}),
					sourceType: dreamerAllowed ? "dreamer" : "agent",
					sessionId,
				},
			]);
			return ok(`Updated memory [ID: ${memory.id}] in ${memory.category}.`);
			}

			if (params.action === "merge") {
				const ids = params.ids;
				if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
					return err(
						"Error: 'ids' must include at least two integer memory IDs when action is 'merge'.",
					);
				}
				if (new Set(ids).size !== ids.length) {
					return err(
						"Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.",
					);
				}

				const content = params.content?.trim();
				if (!content) {
					return err("Error: 'content' is required when action is 'merge'.");
				}

				const sourceMemories = ids
					.map((id) => getMemoryById(deps.db, id))
					.filter((memory): memory is Memory => Boolean(memory));
				if (sourceMemories.length !== ids.length) {
					return err("Error: One or more source memories were not found.");
				}

				// Cross-identity consolidation is a DREAMER-ONLY capability: each
				// source is superseded under ITS OWN project identity with a
				// per-project supersede-delta row (see the supersede loop below),
				// so every affected project's m[1] reconciles correctly. But
				// `merge` is in the primary action set too, and a primary agent
				// must not reach into ANOTHER project's memories — mirror
				// update/archive ownership (parity with OpenCode).
				if (!dreamerAllowed) {
					const foreign = sourceMemories.find(
						(memory) => !memoryVisibleToTool(memory),
					);
					if (foreign) {
						return err(`Error: Memory with ID ${foreign.id} was not found.`);
					}
					const inactive = sourceMemories.find(
						(memory) => !isPrimaryMutableMemory(memory),
					);
					if (inactive) {
						return err(inactiveMemoryError(inactive.id, "merging"));
					}
				}

				// Schema-validated literal union — no runtime re-check needed.
				const requestedCategoryTyped: MemoryCategory | undefined =
					params.category;
				const fallbackCategory = sourceMemories[0]?.category;
				const category: MemoryCategory | undefined =
					requestedCategoryTyped ?? fallbackCategory;
				if (!category) {
					return err(
						"Error: A valid category is required when action is 'merge'.",
					);
				}

				if (
					!requestedCategoryTyped &&
					sourceMemories.some((memory) => memory.category !== category)
				) {
					return err(
						"Error: Mixed-category merges require an explicit 'category'.",
					);
				}

				const normalizedHash = computeNormalizedHash(content);
				const duplicate = getMemoryByHash(
					deps.db,
					projectIdentity,
					category,
					normalizedHash,
				);
				const canonicalExisting =
					duplicate && ids.includes(duplicate.id) ? duplicate : null;
				if (duplicate && !canonicalExisting) {
					return err(
						`Error: Memory content already exists as ID ${duplicate.id}; update or archive existing duplicates instead.`,
					);
				}

				// Aggregate stats from all source memories.
				const mergedSeenCount = sourceMemories.reduce(
					(sum, memory) => sum + memory.seenCount,
					0,
				);
				const mergedRetrievalCount = sourceMemories.reduce(
					(sum, memory) => sum + memory.retrievalCount,
					0,
				);
				// `mergedFrom` is JSON-stringified in the DB. Flatten any prior
				// merge chains so the lineage stays accurate when merging
				// already-merged memories. Mirrors OpenCode's parity construction
				// at packages/plugin/src/tools/ctx-memory/tools.ts:381-405.
				const mergedFromIds = Array.from(
					new Set(
						sourceMemories.flatMap((memory) => {
							let parsed: unknown[] = [];
							try {
								parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
							} catch {
								parsed = [];
							}
							const priorIds = Array.isArray(parsed)
								? parsed.filter(
										(value): value is number => typeof value === "number",
									)
								: [];
							return [memory.id, ...priorIds];
						}),
					),
				).sort((left, right) => left - right);
				const mergedFrom = JSON.stringify(mergedFromIds);
				const mergedStatus: "active" | "permanent" = sourceMemories.some(
					(memory) => memory.status === "permanent",
				)
					? "permanent"
					: "active";

				let canonicalMemory!: Memory;
				deps.db.transaction(() => {
					let canonicalContentChanged = false;
					if (canonicalExisting) {
						// One of the source memories already has the merged content.
						// Update it in place to absorb stats from the others.
						canonicalMemory = canonicalExisting;
						canonicalContentChanged =
							canonicalMemory.content !== content ||
							canonicalMemory.normalizedHash !== normalizedHash;
						if (canonicalContentChanged) {
							updateMemoryContent(
								deps.db,
								canonicalMemory.id,
								content,
								normalizedHash,
							);
						}
					} else {
						// Insert a fresh canonical memory with the merged content.
						canonicalMemory = insertMemory(deps.db, {
							projectPath: projectIdentity,
							category,
							content,
							sourceSessionId: sessionId,
							sourceType: dreamerAllowed ? "dreamer" : "agent",
						});
					}

					mergeMemoryStats(
						deps.db,
						canonicalMemory.id,
						mergedSeenCount,
						mergedRetrievalCount,
						mergedFrom,
						mergedStatus,
					);

					for (const memory of sourceMemories) {
						if (memory.id === canonicalMemory.id) {
							continue;
						}
						supersededMemory(deps.db, memory.id, canonicalMemory.id);
						queueMemoryMutation(deps.db, {
							// Normalize the stored path to the resolved identity
							// before queueing — the render-side mutation-log reader
							// matches exact project_path, and OpenCode + dashboard
							// both normalize first. A legacy raw filesystem path here
							// would write a row that normalized git:/dir: sessions
							// never read (the supersede delta would silently vanish).
							projectPath: normalizeStoredProjectPath(memory.projectPath),
							mutationType: "superseded",
							targetMemoryId: memory.id,
							supersededById: canonicalMemory.id,
						});
					}

					if (canonicalExisting && canonicalContentChanged) {
						queueMemoryMutation(deps.db, {
							projectPath: normalizeStoredProjectPath(
								canonicalMemory.projectPath,
							),
							mutationType: "update",
							targetMemoryId: canonicalMemory.id,
							category,
							newContent: content,
						});
					}
				})();

				queueEmbedding({
					deps,
					projectIdentity,
					memoryId: canonicalMemory.id,
					content,
				});
				const supersededIds = sourceMemories
					.map((memory) => memory.id)
					.filter((id) => id !== canonicalMemory.id);
				return ok(
					`Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`,
				);
			}

			if (params.action === "archive") {
				const rawArchiveIds = params.ids;
				if (
					!rawArchiveIds ||
					rawArchiveIds.length === 0 ||
					!rawArchiveIds.every(Number.isInteger)
				) {
					return err(
						"Error: 'ids' must contain at least one integer memory ID when action is 'archive'.",
					);
				}
				// De-dupe (first-seen order): `ids:[42,42]` archives once.
				const archiveIds = [...new Set(rawArchiveIds)];
				// Validate the whole batch BEFORE mutating so a typo'd id can't
				// half-archive a batch (all-or-nothing, matching the transaction).
				for (const memoryId of archiveIds) {
					const memory = getMemoryById(deps.db, memoryId);
					if (!memory || !memoryVisibleToTool(memory)) {
						return err(`Error: Memory with ID ${memoryId} was not found.`);
					}
					if (!dreamerAllowed && !isPrimaryMutableMemory(memory)) {
						// Match update/merge: once a primary caller archived or
						// superseded a memory, re-archiving it should stop with the same
						// friendly inactive-memory error instead of rewriting it.
						return err(inactiveMemoryError(memoryId, "archiving"));
					}
				}
			// Capture memory rows BEFORE archiving so the external corrective
			// remove can derive the document_id from the content AS IT STOOD.
			const targets = archiveIds.map((memoryId) => {
				const memory = getMemoryById(deps.db, memoryId);
				if (!memory)
					throw new Error(`validated memory ${memoryId} disappeared`);
				return {
					memoryId,
					memory,
					projectIdentity: targetIdentityForStoredPath(memory.projectPath),
				};
			});
			deps.db.transaction(() => {
				for (const target of targets) {
					archiveMemory(deps.db, target.memoryId, params.reason);
					queueMemoryMutation(deps.db, {
						projectPath: target.projectIdentity,
						mutationType: "archive",
						targetMemoryId: target.memoryId,
					});
				}
			})();
			// Corrective propagation: the facts are gone locally (archived) →
			// drop the external documents. Mirrors OpenCode's archive path.
			void removeFromExternalBackend(
				targets.map((target) =>
					buildRemoveItem(target.memory, target.projectIdentity),
				),
			);
			const reasonSuffix = params.reason ? ` (${params.reason})` : "";
			const idList = archiveIds.join(", ");
			const plural = archiveIds.length > 1 ? "memories" : "memory";
			return ok(`Archived ${plural} [ID: ${idList}]${reasonSuffix}.`);
		}

		if (params.action === "verify") {
			// Dreamer-only: mark a memory as verified and upsert to external
			// backend (refreshes Hindsight's recency with zero duplicate risk).
			// Mirrors OpenCode's verify action.
			const verifyIds = params.ids;
			if (
				!verifyIds ||
				verifyIds.length !== 1 ||
				!verifyIds.every(Number.isInteger)
			) {
				return err(
					"Error: 'ids' must contain exactly one integer memory ID when action is 'verify'.",
				);
			}
			const verifyId = verifyIds[0];
			const memory = getMemoryById(deps.db, verifyId);
			if (!memory || !memoryVisibleToTool(memory)) {
				return err(`Error: Memory with ID ${verifyId} was not found.`);
			}
			const verifyProjectIdentity = targetIdentityForStoredPath(
				memory.projectPath,
			);
			updateMemoryVerification(deps.db, memory.id, "verified");
			// Verbatim re-retain = same document_id = server-side upsert →
			// refreshes Hindsight's mentioned_at recency with ZERO duplicate risk.
			void upsertToExternalBackend([
				{
					content: memory.content,
					category: memory.category as MemoryCategory,
					scope: "project",
					projectIdentity: verifyProjectIdentity,
					...(ctx.cwd ? { projectName: basename(ctx.cwd) } : {}),
					sourceType: "dreamer",
					sessionId,
					verifiedAt: Date.now(),
				},
			]);
			return ok(`Verified memory [ID: ${memory.id}].`);
		}

		return err("Error: Unknown action.");
		},
	};
}
