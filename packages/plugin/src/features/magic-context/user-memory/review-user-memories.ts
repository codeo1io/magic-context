import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { renewLease } from "../dreamer/lease";
import { DREAMER_SYSTEM_PROMPT } from "../dreamer/task-prompts";
import { removeFromExternalBackend, teeToExternalBackend } from "../memory/external-memory";
import type { ExternalMemoryRemoveItem } from "../memory/external-memory-provider";
import { bumpProjectUserProfileVersion } from "../storage";
import { recordChildInvocation } from "../subagent-token-capture";
import {
    deleteUserMemoryCandidates,
    dismissUserMemory,
    getActiveUserMemories,
    getUserMemoryCandidates,
    insertUserMemory,
    updateUserMemoryContent,
} from "./storage-user-memory";

interface ReviewUserMemoriesArgs {
    db: Database;
    client: PluginContext["client"];
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    deadline: number;
    promotionThreshold: number;
    /** Resolved dreamer fallback chain. */
    fallbackModels?: readonly string[];
}

interface ReviewResult {
    promoted: number;
    merged: number;
    dismissed: number;
    candidatesConsumed: number;
}

export async function reviewUserMemories(args: ReviewUserMemoriesArgs): Promise<ReviewResult> {
    const result: ReviewResult = { promoted: 0, merged: 0, dismissed: 0, candidatesConsumed: 0 };

    const candidates = getUserMemoryCandidates(args.db);
    if (candidates.length < args.promotionThreshold) {
        log(
            `[dreamer] user-memories: ${candidates.length} candidate(s), need ${args.promotionThreshold} — skipping`,
        );
        return result;
    }

    const stableMemories = getActiveUserMemories(args.db);
    log(
        `[dreamer] user-memories: reviewing ${candidates.length} candidate(s) against ${stableMemories.length} stable memorie(s)`,
    );

    const candidateList = candidates
        .map((c) => `- Candidate #${c.id} [session ${c.sessionId.slice(0, 12)}]: "${c.content}"`)
        .join("\n");

    const stableList =
        stableMemories.length > 0
            ? stableMemories.map((m) => `- Memory #${m.id}: "${m.content}"`).join("\n")
            : "(none)";

    const prompt = `## Task: Review User Memory Candidates

You are reviewing behavioral observations about a human user to decide which patterns are real and persistent.

### Current Stable User Memories
${stableList}

### Candidate Observations (from recent historian runs)
${candidateList}

### Instructions

1. Look for **recurring patterns** across multiple candidates — observations that appear independently from different sessions or historian runs indicate a real user trait.
2. A candidate must appear in at least ${args.promotionThreshold} semantically similar variants before promotion.
3. Only promote **truly universal** user traits — communication style, expertise level, review focus, decision-making patterns, working habits.
4. Do NOT promote: project-specific preferences, framework choices, one-off moods, task-local frustrations.
5. If a candidate is semantically equivalent to an existing stable memory, mark it as already covered.
6. If multiple candidates describe the same trait, merge them into one clean statement.
7. If an existing stable memory should be updated based on new evidence, include the update.

### Output Format

Return valid JSON (no markdown fencing):

{
  "promote": [
    { "content": "Clean universal observation text", "candidate_ids": [1, 3, 7] }
  ],
  "update_existing": [
    { "memory_id": 5, "content": "Updated text incorporating new evidence", "candidate_ids": [2] }
  ],
  "dismiss_existing": [
    { "memory_id": 3, "reason": "No longer supported by recent observations" }
  ],
  "consume_candidate_ids": [1, 2, 3, 4, 5, 7, 8]
}

- \`promote\`: new stable memories to create from candidates
- \`update_existing\`: existing stable memories to rewrite with new evidence
- \`dismiss_existing\`: existing stable memories that are no longer valid
- \`consume_candidate_ids\`: ALL candidate IDs that were reviewed (promoted, merged, or rejected) — they will be deleted from the candidate pool

If no promotions are warranted, return empty arrays. Always consume reviewed candidates so they don't accumulate indefinitely.`;

    let agentSessionId: string | null = null;
    const startedAt = Date.now();
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: "opencode",
            // subagent: "dreamer" + task: "user memories" so the dashboard's
            // dream-run token enrichment (filters subagent='dreamer', GROUP BY
            // task) maps this invocation's tokens to the "user memories" row.
            // The task name MUST match the phase name pushed by the dreamer
            // runner. Mirrors the smart-notes precedent.
            subagent: "dreamer",
            task: "user memories",
            startedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };
    const abortController = new AbortController();
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(args.db, args.holderId)) {
                log("[dreamer] user-memories: lease renewal failed — aborting");
                abortController.abort();
            }
        } catch {
            abortController.abort();
        }
    }, 60_000);

    try {
        const createResponse = await args.client.session.create({
            body: {
                ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                title: "magic-context-dream-user-memories",
            },
            query: { directory: args.sessionDirectory },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) {
            const error = new Error("Could not create user memory review session.");
            recordInvocation({ status: "failed", error });
            throw error;
        }

        log(`[dreamer] user-memories: child session created ${agentSessionId}`);

        const remainingMs = Math.max(0, args.deadline - Date.now());
        await shared.promptSyncWithModelSuggestionRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_AGENT,
                    system: DREAMER_SYSTEM_PROMPT,
                    // synthetic: true hides the user-memory review prompt from the TUI
                    // subagent pane while still delivering it to the model. See issue #50.
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: Math.min(remainingMs, 5 * 60 * 1000),
                signal: abortController.signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:user-memories",
            },
        );

        const messagesResponse = await args.client.session.messages({
            path: { id: agentSessionId },
            query: { directory: args.sessionDirectory, limit: 50 },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        recordInvocation({ status: "completed", messages });
        const responseText = extractLatestAssistantText(messages);
        if (!responseText) {
            log("[dreamer] user-memories: no response from review agent");
            return result;
        }

        // Parse the JSON response — try to extract from possible markdown fencing
        const jsonMatch =
            responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ??
            responseText.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) {
            log("[dreamer] user-memories: could not parse JSON from response");
            return result;
        }

        let parsed: {
            promote?: Array<{ content: string; candidate_ids: number[] }>;
            update_existing?: Array<{
                memory_id: number;
                content: string;
                candidate_ids?: number[];
            }>;
            dismiss_existing?: Array<{ memory_id: number; reason?: string }>;
            consume_candidate_ids?: number[];
        };
        try {
            parsed = JSON.parse(jsonMatch[1]);
        } catch {
            log("[dreamer] user-memories: JSON parse failed");
            return result;
        }

        const promotions = (parsed.promote ?? [])
            .map((p) => ({
                content: p.content?.trim() ?? "",
                candidateIds: p.candidate_ids ?? [],
            }))
            .filter((p) => p.content.length > 0);
        // Coerce LLM-provided ids to integers: a stringified id ("5") would
        // pass a truthiness check but miss both the number-keyed snapshot Map
        // (silently skipping the external corrective remove — resurrecting
        // dismissed memories next session) and any strict-typed DB binding.
        const updates = (parsed.update_existing ?? [])
            .map((u) => ({
                memoryId: Number(u.memory_id),
                content: u.content?.trim() ?? "",
            }))
            .filter((u) => Number.isInteger(u.memoryId) && u.memoryId > 0 && u.content.length > 0);
        const dismissals = (parsed.dismiss_existing ?? [])
            .map((d) => ({ ...d, memory_id: Number(d.memory_id) }))
            .filter((d) => Number.isInteger(d.memory_id) && d.memory_id > 0);
        const consumeCandidateIds = parsed.consume_candidate_ids ?? [];

        // Snapshot of pre-mutation content for every stable memory touched by
        // this pass — needed to compute the corrective remove items for the
        // external store AFTER the transaction (the new content is already
        // persisted at that point).
        const stableContentById = new Map(stableMemories.map((m) => [m.id, m.content]));

        args.db.transaction(() => {
            for (const promotion of promotions) {
                insertUserMemory(args.db, promotion.content, promotion.candidateIds);
            }

            for (const update of updates) {
                updateUserMemoryContent(args.db, update.memoryId, update.content);
            }

            for (const dismissal of dismissals) {
                dismissUserMemory(args.db, dismissal.memory_id);
            }

            if (consumeCandidateIds.length > 0) {
                deleteUserMemoryCandidates(args.db, consumeCandidateIds);
            }

            if (promotions.length > 0 || updates.length > 0 || dismissals.length > 0) {
                bumpProjectUserProfileVersion(args.db);
            }
        })();

        result.promoted = promotions.length;
        result.merged = updates.length;
        result.dismissed = dismissals.length;
        result.candidatesConsumed = consumeCandidateIds.length;

        // Corrective propagation (W2): dismissed/updated stable user memories
        // must leave the external store too, or the profile recall slice will
        // resurrect them next session. Updates also re-tee the new content so
        // the fresh text lands in the main bank immediately (the next recall
        // would otherwise still surface the stale content via hash mismatch).
        const removedItems: ExternalMemoryRemoveItem[] = [];
        for (const dismissal of dismissals) {
            const oldContent = stableContentById.get(dismissal.memory_id);
            if (oldContent) {
                removedItems.push({
                    content: oldContent,
                    category: "USER_PROFILE",
                    scope: "user",
                });
            }
        }
        for (const update of updates) {
            const oldContent = stableContentById.get(update.memoryId);
            if (oldContent && oldContent !== update.content) {
                removedItems.push({
                    content: oldContent,
                    category: "USER_PROFILE",
                    scope: "user",
                });
            }
        }
        if (removedItems.length > 0) {
            void removeFromExternalBackend(removedItems);
        }
        if (updates.length > 0) {
            void teeToExternalBackend(
                "dreamer",
                updates.map((update) => ({
                    content: update.content,
                    category: "USER_PROFILE" as const,
                    scope: "user" as const,
                    sourceType: "dreamer" as const,
                })),
            );
        }

        if (promotions.length > 0) {
            void teeToExternalBackend(
                "dreamer",
                promotions.map((promotion) => ({
                    content: promotion.content,
                    category: "USER_PROFILE" as const,
                    scope: "user" as const,
                    sourceType: "dreamer" as const,
                })),
            );
        }

        for (const promotion of promotions) {
            log(`[dreamer] user-memories: promoted "${promotion.content.slice(0, 60)}..."`);
        }
        for (const update of updates) {
            log(`[dreamer] user-memories: updated memory #${update.memoryId}`);
        }
        for (const dismissal of dismissals) {
            log(
                `[dreamer] user-memories: dismissed memory #${dismissal.memory_id} — ${dismissal.reason ?? "no reason"}`,
            );
        }
        if (consumeCandidateIds.length > 0) {
            log(`[dreamer] user-memories: consumed ${result.candidatesConsumed} candidate(s)`);
        }

        return result;
    } catch (error) {
        const errorDescription = describeError(error);
        log(
            `[dreamer] user-memories: review failed: ${errorDescription.brief}`,
            errorDescription.stackHead ? { stackHead: errorDescription.stackHead } : undefined,
        );
        return result;
    } finally {
        clearInterval(leaseInterval);
        if (agentSessionId && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] user-memories: session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}
