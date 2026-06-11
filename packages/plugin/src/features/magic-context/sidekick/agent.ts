import { SIDEKICK_AGENT } from "../../../agents/sidekick";
import type { SidekickConfig } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log, sessionLog } from "../../../shared/logger";
import { resolveFallbackChain } from "../../../shared/resolve-fallbacks";
import { registerSessionParent } from "../session-parent-registry";
import { openDatabase } from "../storage";
import { recordChildInvocation } from "../subagent-token-capture";
import { SIDEKICK_SYSTEM_PROMPT, stripThinkingBlocks } from "./core";

// Re-export the system prompt so existing call sites that import from this
// module keep working. The canonical location is now `./core` so the
// pi-plugin can pull it without depending on OpenCode-specific imports.
export { SIDEKICK_SYSTEM_PROMPT };

export async function runSidekick(deps: {
    client: PluginContext["client"];
    sessionId?: string;
    projectPath: string;
    userMessage: string;
    config: SidekickConfig;
    sessionDirectory?: string;
}): Promise<string | null> {
    const fallbackModels = resolveFallbackChain(SIDEKICK_AGENT, deps.config.fallback_models);
    let agentSessionId: string | null = null;
    const startedAt = Date.now();
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!deps.sessionId || invocationRecorded) return;
        invocationRecorded = true;
        try {
            recordChildInvocation({
                db: openDatabase(),
                parentSessionId: deps.sessionId,
                harness: "opencode",
                subagent: "sidekick",
                startedAt,
                status: params.status,
                messages: params.messages,
                error: params.error,
            });
        } catch (error) {
            sessionLog(deps.sessionId, "subagent token accounting unavailable:", error);
        }
    };

    try {
        const createResponse = await deps.client.session.create({
            body: {
                ...(deps.sessionId ? { parentID: deps.sessionId } : {}),
                title: "magic-context-sidekick",
            },
            query: { directory: deps.sessionDirectory ?? deps.projectPath },
        });
        const createdSession = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;
        if (!agentSessionId) {
            const error = new Error("Sidekick could not create its child session.");
            recordInvocation({ status: "failed", error });
            throw error;
        }

        // Synchronous belt-and-braces alongside the session.created event
        // registration: sidekick's ctx_search calls must resolve to the parent
        // conversation even if async event delivery races the child's first
        // tool call. Cleanup rides session.deleted / LRU eviction.
        if (deps.sessionId) {
            registerSessionParent(agentSessionId, deps.sessionId);
        }

        await shared.promptSyncWithModelSuggestionRetry(
            deps.client,
            {
                path: { id: agentSessionId },
                query: { directory: deps.sessionDirectory ?? deps.projectPath },
                body: {
                    agent: SIDEKICK_AGENT,
                    system:
                        deps.config.system_prompt?.trim() ||
                        deps.config.prompt?.trim() ||
                        SIDEKICK_SYSTEM_PROMPT,
                    // synthetic: true hides the sidekick prompt from the TUI subagent
                    // pane while still delivering it to the model. See issue #50.
                    parts: [{ type: "text", text: deps.userMessage, synthetic: true }],
                },
            },
            { timeoutMs: deps.config.timeout_ms, fallbackModels, callContext: "sidekick" },
        );

        const messagesResponse = await deps.client.session.messages({
            path: { id: agentSessionId },
            query: { directory: deps.sessionDirectory ?? deps.projectPath, limit: 50 },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        recordInvocation({ status: "completed", messages });
        const taskResult = extractLatestAssistantText(messages);
        if (!taskResult) {
            return null;
        }

        const finalText = stripThinkingBlocks(taskResult);
        return finalText.length > 0 ? finalText : null;
    } catch (error) {
        recordInvocation({ status: "failed", error });
        if (deps.sessionId) {
            sessionLog(deps.sessionId, "sidekick failed:", error);
        } else {
            log("[magic-context] sidekick failed:", error);
        }
        return null;
    } finally {
        if (agentSessionId && !shouldKeepSubagents()) {
            await deps.client.session
                .delete({
                    path: { id: agentSessionId },
                })
                .catch((error: unknown) => {
                    log("[magic-context] failed to delete sidekick child session:", error);
                });
        }
    }
}
