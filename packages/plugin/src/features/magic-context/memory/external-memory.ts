import type {
    ExternalMemoryConfig,
    ExternalMemoryRetainSource,
    ExternalRecallConfig,
} from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import { HindsightMemoryBackend } from "./external-memory-hindsight";
import type {
    ExternalMemoryBackend,
    ExternalMemoryMentalModelQuery,
    ExternalMemoryRecallQuery,
    ExternalMemoryRecallResult,
    ExternalMemoryRemoveItem,
    ExternalMemoryRetainItem,
} from "./external-memory-provider";

const OFF_CONFIG: ExternalMemoryConfig = { provider: "off" };

let externalConfig: ExternalMemoryConfig = OFF_CONFIG;
let backend: ExternalMemoryBackend | null = null;
let testBackendFactory: ((config: ExternalMemoryConfig) => ExternalMemoryBackend | null) | null =
    null;

export function createExternalMemoryBackend(
    config: ExternalMemoryConfig,
): ExternalMemoryBackend | null {
    if (testBackendFactory) {
        return config.provider === "off" ? null : testBackendFactory(config);
    }
    if (config.provider === "hindsight") {
        return new HindsightMemoryBackend(config);
    }
    return null;
}

function configIdentity(config: ExternalMemoryConfig): string {
    if (config.provider === "off") return "external-memory:off";
    return `external-memory:${config.provider}:${config.endpoint}:${config.main_bank}:${config.project_bank}`;
}

export function initializeExternalMemory(config?: ExternalMemoryConfig): void {
    const next = config ?? OFF_CONFIG;
    if (configIdentity(next) === configIdentity(externalConfig)) {
        externalConfig = next; // pick up retain_sources/tags changes cheaply
        return;
    }
    const previous = backend;
    externalConfig = next;
    backend = null;
    if (previous) {
        void previous.dispose().catch((error) => {
            log("[magic-context] external memory backend dispose failed:", error);
        });
    }
}

function getOrCreateBackend(): ExternalMemoryBackend | null {
    if (backend) return backend;
    backend = createExternalMemoryBackend(externalConfig);
    return backend;
}

/**
 * Fire-and-forget tee of memory creations to the external backend.
 * Best-effort: NEVER throws, never blocks the caller's local write.
 * `source` identifies the creation point for retain_sources filtering.
 */
export async function teeToExternalBackend(
    source: ExternalMemoryRetainSource,
    items: ExternalMemoryRetainItem[],
): Promise<void> {
    try {
        if (items.length === 0) return;
        if (externalConfig.provider === "off") return;
        if (!externalConfig.retain_sources.includes(source)) return;
        const current = getOrCreateBackend();
        if (!current) return;
        if (!(await current.initialize())) return;
        const accepted = await current.retain(items);
        if (accepted > 0) {
            log(`[magic-context] external memory: retained ${accepted}/${items.length} item(s)`);
        }
    } catch (error) {
        log("[magic-context] external memory tee failed:", error);
    }
}

/** Resolved recall config, or null when the provider is off. */
export function getExternalRecallConfig(): ExternalRecallConfig | null {
    if (externalConfig.provider === "off") return null;
    return externalConfig.recall;
}

export function isExternalSearchEnabled(): boolean {
    const recall = getExternalRecallConfig();
    return recall !== null && recall.search === true;
}

/**
 * Direct recall against the external backend. UNGATED by retain_sources
 * (read path). Never throws; [] when off/unsupported/failing.
 */
export async function recallFromExternalBackend(
    query: ExternalMemoryRecallQuery,
    signal?: AbortSignal,
): Promise<ExternalMemoryRecallResult[]> {
    try {
        if (externalConfig.provider === "off") return [];
        const current = getOrCreateBackend();
        if (!current?.recall) return [];
        if (!(await current.initialize())) return [];
        return await current.recall(query, signal);
    } catch (error) {
        log("[magic-context] external memory recall failed:", error);
        return [];
    }
}

/**
 * Corrective removal. UNGATED by retain_sources (consistency propagation,
 * not a retain source). Fire-and-forget; never throws.
 */
export async function removeFromExternalBackend(items: ExternalMemoryRemoveItem[]): Promise<void> {
    try {
        if (items.length === 0) return;
        if (externalConfig.provider === "off") return;
        const current = getOrCreateBackend();
        if (!current?.remove) return;
        if (!(await current.initialize())) return;
        const removed = await current.remove(items);
        if (removed > 0) {
            log(`[magic-context] external memory: removed ${removed}/${items.length} item(s)`);
        }
    } catch (error) {
        log("[magic-context] external memory remove failed:", error);
    }
}

/**
 * Mental-model fast path (single GET vs full recall). UNGATED by
 * retain_sources. Never throws; [] when off/unsupported/failing.
 */
export async function mentalModelsFromExternalBackend(
    query: ExternalMemoryMentalModelQuery,
    signal?: AbortSignal,
): Promise<ExternalMemoryRecallResult[]> {
    try {
        if (externalConfig.provider === "off") return [];
        const current = getOrCreateBackend();
        if (!current?.mentalModels) return [];
        if (!(await current.initialize())) return [];
        return await current.mentalModels(query, signal);
    } catch (error) {
        log("[magic-context] external memory mental-models failed:", error);
        return [];
    }
}

/**
 * Corrective upsert (verify-confirmed verbatim re-retain). UNGATED by
 * retain_sources. Fire-and-forget; never throws.
 */
export async function upsertToExternalBackend(items: ExternalMemoryRetainItem[]): Promise<void> {
    try {
        if (items.length === 0) return;
        if (externalConfig.provider === "off") return;
        const current = getOrCreateBackend();
        if (!current) return;
        if (!(await current.initialize())) return;
        await current.retain(items);
    } catch (error) {
        log("[magic-context] external memory upsert failed:", error);
    }
}

/** Status snapshot for the ctx-status / RPC surface. Sync, no network. */
export interface ExternalMemoryStatus {
    provider: string;
    endpoint?: string;
    circuitState?: string;
}

export function getExternalMemoryStatus(): ExternalMemoryStatus | null {
    if (externalConfig.provider === "off") return null;
    const current = getOrCreateBackend();
    const circuitState =
        current && "_getCircuitState" in current
            ? (current as { _getCircuitState(): string })._getCircuitState()
            : undefined;
    return {
        provider: externalConfig.provider,
        endpoint: externalConfig.endpoint,
        ...(circuitState ? { circuitState } : {}),
    };
}

/** Best-effort failed-retain count from the operations endpoint (doctor).
 *  Returns null when the backend is offline, the endpoint is missing, or the
 *  response is malformed. Never throws. */
export async function fetchExternalFailedRetains(signal?: AbortSignal): Promise<number | null> {
    try {
        if (externalConfig.provider === "off") return null;
        const current = getOrCreateBackend();
        if (!current || !("fetchFailedRetainCount" in current)) return null;
        return await (
            current as { fetchFailedRetainCount(s?: AbortSignal): Promise<number | null> }
        ).fetchFailedRetainCount(signal);
    } catch {
        return null;
    }
}

export async function disposeExternalMemoryBackend(): Promise<void> {
    const current = backend;
    backend = null;
    if (current) await current.dispose();
}

// Test-only hooks (mirror embedding.ts naming).
export function _setTestExternalBackendFactory(
    factory: ((config: ExternalMemoryConfig) => ExternalMemoryBackend | null) | null,
): void {
    testBackendFactory = factory;
}
export function _resetExternalMemoryForTests(): void {
    externalConfig = OFF_CONFIG;
    backend = null;
    testBackendFactory = null;
}
