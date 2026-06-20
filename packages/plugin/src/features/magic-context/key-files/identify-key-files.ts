import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DREAMER_AGENT } from "../../../agents/dreamer";
import { estimateTokens } from "../../../hooks/magic-context/read-session-formatting";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { getErrorMessage } from "../../../shared/error-message";
import { getHarness } from "../../../shared/harness";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { runWriteTransaction } from "../../../shared/write-transaction";
import { peekLeaseHolderAndExpiry, renewLease } from "../dreamer/lease";
import { recordChildInvocation } from "../subagent-token-capture";
import { isAftAvailable } from "./aft-availability";
import {
    bumpKeyFilesVersion,
    insertResolvedKeyFiles,
    isRelativeProjectFile,
    readCurrentKeyFiles,
    resolveCommitFiles,
    resolveProjectPath,
    sha256,
} from "./project-key-files";
import { collectKeyFileCandidates, type KeyFileCandidate } from "./read-history";
import { type FileReadStat, getSessionReadStats } from "./read-stats";
import { greedyFitFiles, setKeyFiles } from "./storage-key-files";

export const KEY_FILES_SYSTEM_PROMPT =
    "You are a file importance evaluator. Given read statistics about files in a coding session, identify which are core orientation files worth pinning in context. Return a JSON array.";

/**
 * Build the LLM prompt for key file identification.
 * Called from the dreamer runner which handles session creation.
 */
export function buildKeyFilesPrompt(
    candidates: FileReadStat[],
    tokenBudget: number,
    minReads: number,
): string {
    const statsText = candidates
        .map(
            (s) =>
                `- **${s.filePath}** — ${s.fullReadCount} full reads, ${s.editCount} edits, ~${s.latestReadTokens} tokens`,
        )
        .join("\n");

    return `## Identify Key Files for Pinning

The following files were fully read ${minReads}+ times during a coding session.
Identify which ones are **core orientation files** worth keeping permanently in context.

### Signals of a core orientation file:
- Read many times across different phases of work (not clustered in one task)
- Read without editing — consulted for understanding, not modification
- Contains architecture, configuration, types, or key abstractions

### Signals of a NON-core file (exclude):
- Read many times but always edited — actively working on it
- Very large (>5000 tokens) — too expensive to pin
- Test files, scripts, or generated files

### Token budget: ${tokenBudget} tokens total

### Files:
${statsText}

### Output Format
Return a JSON array ranked by importance (most important first):
\`\`\`json
[
  {"filePath": "src/path/to/file.ts", "tokens": 2500, "reason": "brief reason"}
]
\`\`\`

Only include files you're confident are true orientation files. Return empty array if none qualify.`;
}

/**
 * Parse the LLM's response into a ranked file list.
 */
export function parseKeyFilesOutput(text: string): Array<{ filePath: string; tokens: number }> {
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
        const raw = jsonMatch[1] ?? jsonMatch[0];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];

        return parsed
            .filter(
                (item: unknown): item is { filePath: string; tokens: number } =>
                    typeof item === "object" &&
                    item !== null &&
                    typeof (item as Record<string, unknown>).filePath === "string" &&
                    typeof (item as Record<string, unknown>).tokens === "number",
            )
            .map((item) => ({ filePath: item.filePath, tokens: item.tokens }));
    } catch {
        return [];
    }
}

/**
 * Get candidate files for key-file analysis from OpenCode's DB.
 * Returns files with full reads >= minReads and size under half the budget.
 */
export function getKeyFileCandidates(
    openCodeDb: Database,
    sessionId: string,
    minReads: number,
    tokenBudget: number,
    projectDirectory?: string,
): FileReadStat[] {
    const stats = getSessionReadStats(openCodeDb, sessionId, minReads);
    const maxPerFileTokens = Math.min(tokenBudget / 2, 5000);
    // Filter to files within the project directory — long-running sessions may have
    // read files from other repos, which should not be pinned as key files.
    // Use the authoritative realpath + segment-aware containment check
    // (isRelativeProjectFile), NOT a naive string prefix: a bare `startsWith`
    // is not symlink-safe, not case-normalized, and not segment-aware, so an
    // out-of-project path could be seeded into the Dreamer prompt before the
    // commit-time validator runs. isRelativeProjectFile takes a project-relative
    // path, so convert the absolute read path first and reject anything that
    // resolves outside the project root.
    return stats.filter((s) => {
        if (!(s.latestReadTokens > 0 && s.latestReadTokens <= maxPerFileTokens)) {
            return false;
        }
        if (!projectDirectory) return true;
        const rel = isAbsolute(s.filePath) ? relative(projectDirectory, s.filePath) : s.filePath;
        return isRelativeProjectFile(projectDirectory, rel);
    });
}

