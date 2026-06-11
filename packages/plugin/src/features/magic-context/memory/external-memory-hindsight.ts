import type { ExternalMemoryConfig } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import { blockedEmbeddingEndpointReason } from "./embedding-ssrf";
import type {
    ExternalMemoryBackend,
    ExternalMemoryMentalModelQuery,
    ExternalMemoryRecallQuery,
    ExternalMemoryRecallResult,
    ExternalMemoryRemoveItem,
    ExternalMemoryRetainItem,
    ExternalMemoryScope,
} from "./external-memory-provider";
import { computeNormalizedHash } from "./normalize-hash";

type HindsightConfig = Extract<ExternalMemoryConfig, { provider: "hindsight" }>;

// Circuit breaker constants — same shape as embedding-openai.ts so a hung
// Hindsight endpoint can't drag every plugin operation through its timeout.
const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 60_000;
const OPEN_DURATION_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

type CircuitState = "closed" | "open" | "half_open";

const RETAIN_CONTEXT =
    "magic-context curated fact store (structured project/user memory, not conversation)";
const PROJECT_BANK_MISSION =
    "Curated long-term memory for one software project, fed by the magic-context plugin: " +
    "project rules, architecture decisions, configuration values, constraints, and naming " +
    "conventions extracted from coding sessions. Facts are pre-deduplicated and pre-curated; " +
    "extract them faithfully without speculation.";

// Project-scoped mental models seeded once per project bank (after the first
// successful retain). Source queries are REFLECT prompts — Hindsight runs them
// on each refresh to keep the document current. mode "delta" preserves stable
// prose; refresh_after_consolidation re-runs after each ingest cycle.
const PROJECT_MENTAL_MODELS: ReadonlyArray<{
    name: string;
    maxTokens: number;
    sourceQuery: string;
}> = [
    {
        name: "project-conventions",
        maxTokens: 800,
        sourceQuery:
            "Project conventions and rules — naming, structure, configuration, " +
            "constraints, and tooling choices extracted from recent coding sessions. " +
            "Surface only items that recur across multiple sessions or are explicitly " +
            "asserted by the user.",
    },
    {
        name: "project-decisions",
        maxTokens: 800,
        sourceQuery:
            "Key architectural and design decisions for this project — what was chosen, " +
            "what was rejected, and the rationale. Focus on durable choices that affect " +
            "future work; ignore one-off trade-offs.",
    },
];

function sanitizeBankSegment(value: string): string {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "project"
    );
}

export class HindsightMemoryBackend implements ExternalMemoryBackend {
    readonly backendId: string;

    private readonly endpoint: string;
    private readonly apiKey: string;
    private readonly projectBankTemplate: string;
    private readonly mainBank: string;
    private readonly staticTags: readonly string[];
    private readonly recallGlobalTags: readonly string[];
    private readonly mentalModelsEnabled: boolean;
    private readonly profileMentalModelNames: Set<string>;
    private initialized = false;
    private readonly ensuredBanks = new Set<string>();
    private readonly seededMentalModelBanks = new Set<string>();

    // Circuit breaker state — copied from OpenAICompatibleEmbeddingProvider.
    private failureTimes: number[] = [];
    private circuitOpenUntil = 0;
    private openLogged = false;
    private halfOpenProbeInFlight = false;

    constructor(config: HindsightConfig) {
        this.endpoint = config.endpoint.replace(/\/+$/, "");
        this.apiKey = config.api_key ?? "";
        this.projectBankTemplate = config.project_bank;
        this.mainBank = config.main_bank;
        this.staticTags = config.tags;
        this.recallGlobalTags = config.recall?.global_tags ?? [];
        this.mentalModelsEnabled = config.recall?.mental_models ?? true;
        this.profileMentalModelNames = new Set(
            (config.recall?.profile_mental_models ?? ["user-preferences"]).map((n) =>
                n.toLowerCase(),
            ),
        );
        this.backendId = `hindsight:${this.endpoint}:${this.mainBank}:${this.projectBankTemplate}`;
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (!this.endpoint || !this.mainBank) {
            log("[magic-context] hindsight backend missing endpoint or main_bank");
            return false;
        }
        const blockedReason = blockedEmbeddingEndpointReason(this.endpoint);
        if (blockedReason) {
            log(`[magic-context] hindsight endpoint blocked: ${blockedReason}`);
            return false;
        }
        this.initialized = true;
        return true;
    }

