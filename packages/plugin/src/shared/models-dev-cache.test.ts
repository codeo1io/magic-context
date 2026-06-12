import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearModelsDevCache,
    getModelsDevCacheState,
    getSdkContextLimit,
    refreshModelLimitsFromApi,
} from "./models-dev-cache";

/**
 * Model context limits resolve from OpenCode's SDK only (`config.providers()`),
 * bounded to a sane [20k, 3M] range, with a persisted last-known-good cache for
 * cold start. We no longer read OpenCode's `models.json` file ourselves (a torn
 * read produced impossible limits and a stale copy out-voted the live cap).
 */
describe("models-dev-cache (SDK-only)", () => {
    let tempDir: string;
    let originalXdgData: string | undefined;

    function makeClient(providers: Array<unknown>) {
        return { config: { providers: async () => ({ data: { providers } }) } };
    }

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "mc-models-dev-"));
        // Isolate the persisted-cache file under a temp data dir so tests never
        // touch the real ~/.local/share/cortexkit/magic-context cache.
        originalXdgData = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = tempDir;
        clearModelsDevCache();
    });

    afterEach(() => {
        if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgData;
        try {
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
        clearModelsDevCache();
    });

    test("resolves from the SDK and prefers limit.input over limit.context", async () => {
        // github-copilot / codex shape: input is the max prompt, context the total
        // window. Pressure math must use the input cap (OpenCode's own overflow.ts
        // does the same), so a 400k-context / 272k-input model resolves to 272k.
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "github-copilot",
                    models: {
                        "gpt-5.3-codex": { limit: { context: 400000, input: 272000 } },
                        "legacy-only-context": { limit: { context: 100000 } },
                    },
                },
            ]),
        );

        expect(getSdkContextLimit("github-copilot", "gpt-5.3-codex")).toBe(272000);
        expect(getSdkContextLimit("github-copilot", "legacy-only-context")).toBe(100000);
        expect(getSdkContextLimit("unknown", "unknown")).toBeUndefined();
    });

    test("Codex-OAuth cap is honored: a 400k/272k gpt-5.5 resolves to 272k (not the stale 922k)", async () => {
        // The bug we're fixing: the SDK reports the auth-resolved cap; nothing may
        // out-vote it with a larger stale value.
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "openai",
                    models: { "gpt-5.5": { limit: { context: 400000, input: 272000 } } },
                },
            ]),
        );
        expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
    });

    test("derived experimental.modes inherit the effective (input) limit", async () => {
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "openai",
                    models: {
                        "gpt-5.4": {
                            limit: { context: 1050000, input: 922000 },
                            experimental: { modes: { fast: {}, mini: {} } },
                        },
                    },
                },
            ]),
        );
        expect(getSdkContextLimit("openai", "gpt-5.4")).toBe(922000);
        expect(getSdkContextLimit("openai", "gpt-5.4-fast")).toBe(922000);
        expect(getSdkContextLimit("openai", "gpt-5.4-mini")).toBe(922000);
    });

    test("matches a tagged ollama model against its tag-less SDK entry", async () => {
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "ollama-cloud",
                    models: {
                        "deepseek-v4-pro": { limit: { context: 1048576 } },
                        "gemma3:27b": { limit: { context: 131072 } },
                    },
                },
            ]),
        );
        // Tagged invocation falls back to the tag-less entry.
        expect(getSdkContextLimit("ollama-cloud", "deepseek-v4-pro:cloud")).toBe(1048576);
        // Exact tagged match still wins (no wrongful collapse).
        expect(getSdkContextLimit("ollama-cloud", "gemma3:27b")).toBe(131072);
        // Unknown tagged model with no tag-less base stays undefined.
        expect(getSdkContextLimit("ollama-cloud", "nonexistent:cloud")).toBeUndefined();
    });

    describe("sanity bounds [20k, 3M]", () => {
        test("rejects an implausibly small limit (torn-read garbage like 6748)", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "ollama-cloud",
                        // 6748 is smaller than a single system prompt — impossible
                        // as a real limit; must be rejected, not trusted.
                        models: { "deepseek-v4-pro": { limit: { context: 6748 } } },
                    },
                ]),
            );
            expect(getSdkContextLimit("ollama-cloud", "deepseek-v4-pro")).toBeUndefined();
        });

        test("rejects a below-floor 8192 num_ctx default", async () => {
            await refreshModelLimitsFromApi(
                makeClient([{ id: "p", models: { m: { limit: { context: 8192 } } } }]),
            );
            expect(getSdkContextLimit("p", "m")).toBeUndefined();
        });

        test("rejects an impossibly large limit (> 3M)", async () => {
            await refreshModelLimitsFromApi(
                makeClient([{ id: "p", models: { m: { limit: { context: 5_000_000 } } } }]),
            );
            expect(getSdkContextLimit("p", "m")).toBeUndefined();
        });

        test("accepts values exactly on the bounds", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "p",
                        models: {
                            lo: { limit: { context: 20000 } },
                            hi: { limit: { context: 3000000 } },
                        },
                    },
                ]),
            );
            expect(getSdkContextLimit("p", "lo")).toBe(20000);
            expect(getSdkContextLimit("p", "hi")).toBe(3000000);
        });
    });

    describe("persisted cache (cold start)", () => {
        test("seeds from the persisted file after a clear (restart simulation)", async () => {
            // First run: warm + persist.
            await refreshModelLimitsFromApi(
                makeClient([{ id: "openai", models: { "gpt-5.5": { limit: { input: 272000 } } } }]),
            );
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);

            // Simulate a restart: in-memory cache gone, but the persisted file
            // remains under XDG_DATA_HOME. The next lookup seeds from disk.
            clearModelsDevCache();
            expect(getModelsDevCacheState().apiLoaded).toBe(false);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            // Seeding populated the in-memory cache.
            expect(getModelsDevCacheState().apiLoaded).toBe(true);
        });

        test("does not persist or seed insane values", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "p",
                        models: {
                            good: { limit: { context: 200000 } },
                            bad: { limit: { context: 6748 } },
                        },
                    },
                ]),
            );
            clearModelsDevCache();
            expect(getSdkContextLimit("p", "good")).toBe(200000);
            expect(getSdkContextLimit("p", "bad")).toBeUndefined();
        });
    });

    describe("startup retry", () => {
        test("retries when the provider payload is empty, then succeeds", async () => {
            let calls = 0;
            const client = {
                config: {
                    providers: async () => {
                        calls++;
                        if (calls === 1) return { data: { providers: [] } };
                        return {
                            data: {
                                providers: [
                                    { id: "p", models: { m: { limit: { context: 200000 } } } },
                                ],
                            },
                        };
                    },
                },
            };
            await refreshModelLimitsFromApi(client, { retries: 2, retryDelayMs: 1 });
            expect(calls).toBe(2);
            expect(getSdkContextLimit("p", "m")).toBe(200000);
        });

        test("stops early on first successful load (no wasted retries)", async () => {
            let calls = 0;
            const client = {
                config: {
                    providers: async () => {
                        calls++;
                        return {
                            data: {
                                providers: [
                                    { id: "p", models: { m: { limit: { context: 200000 } } } },
                                ],
                            },
                        };
                    },
                },
            };
            await refreshModelLimitsFromApi(client, { retries: 3, retryDelayMs: 1 });
            expect(calls).toBe(1);
        });
    });

    test("tolerates empty / malformed / thrown responses without populating", async () => {
        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: undefined }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: { providers: "not an array" } }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        await refreshModelLimitsFromApi({
            config: {
                providers: async () => {
                    throw new Error("network error");
                },
            },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);
    });

    describe("cache-first boot", () => {
        function persistedFilePath(): string {
            return join(
                tempDir,
                "cortexkit",
                "magic-context",
                "model-context-limits-opencode.json",
            );
        }

        test("persisted cache seeds the in-memory map synchronously, before the API refresh resolves", async () => {
            // First run: warm + persist so the persisted file exists for the
            // "next boot" we're about to simulate.
            await refreshModelLimitsFromApi(
                makeClient([{ id: "openai", models: { "gpt-5.5": { limit: { input: 272000 } } } }]),
            );

            // Simulate a restart: in-memory cache gone, persisted file remains.
            clearModelsDevCache();
            expect(getModelsDevCacheState().apiLoaded).toBe(false);

            // A deferred fetch — we control when (or if) it resolves. Models
            // the boot-time state where OpenCode's provider service isn't
            // ready yet: the SDK call hangs, no payload comes back.
            let resolveFetch: (value: { data?: { providers?: unknown[] } }) => void = () => {};
            const fetchPromise = new Promise<{ data?: { providers?: unknown[] } }>((resolve) => {
                resolveFetch = resolve;
            });
            const deferredClient = { config: { providers: () => fetchPromise } };

            // Kick off the background refresh. Do NOT await — the test asserts
            // that the in-memory map is populated synchronously inside the
            // function body, before the first `await`, so the very next
            // `getSdkContextLimit` lookup returns the persisted value with no
            // wait on the API.
            const refreshPromise = refreshModelLimitsFromApi(deferredClient, {
                retries: 0,
                retryDelayMs: 1,
            });

            // CACHE-FIRST: the persisted cache must be loaded SYNCHRONOUSLY
            // by refreshModelLimitsFromApi before any await, so the lookup
            // resolves immediately from the persisted cache — even though
            // the API fetch is still pending (and may never resolve).
            expect(getModelsDevCacheState().apiLoaded).toBe(true);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);

            // Let the background refresh complete (with an empty payload —
            // no overwrite) so the test can finish cleanly.
            resolveFetch({ data: { providers: [] } });
            await refreshPromise;
        });

        test("background API refresh success later swaps the in-memory map AND persists the new values", async () => {
            // First run: warm + persist with one set of values.
            await refreshModelLimitsFromApi(
                makeClient([{ id: "openai", models: { "gpt-5.5": { limit: { input: 272000 } } } }]),
            );

            // Simulate a restart: in-memory cache gone, persisted file remains.
            clearModelsDevCache();

            // Deferred fetch returning FRESH data (different limit value).
            let resolveFetch: (value: { data?: { providers?: unknown[] } }) => void = () => {};
            const fetchPromise = new Promise<{ data?: { providers?: unknown[] } }>((resolve) => {
                resolveFetch = resolve;
            });
            const deferredClient = { config: { providers: () => fetchPromise } };

            // Kick off the background refresh.
            const refreshPromise = refreshModelLimitsFromApi(deferredClient, {
                retries: 0,
                retryDelayMs: 1,
            });

            // CACHE-FIRST: the in-memory map is populated SYNCHRONOUSLY by
            // refreshModelLimitsFromApi before the first await, so the
            // lookup serves the OLD persisted value (272000) even though the
            // API refresh is still in flight.
            expect(getModelsDevCacheState().apiLoaded).toBe(true);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);

            // Now resolve the fetch with FRESH data.
            resolveFetch({
                data: {
                    providers: [
                        {
                            id: "openai",
                            models: { "gpt-5.5": { limit: { input: 100000 } } },
                        },
                    ],
                },
            });

            // Let the refresh function complete. The in-memory map is
            // atomically swapped to the API data; the persisted file is
            // rewritten with the new values.
            await refreshPromise;

            // The in-memory map was swapped to the API data.
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(100000);
            expect(getModelsDevCacheState().apiCount).toBe(1);

            // And the new value was persisted to disk so the NEXT process
            // cold-starts with it (not the stale 272k).
            const persistedRaw = readFileSync(persistedFilePath(), "utf-8");
            const persisted = JSON.parse(persistedRaw) as Record<string, number>;
            expect(persisted["openai/gpt-5.5"]).toBe(100000);
        });

        test("without a persisted cache, the cache is populated only when the API refresh succeeds (no synchronous preload)", async () => {
            // No persisted cache exists (fresh beforeEach, nothing persisted).
            expect(getModelsDevCacheState().apiLoaded).toBe(false);

            let calls = 0;
            const client = {
                config: {
                    providers: async () => {
                        calls++;
                        return {
                            data: {
                                providers: [
                                    { id: "p", models: { m: { limit: { context: 200000 } } } },
                                ],
                            },
                        };
                    },
                },
            };

            // With no persisted file, the eager preload inside
            // refreshModelLimitsFromApi is a no-op (the file read fails and
            // is caught). The existing retry-loop behavior is unchanged: the
            // first successful fetch populates the cache.
            await refreshModelLimitsFromApi(client, { retries: 0, retryDelayMs: 1 });

            expect(calls).toBe(1);
            expect(getSdkContextLimit("p", "m")).toBe(200000);
            expect(getModelsDevCacheState().apiLoaded).toBe(true);
        });
    });

    test("repeated refreshes replace cache state without corruption", async () => {
        const clientA = makeClient([
            {
                id: "p",
                models: {
                    m1: { limit: { context: 200000 } },
                    m2: { limit: { context: 200000 } },
                    m3: { limit: { context: 200000 } },
                },
            },
        ]);
        const clientB = makeClient([
            {
                id: "p",
                models: { m1: { limit: { context: 200000 } }, m2: { limit: { context: 200000 } } },
            },
        ]);

        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);
        await refreshModelLimitsFromApi(clientB);
        expect(getModelsDevCacheState().apiCount).toBe(2);
        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);

        expect(getSdkContextLimit("p", "m1")).toBe(200000);
        expect(getSdkContextLimit("p", "m3")).toBe(200000);
    });
});
