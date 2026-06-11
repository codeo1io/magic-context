import { basename } from "node:path";

import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import {
    archiveMemory,
    CATEGORY_PRIORITY,
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
    updateMemorySeenCount,
    updateMemoryVerification,
    upsertToExternalBackend,
    V2_MEMORY_CATEGORIES,
} from "../../features/magic-context/memory";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import { invalidateMemory } from "../../features/magic-context/memory/embedding-cache";
import type { ExternalMemoryRemoveItem } from "../../features/magic-context/memory/external-memory-provider";
import { computeNormalizedHash } from "../../features/magic-context/memory/normalize-hash";
import {
    normalizeStoredProjectPath,
    queueMemoryMutation,
    storedPathBelongsToIdentity,
} from "../../features/magic-context/storage";
import {
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    storedPathBelongsToWorkspace,
} from "../../features/magic-context/workspaces";
import { sessionLog } from "../../shared/logger";
import { CTX_MEMORY_DESCRIPTION, CTX_MEMORY_TOOL_NAME, DEFAULT_SEARCH_LIMIT } from "./constants";
import {
    CTX_MEMORY_ACTIONS,
    CTX_MEMORY_DREAMER_ACTIONS,
    type CtxMemoryAction,
    type CtxMemoryArgs,
    type CtxMemoryToolDeps,
} from "./types";

const MEMORY_CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function isMemoryCategory(value: string): value is MemoryCategory {
    return MEMORY_CATEGORIES.has(value);
}

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_SEARCH_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

// When a caller omits `allowedActions`, fall back
// to the least-privileged set instead of the dreamer's full action list. The
// only production caller (`tool-registry.ts`) passes the primary set
// (`CTX_MEMORY_ACTIONS`) explicitly, and dreamer child sessions are gated by the
// runtime `toolContext.agent === DREAMER_AGENT` check below — they bypass
// `allowedActions` entirely. A future caller that forgets the field would
// previously have inadvertently let primary agents run the dreamer-only `list`;
// fail-closed default prevents that class of regression.
function getAllowedActions(deps: CtxMemoryToolDeps): [CtxMemoryAction, ...CtxMemoryAction[]] {
    const allowed = deps.allowedActions?.length ? deps.allowedActions : CTX_MEMORY_ACTIONS;
    return [...allowed] as [CtxMemoryAction, ...CtxMemoryAction[]];
}

function normalizeCategory(category?: string): string | undefined {
    const trimmed = category?.trim();
    return trimmed ? trimmed : undefined;
}

