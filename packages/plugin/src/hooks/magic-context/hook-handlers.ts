import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import {
    clearSessionTracking,
    scheduleIncrementalIndex,
    scheduleReconciliation,
} from "../../features/magic-context/message-index-async";
import type { SkillMemoryConfig } from "../../features/magic-context/skill-memory/frontmatter";
import { recallSkillMemoryBlock } from "../../features/magic-context/skill-memory/recall";
import { clearPersistedReasoningWatermark } from "../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    clearDetectedContextLimit,
    clearEmergencyDropSample,
    clearEmergencyRecovery,
    clearHistorianFailureState,
    getLastNudgeLevel,
    getLastNudgeUndropped,
    resetLastNudgeCycle,
    setLastNudgeLevel,
    setLastNudgeUndropped,
} from "../../features/magic-context/storage-meta-persisted";
import { clearSidebarSnapshotCache } from "../../plugin/sidebar-snapshot-cache";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { clearAutoSearchForSession } from "./auto-search-runner";
import {
    buildChannel1Reminder,
    CHANNEL1_SENTINEL,
    type Channel1State,
    computePressure,
    decideChannel1,
    toolOutputTokens,
} from "./ctx-reduce-nudge";
import {
    getMessageUpdatedAssistantInfo,
    getMessageUpdatedInfo,
    getSessionProperties,
} from "./event-payloads";
import { resolveSessionId as resolveEventSessionId } from "./event-resolvers";
import {
    clearNoteNudgeTriggerAndCooldown,
    onNoteTrigger,
    resetNoteNudgeCooldownOnly,
} from "./note-nudger";
import { readRawSessionMessageById, readRawSessionMessages } from "./read-session-chunk";
import { normalizeTodoStateJson } from "./todo-view";

export type LiveModelBySession = Map<string, { providerID: string; modelID: string }>;
export type VariantBySession = Map<string, string | undefined>;
export type AgentBySession = Map<string, string>;

/**
 * Cache-busting signal sets — replaces the old monolithic `flushedSessions`.
 *
 * The old `Set<string>` conflated three independent lifetimes into one flag,
 * which caused defer passes blocked by an in-progress historian to keep
 * re-firing the same flush signal across multiple turns (Oracle review,
 * 2026-04-26). Each set now has exactly one consumer and one lifetime.
 *
 * Design rule: every producer that wants to refresh state should `add` to
 * EVERY set whose consumer needs to react. Consumers are responsible for
 * draining their own set after they consume the signal.
 */

/**
 * One-shot: signals that `<session-history>` (compartments + facts +
 * memories block in `message[0]`) needs to be rebuilt on the very next
 * pass. Consumed by `prepareCompartmentInjection()` in `transform.ts`,
 * which drains the entry after invocation regardless of whether a rebuild
 * actually occurred — the next defer pass MUST hit the cache.
 *
 * Producers: `/ctx-flush`, real variant change, system-prompt hash change,
 * explicit user refresh paths (flush/recomp/variant/system-prompt hash).
 * Background historian/compressor publications use DeferredHistoryRefreshSessions.
 *
 * NOT a producer: the background compressor — its output deliberately
 * lands on the next natural cache-bust pass instead of forcing one.
 */
export type HistoryRefreshSessions = Set<string>;

/** Persistent deferred history refresh from background historian/compressor publication. */
export type DeferredHistoryRefreshSessions = Set<string>;

/**
 * One-shot: signals that the system-prompt adjuncts (project docs, user
 * profile, key files, sticky date) should be re-read from disk on the
 * very next system-transform call. Consumed by `system-prompt-hash.ts`,
 * which drains the entry after refreshing.
 *
 * Producers: `/ctx-flush`, real variant change, system-prompt hash change.
 *
 * NOT a producer: historian/compressor/recomp — those don't change disk
 * adjuncts, so refreshing them would burn IO for no reason.
 */
export type SystemPromptRefreshSessions = Set<string>;