/**
 * Apply LLM-ranked results through the knapsack solver and persist.
 */
export function applyKeyFileResults(
    db: Database,
    sessionId: string,
    llmRanked: Array<{ filePath: string; tokens: number }>,
    tokenBudget: number,
    candidatePaths?: Set<string>,
): { filesIdentified: number; totalTokens: number } {
    // Filter LLM output to only include files that were in the candidate set.
    // Prevents hallucinated paths from being pinned.
    const filtered = candidatePaths
        ? llmRanked.filter((f) => candidatePaths.has(f.filePath))
        : llmRanked;
    const selected = greedyFitFiles(filtered, tokenBudget);
    setKeyFiles(db, sessionId, selected);

    const totalTokens = selected.reduce((sum, f) => sum + f.tokens, 0);
    log(
        `[key-files][${sessionId}] pinned ${selected.length} files (${totalTokens} tokens): ${selected.map((f) => f.filePath).join(", ")}`,
    );

    return { filesIdentified: selected.length, totalTokens };
}

/**
 * Pure heuristic fallback when LLM is unavailable.
 * Ranks by: high read count, low edit count, reasonable size.
 */
export function heuristicKeyFileSelection(
    db: Database,
    sessionId: string,
    candidates: FileReadStat[],
    tokenBudget: number,
): { filesIdentified: number; totalTokens: number } {
    const scored = candidates
        .map((c) => ({
            filePath: c.filePath,
            tokens: c.latestReadTokens,
            score: c.fullReadCount * 2 - c.editCount * 3,
        }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

    const selected = greedyFitFiles(scored, tokenBudget);
    setKeyFiles(db, sessionId, selected);

    const totalTokens = selected.reduce((sum, f) => sum + f.tokens, 0);
    log(
        `[key-files][${sessionId}] heuristic pinned ${selected.length} files (${totalTokens} tokens)`,
    );

    return { filesIdentified: selected.length, totalTokens };
}

export interface V6KeyFilesConfig {
    enabled: boolean;
    token_budget: number;
    min_reads: number;
}

export interface ValidatedKeyFilesOutput {
    no_change: boolean;
    files: Array<{
        path: string;
        content: string;
        approx_token_estimate: number;
        local_token_estimate: number;
    }>;
}

export class KeyFilesValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "KeyFilesValidationError";
    }
}

export function computeGenerationConfigHash(
    config: Pick<V6KeyFilesConfig, "token_budget" | "min_reads">,
): string {
    return sha256(JSON.stringify({ budget: config.token_budget, min_reads: config.min_reads }));
}

function extractJsonObject(text: string): string {
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced?.[1]) return fenced[1];
    const object = text.match(/\{[\s\S]*\}/);
    if (object?.[0]) return object[0];
    throw new KeyFilesValidationError("missing JSON object");
}

function formatCandidates(candidates: KeyFileCandidate[]): string {
    return candidates
        .map((candidate) => {
            const ranges = candidate.ranges
                .map((range) => `${range.start}-${range.end} (${range.count}x)`)
                .join(", ");
            return `| ${candidate.path} | ${candidate.totalReads} | ${new Date(candidate.lastReadAt).toISOString()} | ${ranges || "full reads"} |`;
        })
        .join("\n");
}

function buildV6KeyFilesPrompt(args: {
    candidates: KeyFileCandidate[];
    currentRows: ReturnType<typeof readCurrentKeyFiles>;
    config: V6KeyFilesConfig;
}): string {
    const current = args.currentRows
        .map(
            (row) =>
                `- ${row.path}: ${row.localTokenEstimate} tokens, stale=${row.staleReason ?? "fresh"}`,
        )
        .join("\n");
    return `## Task: Identify project key files

You are deciding which files this project's primary agent should always see as orientation context. The injection budget is **${args.config.token_budget} tokens** for all files combined.

## Read history (primary sessions only, project-scoped)

| path | total reads | last read | common line ranges |
| --- | ---: | --- | --- |
${formatCandidates(args.candidates)}

## Current key files (if any)

${current || "(none)"}

## Tools available

- \`aft_outline(target=<path>)\` — get symbol outline for a file
- \`aft_zoom(filePath=<path>, symbol=<name>)\` — get full source of one symbol

## Output (strict JSON)

\`\`\`json
{
  "no_change": false,
  "files": [
    {
      "path": "src/example.ts",
      "content": "...outline + symbol bodies stitched from src/example.ts only...",
      "approx_token_estimate": 1200
    }
  ]
}
\`\`\`

If current key files are still optimal, return \`{ "no_change": true, "files": [] }\`.

Rules:
- Each row's content MUST come from ONLY the one file at path. If two files matter, emit two rows.
- Do NOT emit source_files. One row = one file = one hash.
- Total approx_token_estimate must be < ${args.config.token_budget}.
- path must be relative, no .., no absolute paths, no symlinks escaping project root.
- path must be unique case-sensitively and case-insensitively.
- content must be plain text; no XML tags inside.
- DO NOT pick prose documentation (README.md, CONTRIBUTING.md, CHANGELOG, LICENSE, *.md/*.mdx/*.rst/*.txt) or lockfiles. Key files are project SOURCE the agent needs repeated orientation context on, not reference docs. Project docs are surfaced through a separate injection path.`;
}

