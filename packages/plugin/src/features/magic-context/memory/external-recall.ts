import { estimateTokens } from "../../../hooks/magic-context/read-session-formatting";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { embedBatchForProject } from "../project-embedding-registry";
import { getActiveUserMemories } from "../user-memory/storage-user-memory";
import { cosineSimilarity } from "./cosine-similarity";
import { getProjectEmbeddings } from "./embedding-cache";
import {
    getExternalRecallConfig,
    mentalModelsFromExternalBackend,
    recallFromExternalBackend,
} from "./external-memory";
import type {
    ExternalMemoryMentalModelQuery,
    ExternalMemoryRecallResult,
} from "./external-memory-provider";
import {
    computeRecallSnapshotHash,
    type ExternalRecallSliceItem,
    type ExternalRecallSnapshot,
    readExternalRecallSnapshot,
} from "./external-recall-read";
import { computeNormalizedHash } from "./normalize-hash";
import { getMemoriesByProject } from "./storage-memory";

const inFlight = new Map<string, Promise<void>>();

export function _resetExternalRecallForTests(): void {
    inFlight.clear();
}

function persistRecallState(
    db: Database,
    sessionId: string,
    state: "pending" | "done" | "failed",
    snapshot?: ExternalRecallSnapshot,
): void {
    try {
        db.prepare(
            "UPDATE session_meta SET external_recall_state = ?, external_recall_json = ?, external_recall_at = ? WHERE session_id = ?",
        ).run(state, snapshot ? JSON.stringify(snapshot) : null, Date.now(), sessionId);
    } catch (error) {
        log("[magic-context] external recall: persist failed:", error);
    }
}

/** Fire the once-per-session external recall. Idempotent; never throws. */
export function startSessionRecall(args: {
    db: Database;
    sessionId: string;
    projectIdentity: string;
    projectName: string;
    /** Excerpt of the session's FIRST user prompt — enriches the global-slice
     *  query when `recall.global_from_prompt` is enabled. The first prompt is
     *  immutable for the session, so the query (and therefore the frozen
     *  snapshot) stays deterministic across crash-recovery re-fires. */
    firstUserPrompt?: string;
}): void {
    try {
        const config = getExternalRecallConfig();
        if (!config?.enabled) return;
        if (inFlight.has(args.sessionId)) return;
        const { state } = readExternalRecallSnapshot(args.db, args.sessionId);
        // done/failed → settled for this session. pending WITH no in-flight
        // promise = previous process died mid-recall → re-fire (deadlock guard).
        if (state === "done" || state === "failed") return;
        persistRecallState(args.db, args.sessionId, "pending");
        const promise = runSessionRecall(args, config).catch((error) => {
            log("[magic-context] external recall failed:", error);
            persistRecallState(args.db, args.sessionId, "failed");
        });
        inFlight.set(args.sessionId, promise);
        void promise.finally(() => inFlight.delete(args.sessionId));
    } catch (error) {
        log("[magic-context] external recall start failed:", error);
    }
}