    resolveBank(item: ExternalMemoryRetainItem): string {
        return this.resolveBankForScope(item.scope, item.projectIdentity, item.projectName);
    }

    private resolveBankForScope(
        scope: ExternalMemoryScope,
        projectIdentity?: string,
        projectName?: string,
    ): string {
        if (scope === "project" && projectIdentity) {
            const id8 = projectIdentity.replace(/^(git:|dir:)/, "").slice(0, 8);
            const name = sanitizeBankSegment(projectName ?? "project");
            return this.projectBankTemplate.replace("{name}", name).replace("{id8}", id8);
        }
        return this.mainBank;
    }

    private documentIdFor(item: {
        scope: ExternalMemoryScope;
        projectIdentity?: string;
        category: string;
        content: string;
    }): string {
        const scopeKey =
            item.scope === "project" ? (item.projectIdentity ?? "project") : item.scope;
        return `mc:${scopeKey}:${item.category}:${computeNormalizedHash(item.content)}`;
    }

    buildMemoryItem(item: ExternalMemoryRetainItem): Record<string, unknown> {
        const scopeTags =
            item.scope === "project" && item.projectIdentity
                ? [
                      `project:${item.projectIdentity}`,
                      ...(item.projectName ? [`project-name:${item.projectName}`] : []),
                  ]
                : [
                      `scope:${item.scope}`,
                      // Origin provenance for globals: distinct origin-* prefix
                      // (NOT project:*, which stays the project-partition axis)
                      // so future filtered recalls can target "globals learned
                      // in project X" without colliding with project items.
                      ...(item.scope === "global" && item.projectIdentity
                          ? [`origin-project:${item.projectIdentity}`]
                          : []),
                      ...(item.scope === "global" && item.projectName
                          ? [`origin-project-name:${item.projectName}`]
                          : []),
                  ];
        // For globals with a known origin, name the project in the extraction
        // context: Hindsight's fact extractor links the project as an ENTITY,
        // so graph retrieval surfaces this memory whenever any session — in
        // any project — recalls with that project's name in the query (the
        // global slice query always carries the current project name).
        const context =
            item.scope === "global" && item.projectName
                ? `${RETAIN_CONTEXT}; recorded while working on the "${item.projectName}" project`
                : RETAIN_CONTEXT;
        return {
            content: item.content,
            context,
            document_id: this.documentIdFor(item),
            metadata: {
                source: "magic-context",
                category: item.category,
                ...(item.projectIdentity ? { project_path: item.projectIdentity } : {}),
                ...(item.sessionId ? { session_id: item.sessionId } : {}),
                ...(item.verifiedAt ? { verified_at: item.verifiedAt } : {}),
            },
            tags: [
                "source:magic-context",
                `category:${item.category}`,
                ...scopeTags,
                ...this.staticTags,
            ],
        };
    }

    async retain(items: ExternalMemoryRetainItem[], signal?: AbortSignal): Promise<number> {
        if (items.length === 0) return 0;
        if (!(await this.initialize())) return 0;
        const byBank = new Map<string, ExternalMemoryRetainItem[]>();
        for (const item of items) {
            const bank = this.resolveBank(item);
            const group = byBank.get(bank);
            if (group) group.push(item);
            else byBank.set(bank, [item]);
        }
        let accepted = 0;
        for (const [bank, group] of byBank) {
            try {
                if (!(await this.ensureBank(bank, signal))) continue;
                const ok = await this.postRetain(bank, group, signal);
                if (ok) {
                    accepted += group.length;
                    // Seed missing project-bank mental models after a successful
                    // retain. The MAIN bank is NEVER seeded — those MMs are
                    // user-curated and the plugin must not modify them.
                    if (bank !== this.mainBank) {
                        void this.ensureProjectMentalModels(bank, group[0]);
                    }
                }
            } catch (error) {
                log(`[magic-context] hindsight retain failed for bank ${bank}:`, error);
            }
        }
        return accepted;
    }