/**
 * Documentation / lockfile / non-source paths that must never be persisted as
 * key files even if the LLM emits them. The Dreamer prompt forbids these, but
 * a non-compliant or prompt-injected response must be rejected in code too —
 * key files are stitched into every future prompt, so the persisted set is a
 * trust boundary, not a suggestion. Matched case-insensitively on the path.
 */
const DISALLOWED_KEY_FILE_PATTERN =
    /(?:^|\/)(?:readme|contributing|changelog|license|licence|code_of_conduct|authors|notice)\b|\.(?:md|mdx|rst|txt|lock)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|bun\.lockb|cargo\.lock|poetry\.lock|gemfile\.lock|composer\.lock)$/i;

function isDisallowedKeyFilePath(path: string): boolean {
    return DISALLOWED_KEY_FILE_PATTERN.test(path);
}

export function validateLlmOutput(
    raw: string,
    config: V6KeyFilesConfig,
    projectPath: string,
    candidatePaths?: ReadonlySet<string>,
): ValidatedKeyFilesOutput {
    let obj: unknown;
    try {
        obj = JSON.parse(extractJsonObject(raw));
    } catch (error) {
        if (error instanceof KeyFilesValidationError) throw error;
        throw new KeyFilesValidationError(`invalid JSON: ${getErrorMessage(error)}`);
    }
    if (!obj || typeof obj !== "object") throw new KeyFilesValidationError("output must be object");
    const record = obj as Record<string, unknown>;
    if (typeof record.no_change !== "boolean")
        throw new KeyFilesValidationError("missing no_change");
    if (!Array.isArray(record.files)) throw new KeyFilesValidationError("missing files array");
    if (record.no_change && record.files.length > 0)
        throw new KeyFilesValidationError("no_change=true with files");
    if (!record.no_change && record.files.length === 0)
        throw new KeyFilesValidationError("no_change=false with empty files");

    const seen = new Set<string>();
    const seenLower = new Set<string>();
    const files: ValidatedKeyFilesOutput["files"] = [];
    for (const item of record.files) {
        if (!item || typeof item !== "object") throw new KeyFilesValidationError("bad file entry");
        const file = item as Record<string, unknown>;
        if ("source_files" in file) {
            throw new KeyFilesValidationError(
                `source_files field not allowed (one file per row): ${String(file.path)}`,
            );
        }
        if (typeof file.path !== "string" || file.path.length === 0)
            throw new KeyFilesValidationError("bad path");
        // Segment-aware traversal guard (not substring): reject `/abs` and any
        // path segment equal to "..", but allow legitimate names like
        // `types..d.ts`. isRelativeProjectFile below is the authoritative
        // symlink-safe containment check.
        if (
            file.path.startsWith("/") ||
            file.path.split(/[/\\]/).some((segment) => segment === "..")
        )
            throw new KeyFilesValidationError(`escape: ${file.path}`);
        // Enforce the prompt's doc/lockfile ban in code — the persisted key-files
        // set is injected into every future prompt, so an off-prompt or injected
        // response must not slip docs/lockfiles through.
        if (isDisallowedKeyFilePath(file.path))
            throw new KeyFilesValidationError(`doc/lockfile not allowed as key file: ${file.path}`);
        // Enforce candidate-set membership: the LLM may only pin files that were
        // in the read-history-derived candidate set it was shown. Anything else
        // is fabricated/injected and must be rejected (memory: persistence accepts
        // only LLM-selected paths from the candidate allow-set).
        if (candidatePaths && !candidatePaths.has(file.path))
            throw new KeyFilesValidationError(`not in candidate set: ${file.path}`);
        if (seen.has(file.path)) throw new KeyFilesValidationError(`dup path: ${file.path}`);
        if (seenLower.has(file.path.toLowerCase()))
            throw new KeyFilesValidationError(`case-dup: ${file.path}`);
        seen.add(file.path);
        seenLower.add(file.path.toLowerCase());
        if (!isRelativeProjectFile(projectPath, file.path))
            throw new KeyFilesValidationError(`unreadable: ${file.path}`);
        if (typeof file.content !== "string")
            throw new KeyFilesValidationError(`bad content: ${file.path}`);
        if (file.content.length > 100_000)
            throw new KeyFilesValidationError(`content >100KB: ${file.path}`);
        if (typeof file.approx_token_estimate !== "number" || file.approx_token_estimate < 0) {
            throw new KeyFilesValidationError(`bad token estimate: ${file.path}`);
        }
        const local = estimateTokens(file.content);
        if (
            file.approx_token_estimate > 0 &&
            (local / file.approx_token_estimate > 1.5 || local / file.approx_token_estimate < 0.5)
        ) {
            log(
                `key-files: token estimate divergence for ${file.path}: claimed=${file.approx_token_estimate}, plugin=${local}`,
            );
        }
        files.push({
            path: file.path,
            content: file.content,
            approx_token_estimate: file.approx_token_estimate,
            local_token_estimate: local,
        });
    }
    const total = files.reduce((sum, file) => sum + file.local_token_estimate, 0);
    if (total > config.token_budget)
        throw new KeyFilesValidationError(`total ${total} > budget ${config.token_budget}`);
    // Intentional: semantic proof that content was stitched only from `path` is not enforceable here.
    return { no_change: record.no_change, files };
}

