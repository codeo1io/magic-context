import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    loadCompartmentChunkEmbeddingsForSearch,
    type StoredCompartmentChunkEmbedding,
} from "./compartment-chunk-embedding";
import { type GitCommitSearchHit, searchGitCommitsSync } from "./git-commits";
import { containsProbeVerbatim, extractLiteralProbes } from "./literal-probes";
import {
    ensureMemoryEmbeddings,
    getMemoriesByProject,
    getMemoriesByProjects,
    getProjectEmbeddings,
    type Memory,
    peekProjectEmbeddings,
    searchMemoriesFTS,
    searchMemoriesFTSUnion,
    updateMemoryRetrievalCount,
} from "./memory";
import { cosineSimilarity } from "./memory/cosine-similarity";
import { embedText, getProjectEmbeddingSnapshot, isEmbeddingEnabled } from "./memory/embedding";
import { isExternalSearchEnabled, recallFromExternalBackend } from "./memory/external-memory";
import { readExternalRecallSnapshot } from "./memory/external-recall-read";
import { computeNormalizedHash } from "./memory/normalize-hash";
import { sanitizeFtsQuery } from "./memory/storage-memory-fts";
import {
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    sourceNameForMemory,
    type WorkspaceIdentitySet,
} from "./workspaces";

const DEFAULT_UNIFIED_SEARCH_LIMIT = 10;
const FTS_SEMANTIC_CANDIDATE_LIMIT = 50;
const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;
const RESULT_PREVIEW_LIMIT = 220;
/** Source boost multipliers for unified ranking.
 *
 * Memories are curated, hand-written summaries — strongest signal.
 * Git commits are terse human-written descriptions — high signal.
 * Messages are raw history that survived compression — boosted above baseline
 * (1.15 in this release, up from 1.0) because by definition these are the
 * specific details the historian didn't preserve as memories or compartments,
 * which is exactly what ctx_search is most useful for. */
const MEMORY_SOURCE_BOOST = 1.3;
const MESSAGE_SOURCE_BOOST = 1.15;
const GIT_COMMIT_SOURCE_BOOST = 1.2;

interface MessageSearchRow {
    messageOrdinal?: number | string;
    messageId?: string;
    role?: string;
    content?: string;
}

const messageSearchStatements = new WeakMap<Database, PreparedStatement>();

export type SearchSource = "memory" | "message" | "git_commit" | "external";

export interface UnifiedSearchOptions {
    limit?: number;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    /** Deprecated: message search no longer reads raw messages on the hot path. */
    readMessages?: (sessionId: string) => unknown[];
    embedQuery?: (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;
    isEmbeddingRuntimeEnabled?: () => boolean;
    /** Only return message-history hits with ordinal ≤ this value (e.g. last compartment end). -1 or omit to search all. */
    maxMessageOrdinal?: number;
    /** Include indexed git commits in the result set. Default false — the
     *  feature is gated behind experimental.git_commit_indexing config. */
    gitCommitsEnabled?: boolean;
    /** Restrict results to these sources. Omit or pass undefined to search all
     *  enabled sources. Empty array is treated as "no sources enabled" → [].
     *  Facts are NOT a source — they're already always rendered in the
     *  <session-history> block injected into message[0]. */
    sources?: SearchSource[];
    /** Hard-filter memories already rendered in <session-history>. The agent
     *  can see them in message[0] — surfacing them via ctx_search wastes
     *  tokens and crowds out high-signal raw-history hits. Pass null or omit
     *  to disable filtering (for callers outside the transform context that
     *  can't resolve the visible set). */
    visibleMemoryIds?: Set<number> | null;
    /** Abort signal — if provided, cancels in-flight embedding requests
     *  (and any downstream HTTP calls) when the caller gives up. Used by
     *  transform-hot-path callers like auto-search whose own 3s timeout
     *  needs to cancel the 30s embedding fetch. */
    signal?: AbortSignal;
    /** When true (default), increment retrieval_count on memory hits. Explicit
     *  `ctx_search` tool calls from the agent SHOULD count — the agent asked
     *  for the memory, saw it, and used it. Plugin-internal automatic surfacing
     *  (e.g. auto-search hints appended to every user prompt) should NOT count
     *  because the agent may never actually consume the hint, and even if they
     *  do, automatic surfacing doesn't indicate usefulness. Mis-counting drives
     *  spurious retrieval-count-based memory promotion decisions. */
    countRetrievals?: boolean;
    /** When true, run multi-probe message search: extract literal symbol/command/
     *  path probes from the query and query each one separately (RRF-fused) so a
     *  message containing the exact literal but not the query's other tokens is
     *  still recalled. Default false — only explicit `ctx_search` tool calls opt
     *  in; the auto-search hot path stays single-probe to protect its latency
     *  budget. NL queries with no extractable probes are unaffected either way. */
    explicitSearch?: boolean;
    /** Override for tests; defaults to module-level isExternalSearchEnabled(). */
    externalSearchEnabled?: boolean;
    /** Project name (basename) for external bank resolution. */
    projectName?: string;
}

export interface MemorySearchResult {
    source: "memory";
    content: string;
    score: number;
    memoryId: number;
    category: string;
    matchType: "semantic" | "fts" | "hybrid";
    sourceName?: string;
}

export interface MessageSearchResult {
    source: "message";
    content: string;
    score: number;
    messageOrdinal: number;
    messageId: string;
    role: string;
}

export interface CompartmentSearchResult {
    source: "compartment";
    content: string;
    score: number;
    compartmentId: number;
    sessionId: string;
    title: string;
    startOrdinal: number;
    endOrdinal: number;
    matchType: "semantic" | "hybrid";
    snippet?: string;
}

export interface GitCommitSearchResult {
    source: "git_commit";
    content: string;
    score: number;
    sha: string;
    shortSha: string;
    author: string | null;
    committedAtMs: number;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface ExternalSearchResult {
    source: "external";
    content: string;
    score: number;
    category?: string;
}

export type UnifiedSearchResult =
    | MemorySearchResult
    | MessageSearchResult
    | CompartmentSearchResult
    | GitCommitSearchResult
    | ExternalSearchResult;

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_UNIFIED_SEARCH_LIMIT;
    }
    return Math.max(1, Math.floor(limit));
}