function formatMemoryList(memories: Memory[]): string {
    if (memories.length === 0) {
        return "No active memories found.";
    }

    const rows = memories.map((memory) => ({
        id: String(memory.id),
        category: memory.category,
        status: memory.status,
        verification: memory.verificationStatus,
        updated: new Date(memory.updatedAt).toISOString(),
        content: memory.content.replace(/\s+/g, " ").trim(),
    }));
    const headers = {
        id: "ID",
        category: "CATEGORY",
        status: "STATUS",
        verification: "VERIFY",
        updated: "UPDATED",
        content: "CONTENT",
    };
    const widths = {
        id: Math.max(headers.id.length, ...rows.map((row) => row.id.length)),
        category: Math.max(headers.category.length, ...rows.map((row) => row.category.length)),
        status: Math.max(headers.status.length, ...rows.map((row) => row.status.length)),
        verification: Math.max(
            headers.verification.length,
            ...rows.map((row) => row.verification.length),
        ),
        updated: Math.max(headers.updated.length, ...rows.map((row) => row.updated.length)),
    };
    const formatRow = (row: (typeof rows)[number] | typeof headers) =>
        [
            row.id.padEnd(widths.id),
            row.category.padEnd(widths.category),
            row.status.padEnd(widths.status),
            row.verification.padEnd(widths.verification),
            row.updated.padEnd(widths.updated),
            row.content,
        ].join(" | ");

    return [
        `Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
        "",
        formatRow(headers),
        [
            "-".repeat(widths.id),
            "-".repeat(widths.category),
            "-".repeat(widths.status),
            "-".repeat(widths.verification),
            "-".repeat(widths.updated),
            "-------",
        ].join("-+-"),
        ...rows.map(formatRow),
    ].join("\n");
}

function filterByCategory(memories: Memory[], category?: string): Memory[] {
    if (!category) {
        return memories;
    }

    return memories.filter((memory) => memory.category === category);
}

function queueMemoryEmbedding(args: {
    deps: CtxMemoryToolDeps;
    sessionId: string;
    projectPath: string;
    memoryId: number;
    content: string;
}): void {
    const snapshot = getProjectEmbeddingSnapshot(args.projectPath);
    if (!snapshot?.enabled) {
        return;
    }

    void (async () => {
        const result = await embedTextForProject(args.projectPath, args.content);
        if (!result) {
            sessionLog(
                args.sessionId,
                `memory embedding skipped for memory ${args.memoryId}: provider unavailable or embedding generation failed.`,
            );
            return;
        }

        saveEmbedding(args.deps.db, args.memoryId, result.vector, result.modelId);
        sessionLog(args.sessionId, `proactively embedded memory ${args.memoryId}.`);
    })().catch((error: unknown) => {
        sessionLog(args.sessionId, `memory embedding failed for memory ${args.memoryId}:`, error);
    });
}

function getValidatedCategory(category: string | undefined): MemoryCategory | null {
    const trimmedCategory = category?.trim();

    if (!trimmedCategory) {
        return null;
    }

    if (!isMemoryCategory(trimmedCategory)) {
        return null;
    }

    return trimmedCategory;
}

function getDisabledMessage(): string {
    return "Cross-session memory is disabled for this project.";
}

function getSourceType(deps: CtxMemoryToolDeps) {
    return deps.sourceType ?? "agent";
}

interface MemoryProjectPathRow {
    project_path: string;
}

function projectPathForMemoryId(db: CtxMemoryToolDeps["db"], id: number): string | null {
    const row = db.prepare("SELECT project_path FROM memories WHERE id = ?").get(id) as
        | MemoryProjectPathRow
        | undefined;
    return row?.project_path ?? null;
}

function projectIdentityForStoredPath(rawProjectPath: string): string {
    return normalizeStoredProjectPath(rawProjectPath);
}

function memoryBelongsToProject(memory: Memory, projectPath: string): boolean {
    return storedPathBelongsToIdentity(memory.projectPath, projectPath);
}

function isPrimaryMutableMemory(memory: Memory): boolean {
    return (
        (memory.status === "active" || memory.status === "permanent") &&
        memory.supersededByMemoryId === null
    );
}

function inactiveMemoryError(id: number, action: "updating" | "merging" | "archiving"): string {
    return `Error: Memory with ID ${id} is archived or superseded; restore it before ${action}.`;
}

function updateMemoryContentInCurrentTransaction(
    db: CtxMemoryToolDeps["db"],
    memory: Memory,
    content: string,
    normalizedHash: string,
): void {
    db.prepare(
        "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
    ).run(content, normalizedHash, Date.now(), memory.id);
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
    invalidateMemory(memory.projectPath, memory.id);
}

function createCtxMemoryTool(deps: CtxMemoryToolDeps): ToolDefinition {
    const allowedActions = getAllowedActions(deps);

    return tool({
        description: CTX_MEMORY_DESCRIPTION,
        args: {
            // The OpenCode plugin exposes one shared tool definition for all agents, so
            // schema-level narrowing to `allowedActions` blocks dreamer child sessions
            // before execute() can inspect `toolContext.agent`. Keep the full action
            // schema visible to the runtime and enforce primary-session safety below.
            action: tool.schema
                .enum([...CTX_MEMORY_DREAMER_ACTIONS])
                .describe("What to do: write, update, archive, or merge"),
            content: tool.schema
                .string()
                .optional()
                .describe(
                    "The memory text — one standalone fact (required for write, update, merge)",
                ),
            category: tool.schema
                .enum([...V2_MEMORY_CATEGORIES])
                .optional()
                .describe(
                    "What kind of fact this is (required for write; optional merge override)",
                ),
            ids: tool.schema
                .array(tool.schema.number())
                .optional()
                .describe(
                    "Target memory id(s) from <project-memory>: update takes exactly one, archive one or more, merge two or more",
                ),
            limit: tool.schema.number().optional().describe("Max results for list (default: 10)"),
            reason: tool.schema
                .string()
                .optional()
                .describe("Why the memory is being archived (optional, recommended)"),
            scope: tool.schema
                .enum(["project", "global"])
                .optional()
                .describe(
                    'Write only. "project" (default): this project\'s memory store. "global": a cross-project fact (infrastructure, tooling, environment) stored ONLY in the external long-term memory backend — use when the fact is true regardless of which project you are in. Requires an external backend; recallable from the next session onward.',
                ),
        },
        async execute(args: CtxMemoryArgs, toolContext) {
            // Sidekick consumes untrusted `/ctx-aug` prompt text and is retrieval-only;
            // fail closed even if a future permission list accidentally exposes this tool.
            if (toolContext.agent === SIDEKICK_AGENT) {
                return "Error: ctx_memory is not available to the sidekick agent.";
            }
            if (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action)) {
                return `Error: Action '${args.action}' is not allowed in this context.`;
            }

            // Build an ExternalMemoryRemoveItem from a freshly-loaded memory row.
            // Document identity in the external backend derives from the original
            // content hash + project identity, so a corrective remove needs the
            // row AS IT STOOD (not a stale in-memory `memory` from before the
            // caller mutated it). Used by the delete/archive/update branches.
            const buildRemoveItem = (
                memory: { content: string; category: Memory["category"] },
                projectIdentity: string,
            ): ExternalMemoryRemoveItem => ({
                content: memory.content,
                category: memory.category as MemoryCategory,
                scope: "project",
                projectIdentity,
                ...(toolContext.directory ? { projectName: basename(toolContext.directory) } : {}),
            });

            // Resolve the session's actual project from `toolContext.directory`
            // each call. OpenCode's top-level `ctx.directory` (the launch dir)
            // can differ from the session's working directory when the user
            // runs `opencode -s <id>` from outside the project.
            const projectPath = deps.resolveProjectPath(toolContext.directory);
            await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
            const workspaceIdentitySet = resolveWorkspaceIdentitySet(deps.db, projectPath);
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
                      ) ?? projectIdentityForStoredPath(rawProjectPath))
                    : projectIdentityForStoredPath(rawProjectPath);
            // The workspace's share-category policy, identical to the render path
            // (resolveWorkspaceRenderContext): null = share all categories.
            const toolShareCategories =
                workspaceIdentitySet.identities.length > 1
                    ? resolveWorkspaceShareCategories(deps.db, projectPath)
                    : null;
            // Tool visibility MUST match render visibility, or the agent could
            // mutate (update/archive) a foreign workspace memory it can't even
            // see. Own-project memories: every category is mutable. Foreign
            // member memories: only when shared — shareCategories===null shares
            // all, an empty list shares none, otherwise only the listed
            // categories. Mirrors buildWorkspaceMemorySqlFilter's own/foreign split.
            const memoryVisibleToTool = (memory: Memory): boolean => {
                if (workspaceIdentitySet.identities.length <= 1) {
                    return memoryBelongsToProject(memory, projectPath);
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
                const isOwn = targetIdentityForStoredPath(memory.projectPath) === projectPath;
                if (isOwn) return true;
                return (
                    toolShareCategories === null || toolShareCategories.includes(memory.category)
                );
            };
            const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
            if (
                embeddingSnapshot
                    ? !embeddingSnapshot.features.memoryEnabled
                    : deps.memoryEnabled === false
            ) {
                return getDisabledMessage();
            }

            if (args.action === "write") {
                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'write'.";
                }

                const rawCategory = args.category?.trim();
                if (!rawCategory) {
                    return "Error: 'category' is required when action is 'write'.";
                }

                const category = getValidatedCategory(rawCategory);
                if (!category) {
                    return `Error: Unknown memory category '${rawCategory}'.`;
                }

                // Global scope: cross-project knowledge goes to the external
                // long-term store's main bank ONLY — no local row. The local
                // store is project-keyed; parking globals under a pseudo-project
                // would corrupt the id-addressable curation model (update/
                // archive/dreamer flows). Server-side document_id idempotency
                // (content-hash-derived) replaces the local hash dedup, so a
                // re-write of the same fact upserts instead of duplicating.
                // projectIdentity/projectName ride along as ORIGIN provenance
                // (origin-* tags + extraction context), NOT as routing — the
                // item still lands in the main bank with scope:global, but the
                // engine links the originating project as an entity so the
                // fact surfaces when any project references it by name.
                if (args.scope === "global") {
                    if (!getExternalMemoryStatus()) {
                        return "Error: scope 'global' requires an external memory backend (memory.external) — none is configured. Use the default project scope instead.";
                    }
                    void teeToExternalBackend("agent", [
                        {
                            content,
                            category,
                            scope: "global",
                            projectIdentity: projectPath,
                            ...(toolContext.directory
                                ? { projectName: basename(toolContext.directory) }
                                : {}),
                            sourceType:
                                toolContext.agent === DREAMER_AGENT
                                    ? "dreamer"
                                    : getSourceType(deps),
                            sessionId: toolContext.sessionID,
                        },
                    ]);
                    return `Queued global memory in ${category} for the long-term store (origin: this project). It has no local ID; it surfaces via the session-start global recall slice and ctx_search source "external" from the next session onward.`;
                }

                const existingMemory = getMemoryByHash(
                    deps.db,
                    projectPath,
                    category,
                    computeNormalizedHash(content),
                );
                if (existingMemory) {
                    updateMemorySeenCount(deps.db, existingMemory.id);
                    return `Memory already exists [ID: ${existingMemory.id}] in ${category} (seen count incremented).`;
                }

                const memory = insertMemory(deps.db, {
                    projectPath: projectPath,
                    category,
                    content,
                    sourceSessionId: toolContext.sessionID,
                    sourceType:
                        toolContext.agent === DREAMER_AGENT ? "dreamer" : getSourceType(deps),
                });

                queueMemoryEmbedding({
                    deps,
                    sessionId: toolContext.sessionID,
                    projectPath,
                    memoryId: memory.id,
                    content,
                });

                void teeToExternalBackend("agent", [
                    {
                        content,
                        category,
                        scope: "project",
                        projectIdentity: projectPath,
                        ...(toolContext.directory
                            ? { projectName: basename(toolContext.directory) }
                            : {}),
                        sourceType:
                            toolContext.agent === DREAMER_AGENT ? "dreamer" : getSourceType(deps),
                        sessionId: toolContext.sessionID,
                    },
                ]);

                return `Saved memory [ID: ${memory.id}] in ${category}.`;
            }

            // NOTE: the former `delete` action (an exact alias of archive) was
            // removed upstream in v0.23.0; its external corrective-remove hook
            // lives on in the `archive` branch below.
            if (args.action === "list") {
                const limit = normalizeLimit(args.limit);
                const category = normalizeCategory(args.category);
                const memories = filterByCategory(
                    getMemoriesByProject(deps.db, projectPath),
                    category,
                ).slice(0, limit);

                return formatMemoryList(memories);
            }

            if (args.action === "update") {
                const updateIds = args.ids;
                if (!updateIds || updateIds.length !== 1 || !updateIds.every(Number.isInteger)) {
                    return "Error: 'ids' must contain exactly one integer memory ID when action is 'update'.";
                }
                const updateId = updateIds[0];

                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'update'.";
                }

                const rawProjectPath = projectPathForMemoryId(deps.db, updateId);
                const memory = getMemoryById(deps.db, updateId);
                if (!memory || !rawProjectPath || !memoryVisibleToTool(memory)) {
                    return `Error: Memory with ID ${updateId} was not found.`;
                }
                if (toolContext.agent !== DREAMER_AGENT && !isPrimaryMutableMemory(memory)) {
                    return inactiveMemoryError(updateId, "updating");
                }

                const normalizedHash = computeNormalizedHash(content);
                const duplicate = getMemoryByHash(
                    deps.db,
                    targetIdentityForStoredPath(rawProjectPath),
                    memory.category,
                    normalizedHash,
                );
                if (duplicate && duplicate.id !== memory.id) {
                    return `Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`;
                }

                const projectIdentity = targetIdentityForStoredPath(rawProjectPath);
                deps.db.transaction(() => {
                    updateMemoryContentInCurrentTransaction(
                        deps.db,
                        memory,
                        content,
                        normalizedHash,
                    );
                    queueMemoryMutation(deps.db, {
                        projectPath: projectIdentity,
                        mutationType: "update",
                        targetMemoryId: memory.id,
                        category: memory.category,
                        newContent: content,
                    });
                })();
                queueMemoryEmbedding({
                    deps,
                    sessionId: toolContext.sessionID,
                    projectPath: projectIdentity,
                    memoryId: memory.id,
                    content,
                });

                // Corrective propagation: drop the STALE external document (old
                // content hash) and tee the corrected fact as a new document. The
                // local row's content rewrite already happened in the transaction
                // above, so `memory.content` is still the OLD content and
                // `content` is the NEW content — both needed for the
                // remove-then-tee cascade.
                void removeFromExternalBackend([buildRemoveItem(memory, projectIdentity)]);
                void teeToExternalBackend("agent", [
                    {
                        content,
                        category: memory.category as MemoryCategory,
                        scope: "project",
                        projectIdentity,
                        ...(toolContext.directory
                            ? { projectName: basename(toolContext.directory) }
                            : {}),
                        sourceType:
                            toolContext.agent === DREAMER_AGENT ? "dreamer" : getSourceType(deps),
                        sessionId: toolContext.sessionID,
                    },
                ]);

                return `Updated memory [ID: ${memory.id}] in ${memory.category}.`;
            }

            if (args.action === "merge") {
                const ids = args.ids;
                if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
                    return "Error: 'ids' must include at least two integer memory IDs when action is 'merge'.";
                }
                if (new Set(ids).size !== ids.length) {
                    return "Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.";
                }

                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'merge'.";
                }

                const sourceMemories = ids
                    .map((id) => getMemoryById(deps.db, id))
                    .filter((memory): memory is Memory => Boolean(memory));
                if (sourceMemories.length !== ids.length) {
                    return "Error: One or more source memories were not found.";
                }
                // Cross-identity consolidation is a DREAMER-ONLY capability: the
                // loop below supersedes each source under ITS OWN project identity
                // and queues a per-project supersede-delta row, so every affected
                // project's m[1] reconciles. But `merge` is now in the primary
                // action set too, and a primary agent must not be able to reach
                // into ANOTHER project's memories. So mirror update/archive: a
                // non-dreamer caller may only merge memories that all belong to
                // its own resolved project. The dreamer keeps the cross-identity
                // path (see the "merging across identities" test).
                if (toolContext.agent !== DREAMER_AGENT) {
                    const foreign = sourceMemories.find((memory) => !memoryVisibleToTool(memory));
                    if (foreign) {
                        return `Error: Memory with ID ${foreign.id} was not found.`;
                    }
                    const inactive = sourceMemories.find(
                        (memory) => !isPrimaryMutableMemory(memory),
                    );
                    if (inactive) {
                        return inactiveMemoryError(inactive.id, "merging");
                    }
                }

                const category =
                    getValidatedCategory(args.category) ?? sourceMemories[0]?.category ?? null;
                if (!category) {
                    return "Error: A valid category is required when action is 'merge'.";
                }

                if (
                    !args.category &&
                    sourceMemories.some((memory) => memory.category !== category)
                ) {
                    return "Error: Mixed-category merges require an explicit 'category'.";
                }

                const normalizedHash = computeNormalizedHash(content);
                const duplicate = getMemoryByHash(deps.db, projectPath, category, normalizedHash);
                const canonicalExisting =
                    duplicate && ids.includes(duplicate.id) ? duplicate : null;
                if (duplicate && !canonicalExisting) {
                    return `Error: Memory content already exists as ID ${duplicate.id}; update or archive existing duplicates instead.`;
                }

                const mergedFrom = JSON.stringify(
                    Array.from(
                        new Set(
                            sourceMemories.flatMap((memory) => {
                                let parsed: unknown[];
                                try {
                                    parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
                                } catch {
                                    parsed = [];
                                }
                                return [
                                    memory.id,
                                    ...(Array.isArray(parsed)
                                        ? parsed.filter(
                                              (value): value is number => typeof value === "number",
                                          )
                                        : []),
                                ];
                            }),
                        ),
                    ).sort((left, right) => left - right),
                );
                const mergedSeenCount = sourceMemories.reduce(
                    (sum, memory) => sum + memory.seenCount,
                    0,
                );
                const mergedRetrievalCount = sourceMemories.reduce(
                    (sum, memory) => sum + memory.retrievalCount,
                    0,
                );
                const mergedStatus = sourceMemories.some((memory) => memory.status === "permanent")
                    ? "permanent"
                    : "active";

                const canonicalMemory = deps.db.transaction(() => {
                    const nextCanonical =
                        canonicalExisting ??
                        insertMemory(deps.db, {
                            projectPath: projectPath,
                            category,
                            content,
                            sourceSessionId: toolContext.sessionID,
                            sourceType:
                                toolContext.agent === DREAMER_AGENT
                                    ? "dreamer"
                                    : getSourceType(deps),
                        });
                    const canonicalContentChanged =
                        nextCanonical.content !== content ||
                        nextCanonical.normalizedHash !== normalizedHash;

                    if (canonicalContentChanged) {
                        updateMemoryContentInCurrentTransaction(
                            deps.db,
                            nextCanonical,
                            content,
                            normalizedHash,
                        );
                    }

                    mergeMemoryStats(
                        deps.db,
                        nextCanonical.id,
                        mergedSeenCount,
                        mergedRetrievalCount,
                        mergedFrom,
                        mergedStatus,
                    );

                    for (const memory of sourceMemories) {
                        if (memory.id === nextCanonical.id) {
                            continue;
                        }
                        supersededMemory(deps.db, memory.id, nextCanonical.id);
                        queueMemoryMutation(deps.db, {
                            projectPath: projectIdentityForStoredPath(memory.projectPath),
                            mutationType: "superseded",
                            targetMemoryId: memory.id,
                            supersededById: nextCanonical.id,
                        });
                    }

                    if (canonicalExisting && canonicalContentChanged) {
                        queueMemoryMutation(deps.db, {
                            projectPath: projectIdentityForStoredPath(nextCanonical.projectPath),
                            mutationType: "update",
                            targetMemoryId: nextCanonical.id,
                            category,
                            newContent: content,
                        });
                    }

                    return nextCanonical;
                })();

                queueMemoryEmbedding({
                    deps,
                    sessionId: toolContext.sessionID,
                    projectPath,
                    memoryId: canonicalMemory.id,
                    content,
                });

                const supersededIds = sourceMemories
                    .map((memory) => memory.id)
                    .filter((id) => id !== canonicalMemory.id);
                return `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`;
            }

            if (args.action === "archive") {
                const rawArchiveIds = args.ids;
                if (
                    !rawArchiveIds ||
                    rawArchiveIds.length === 0 ||
                    !rawArchiveIds.every(Number.isInteger)
                ) {
                    return "Error: 'ids' must contain at least one integer memory ID when action is 'archive'.";
                }
                // De-dupe (first-seen order) so `ids:[42,42]` archives once and
                // queues one mutation-log row instead of two.
                const archiveIds = [...new Set(rawArchiveIds)];

                // Validate the whole batch BEFORE mutating anything so a typo'd
                // id can't half-archive a batch (all-or-nothing, matching the
                // single-transaction write below). The pre-mutation row rides
                // along: the external corrective remove derives its document_id
                // from the content AS IT STOOD.
                const targets: Array<{
                    memoryId: number;
                    projectIdentity: string;
                    memory: Memory;
                }> = [];
                for (const memoryId of archiveIds) {
                    const rawProjectPath = projectPathForMemoryId(deps.db, memoryId);
                    const memory = getMemoryById(deps.db, memoryId);
                    if (!memory || !rawProjectPath || !memoryVisibleToTool(memory)) {
                        return `Error: Memory with ID ${memoryId} was not found.`;
                    }
                    if (toolContext.agent !== DREAMER_AGENT && !isPrimaryMutableMemory(memory)) {
                        // Mirror update/merge: once the primary agent archived or
                        // superseded this memory, re-archiving it should return the
                        // same friendly inactive-memory error instead of mutating it.
                        return inactiveMemoryError(memoryId, "archiving");
                    }
                    targets.push({
                        memoryId,
                        projectIdentity: targetIdentityForStoredPath(rawProjectPath),
                        memory,
                    });
                }

                deps.db.transaction(() => {
                    for (const target of targets) {
                        archiveMemory(deps.db, target.memoryId, args.reason);
                        queueMemoryMutation(deps.db, {
                            projectPath: target.projectIdentity,
                            mutationType: "archive",
                            targetMemoryId: target.memoryId,
                        });
                    }
                })();
                // Corrective propagation: the facts are gone locally (archived,
                // not merely hidden) → drop the external documents. One batched
                // call for the whole archive batch, after the local commit.
                void removeFromExternalBackend(
                    targets.map((target) => buildRemoveItem(target.memory, target.projectIdentity)),
                );
                const idList = targets.map((t) => t.memoryId).join(", ");
                const plural = targets.length > 1 ? "memories" : "memory";
                return args.reason?.trim()
                    ? `Archived ${plural} [ID: ${idList}] (${args.reason.trim()}).`
                    : `Archived ${plural} [ID: ${idList}].`;
            }

            if (args.action === "verify") {
                const verifyIds = args.ids;
                if (!verifyIds || verifyIds.length !== 1 || !verifyIds.every(Number.isInteger)) {
                    return "Error: 'ids' must contain exactly one integer memory ID when action is 'verify'.";
                }
                const verifyId = verifyIds[0];
                const rawProjectPath = projectPathForMemoryId(deps.db, verifyId);
                const memory = getMemoryById(deps.db, verifyId);
                if (!memory || !rawProjectPath || !memoryBelongsToProject(memory, projectPath)) {
                    return `Error: Memory with ID ${verifyId} was not found.`;
                }
                const projectIdentity = projectIdentityForStoredPath(rawProjectPath);
                updateMemoryVerification(deps.db, memory.id, "verified");
                // Verbatim re-retain = same document_id = server-side upsert →
                // refreshes Hindsight's mentioned_at recency with ZERO duplicate
                // risk. verifiedAt lands in metadata.verified_at.
                void upsertToExternalBackend([
                    {
                        content: memory.content,
                        category: memory.category as MemoryCategory,
                        scope: "project",
                        projectIdentity,
                        ...(toolContext.directory
                            ? { projectName: basename(toolContext.directory) }
                            : {}),
                        sourceType: "dreamer",
                        sessionId: toolContext.sessionID,
                        verifiedAt: Date.now(),
                    },
                ]);
                // No queueMemoryMutation: verification status is not rendered in
                // memory lines, so the cached m[0]/m[1] bytes are unaffected.
                return `Verified memory [ID: ${memory.id}].`;
            }

            return "Error: Unknown action.";
        },
    });
}

export function createCtxMemoryTools(deps: CtxMemoryToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_MEMORY_TOOL_NAME]: createCtxMemoryTool(deps),
    };
}
