export interface TagEntry {
    tagNumber: number;
    messageId: string;
    type: "message" | "tool" | "file";
    status: "active" | "dropped" | "compacted";
    dropMode: "full" | "truncated";
    toolName: string | null;
    inputByteSize: number;
    byteSize: number;
    reasoningByteSize: number;
    sessionId: string;
    /**
     * Caveman compression depth applied to this tag's text part. 0 = none,
     * 1 = lite, 2 = full, 3 = ultra. Only meaningful for `type: "message"`;
     * tool/file tags stay at 0. Used by experimental age-tier caveman
     * heuristic to avoid re-compressing text that already matches the
     * target depth for its age band.
     */
    cavemanDepth: number;
    /**
     * For `type: "tool"` tags: the assistant message id where the
     * underlying tool call was invoked. Identity for a tool tag is the
     * triple `(sessionId, messageId/callID, toolOwnerMessageId)` —
     * including this field disambiguates collisions when OpenCode's
     * per-turn callID counter produces the same id across turns.
     *
     * NULL on:
     *   - all `type: "message"` and `type: "file"` tags (not applicable)
     *   - legacy tool tags written before plugin v0.16.x (the
     *     tag-owner-fix migration v10). The runtime lazily adopts these
     *     orphan rows on first observation; backfill populates them at
     *     plugin startup against the OpenCode DB.
     *
     * See plan v3.3.1 in `.alfonso/plans/tag-owner-fix-plan.md`.
     */
    toolOwnerMessageId: string | null;
}

export interface PendingOp {
    id: number;
    sessionId: string;
    tagId: number;
    operation: "drop";
    queuedAt: number;
}

export interface SessionMeta {
    sessionId: string;
    lastResponseTime: number;
    cacheTtl: string;
    counter: number;
    lastNudgeTokens: number;
    lastNudgeBand: "far" | "near" | "urgent" | "critical" | null;
    lastTransformError: string | null;
    isSubagent: boolean;
    lastContextPercentage: number;
    lastInputTokens: number;
    observedSafeInputTokens: number;
    cacheAlertSent: boolean;
    timesExecuteThresholdReached: number;
    compartmentInProgress: boolean;
    systemPromptHash: string;
    systemPromptTokens: number;
    conversationTokens: number;
    toolCallTokens: number;
    clearedReasoningThroughTag: number;
    toolReclaimWatermark: number;
    lastTodoState: string;
    cachedM0Bytes: Buffer | null;
    cachedM1Bytes: Buffer | null;
    cachedM0ProjectMemoryEpoch: number | null;
    cachedM0WorkspaceFingerprint: string | null;
    cachedM0ProjectUserProfileVersion: number | null;
    cachedM0MaxCompartmentSeq: number | null;
    cachedM0MaxMemoryId: number | null;
    /**
     * Pi message stable-id scheme version (Pi-only; OpenCode ignores it).
     * NULL/0 = legacy index-based `pi-msg-*` ids; >=1 = real-SessionEntry-id
     * scheme. Drives the one-time forced execute+materialize cutover when a
     * session's stored scheme is below PI_STABLE_ID_SCHEME.
     */
    piStableIdScheme: number | null;
    cachedM0MaxMutationId: number | null;
    cachedM0MaxMemoryMutationId: number | null;
    cachedM0ProjectDocsHash: string | null;
    cachedM0MaterializedAt: number | null;
    cachedM0SessionFactsVersion: number | null;
    cachedM0UpgradeState: string | null;
    /** HARD-bust markers: provider-side cache-eviction signals (system/tools/model). */
    cachedM0SystemHash: string | null;
    cachedM0ToolSetHash: string | null;
    cachedM0ModelKey: string | null;
    cachedM0ExternalRecallHash: string | null;
    lastObservedModelKey: string | null;
    lastUsageContextLimit: number;
    priorBoundaryOrdinal: number;
    protectedTailPolicyVersion: number;
    protectedTailDrainWindowStartedAt: number;
    protectedTailDrainTokens: number;
    recoveryNoEligibleHeadCount: number;
    forceEmergencyBypassWindowStart: number;
    forceEmergencyBypassUsed: number;
    upgradeRemindedAt: number | null;
}

export type SchedulerDecision = "execute" | "defer";

export interface ContextUsage {
    percentage: number;
    inputTokens: number;
}