function normalizeCosineScore(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }

    return Math.min(1, Math.max(0, score));
}

function previewText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= RESULT_PREVIEW_LIMIT) {
        return normalized;
    }
    return `${normalized.slice(0, RESULT_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

interface SearchWorkspaceContext {
    identities: string[];
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
    namesByIdentity: Map<string, string>;
    canonicalIdentityByStoredPath: Map<string, string>;
    isWorkspaced: boolean;
}

function resolveSearchWorkspaceContext(
    db: Database,
    projectPath: string,
    identitySet?: WorkspaceIdentitySet,
): SearchWorkspaceContext {
    const resolved = identitySet ?? resolveWorkspaceIdentitySet(db, projectPath);
    const isWorkspaced = resolved.identities.length > 1;
    const expanded = expandWorkspaceIdentitySetWithAliases(db, resolved.identities);
    const expandedIdentities = isWorkspaced ? expanded.expandedIdentities : resolved.identities;
    const canonicalIdentityByStoredPath = isWorkspaced
        ? expanded.canonicalIdentityByStoredPath
        : new Map(resolved.identities.map((identity) => [identity, identity]));
    const ownIdentities = expandedIdentities.filter(
        (identity) => canonicalIdentityByStoredPath.get(identity) === projectPath,
    );
    return {
        identities: resolved.identities,
        expandedIdentities,
        ownIdentities,
        shareCategories: isWorkspaced ? resolveWorkspaceShareCategories(db, projectPath) : null,
        namesByIdentity: resolved.namesByIdentity,
        canonicalIdentityByStoredPath,
        isWorkspaced,
    };
}

function memoryWorkspaceIdentity(memory: Memory, workspace: SearchWorkspaceContext): string | null {
    return resolveStoredPathWorkspaceIdentity(
        memory.projectPath,
        workspace.identities,
        workspace.canonicalIdentityByStoredPath,
    );
}

function sourceNamesForSearchMemories(args: {
    memories: readonly Memory[];
    projectPath: string;
    workspace: SearchWorkspaceContext;
}): Map<number, string> | undefined {
    if (!args.workspace.isWorkspaced) return undefined;
    const sourceNames = new Map<number, string>();
    for (const memory of args.memories) {
        const source = sourceNameForMemory(
            memory.projectPath,
            args.projectPath,
            args.workspace.identities,
            args.workspace.namesByIdentity,
            args.workspace.canonicalIdentityByStoredPath,
        );
        if (source) sourceNames.set(memory.id, source);
    }
    return sourceNames.size > 0 ? sourceNames : undefined;
}

function getMessageSearchStatement(db: Database): PreparedStatement {
    let stmt = messageSearchStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?",
        );
        messageSearchStatements.set(db, stmt);
    }
    return stmt;
}

const ftsRowCountStatements = new WeakMap<Database, PreparedStatement>();
const ftsMatchCountStatements = new WeakMap<Database, PreparedStatement>();

/** Total indexed FTS rows for one session (probe-weight denominator). */
function getSessionFtsRowCount(db: Database, sessionId: string): number {
    let stmt = ftsRowCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT COUNT(*) AS n FROM message_history_fts WHERE session_id = ?");
        ftsRowCountStatements.set(db, stmt);
    }
    const row = stmt.get(sessionId) as { n?: number } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
}

/** Document frequency of one (sanitized) FTS query within a session. */
function countSessionFtsMatches(db: Database, sessionId: string, ftsQuery: string): number {
    let stmt = ftsMatchCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COUNT(*) AS n FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ?",
        );
        ftsMatchCountStatements.set(db, stmt);
    }
    try {
        const row = stmt.get(sessionId, ftsQuery) as { n?: number } | undefined;
        return typeof row?.n === "number" ? row.n : 0;
    } catch {
        // Malformed FTS syntax that survived sanitization — treat as rare.
        return 0;
    }
}

function getMessageOrdinal(value: number | string | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

async function getSemanticScores(args: {
    db: Database;
    projectPath: string;
    memories: Memory[];
    /** Pre-computed query embedding. Pass `null` to skip semantic scoring
     *  (e.g. embedding disabled, query embed failed, runtime not ready).
     *  unifiedSearch is responsible for computing this once and passing the
     *  same vector to memory + git-commit searches so we never embed the
     *  same query twice in parallel. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    workspace?: SearchWorkspaceContext;
}): Promise<Map<number, number>> {
    const semanticScores = new Map<number, number>();

    if (!args.queryEmbedding || args.memories.length === 0) {
        return semanticScores;
    }

    if (!args.workspace?.isWorkspaced) {
        const cachedEmbeddings = getProjectEmbeddings(args.db, args.projectPath);
        const embeddings = await ensureMemoryEmbeddings({
            db: args.db,
            projectIdentity: args.projectPath,
            memories: args.memories,
            existingEmbeddings: cachedEmbeddings,
        });

        for (const memory of args.memories) {
            const memoryEmbedding = embeddings.get(memory.id);
            if (!memoryEmbedding) {
                continue;
            }

            semanticScores.set(
                memory.id,
                normalizeCosineScore(
                    cosineSimilarity(args.queryEmbedding, memoryEmbedding.embedding),
                ),
            );
        }

        return semanticScores;
    }

    if (!args.queryModelId || args.queryModelId === "off") {
        return semanticScores;
    }

    const workspace = args.workspace;
    const memoriesByIdentity = new Map<string, Memory[]>();
    for (const memory of args.memories) {
        const identity = memoryWorkspaceIdentity(memory, workspace);
        if (!identity) continue;
        const list = memoriesByIdentity.get(identity) ?? [];
        list.push(memory);
        memoriesByIdentity.set(identity, list);
    }

    const ownMemories = memoriesByIdentity.get(args.projectPath) ?? [];
    if (ownMemories.length > 0) {
        const ownEmbeddings = getProjectEmbeddings(args.db, args.projectPath);
        await ensureMemoryEmbeddings({
            db: args.db,
            projectIdentity: args.projectPath,
            memories: ownMemories,
            existingEmbeddings: ownEmbeddings,
        });
    }

    for (const identity of workspace.identities) {
        const memberMemories = memoriesByIdentity.get(identity) ?? [];
        if (memberMemories.length === 0) continue;
        const cachedEmbeddings = getProjectEmbeddings(args.db, identity);
        for (const memory of memberMemories) {
            const memoryEmbedding = cachedEmbeddings.get(memory.id);
            if (!memoryEmbedding || memoryEmbedding.modelId !== args.queryModelId) continue;
            semanticScores.set(
                memory.id,
                normalizeCosineScore(
                    cosineSimilarity(args.queryEmbedding, memoryEmbedding.embedding),
                ),
            );
        }
    }

    return semanticScores;
}

function getFtsMatches(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    workspace?: SearchWorkspaceContext;
}): Memory[] {
    try {
        return args.workspace?.isWorkspaced
            ? searchMemoriesFTSUnion(
                  args.db,
                  args.workspace.expandedIdentities,
                  args.query,
                  args.limit,
                  args.workspace.ownIdentities,
                  args.workspace.shareCategories,
              )
            : searchMemoriesFTS(args.db, args.projectPath, args.query, args.limit);
    } catch (error) {
        log(
            `[search] FTS query failed for "${args.query}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
    }
}