/**
 * Persistent: signals that there are queued user `ctx_reduce` ops or
 * pending heuristic-cleanup work that MUST run, even if the current pass
 * can't safely run heuristics yet (e.g. a compartment run is active).
 * Consumed and drained by `transform-postprocess-phase.ts` only after
 * `shouldRunHeuristics` actually executes — survives any number of
 * blocked passes until the materialization succeeds.
 *
 * Producers: `/ctx-flush`, real variant change, system-prompt hash change,
 * explicit user refresh paths (flush/recomp/variant/system-prompt hash).
 * Background historian publications use DeferredMaterializationSessions.
 *
 * Why historian/recomp produce here too: those publish paths queue drop
 * ops via `queueDropsForCompartmentalizedMessages`. The next safe pass
 * needs to materialize those queued drops or context will accumulate.
 */
export type PendingMaterializationSessions = Set<string>;

/** Persistent deferred drop-materialization signal from background historian publication. */
export type DeferredMaterializationSessions = Set<string>;

/**
 * @deprecated Use `HistoryRefreshSessions`, `SystemPromptRefreshSessions`,
 * or `PendingMaterializationSessions` directly. Kept as a type alias only
 * for any external consumers that may still import it. Will be removed in
 * a future major.
 */
export type FlushedSessions = Set<string>;

export type LastHeuristicsTurnId = Map<string, string>;

export function getLiveNotificationParams(
    sessionId: string,
    liveModelBySession: LiveModelBySession,
    variantBySession: VariantBySession,
    agentBySession?: AgentBySession,
): {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
} {
    const model = liveModelBySession.get(sessionId);
    const variant = variantBySession.get(sessionId);
    const agent = agentBySession?.get(sessionId);
    return {
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
        ...(model ? { providerId: model.providerID, modelId: model.modelID } : {}),
    };
}

export function createChatMessageHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    liveModelBySession: LiveModelBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /** Variant changes invalidate `<session-history>` injection cache and
     *  may pair with a different model whose pending drops still need to
     *  materialize — so a real variant flip signals all three sets. */
    historyRefreshSessions: HistoryRefreshSessions;
    systemPromptRefreshSessions: SystemPromptRefreshSessions;
    pendingMaterializationSessions: PendingMaterializationSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    ctxReduceEnabled?: boolean;
    /** E5 — one-time session upgrade reminder. Optional: only wired when the
     *  historian can run (so an upgrade is actually possible). Self-gates. */
    upgradeReminder?: (sessionId: string) => Promise<void>;
}) {
    return async (input: {
        sessionID?: string;
        variant?: string;
        agent?: string;
        model?: { providerID?: string; modelID?: string };
    }) => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        // E5: fire-and-forget one-time upgrade reminder for legacy sessions.
        // Self-gating + model-invisible, so it never affects the prompt prefix.
        if (args.upgradeReminder) {
            void args.upgradeReminder(sessionId);
        }

        if (input.model?.providerID && input.model.modelID) {
            args.liveModelBySession.set(sessionId, {
                providerID: input.model.providerID,
                modelID: input.model.modelID,
            });
        }

        // The tool-heavy "sticky turn reminder" was replaced by the in-turn
        // Channel 1 ctx_reduce nudge (injected into tool outputs). No per-user-turn
        // reminder state to track here anymore.

        const previousVariant = args.variantBySession.get(sessionId);
        args.variantBySession.set(sessionId, input.variant);
        if (input.agent) {
            args.agentBySession.set(sessionId, input.agent);
        }
        if (
            previousVariant !== undefined &&
            input.variant !== undefined &&
            previousVariant !== input.variant
        ) {
            sessionLog(
                sessionId,
                `variant changed (${previousVariant} -> ${input.variant}), triggering flush`,
            );
            args.historyRefreshSessions.add(sessionId);
            args.systemPromptRefreshSessions.add(sessionId);
            args.pendingMaterializationSessions.add(sessionId);
            args.lastHeuristicsTurnId.delete(sessionId);
        }
    };
}