    async recall(
        query: ExternalMemoryRecallQuery,
        signal?: AbortSignal,
    ): Promise<ExternalMemoryRecallResult[]> {
        const scope = query.scope ?? "global";
        if (scope === "project" && !query.projectIdentity) {
            log("[magic-context] hindsight recall: project scope without identity — skipping");
            return [];
        }
        if (!(await this.initialize())) return [];
        const bank = this.resolveBankForScope(scope, query.projectIdentity, query.projectName);
        const filter =
            scope === "user"
                ? { tags: ["scope:user"], tags_match: "any_strict" }
                : scope === "global" && this.recallGlobalTags.length > 0
                  ? { tags: [...this.recallGlobalTags], tags_match: "any" }
                  : {};
        const response = await this.request(
            "POST",
            `/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`,
            {
                query: query.query,
                types: ["world", "observation"],
                budget: "mid",
                ...(query.maxTokens ? { max_tokens: query.maxTokens } : {}),
                ...filter,
            },
            signal,
            { benign404: true },
        );
        if (!response || response.status === 404) return [];
        const body = (await response.json().catch(() => null)) as {
            results?: unknown;
        } | null;
        const rawResults = Array.isArray(body?.results) ? body.results : [];
        const results: ExternalMemoryRecallResult[] = [];
        for (const r of rawResults) {
            if (!r || typeof r !== "object") continue;
            const item = r as { text?: unknown; score?: unknown; tags?: unknown };
            if (typeof item.text !== "string" || item.text.length === 0) continue;
            const tags = Array.isArray(item.tags) ? item.tags : [];
            const categoryTag = tags.find(
                (t): t is string => typeof t === "string" && t.startsWith("category:"),
            );
            results.push({
                content: item.text,
                ...(typeof item.score === "number" ? { score: item.score } : {}),
                ...(categoryTag ? { category: categoryTag.slice("category:".length) } : {}),
            });
            if (query.limit && results.length >= query.limit) break;
        }
        return results;
    }

    async remove(items: ExternalMemoryRemoveItem[], signal?: AbortSignal): Promise<number> {
        if (items.length === 0) return 0;
        if (!(await this.initialize())) return 0;
        let removed = 0;
        for (const item of items) {
            if (item.scope === "project" && !item.projectIdentity) {
                log("[magic-context] hindsight remove: project scope without identity — skipping");
                continue;
            }
            try {
                const bank = this.resolveBankForScope(
                    item.scope,
                    item.projectIdentity,
                    item.projectName,
                );
                const documentId = this.documentIdFor(item);
                const response = await this.request(
                    "DELETE",
                    `/v1/default/banks/${encodeURIComponent(bank)}/documents/${encodeURIComponent(documentId)}`,
                    undefined,
                    signal,
                    { benign404: true },
                );
                if (response) removed += 1; // 2xx or benign 404 (already gone)
            } catch (error) {
                log("[magic-context] hindsight remove failed:", error);
            }
        }
        return removed;
    }

    async mentalModels(
        query: ExternalMemoryMentalModelQuery,
        signal?: AbortSignal,
    ): Promise<ExternalMemoryRecallResult[]> {
        if (!this.mentalModelsEnabled) return [];
        try {
            if (!(await this.initialize())) return [];
            if (query.scope === "project" && !query.projectIdentity) {
                log(
                    "[magic-context] hindsight mental-models: project scope without identity — skipping",
                );
                return [];
            }
            const bank = this.resolveBankForScope(
                query.scope,
                query.projectIdentity,
                query.projectName,
            );
            const response = await this.request(
                "GET",
                `/v1/default/banks/${encodeURIComponent(bank)}/mental-models?detail=content`,
                undefined,
                signal,
                { benign404: true },
            );
            if (!response) return [];
            if (response.status === 404) return []; // bank missing → no MMs
            const body = (await response.json().catch(() => null)) as {
                items?: unknown;
            } | null;
            const rawItems = Array.isArray(body?.items) ? body.items : [];
            const results: ExternalMemoryRecallResult[] = [];
            for (const raw of rawItems) {
                if (!raw || typeof raw !== "object") continue;
                const model = raw as {
                    name?: unknown;
                    content?: unknown;
                };
                if (typeof model.name !== "string" || model.name.length === 0) continue;
                if (typeof model.content !== "string") continue; // null/unpopulated
                const trimmed = model.content.trim();
                if (trimmed.length === 0) continue;
                // For non-project scopes, gate by the configured profile names
                // (case-insensitive). Project scope returns everything non-empty.
                if (query.scope !== "project") {
                    if (!this.profileMentalModelNames.has(model.name.toLowerCase())) continue;
                }
                results.push({ content: trimmed, category: model.name });
            }
            return results;
        } catch (error) {
            log("[magic-context] hindsight mental-models failed:", error);
            return [];
        }
    }