/** Resolve when the session's recall settles, or after timeoutMs. Never throws. */
export async function waitForSessionRecall(sessionId: string, timeoutMs: number): Promise<void> {
    const promise = inFlight.get(sessionId);
    if (!promise) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            promise,
            new Promise<void>((r) => {
                timer = setTimeout(r, timeoutMs);
            }),
        ]);
    } finally {
        // Clear the timer on the fast-resolve path so the node timer queue does
        // not hold the callback (and any closure) past the function return.
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * Hybrid A-path: block ONLY when the first m[0] render is imminent (cache
 * already cold) and a recall is in flight. Called from the async transform
 * right before the postprocess phase.
 */
export async function maybeAwaitExternalRecall(args: {
    db: Database;
    sessionId: string;
    hasCachedM0: boolean;
}): Promise<void> {
    const config = getExternalRecallConfig();
    if (!config?.enabled) return;
    if (args.hasCachedM0) return;
    if (!inFlight.has(args.sessionId)) return;
    await waitForSessionRecall(args.sessionId, config.timeout_ms);
}

async function sliceWithMentalModelFastPath(
    config: { mental_models: boolean },
    query: ExternalMemoryMentalModelQuery,
    recallFallback: () => Promise<ExternalMemoryRecallResult[]>,
): Promise<ExternalMemoryRecallResult[]> {
    if (config.mental_models) {
        const models = await mentalModelsFromExternalBackend(query);
        if (models.length > 0) return models;
    }
    return recallFallback();
}

/** Max characters of first-prompt text folded into the global recall query.
 *  Long prompts dilute the semantic signal and bloat the recall request. */
const GLOBAL_QUERY_PROMPT_EXCERPT_CHARS = 400;

/** Normalize a first-prompt excerpt for query embedding: collapse whitespace
 *  (multi-line prompts must not break the query shape) and cap length. */
export function normalizePromptExcerpt(prompt: string | undefined): string {
    if (!prompt) return "";
    return prompt.replace(/\s+/g, " ").trim().slice(0, GLOBAL_QUERY_PROMPT_EXCERPT_CHARS);
}

function buildGlobalQuery(args: { projectName: string; firstUserPrompt?: string }): string {
    const base = `infrastructure, environment, tooling, gotchas, and conventions relevant to working on ${args.projectName}`;
    const excerpt = normalizePromptExcerpt(args.firstUserPrompt);
    // Project name stays in the query either way — cross-project globals that
    // mention THIS project by name (origin provenance, entity links) must keep
    // surfacing even when the prompt is about something else entirely.
    return excerpt ? `${base}; current task: ${excerpt}` : base;
}

async function runSessionRecall(
    args: {
        db: Database;
        sessionId: string;
        projectIdentity: string;
        projectName: string;
        firstUserPrompt?: string;
    },
    config: NonNullable<ReturnType<typeof getExternalRecallConfig>>,
): Promise<void> {
    const [project, profile, global] = await Promise.all([
        sliceWithMentalModelFastPath(
            config,
            {
                scope: "project",
                projectIdentity: args.projectIdentity,
                projectName: args.projectName,
            },
            () =>
                recallFromExternalBackend({
                    query: `project rules, architecture decisions, configuration, constraints, conventions for ${args.projectName}`,
                    scope: "project",
                    projectIdentity: args.projectIdentity,
                    projectName: args.projectName,
                    maxTokens: config.max_tokens,
                }),
        ),
        sliceWithMentalModelFastPath(config, { scope: "user" }, () =>
            recallFromExternalBackend({
                query: "user preferences, working style, communication habits",
                scope: "user",
                maxTokens: config.max_tokens,
            }),
        ),
        // Global slice always uses full recall — no fast path. The query is
        // optionally enriched with the session's first user prompt
        // (recall.global_from_prompt) so cross-project knowledge relevant to
        // the task at hand — e.g. globals that name ANOTHER project the
        // prompt mentions — surfaces without an explicit ctx_search.
        recallFromExternalBackend({
            query: buildGlobalQuery({
                projectName: args.projectName,
                ...(config.global_from_prompt && args.firstUserPrompt
                    ? { firstUserPrompt: args.firstUserPrompt }
                    : {}),
            }),
            scope: "global",
            maxTokens: config.max_tokens,
        }),
    ]);

    const snapshot = await dedupAndTrim(args.db, args.projectIdentity, config, {
        project: project.map(toSliceItem),
        profile: profile.map(toSliceItem),
        global: global.map(toSliceItem),
    });

    // PERSIST FIRST, then settle (the promise resolution is the A-path's
    // signal that materializeM0 can read the snapshot).
    persistRecallState(args.db, args.sessionId, "done", snapshot);
}

function toSliceItem(result: { content: string; category?: string }): ExternalRecallSliceItem {
    return { content: result.content, ...(result.category ? { category: result.category } : {}) };
}

function safeActiveUserMemoryContents(db: Database): string[] {
    try {
        return getActiveUserMemories(db).map((m) => m.content);
    } catch {
        return []; // table missing in minimal fixtures
    }
}

async function dedupAndTrim(
    db: Database,
    projectIdentity: string,
    config: { dedup_threshold: number; max_tokens: number },
    raw: ExternalRecallSnapshot,
): Promise<ExternalRecallSnapshot> {
    // ── Hash sets (always available) ──
    const localMemories = getMemoriesByProject(db, projectIdentity);
    const localHashes = new Set(localMemories.map((m) => m.normalizedHash));
    const userContents = safeActiveUserMemoryContents(db);
    for (const content of userContents) localHashes.add(computeNormalizedHash(content));

    // ── Embedding side (best-effort) ──
    const allRecalled = [...raw.project, ...raw.profile, ...raw.global];
    const recalledVectors: (Float32Array | null)[] = allRecalled.map(() => null);
    let localVectors: Float32Array[] = [];
    try {
        const recalledResult =
            allRecalled.length > 0
                ? await embedBatchForProject(
                      projectIdentity,
                      allRecalled.map((item) => item.content),
                  )
                : null;
        if (recalledResult) {
            for (let i = 0; i < recalledResult.vectors.length; i += 1) {
                recalledVectors[i] = recalledResult.vectors[i] ?? null;
            }
            const stored = getProjectEmbeddings(db, projectIdentity);
            // Honor the model guard: only compare against local vectors that were
            // embedded with the same model as the recalled items. Mismatched
            // vectors (different dimensionality or space) produce meaningless
            // cosine scores and must be excluded.
            // When the query model is unknown ("off" / falsy), cosine dedup is
            // meaningless across potentially different embedding spaces — fall
            // back to hash-only dedup by keeping localVectors empty.
            const queryModelId = recalledResult.modelId;
            localVectors =
                queryModelId && queryModelId !== "off"
                    ? [...stored.values()]
                          .filter((e) => e.modelId === queryModelId)
                          .map((e) => e.embedding)
                    : [];
            if (userContents.length > 0) {
                const userResult = await embedBatchForProject(projectIdentity, userContents);
                if (userResult) {
                    for (const vector of userResult.vectors) {
                        if (vector) localVectors.push(vector);
                    }
                }
            }
        }
    } catch (error) {
        log("[magic-context] external recall: dedup embedding unavailable, hash-only:", error);
    }

    const keptVectors: Float32Array[] = [];
    const keptHashes = new Set<string>();
    let flatIndex = 0;
    const isDuplicate = (item: ExternalRecallSliceItem): boolean => {
        const hash = computeNormalizedHash(item.content);
        if (localHashes.has(hash) || keptHashes.has(hash)) return true;
        const vector = recalledVectors[flatIndex];
        if (vector) {
            for (const localVector of localVectors) {
                if (cosineSimilarity(vector, localVector) >= config.dedup_threshold) return true;
            }
            for (const keptVector of keptVectors) {
                if (cosineSimilarity(vector, keptVector) >= config.dedup_threshold) return true;
            }
        }
        return false;
    };
    const keep = (item: ExternalRecallSliceItem): void => {
        keptHashes.add(computeNormalizedHash(item.content));
        const vector = recalledVectors[flatIndex];
        if (vector) keptVectors.push(vector);
    };

    const dedupSlice = (slice: ExternalRecallSliceItem[]): ExternalRecallSliceItem[] => {
        const result: ExternalRecallSliceItem[] = [];
        for (const item of slice) {
            if (!isDuplicate(item)) {
                keep(item);
                result.push(item);
            }
            flatIndex += 1;
        }
        return result;
    };

    // Order matters: project wins over global on cross-slice duplicates.
    const projectSlice = dedupSlice(raw.project);
    const profileSlice = dedupSlice(raw.profile);
    const globalSlice = dedupSlice(raw.global);

    return {
        project: trimSlice(sortSlice(projectSlice), config.max_tokens),
        profile: trimSlice(sortSlice(profileSlice), config.max_tokens),
        global: trimSlice(sortSlice(globalSlice), config.max_tokens),
    };
}

/** Deterministic render order — recall result order is not guaranteed stable. */
function sortSlice(slice: ExternalRecallSliceItem[]): ExternalRecallSliceItem[] {
    return [...slice].sort((a, b) => a.content.localeCompare(b.content));
}

function trimSlice(slice: ExternalRecallSliceItem[], maxTokens: number): ExternalRecallSliceItem[] {
    const result: ExternalRecallSliceItem[] = [];
    let used = 0;
    for (const item of slice) {
        // Price the item the way the injection renders it: single-line items
        // as "- content" (+newline), multi-line documents (mental models)
        // verbatim with blank-line separators on both sides.
        const multiLine = item.content.includes("\n");
        const rendered = multiLine ? item.content : `- ${item.content}`;
        const tokens = estimateTokens(rendered) + (multiLine ? 2 : 1);
        if (used + tokens > maxTokens) continue;
        result.push(item);
        used += tokens;
    }
    return result;
}

export { computeRecallSnapshotHash, readExternalRecallSnapshot };