export function commitKeyFiles(args: {
    db: Database;
    projectPath: string;
    validated: ValidatedKeyFilesOutput;
    configHash: string;
    modelId: string;
    leaseHolderId: string;
    bumpVersion?: typeof bumpKeyFilesVersion;
}): number | null {
    if (args.validated.no_change) return null;
    const projectPath = resolveProjectPath(args.projectPath) ?? args.projectPath;
    const resolved = resolveCommitFiles(
        projectPath,
        args.validated.files.map((file) => ({
            path: file.path,
            content: file.content,
            localTokenEstimate: file.local_token_estimate,
        })),
    );
    const generatedAt = Date.now();
    const bump = args.bumpVersion ?? bumpKeyFilesVersion;
    return runWriteTransaction(args.db, () => {
        if (!peekLeaseHolderAndExpiry(args.db, args.leaseHolderId)) {
            log(`key-files commit aborted: lease lost (holder ${args.leaseHolderId})`);
            return null;
        }
        args.db.prepare("DELETE FROM project_key_files WHERE project_path = ?").run(projectPath);
        insertResolvedKeyFiles(
            args.db,
            projectPath,
            resolved,
            generatedAt,
            args.modelId,
            args.configHash,
        );
        const version = bump(args.db, projectPath);
        log(
            `key-files committed: ${resolved.length} files, version=${version}, ${resolved.filter((r) => r.staleReason).length} pre-stale`,
        );
        return version;
    });
}