export function createEventHook(args: {
    eventHandler: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
    contextUsageMap: Map<
        string,
        { usage: { percentage: number; inputTokens: number }; updatedAt: number }
    >;
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    liveModelBySession: LiveModelBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /**
     * Cache of resolved session.directory values from `client.session.get(...)`.
     * Cleaned on `session.deleted` to prevent leaks. See live-session-state.ts
     * for the full doc-comment.
     */
    sessionDirectoryBySession: Map<string, string>;
    /** All signal sets are cleaned on `session.deleted` to prevent leaks. */
    historyRefreshSessions: HistoryRefreshSessions;
    deferredHistoryRefreshSessions: DeferredHistoryRefreshSessions;
    systemPromptRefreshSessions: SystemPromptRefreshSessions;
    pendingMaterializationSessions: PendingMaterializationSessions;
    deferredMaterializationSessions: DeferredMaterializationSessions;
    lastHeuristicsTurnId: LastHeuristicsTurnId;
    commitSeenLastPass?: Map<string, boolean>;
    client: PluginContext["client"];
    protectedTags: number;
    ctxReduceEnabled?: boolean;
}) {
    return async (input: { event: { type: string; properties?: unknown } }) => {
        await args.eventHandler(input);

        if (input.event.type === "message.updated") {
            const messageInfo = getMessageUpdatedInfo(input.event.properties);
            if (messageInfo?.messageID) {
                const isTerminalUser = messageInfo.role === "user";
                const isTerminalAssistant =
                    messageInfo.role === "assistant" &&
                    (typeof messageInfo.completedAt === "number" ||
                        typeof messageInfo.finish === "string");
                if (isTerminalUser || isTerminalAssistant) {
                    scheduleIncrementalIndex(
                        args.db,
                        messageInfo.sessionID,
                        messageInfo.messageID,
                        readRawSessionMessageById,
                    );
                }
            }

            const assistantInfo = getMessageUpdatedAssistantInfo(input.event.properties);
            if (assistantInfo?.providerID && assistantInfo?.modelID) {
                const previous = args.liveModelBySession.get(assistantInfo.sessionID);
                args.liveModelBySession.set(assistantInfo.sessionID, {
                    providerID: assistantInfo.providerID,
                    modelID: assistantInfo.modelID,
                });
                // When the model changes (e.g., switching from 128k to 1M context model),
                // clear stale context percentage and historian failure state so the transform
                // doesn't keep using the old model's usage metrics or emergency state.
                if (
                    previous &&
                    (previous.providerID !== assistantInfo.providerID ||
                        previous.modelID !== assistantInfo.modelID)
                ) {
                    // The reasoning watermark is only valid for the model that
                    // produced it. On a switch TO an interleaved-reasoning
                    // provider (e.g. Moonshot/Kimi), replaying the old
                    // watermark would re-clear typed reasoning that OpenCode
                    // must preserve so it can emit `reasoning_content` on the
                    // wire. On a switch BACK to a normal model, keeping the old
                    // watermark would make reasoning cleanup resume from the
                    // previous model's cutoff instead of starting fresh. Clear
                    // it for both forward and backward transitions.
                    sessionLog(
                        assistantInfo.sessionID,
                        `model changed (${previous.providerID}/${previous.modelID} -> ${assistantInfo.providerID}/${assistantInfo.modelID}), clearing historian failure state and reasoning watermark`,
                    );
                    // Don't clear lastContextPercentage/lastInputTokens here — the event handler
                    // already computed the correct percentage using the NEW model's context limit
                    // (via resolveContextLimit with the new providerID/modelID). Clearing would
                    // erase the first valid usage sample from the new model.
                    clearHistorianFailureState(args.db, assistantInfo.sessionID);
                    clearPersistedReasoningWatermark(args.db, assistantInfo.sessionID);
                    // Clear the prior model's detected-overflow limit and the
                    // emergency-recovery flag. The transform has its OWN model-change
                    // branch that clears these, but it never fires on a mid-session
                    // switch: this handler updates liveModelBySession first, so by the
                    // time the transform runs, its knownModel already equals the new
                    // model. transform.ts explicitly delegates mid-session switches to
                    // "the first message.updated to trigger hook-handler clearing" —
                    // so the detected-limit + recovery clears must live HERE too, else
                    // the old model's limit leaks into the new model's pressure math
                    // (e.g. a 120K detected limit kept after switching to a 1M model).
                    clearDetectedContextLimit(args.db, assistantInfo.sessionID);
                    clearEmergencyRecovery(args.db, assistantInfo.sessionID);
                    // The emergency idempotence latch is keyed to the prior model's
                    // ceiling (contextLimit × executeThreshold). A switch to a
                    // smaller model lowers the ceiling, so the latch must reset to
                    // re-evaluate the full tail. For the same delegation reason as
                    // above, the transform-side reset is dead on a live switch —
                    // clear it HERE.
                    clearEmergencyDropSample(args.db, assistantInfo.sessionID);
                    updateSessionMeta(args.db, assistantInfo.sessionID, {
                        clearedReasoningThroughTag: 0,
                        observedSafeInputTokens: 0,
                        cacheAlertSent: false,
                    });
                }
            }
        }

        const properties = getSessionProperties(input.event.properties);
        const sessionId = resolveEventSessionId(properties);
        if (!sessionId) return;

        if (input.event.type !== "session.deleted") {
            scheduleReconciliation(args.db, sessionId, readRawSessionMessages);
        }

        if (input.event.type === "session.deleted") {
            args.liveModelBySession.delete(sessionId);
            args.variantBySession.delete(sessionId);
            args.agentBySession.delete(sessionId);
            args.sessionDirectoryBySession.delete(sessionId);
            args.historyRefreshSessions.delete(sessionId);
            args.deferredHistoryRefreshSessions.delete(sessionId);
            args.systemPromptRefreshSessions.delete(sessionId);
            args.pendingMaterializationSessions.delete(sessionId);
            args.deferredMaterializationSessions.delete(sessionId);
            args.lastHeuristicsTurnId.delete(sessionId);
            args.commitSeenLastPass?.delete(sessionId);
            resetNoteNudgeCooldownOnly(sessionId);
            clearAutoSearchForSession(sessionId);
            clearSidebarSnapshotCache(sessionId);
            clearSessionTracking(sessionId);
        }

        // Historical note: v0.14.1 removed the 80% "context emergency" nudge
        // that fired from message.updated. By the time usage reached 80% the
        // agent had already received 4-8 earlier reduction nudges from the
        // rolling band system and ignored all of them — the emergency nudge
        // was louder but mechanistically identical. Automatic safety valves
        // (85% force-drop-tools in transform-postprocess-phase.ts, 95%
        // block-and-wait-for-historian in transform.ts) keep context from
        // overflowing without depending on agent cooperation, so the nudge
        // was doing more harm than good: firing repeatedly during slow-
        // historian runs (common with Copilot Claude) and mutating the
        // active user message via promptAsync every time.
    };
}