    async fetchFailedRetainCount(signal?: AbortSignal): Promise<number | null> {
        try {
            if (!(await this.initialize())) return null;
            // benign404: a missing operations route (older Hindsight build)
            // must not feed the circuit breaker — this is a pure status check
            // and opening the circuit here would suppress real retains.
            const response = await this.request(
                "GET",
                `/v1/default/banks/${encodeURIComponent(this.mainBank)}/operations?type=retain&status=failed&exclude_parents=true&limit=5`,
                undefined,
                signal,
                { benign404: true },
            );
            if (!response || response.status === 404) return null;
            const body = (await response.json().catch(() => null)) as {
                total?: unknown;
            } | null;
            if (!body) return null;
            // The live operations envelope (OperationsListResponse) exposes
            // `total` as the authoritative failed-count. We do NOT fall back
            // to `operations.length` — a paginated `limit=N` slice can be
            // smaller than the true total, so that heuristic would understate
            // the count and silently mask real backend failures.
            return typeof body.total === "number" ? body.total : null;
        } catch {
            return null;
        }
    }

    /** Seed missing project-bank mental models (idempotent, fire-and-forget).
     *  Called after the first successful retain to a non-main bank. Seeding
     *  pre-existing project banks with a `project:X` MM would create a permanent
     *  empty document (the reflect loop sees no memories tagged for that
     *  project until the first retain), so we always seed AFTER retain — and
     *  gate on a per-bank claim so transient failures don't retry forever. */
    private async ensureProjectMentalModels(
        bank: string,
        sample: ExternalMemoryRetainItem,
    ): Promise<void> {
        if (!this.mentalModelsEnabled) return;
        if (this.seededMentalModelBanks.has(bank)) return;
        this.seededMentalModelBanks.add(bank); // claim first; transient failures retry next process
        try {
            const listResponse = await this.request(
                "GET",
                `/v1/default/banks/${encodeURIComponent(bank)}/mental-models`,
                undefined,
                undefined,
                { benign404: true },
            );
            if (!listResponse) return;
            const body = (await listResponse.json().catch(() => null)) as {
                items?: unknown;
            } | null;
            const existing = new Set<string>();
            for (const raw of Array.isArray(body?.items) ? body.items : []) {
                if (!raw || typeof raw !== "object") continue;
                const name = (raw as { name?: unknown }).name;
                if (typeof name === "string" && name.length > 0) {
                    existing.add(name.toLowerCase());
                }
            }
            const projectTag = sample.projectIdentity
                ? `project:${sample.projectIdentity}`
                : "project:unknown";
            for (const model of PROJECT_MENTAL_MODELS) {
                if (existing.has(model.name)) continue;
                await this.request(
                    "POST",
                    `/v1/default/banks/${encodeURIComponent(bank)}/mental-models`,
                    {
                        name: model.name,
                        source_query: model.sourceQuery,
                        tags: [projectTag],
                        max_tokens: model.maxTokens,
                        trigger: { mode: "delta", refresh_after_consolidation: true },
                    },
                );
            }
        } catch (error) {
            log(`[magic-context] mental-model seeding failed for bank ${bank}:`, error);
        }
    }

    private async ensureBank(bank: string, signal?: AbortSignal): Promise<boolean> {
        if (bank === this.mainBank) return true;
        if (this.ensuredBanks.has(bank)) return true;
        const listResponse = await this.request("GET", "/v1/default/banks", undefined, signal);
        if (!listResponse) return false;
        const listBody = (await listResponse.json().catch(() => null)) as {
            banks?: Array<{ bank_id?: string }>;
        } | null;
        const exists = (listBody?.banks ?? []).some((b) => b.bank_id === bank);
        if (!exists) {
            const created = await this.request(
                "PUT",
                `/v1/default/banks/${encodeURIComponent(bank)}`,
                { name: bank, mission: PROJECT_BANK_MISSION },
                signal,
            );
            if (!created) return false;
        }
        this.ensuredBanks.add(bank);
        return true;
    }

    private async postRetain(
        bank: string,
        group: ExternalMemoryRetainItem[],
        signal?: AbortSignal,
    ): Promise<boolean> {
        const response = await this.request(
            "POST",
            `/v1/default/banks/${encodeURIComponent(bank)}/memories`,
            { items: group.map((item) => this.buildMemoryItem(item)), async: true },
            signal,
        );
        if (!response) return false;
        const body = (await response.json().catch(() => null)) as { success?: boolean } | null;
        return body?.success === true;
    }