function getFtsScores(matches: Memory[]): Map<number, number> {
    return new Map(matches.map((memory, rank) => [memory.id, 1 / (rank + 1)]));
}

function selectSemanticCandidates(args: {
    memories: Memory[];
    projectPath: string;
    ftsMatches: Memory[];
    workspace?: SearchWorkspaceContext;
}): Memory[] {
    if (args.ftsMatches.length === 0) {
        return args.memories;
    }

    const candidateIds = new Set(args.ftsMatches.map((memory) => memory.id));
    const embeddingProjects = args.workspace?.isWorkspaced
        ? args.workspace.identities
        : [args.projectPath];
    for (const projectPath of embeddingProjects) {
        const cachedEmbeddings = peekProjectEmbeddings(projectPath);
        if (!cachedEmbeddings) continue;
        for (const memoryId of cachedEmbeddings.keys()) {
            candidateIds.add(memoryId);
        }
    }

    return args.memories.filter((memory) => candidateIds.has(memory.id));
}

function mergeMemoryResults(args: {
    memories: Memory[];
    semanticScores: Map<number, number>;
    ftsScores: Map<number, number>;
    limit: number;
    visibleMemoryIds?: Set<number> | null;
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
}): MemorySearchResult[] {
    const memoryById = new Map(args.memories.map((memory) => [memory.id, memory]));
    const candidateIds = new Set<number>([...args.semanticScores.keys(), ...args.ftsScores.keys()]);
    const results: MemorySearchResult[] = [];

    for (const id of candidateIds) {
        // Hard-filter: memory is already rendered in <session-history>, so the
        // agent sees it in message[0]. Returning it from ctx_search wastes
        // output tokens and displaces high-signal raw-history hits.
        if (args.visibleMemoryIds?.has(id)) {
            continue;
        }

        const memory = memoryById.get(id);
        if (!memory) {
            continue;
        }

        const semanticScore = args.semanticScores.get(id);
        const ftsScore = args.ftsScores.get(id);
        let score = 0;
        let matchType: MemorySearchResult["matchType"] = "fts";

        if (semanticScore !== undefined && ftsScore !== undefined) {
            score = SEMANTIC_WEIGHT * semanticScore + FTS_WEIGHT * ftsScore;
            matchType = "hybrid";
        } else if (semanticScore !== undefined) {
            score = semanticScore * SINGLE_SOURCE_PENALTY;
            matchType = "semantic";
        } else if (ftsScore !== undefined) {
            score = ftsScore * SINGLE_SOURCE_PENALTY;
            matchType = "fts";
        }

        if (score <= 0) {
            continue;
        }

        results.push({
            source: "memory",
            content: previewText(memory.content),
            score,
            memoryId: memory.id,
            category: memory.category,
            matchType,
            sourceName: args.sourceNameByMemoryId?.get(memory.id),
        });
    }

    return results
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.memoryId - right.memoryId;
        })
        .slice(0, args.limit);
}