export function createCommandExecuteBeforeHook(commandHandler: {
    "command.execute.before": (
        input: import("./command-handler").CommandExecuteInput,
        output: import("./command-handler").CommandExecuteOutput,
        params: { agent?: string; variant?: string; providerId?: string; modelId?: string },
    ) => Promise<unknown>;
}) {
    return async (input: unknown, output: unknown) => {
        const typedInput = input as import("./command-handler").CommandExecuteInput & {
            agent?: string;
            variant?: string;
            providerID?: string;
            modelID?: string;
        };
        const params = {
            agent: typedInput.agent,
            variant: typedInput.variant,
            providerId: typedInput.providerID,
            modelId: typedInput.modelID,
        };
        return commandHandler["command.execute.before"](
            typedInput as import("./command-handler").CommandExecuteInput,
            output as import("./command-handler").CommandExecuteOutput,
            params,
        );
    };
}

/**
 * Channel 1: append a ctx_reduce `<system-reminder>` to a native/plugin tool's
 * string `output.output` when the metric warrants it. Mutating `output.output`
 * here is persisted by OpenCode and replayed verbatim, so this is "free sticky"
 * — no anchor store / CAS / replay machinery. Native + plugin tools deliver a
 * string `output.output`; true MCP-server tools (`result.content[]`) are skipped.
 */