    private async request(
        method: string,
        path: string,
        body?: unknown,
        signal?: AbortSignal,
        opts?: { benign404?: boolean },
    ): Promise<Response | null> {
        if (signal?.aborted) return null;
        let isProbe = false;
        let internalController: AbortController | undefined;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let onOuterAbort: (() => void) | undefined;
        try {
            const claim = this.claimProbeOrShortCircuit();
            if (claim === "short_circuit") return null;
            isProbe = claim === "probe";
            internalController = new AbortController();
            timeoutHandle = setTimeout(() => internalController?.abort(), FETCH_TIMEOUT_MS);
            onOuterAbort = () => internalController?.abort();
            if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });

            const response = await fetch(`${this.endpoint}${path}`, {
                method,
                headers: {
                    "content-type": "application/json",
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                redirect: "error",
                signal: internalController.signal,
            });

            if (response.status === 404 && opts?.benign404) {
                this.recordSuccess();
                return response;
            }
            if (response.status === 422) {
                log(
                    `[magic-context] hindsight memory defense rejected content (${method} ${path}) — not retrying`,
                );
                this.recordSuccess();
                return null;
            }
            if (!response.ok) {
                log(
                    `[magic-context] hindsight request failed: ${method} ${path} → ${response.status} ${response.statusText}`,
                );
                this.recordFailure(isProbe);
                return null;
            }
            this.recordSuccess();
            return response;
        } catch (error) {
            const isAbort =
                error instanceof Error &&
                (error.name === "AbortError" || error.message.includes("aborted"));
            if (isAbort && signal?.aborted) {
                // Caller gave up — don't penalize the endpoint.
            } else {
                log(`[magic-context] hindsight request error: ${method} ${path}:`, error);
                this.recordFailure(isProbe);
            }
            return null;
        } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            if (signal && onOuterAbort) signal.removeEventListener("abort", onOuterAbort);
            if (isProbe) this.halfOpenProbeInFlight = false;
        }
    }

    async dispose(): Promise<void> {
        this.initialized = false;
        this.ensuredBanks.clear();
    }

    // ── Circuit breaker — copied verbatim from OpenAICompatibleEmbeddingProvider
    // (embedding-openai.ts lines 291-372) with log prefixes "openai-compatible
    // embedding" → "hindsight". Same three-state machine, same rolling window,
    // same probe-claim semantics. Documented in embedding-openai.ts.

    private claimProbeOrShortCircuit(): "allow" | "probe" | "short_circuit" {
        if (this.circuitOpenUntil === 0) {
            return "allow";
        }
        if (Date.now() < this.circuitOpenUntil) {
            return "short_circuit";
        }
        if (this.halfOpenProbeInFlight) {
            return "short_circuit";
        }
        this.halfOpenProbeInFlight = true;
        log("[magic-context] hindsight: circuit half-open, probing endpoint");
        return "probe";
    }

    private recordFailure(isProbe: boolean): void {
        if (isProbe) {
            this.circuitOpenUntil = Date.now() + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] hindsight: probe failed, re-opening circuit for ${OPEN_DURATION_MS / 60_000}min`,
                );
                this.openLogged = true;
            }
            this.failureTimes = [];
            return;
        }

        const now = Date.now();
        const cutoff = now - FAILURE_WINDOW_MS;
        this.failureTimes = this.failureTimes.filter((t) => t > cutoff);
        this.failureTimes.push(now);

        if (this.failureTimes.length >= FAILURE_THRESHOLD) {
            this.circuitOpenUntil = now + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] hindsight: opening circuit for ${OPEN_DURATION_MS / 60_000}min after ${this.failureTimes.length} failures in ${FAILURE_WINDOW_MS / 1_000}s`,
                );
                this.openLogged = true;
            }
            this.failureTimes = [];
        }
    }

    private recordSuccess(): void {
        if (this.failureTimes.length > 0 || this.circuitOpenUntil > 0 || this.openLogged) {
            log("[magic-context] hindsight: endpoint recovered, circuit closed");
        }
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
    }

    _getCircuitState(): CircuitState {
        if (this.circuitOpenUntil === 0) return "closed";
        if (Date.now() < this.circuitOpenUntil) {
            return this.halfOpenProbeInFlight ? "half_open" : "open";
        }
        return "half_open";
    }
    _getFailureCount(): number {
        return this.failureTimes.length;
    }
    _resetCircuit(): void {
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
        this.halfOpenProbeInFlight = false;
    }
}