async function runKeyFilesLlm(args: {
    client: PluginContext["client"];
    parentSessionId: string | undefined;
    projectPath: string;
    prompt: string;
    deadline: number;
    fallbackModels?: readonly string[];
}): Promise<{ text: string; messages: unknown[] }> {
    const createResponse = await args.client.session.create({
        body: {
            ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
            title: "magic-context-dream-key-files-v6",
        },
        query: { directory: args.projectPath },
    });
    const created = shared.normalizeSDKResponse(createResponse, null as { id?: string } | null, {
        preferResponseOnMissingData: true,
    });
    const agentSessionId = typeof created?.id === "string" ? created.id : null;
    if (!agentSessionId) throw new Error("Could not create key-file identification session.");
    try {
        await shared.promptSyncWithModelSuggestionRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.projectPath },
                body: {
                    agent: DREAMER_AGENT,
                    system: KEY_FILES_SYSTEM_PROMPT,
                    parts: [{ type: "text", text: args.prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: Math.min(Math.max(0, args.deadline - Date.now()), 5 * 60 * 1000),
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:key-files-v6",
            },
        );
        const messagesResponse = await args.client.session.messages({
            path: { id: agentSessionId },
            query: { directory: args.projectPath, limit: 50 },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const text = extractLatestAssistantText(messages);
        if (!text) throw new Error("Dreamer returned no key-files output.");
        return { text, messages };
    } finally {
        if (!shouldKeepSubagents()) {
            await args.client.session
                .delete({ path: { id: agentSessionId } })
                .catch(() => undefined);
        }
    }
}

export async function runKeyFilesTask(args: {
    db: Database;
    openCodeDb: Database;
    client: PluginContext["client"];
    projectPath: string;
    config: V6KeyFilesConfig;
    holderId: string;
    deadline: number;
    parentSessionId?: string;
    fallbackModels?: readonly string[];
}): Promise<{ committedVersion: number | null; candidates: number; noChange: boolean }> {
    if (!args.config.enabled) return { committedVersion: null, candidates: 0, noChange: false };
    if (!isAftAvailable()) {
        log("[key-files] AFT not available, skipping key-files task");
        return { committedVersion: null, candidates: 0, noChange: false };
    }
    const projectPath = resolveProjectPath(args.projectPath) ?? args.projectPath;
    const candidates = collectKeyFileCandidates({
        openCodeDb: args.openCodeDb,
        magicDb: args.db,
        projectPath,
        minReads: args.config.min_reads,
    });
    if (candidates.length === 0) return { committedVersion: null, candidates: 0, noChange: false };

    const currentRows = readCurrentKeyFiles(args.db, projectPath);
    const configHash = computeGenerationConfigHash(args.config);
    const allRowsFreshAndCurrent =
        currentRows.length > 0 &&
        currentRows.every((row) => {
            if (row.staleReason !== null || row.generationConfigHash !== configHash) return false;
            try {
                return sha256(readFileSync(join(projectPath, row.path))) === row.contentHash;
            } catch {
                return false;
            }
        });
    const currentPaths = new Set(currentRows.map((row) => row.path));
    if (
        allRowsFreshAndCurrent &&
        candidates.every((candidate) => currentPaths.has(candidate.path))
    ) {
        log(`key-files: no_change short-circuit (${currentRows.length} rows fresh)`);
        return { committedVersion: null, candidates: candidates.length, noChange: true };
    }

    const prompt = buildV6KeyFilesPrompt({ candidates, currentRows, config: args.config });
    let validated: ValidatedKeyFilesOutput;
    // Renew the dream lease every 60s while the LLM call is in flight so the
    // commit-time lease check (peekLeaseHolderAndExpiry) sees a live expiry.
    // Without this, key-files runs longer than the 2-minute lease TTL fail at
    // commit time with "lease lost" even though no other holder took over.
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(args.db, args.holderId)) {
                log("[key-files] lease renewal failed during LLM call");
            }
        } catch (error) {
            log(`[key-files] lease renewal threw: ${getErrorMessage(error)}`);
        }
    }, 60_000);
    // Token telemetry for the key-files LLM call (dashboard "key files" row +
    // keep_subagents data collection). The task name MUST match the phase name
    // pushed in the dreamer runner ("key files") so the dashboard maps tokens
    // to the right row.
    let invocationRecorded = false;
    const llmStartedAt = Date.now();
    const recordKeyFilesInvocation = (params: {
        status: "completed" | "failed";
        messages?: unknown[];
        error?: unknown;
    }): void => {
        if (!args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: getHarness(),
            subagent: "dreamer",
            task: "key files",
            startedAt: llmStartedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };
    try {
        try {
            const { text: raw, messages: llmMessages } = await runKeyFilesLlm({
                client: args.client,
                parentSessionId: args.parentSessionId,
                projectPath,
                prompt,
                deadline: args.deadline,
                fallbackModels: args.fallbackModels,
            });
            // The LLM call completed (tokens spent) — record before validation,
            // which is post-processing that can fail independently.
            recordKeyFilesInvocation({ status: "completed", messages: llmMessages });
            validated = validateLlmOutput(
                raw,
                args.config,
                projectPath,
                new Set(candidates.map((candidate) => candidate.path)),
            );
        } catch (error) {
            recordKeyFilesInvocation({ status: "failed", error });
            log(`[key-files] LLM validation failed: ${getErrorMessage(error)}`);
            throw error;
        }
        if (validated.no_change)
            return { committedVersion: null, candidates: candidates.length, noChange: true };
        const committedVersion = commitKeyFiles({
            db: args.db,
            projectPath,
            validated,
            configHash,
            modelId: args.fallbackModels?.[0] ?? "dreamer",
            leaseHolderId: args.holderId,
        });
        renewLease(args.db, args.holderId);
        return { committedVersion, candidates: candidates.length, noChange: false };
    } finally {
        clearInterval(leaseInterval);
    }
}