function maybeInjectChannel1Nudge(
    args: {
        db: Parameters<typeof getOrCreateSessionMeta>[0];
        channel1StateBySession: Map<string, Channel1State>;
    },
    sessionId: string,
    tool: string,
    output: unknown,
): void {
    const state = args.channel1StateBySession.get(sessionId);
    // No baseline → ctx_reduce is disabled for this session (primary with
    // ctx_reduce off). Both primaries and subagents with ctx_reduce enabled get
    // a baseline (set in transform.ts), so both can receive Channel 1 nudges.
    if (!state) return;

    // Output shape guard: only native/plugin tools with a non-empty string output.
    if (output === null || typeof output !== "object") return;
    const out = output as { output?: unknown };
    if (typeof out.output !== "string" || out.output.length === 0) return;

    // Content-based idempotency (robust to callID reuse on retries).
    if (out.output.includes(CHANNEL1_SENTINEL)) return;

    // Accumulate this tool's tokens into the per-turn accumulator (prospective:
    // this output is not yet tagged/counted in the baseline).
    const thisTurnTokens = toolOutputTokens(out.output);
    state.turnToolTokens += thisTurnTokens;

    if (state.reducedSinceRefresh) return; // suppress nagging right after a reduce

    const undroppedTokens = state.tailToolTokens + state.turnToolTokens;
    const pressure = computePressure({
        lastInputTokens: state.lastInputTokens,
        turnToolTokens: state.turnToolTokens,
        contextLimit: state.contextLimit,
        executeThresholdPercentage: state.executeThresholdPercentage,
    });

    const workingWindowTokens = Math.round(
        (state.contextLimit * state.executeThresholdPercentage) / 100,
    );
    const decision = decideChannel1({
        undroppedTokens,
        pressure,
        workingWindowTokens,
        lastNudgeUndropped: getLastNudgeUndropped(args.db, sessionId),
        lastNudgeLevel: getLastNudgeLevel(args.db, sessionId),
        hasRecentReduce: false, // handled by reducedSinceRefresh above
    });

    // Always persist the cadence + band state so a reduce-driven drop re-arms it.
    setLastNudgeUndropped(args.db, sessionId, decision.nextLastNudge);
    setLastNudgeLevel(args.db, sessionId, decision.nextLastNudgeLevel);
    if (!decision.fire) return;

    out.output += buildChannel1Reminder(
        decision.level,
        decision.undroppedTokens,
        state.oldestReclaimableToolTags,
    );
    sessionLog(
        sessionId,
        `channel1 nudge fired: level=${decision.level} undropped~${Math.round(decision.undroppedTokens / 1000)}k tool=${tool}`,
    );
}

// ── intentByCallId stash map ────────────────────────────────────────────────
// Keyed by callID (= options.toolCallId, identical before↔after).
// Bounded: 60s TTL + 256-entry hard cap. The after-hook deletes in a finally;
// this map is the backstop for callIDs whose after-hook never fires (crash,
// swallowed exception, tool error).
// Spike C (Task 0a) confirmed: tool.execute.before fires PRE-validation on
// raw output.args, so intent is present before Effect-Schema strips it.

export type IntentByCallIdMap = Map<string, { intent: string; ts: number }>;

export function createIntentByCallIdMap(): IntentByCallIdMap {
    return new Map();
}

const INTENT_TTL_MS = 60_000;
const INTENT_MAP_CAP = 256;

export function stashIntent(map: IntentByCallIdMap, callId: string, intent: string): void {
    // Sweep stale entries (TTL backstop)
    const now = Date.now();
    for (const [key, entry] of map) {
        if (now - entry.ts > INTENT_TTL_MS) {
            map.delete(key);
        }
    }
    // Hard cap: evict oldest if at limit
    if (map.size >= INTENT_MAP_CAP) {
        let oldestKey: string | undefined;
        let oldestTs = Infinity;
        for (const [key, entry] of map) {
            if (entry.ts < oldestTs) {
                oldestTs = entry.ts;
                oldestKey = key;
            }
        }
        if (oldestKey !== undefined) map.delete(oldestKey);
    }
    map.set(callId, { intent, ts: now });
}

export function getAndDeleteIntent(map: IntentByCallIdMap, callId: string): string | null {
    const entry = map.get(callId);
    if (!entry) return null;
    map.delete(callId);
    return entry.intent;
}

// ── createToolExecuteBeforeHook ─────────────────────────────────────────────

/**
 * Append a <skill-memory> block to output.output when:
 * 1. frontmatterConfig is non-null (skill has skill-memory: enabled: true)
 * 2. Notes exist for this skill in the DB
 * 3. output.output is a non-empty string
 *
 * Delegates to recallSkillMemoryBlock (feature layer) for the shared recall+format core.
 * Append ordering: this runs BEFORE maybeInjectChannel1Nudge (skill-memory
 * content before Channel-1 meta-reminder). See design §2.6.
 */