async function searchMemories(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    memoryEnabled: boolean;
    /** Pre-computed query embedding (or null if embedding is disabled / failed).
     *  unifiedSearch embeds once and passes the same vector here and to
     *  searchGitCommitsAsync — never embed twice for one query. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    workspace?: SearchWorkspaceContext;
    visibleMemoryIds?: Set<number> | null;
}): Promise<MemorySearchResult[]> {
    if (!args.memoryEnabled) {
        return [];
    }

    const memories = args.workspace?.isWorkspaced
        ? getMemoriesByProjects(
              args.db,
              args.workspace.expandedIdentities,
              ["active", "permanent"],
              Date.now(),
              args.workspace.ownIdentities,
              args.workspace.shareCategories,
          )
        : getMemoriesByProject(args.db, args.projectPath);
    if (memories.length === 0) {
        return [];
    }

    const ftsMatches = getFtsMatches({
        db: args.db,
        projectPath: args.projectPath,
        query: args.query,
        limit: FTS_SEMANTIC_CANDIDATE_LIMIT,
        workspace: args.workspace,
    });
    const ftsScores = getFtsScores(ftsMatches);
    const semanticCandidates = selectSemanticCandidates({
        memories,
        projectPath: args.projectPath,
        ftsMatches,
        workspace: args.workspace,
    });
    const semanticScores = await getSemanticScores({
        db: args.db,
        projectPath: args.projectPath,
        memories: semanticCandidates,
        queryEmbedding: args.queryEmbedding,
        queryModelId: args.queryModelId,
        workspace: args.workspace,
    });

    return mergeMemoryResults({
        memories,
        semanticScores,
        ftsScores,
        limit: args.limit,
        visibleMemoryIds: args.visibleMemoryIds,
        sourceNameByMemoryId: sourceNamesForSearchMemories({
            memories,
            projectPath: args.projectPath,
            workspace: args.workspace ?? {
                identities: [args.projectPath],
                expandedIdentities: [args.projectPath],
                namesByIdentity: new Map(),
                canonicalIdentityByStoredPath: new Map([[args.projectPath, args.projectPath]]),
                ownIdentities: [args.projectPath],
                shareCategories: null,
                isWorkspaced: false,
            },
        }),
    });
}

/** Linear decay message scoring.
 *
 * The old formula (1 / (rank+1)) collapsed quickly: rank-0 = 1.0, rank-1 = 0.5,
 * rank-2 = 0.33, rank-5 = 0.17. In practice only the #1 message hit could
 * compete with boosted memories, so all secondary message matches got buried.
 *
 * Linear decay (1 - rank/limit) keeps signal across the returned window:
 * rank-0 = 1.0, rank-1 = 0.9, rank-2 = 0.8, rank-9 = 0.1. Combined with the
 * bumped MESSAGE_SOURCE_BOOST this lets raw-history hits actually compete. */
function linearDecayScore(rank: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, 1 - rank / total);
}

interface NormalizedMessageRow {
    messageOrdinal: number;
    messageId: string;
    role: string;
    content: string;
}

/** Run one FTS query and return ordinal-cutoff-filtered, validated rows in
 *  bm25 rank order. `ftsQuery` must already be sanitized. */
function runMessageFtsQuery(
    db: Database,
    sessionId: string,
    ftsQuery: string,
    fetchLimit: number,
    cutoff: number | null,
): NormalizedMessageRow[] {
    if (ftsQuery.length === 0) return [];
    const rows = getMessageSearchStatement(db)
        .all(sessionId, ftsQuery, fetchLimit)
        .map((row) => row as MessageSearchRow);

    const result: NormalizedMessageRow[] = [];
    for (const row of rows) {
        const messageOrdinal = getMessageOrdinal(row.messageOrdinal);
        if (
            messageOrdinal === null ||
            typeof row.messageId !== "string" ||
            typeof row.role !== "string" ||
            typeof row.content !== "string"
        ) {
            continue;
        }
        // Skip messages still in the live context (not yet compartmentalized).
        if (cutoff !== null && messageOrdinal > cutoff) {
            continue;
        }
        result.push({
            messageOrdinal,
            messageId: row.messageId,
            role: row.role,
            content: row.content,
        });
    }
    return result;
}