export async function maybeInjectSkillMemory(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    frontmatterConfig: SkillMemoryConfig | null,
    output: { output?: unknown },
    intent?: string,
): Promise<void> {
    if (typeof output.output !== "string" || output.output.length === 0) return;

    // Delegate to shared recall core (also used by ctx_skill_recall tool)
    const block = await recallSkillMemoryBlock(db, {
        skill: skillId,
        intent,
        scope: tier,
        projectIdentity,
        frontmatterConfig,
    });
    if (block) {
        output.output = `${output.output}\n\n${block}`;
    }
}

export function createToolExecuteBeforeHook(args: { intentByCallId: IntentByCallIdMap }) {
    return async (input: unknown, output?: unknown) => {
        const typedInput = input as { tool?: string; callID?: string };
        const typedOutput = output as { args?: Record<string, unknown> } | undefined;
        if (typedInput.tool !== "skill") return;
        if (!typedInput.callID) return;
        const intent = typedOutput?.args?.intent;
        if (typeof intent !== "string") return;
        stashIntent(args.intentByCallId, typedInput.callID, intent);
    };
}

export function createToolExecuteAfterHook(args: {
    db: Parameters<typeof getOrCreateSessionMeta>[0];
    channel1StateBySession: Map<string, Channel1State>;
    skillLoadRegistry: import("../../features/magic-context/skill-memory/provenance").SkillLoadRegistry;
    /** Resolved session.directory values, used to compute projectIdentity for
     *  the skill-memory recall. The hook's transform pass populates this on
     *  every message turn; on the first skill call before the map is seeded,
     *  we fall back to `defaultDirectory` (deps.directory). */
    sessionDirectoryBySession: Map<string, string>;
    defaultDirectory: string;
    intentByCallId: IntentByCallIdMap;
}) {
    return async (input: unknown, output?: unknown) => {
        const typedInput = input as {
            tool?: string;
            sessionID?: string;
            callID?: string;
            args?: unknown;
        };
        if (!typedInput.sessionID || !typedInput.tool) {
            return;
        }

        // Skill-memory: populate registry when skill tool completes.
        // Frontmatter MUST be read from DISK (proven in Task 0b: opencode's
        // skill loader strips the skill-memory: block from the model-facing
        // output). Reading output.output would always yield null. We re-read
        // SKILL.md from provenance.resolvedPath (which IS present in the
        // output's "Base directory for this skill:" line).
        if (typedInput.tool === "skill") {
            const typedOutput = output as { output?: unknown } | undefined;
            if (typeof typedOutput?.output === "string") {
                const skillArgs = typedInput.args as { name?: unknown } | undefined;
                const skillId = typeof skillArgs?.name === "string" ? skillArgs.name : null;
                if (skillId) {
                    try {
                        const { parseSkillProvenance, registryKey } = await import(
                            "../../features/magic-context/skill-memory/provenance"
                        );
                        const { parseFrontmatterConfig } = await import(
                            "../../features/magic-context/skill-memory/frontmatter"
                        );
                        const provenance = parseSkillProvenance(typedOutput.output, skillId);
                        if (provenance) {
                            let frontmatterConfig:
                                | import("../../features/magic-context/skill-memory/frontmatter").SkillMemoryConfig
                                | null = null;
                            try {
                                const { readFileSync } = await import("node:fs");
                                const rawSkillContent = readFileSync(
                                    provenance.resolvedPath,
                                    "utf-8",
                                );
                                frontmatterConfig = parseFrontmatterConfig(rawSkillContent);
                            } catch {
                                // Non-fatal: SKILL.md unreadable → frontmatterConfig stays null
                                // (skill-memory disabled for this skill load)
                            }
                            args.skillLoadRegistry.set(registryKey(typedInput.sessionID, skillId), {
                                ...provenance,
                                frontmatterConfig,
                            });
                        }
                    } catch {
                        // Non-fatal: registry miss means ctx_skill_note will surface an actionable error
                    }

                    // Skill-memory injection (BEFORE Channel-1 nudge — design §2.6).
                    // Re-read skillId/args from typedInput; resolve sessionDir to
                    // projectIdentity; delegate to maybeInjectSkillMemory which
                    // appends the <skill-memory> block to output.output.
                    // Non-fatal: recall failure must never block the tool result.
                    try {
                        const { registryKey: rKey } = await import(
                            "../../features/magic-context/skill-memory/provenance"
                        );
                        const registryEntry = args.skillLoadRegistry.get(
                            rKey(typedInput.sessionID, skillId),
                        );
                        if (registryEntry) {
                            // First-turn fallback: if the map has no entry yet
                            // (skill tool fires before sessionDirectoryBySession
                            // is populated), fall back to args.defaultDirectory.
                            // Intentional: multi-project / Desktop-launched sessions
                            // may misattribute on the very first skill call;
                            // subsequent calls resolve correctly.
                            const sessionDir =
                                args.sessionDirectoryBySession.get(typedInput.sessionID) ??
                                args.defaultDirectory;
                            const projectIdentity = resolveProjectIdentity(sessionDir);
                            const stashed = typedInput.callID
                                ? (getAndDeleteIntent(args.intentByCallId, typedInput.callID) ??
                                  undefined)
                                : undefined;
                            await maybeInjectSkillMemory(
                                args.db,
                                skillId,
                                registryEntry.tier,
                                projectIdentity,
                                registryEntry.frontmatterConfig,
                                output as { output?: unknown },
                                stashed,
                            );
                        }
                    } catch (error) {
                        sessionLog(
                            typedInput.sessionID,
                            "skill-memory injection failed (ignored):",
                            error,
                        );
                    }
                }
            }
        }

        if (typedInput.tool === "ctx_reduce") {
            // Mark the Channel 1 baseline dirty so the next nudge re-measures the
            // (now smaller) reclaimable tail instead of replaying a stale band.
            const state = args.channel1StateBySession.get(typedInput.sessionID);
            if (state) state.reducedSinceRefresh = true;
            try {
                resetLastNudgeCycle(args.db, typedInput.sessionID);
            } catch (error) {
                sessionLog(typedInput.sessionID, "channel1 reduce reset failed (ignored):", error);
            }
        } else {
            // Channel 1: append an in-turn ctx_reduce nudge to this tool's output
            // when reclaimable space + pressure warrant it. Auto-sticky via
            // OpenCode's DB (the mutated output.output persists + replays). Fully
            // guarded so an injection failure can never block the tool result.
            try {
                maybeInjectChannel1Nudge(args, typedInput.sessionID, typedInput.tool, output);
            } catch (error) {
                sessionLog(
                    typedInput.sessionID,
                    "channel1 nudge injection failed (ignored):",
                    error,
                );
            }
        }
        if (typedInput.tool === "todowrite") {
            // Only trigger note nudge when ALL todo items are terminal (completed/cancelled).
            // Firing on every todowrite is too eager — agents call it repeatedly while working.
            const todoArgs = typedInput.args as { todos?: unknown } | undefined;
            const todos = todoArgs?.todos;
            const sessionMeta = Array.isArray(todos)
                ? getOrCreateSessionMeta(args.db, typedInput.sessionID)
                : null;
            if (sessionMeta && !sessionMeta.isSubagent) {
                const normalizedTodos = normalizeTodoStateJson(todos);
                if (normalizedTodos !== null) {
                    updateSessionMeta(args.db, typedInput.sessionID, {
                        lastTodoState: normalizedTodos,
                    });
                }
            }
            if (
                Array.isArray(todos) &&
                todos.length > 0 &&
                todos.every(
                    (t) =>
                        typeof t === "object" &&
                        t !== null &&
                        ((t as { status?: unknown }).status === "completed" ||
                            (t as { status?: unknown }).status === "cancelled"),
                )
            ) {
                // Subagents never deliver note nudges (gated in postprocess), so don't
                // accumulate orphan trigger state for them.
                if (sessionMeta && !sessionMeta.isSubagent) {
                    onNoteTrigger(args.db, typedInput.sessionID, "todos_complete");
                }
            }
        }
        if (typedInput.tool === "ctx_note") {
            clearNoteNudgeTriggerAndCooldown(args.db, typedInput.sessionID);
        }
    };
}