// Reciprocal-rank-fusion constant. 60 is the canonical RRF k; it dampens the
// reward gap between rank-0 and rank-1 so a candidate that appears in several
// probe lists outranks one that tops a single list.
const RRF_K = 60;
// Verbatim containment is worth one extra rank-0 list appearance — the same
// 1/RRF_K currency as the fused lists. The previous flat +0.5 bonus lived 30×
// above the RRF scale (max list contribution is 1/60 ≈ 0.017), so every
// verbatim hit saturated; after divide-by-max normalization all scores
// flattened into a ~0.95–1.0 band, and at the unified layer those ~1.0 scores
// × MESSAGE_SOURCE_BOOST crowded every memory hit out of the result set.
const VERBATIM_RANK_BONUS = 1 / RRF_K;
// Probe discrimination weighting: a probe matching a large share of the
// session's corpus (common acronyms, generic identifiers) carries near-zero
// signal — bm25 over a single common term is nearly flat, so its ranked list
// is noise. Weight each probe list (and its verbatim bonus) by a smooth
// document-frequency falloff: w = 1 / (1 + IDF_FALLOFF · df/N).
// df/N = 0.1% → 0.91, 1% → 0.50, 2% → 0.33, 10% → 0.09.
const IDF_FALLOFF = 100;

/** Smooth document-frequency weight for one probe within a session corpus. */
function probeDiscriminationWeight(df: number, corpusSize: number): number {
    if (corpusSize <= 0 || df <= 0) return 1;
    return 1 / (1 + (IDF_FALLOFF * df) / corpusSize);
}

function searchMessages(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
    /** Only return messages with ordinal ≤ this value. Omit or -1 to search all indexed messages. */
    maxOrdinal?: number;
    /** Literal probes to additionally query (multi-probe recall). Empty = the
     *  original single-query behavior (unchanged for NL queries / hot path). */
    probes?: string[];
}): MessageSearchResult[] {
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    const fetchLimit =
        args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.limit * 3 : args.limit;

    const baseQuery = sanitizeFtsQuery(args.query.trim());
    const probes = args.probes ?? [];

    // No probes → original single-query path, byte-identical scoring. This is
    // the hot path (auto-search) and every plain natural-language query.
    if (probes.length === 0) {
        const filtered = runMessageFtsQuery(
            args.db,
            args.sessionId,
            baseQuery,
            fetchLimit,
            cutoff,
        ).slice(0, args.limit);
        return filtered.map((row, rank) => ({
            source: "message" as const,
            content: previewText(row.content),
            score: linearDecayScore(rank, filtered.length),
            messageOrdinal: row.messageOrdinal,
            messageId: row.messageId,
            role: row.role,
        }));
    }

    // Multi-probe: run the full query plus each literal probe as its OWN FTS
    // query, then RRF-fuse the ranked lists. This recovers messages that
    // contain a literal symbol but not the query's other (AND-joined) tokens.
    // Each probe list is weighted by its discrimination (document frequency):
    // a probe matching 2% of the corpus contributes a third of a rare probe.
    const corpusSize = getSessionFtsRowCount(args.db, args.sessionId);
    const queryLists: Array<{ rows: NormalizedMessageRow[]; weight: number }> = [];
    if (baseQuery.length > 0) {
        queryLists.push({
            rows: runMessageFtsQuery(args.db, args.sessionId, baseQuery, fetchLimit, cutoff),
            // The full query is AND-joined and inherently discriminative.
            weight: 1,
        });
    }
    const probeWeights = new Map<string, number>();
    for (const probe of probes) {
        const probeQuery = sanitizeFtsQuery(probe);
        if (probeQuery.length === 0) continue;
        const df = countSessionFtsMatches(args.db, args.sessionId, probeQuery);
        const weight = probeDiscriminationWeight(df, corpusSize);
        probeWeights.set(probe, weight);
        queryLists.push({
            rows: runMessageFtsQuery(args.db, args.sessionId, probeQuery, fetchLimit, cutoff),
            weight,
        });
    }

    const fused = new Map<string, { row: NormalizedMessageRow; score: number }>();
    for (const list of queryLists) {
        list.rows.forEach((row, rank) => {
            const rrf = list.weight / (RRF_K + rank);
            const existing = fused.get(row.messageId);
            if (existing) {
                existing.score += rrf;
            } else {
                fused.set(row.messageId, { row, score: rrf });
            }
        });
    }

    // Verbatim boost: a message that literally contains a probe is exactly what
    // a symbol/command lookup wants surfaced first. Worth one rank-0 appearance
    // of the BEST (most discriminative) matching probe — rank-domain currency,
    // so it reorders within the band instead of saturating the scale.
    for (const entry of fused.values()) {
        let best = 0;
        for (const probe of probes) {
            const weight = probeWeights.get(probe) ?? 0;
            if (weight > best && containsProbeVerbatim(entry.row.content, [probe])) {
                best = weight;
            }
        }
        if (best > 0) {
            entry.score += best * VERBATIM_RANK_BONUS;
        }
    }

    const ranked = [...fused.values()]
        .sort((a, b) =>
            b.score !== a.score ? b.score - a.score : a.row.messageOrdinal - b.row.messageOrdinal,
        )
        .slice(0, args.limit);

    // Map fused RRF scores into the same linear 0..1 band the single-query path
    // emits (linearDecayScore), so the unified ranker sees comparable scales
    // from both message paths and source boosts behave consistently. Rank is
    // what RRF actually determines; the band keeps cross-source comparability
    // (a rank-0 message no longer pins to exactly 1.0 unless it leads a full
    // result set, and mid-ranked messages no longer all read as ~1.0).
    return ranked.map((entry, rank) => ({
        source: "message" as const,
        content: previewText(entry.row.content),
        score: linearDecayScore(rank, ranked.length),
        messageOrdinal: entry.row.messageOrdinal,
        messageId: entry.row.messageId,
        role: entry.row.role,
    }));
}

function searchCompartmentChunks(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    queryEmbedding: Float32Array | null;
    limit: number;
    maxOrdinal?: number;
    modelId?: string | null;
}): CompartmentSearchResult[] {
    if (!args.queryEmbedding || args.limit <= 0) return [];
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    const rows = loadCompartmentChunkEmbeddingsForSearch(
        args.db,
        args.sessionId,
        args.projectPath,
        args.modelId,
    );
    if (rows.length === 0) return [];

    const byCompartment = new Map<
        number,
        { row: StoredCompartmentChunkEmbedding; score: number }
    >();
    for (const row of rows) {
        if (cutoff !== null && row.endOrdinal > cutoff) {
            continue;
        }
        const score = normalizeCosineScore(cosineSimilarity(args.queryEmbedding, row.vector));
        if (score <= 0) continue;
        const existing = byCompartment.get(row.compartmentId);
        if (!existing || score > existing.score) {
            byCompartment.set(row.compartmentId, { row, score });
        }
    }

    return [...byCompartment.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.row.startOrdinal - right.row.startOrdinal,
        )
        .slice(0, args.limit)
        .map(({ row, score }) => ({
            source: "compartment" as const,
            content: previewText(row.title),
            score: score * SINGLE_SOURCE_PENALTY,
            compartmentId: row.compartmentId,
            sessionId: row.sessionId,
            title: row.title,
            startOrdinal: row.startOrdinal,
            endOrdinal: row.endOrdinal,
            matchType: "semantic" as const,
        }));
}

function mergeMessageAndCompartmentResults(args: {
    messages: MessageSearchResult[];
    compartments: CompartmentSearchResult[];
    limit: number;
}): Array<MessageSearchResult | CompartmentSearchResult> {
    if (args.compartments.length === 0) return args.messages;
    if (args.messages.length === 0) return args.compartments;

    const fused = new Map<
        string,
        {
            result: MessageSearchResult | CompartmentSearchResult;
            score: number;
            tieOrdinal: number;
            snippetScore: number;
        }
    >();

    const add = (
        key: string,
        result: MessageSearchResult | CompartmentSearchResult,
        score: number,
        tieOrdinal: number,
    ) => {
        const existing = fused.get(key);
        if (existing) {
            existing.score += score;
            return existing;
        }
        const entry = { result, score, tieOrdinal, snippetScore: -1 };
        fused.set(key, entry);
        return entry;
    };

    args.compartments.forEach((compartment, rank) => {
        add(
            `compartment:${compartment.compartmentId}`,
            compartment,
            1 / (RRF_K + rank),
            compartment.startOrdinal,
        );
    });

    for (const [rank, message] of args.messages.entries()) {
        const containing = args.compartments.find(
            (compartment) =>
                message.messageOrdinal >= compartment.startOrdinal &&
                message.messageOrdinal <= compartment.endOrdinal,
        );
        const contribution = 1 / (RRF_K + rank);
        if (!containing) {
            add(`message:${message.messageId}`, message, contribution, message.messageOrdinal);
            continue;
        }

        const entry = add(
            `compartment:${containing.compartmentId}`,
            containing,
            contribution,
            containing.startOrdinal,
        );
        if (message.score > entry.snippetScore && entry.result.source === "compartment") {
            entry.snippetScore = message.score;
            entry.result = {
                ...entry.result,
                matchType: "hybrid",
                snippet: message.content,
            };
        }
    }

    const ranked = [...fused.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.tieOrdinal - right.tieOrdinal,
        )
        .slice(0, args.limit);

    return ranked.map((entry, rank) => ({
        ...entry.result,
        score: linearDecayScore(rank, ranked.length),
    }));
}

function getSourceBoost(result: UnifiedSearchResult): number {
    switch (result.source) {
        case "memory":
            return MEMORY_SOURCE_BOOST;
        case "message":
        case "compartment":
            return MESSAGE_SOURCE_BOOST;
        case "git_commit":
            return GIT_COMMIT_SOURCE_BOOST;
        case "external":
            // Below curated memories (1.3) — local rows outrank external
            // matches when the two are even close, which is the safe default
            // (a verified local fact is more authoritative than an external
            // recall of an older, possibly stale statement).
            return 1.0;
    }
}

function compareUnifiedResults(left: UnifiedSearchResult, right: UnifiedSearchResult): number {
    const leftEffective = left.score * getSourceBoost(left);
    const rightEffective = right.score * getSourceBoost(right);

    if (rightEffective !== leftEffective) {
        return rightEffective - leftEffective;
    }

    if (left.source === "memory" && right.source === "memory") {
        return left.memoryId - right.memoryId;
    }

    if (left.source === "message" && right.source === "message") {
        return left.messageOrdinal - right.messageOrdinal;
    }

    if (left.source === "compartment" && right.source === "compartment") {
        return left.startOrdinal - right.startOrdinal;
    }

    if (left.source === "git_commit" && right.source === "git_commit") {
        // Newer commits win ties.
        return right.committedAtMs - left.committedAtMs;
    }

    if (left.source === "external" && right.source === "external") {
        return left.content.localeCompare(right.content);
    }

    return 0;
}

function toGitCommitResult(hit: GitCommitSearchHit): GitCommitSearchResult {
    return {
        source: "git_commit",
        content: previewText(hit.commit.message),
        score: hit.score,
        sha: hit.commit.sha,
        shortSha: hit.commit.shortSha,
        author: hit.commit.author,
        committedAtMs: hit.commit.committedAtMs,
        matchType: hit.matchType,
    };
}

function searchGitCommits(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    /** Pre-computed query embedding (or null if embedding is disabled / failed).
     *  unifiedSearch embeds once and passes the same vector here and to
     *  searchMemories — never embed twice for one query. */
    queryEmbedding: Float32Array | null;
}): GitCommitSearchResult[] {
    if (args.limit <= 0) return [];

    const hits = searchGitCommitsSync(args.db, args.projectPath, args.query, {
        limit: args.limit,
        queryEmbedding: args.queryEmbedding,
    });
    return hits.map(toGitCommitResult);
}

const EXTERNAL_SEARCH_TIMEOUT_MS = 5_000;

async function searchExternal(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    projectName?: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
}): Promise<ExternalSearchResult[]> {
    // Tighter bound than the backend's 10s fetch timeout: an explicit tool
    // call shouldn't hang on a slow Hindsight.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXTERNAL_SEARCH_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort();
    args.signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
        const [project, global] = await Promise.all([
            recallFromExternalBackend(
                {
                    query: args.query,
                    scope: "project",
                    projectIdentity: args.projectPath,
                    ...(args.projectName ? { projectName: args.projectName } : {}),
                    limit: args.limit,
                },
                controller.signal,
            ),
            recallFromExternalBackend(
                { query: args.query, scope: "global", limit: args.limit },
                controller.signal,
            ),
        ]);

        // Drop hits already visible in this session's injected <external-memory>
        // block, and cross-bank duplicates.
        const { snapshot } = readExternalRecallSnapshot(args.db, args.sessionId);
        const injectedHashes = new Set<string>();
        for (const slice of [snapshot?.project, snapshot?.profile, snapshot?.global]) {
            for (const item of slice ?? []) {
                injectedHashes.add(computeNormalizedHash(item.content));
            }
        }
        const seen = new Set<string>();
        const merged: Array<{ content: string; category?: string }> = [];
        for (const hit of [...project, ...global]) {
            const hash = computeNormalizedHash(hit.content);
            if (injectedHashes.has(hash) || seen.has(hash)) continue;
            seen.add(hash);
            merged.push(hit);
        }

        // Rank-based scoring (Hindsight result order is its relevance order).
        const top = merged.slice(0, args.limit);
        return top.map(
            (hit, rank) =>
                ({
                    source: "external" as const,
                    content: previewText(hit.content),
                    score: linearDecayScore(rank, top.length),
                    ...(hit.category ? { category: hit.category } : {}),
                }) satisfies ExternalSearchResult,
        );
    } finally {
        clearTimeout(timeout);
        args.signal?.removeEventListener("abort", onOuterAbort);
    }
}

function resolveSources(sources: SearchSource[] | undefined): Set<SearchSource> {
    if (sources === undefined) {
        // Default: search the three local sources. Facts are deliberately NOT
        // a source — they're always rendered in <session-history> so searching
        // them returns content the agent already sees. External is opt-in via
        // the `sources` arg; the runExternal gate downstream also requires
        // explicitSearch=true so the auto-search hot path never fires an
        // external roundtrip even if a caller lists "external" in the array.
        return new Set<SearchSource>(["memory", "message", "git_commit"]);
    }
    const set = new Set<SearchSource>();
    for (const source of sources) {
        if (
            source === "memory" ||
            source === "message" ||
            source === "git_commit" ||
            source === "external"
        ) {
            set.add(source);
        }
    }
    return set;
}

export async function unifiedSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult[]> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        return [];
    }

    const limit = normalizeLimit(options.limit);
    const tierLimit = Math.max(limit * 3, DEFAULT_UNIFIED_SEARCH_LIMIT);

    const embeddingEnabled = options.embeddingEnabled ?? true;
    const embedQuery = options.embedQuery ?? embedText;
    const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? isEmbeddingEnabled;
    const gitCommitsEnabled = options.gitCommitsEnabled ?? false;
    const activeSources = resolveSources(options.sources);

    const memoryFeatureEnabled = options.memoryEnabled ?? true;
    const runMemory = activeSources.has("memory") && memoryFeatureEnabled;
    const runMessages = activeSources.has("message");
    const runGitCommits = activeSources.has("git_commit") && gitCommitsEnabled;
    const runCompartmentChunks = runMessages && memoryFeatureEnabled && embeddingEnabled;

    // External recall is opt-in AND explicit-only: the auto-search hot path
    // (every user prompt hint) MUST NOT fire an external roundtrip. The
    // `options.sources === undefined` clause means callers who pass no
    // `sources` arg still get external on explicit searches; the auto-search
    // caller never sets `explicitSearch`, so the gate short-circuits there.
    const externalEnabled = options.externalSearchEnabled ?? isExternalSearchEnabled();
    const runExternal =
        externalEnabled &&
        options.explicitSearch === true &&
        (options.sources === undefined || activeSources.has("external"));

    // Embed the query ONCE at the top — both memory and git-commit searches
    // need the same vector. Previously each search called `embedQuery`
    // independently, producing two parallel HTTP requests for the same
    // input text (visible in LMStudio logs as duplicate `/v1/embeddings`
    // entries) which serialized at the model and doubled latency on
    // single-GPU embedding endpoints.
    //
    // We start the embed BEFORE running the synchronous `searchMessages`
    // path. JavaScript evaluates `Promise.all` arguments left-to-right, so
    // any synchronous call inside an arg expression blocks the event loop
    // and prevents in-flight `fetch()` work from being processed by the
    // runtime — even though the request was technically dispatched. On
    // long sessions `searchMessages` can do seconds of indexing work
    // (`ensureMessagesIndexed` walks raw OpenCode session history); doing
    // that BEFORE the embed call meant the embed fetch couldn't start
    // until indexing finished.
    const needsEmbedding =
        (runMemory || runGitCommits || runCompartmentChunks) &&
        embeddingEnabled &&
        isEmbeddingRuntimeEnabled();

    const queryEmbeddingPromise: Promise<Float32Array | null> = needsEmbedding
        ? embedQuery(trimmedQuery, options.signal).catch((error) => {
              log(
                  `[search] query embedding failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              return null;
          })
        : Promise.resolve(null);

    // Yield to the event loop so the embed fetch's request gets a chance
    // to be dispatched at the runtime level before we run any synchronous
    // work. This is the crucial line that unblocks the auto-search 3-second
    // delay observed in production: without it, `searchMessages` runs
    // before the embed fetch is processed, and the embedding HTTP request
    // doesn't actually leave the process until we await later.
    await Promise.resolve();

    // Run the synchronous message-FTS SELECT now that the embed fetch is
    // in flight. Message indexing is event-driven and never runs here;
    // unreconciled sessions simply return no message hits until the async
    // first-touch reconciliation finishes.
    // Multi-probe recall is opt-in for explicit searches only. NL queries
    // yield no probes, so this is a no-op for them regardless of the flag.
    const messageProbes = options.explicitSearch ? extractLiteralProbes(trimmedQuery) : [];
    const messageResults: MessageSearchResult[] = runMessages
        ? searchMessages({
              db,
              sessionId,
              query: trimmedQuery,
              limit: tierLimit,
              maxOrdinal: options.maxMessageOrdinal,
              probes: messageProbes,
          })
        : [];

    // Wait for the single embed call (if any) and then run the two
    // embedding-dependent searches in parallel using the same vector.
    const queryEmbedding = await queryEmbeddingPromise;
    const workspace = resolveSearchWorkspaceContext(db, projectPath);
    const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
    const embeddingModelId = embeddingSnapshot?.modelId;
    const chunkModelId = embeddingSnapshot?.chunkModelId;
    const compartmentResults = runCompartmentChunks
        ? searchCompartmentChunks({
              db,
              sessionId,
              projectPath,
              queryEmbedding,
              limit: tierLimit,
              maxOrdinal: options.maxMessageOrdinal,
              modelId: chunkModelId && chunkModelId !== "off" ? chunkModelId : null,
          })
        : [];
    const messageLikeResults = mergeMessageAndCompartmentResults({
        messages: messageResults,
        compartments: compartmentResults,
        limit: tierLimit,
    });

    const [memoryResults, gitCommitResults, externalResults] = await Promise.all([
        runMemory
            ? searchMemories({
                  db,
                  projectPath,
                  query: trimmedQuery,
                  limit: tierLimit,
                  memoryEnabled: true,
                  queryEmbedding,
                  queryModelId:
                      embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                  workspace,
                  visibleMemoryIds: options.visibleMemoryIds,
              })
            : Promise.resolve([] as MemorySearchResult[]),
        runGitCommits
            ? Promise.resolve(
                  searchGitCommits({
                      db,
                      projectPath,
                      query: trimmedQuery,
                      limit: tierLimit,
                      queryEmbedding,
                  }),
              )
            : Promise.resolve([] as GitCommitSearchResult[]),
        runExternal
            ? searchExternal({
                  db,
                  sessionId,
                  projectPath,
                  projectName: options.projectName,
                  query: trimmedQuery,
                  limit: tierLimit,
                  signal: options.signal,
              })
            : Promise.resolve([] as ExternalSearchResult[]),
    ]);

    const results = [
        ...memoryResults,
        ...messageLikeResults,
        ...gitCommitResults,
        ...externalResults,
    ]
        .sort(compareUnifiedResults)
        .slice(0, limit);

    // Only count retrievals for explicit agent-driven searches. Plugin-internal
    // automatic surfacing (auto-search hints) should not inflate retrieval_count
    // because the agent may never actually consume the hint.
    const countRetrievals = options.countRetrievals ?? true;
    if (countRetrievals) {
        const memoryIds = results
            .filter((result): result is MemorySearchResult => result.source === "memory")
            .map((result) => result.memoryId);

        if (memoryIds.length > 0) {
            db.transaction(() => {
                for (const memoryId of memoryIds) {
                    updateMemoryRetrievalCount(db, memoryId);
                }
            })();
        }
    }

    return results;
}
