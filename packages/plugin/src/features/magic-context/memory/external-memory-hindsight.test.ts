import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HindsightMemoryBackend } from "./external-memory-hindsight";
import type { ExternalMemoryRetainItem } from "./external-memory-provider";
import { computeNormalizedHash } from "./normalize-hash";

const realFetch = globalThis.fetch;
let requests: Array<{ url: string; init: RequestInit }> = [];
let responder: (url: string) => Response;

function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
    requests = [];
    responder = (url) => {
        if (url.endsWith("/v1/default/banks")) {
            return okJson({ banks: [{ bank_id: "main-memory" }] });
        }
        if (/\/banks\/[^/]+$/.test(url)) return okJson({ bank_id: "x" });
        return okJson({ success: true, bank_id: "b", items_count: 1, async: true });
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init: init ?? {} });
        return responder(url);
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

function makeBackend(mentalModelsEnabled = false): HindsightMemoryBackend {
    return new HindsightMemoryBackend({
        provider: "hindsight",
        endpoint: "http://10.0.0.1:8889",
        api_key: "tok-123",
        project_bank: "mc-{name}-{id8}",
        main_bank: "main-memory",
        retain_sources: ["historian", "agent", "dreamer"],
        tags: ["user:test"],
        recall: {
            enabled: true,
            timeout_ms: 3000,
            max_tokens: 2048,
            dedup_threshold: 0.85,
            global_tags: ["user:test"],
            global_from_prompt: false,
            search: true,
            mental_models: mentalModelsEnabled,
            profile_mental_models: ["user-preferences"],
        },
    });
}

function makeMmBackend(): HindsightMemoryBackend {
    return makeBackend(true);
}

const projectItem: ExternalMemoryRetainItem = {
    content: "Always run bun test from packages/plugin",
    category: "PROJECT_RULES",
    scope: "project",
    projectIdentity: "git:abcdef1234567890",
    projectName: "magic-context",
    sourceType: "historian",
    sessionId: "ses_1",
};
const userItem: ExternalMemoryRetainItem = {
    content: "User prefers terse answers",
    category: "USER_PROFILE",
    scope: "user",
    sourceType: "dreamer",
};

describe("HindsightMemoryBackend", () => {
    test("routes project items to templated bank and creates it once", async () => {
        const backend = makeBackend();
        const accepted = await backend.retain([projectItem]);
        expect(accepted).toBe(1);
        const puts = requests.filter((r) => r.init.method === "PUT");
        expect(puts.length).toBe(1);
        expect(puts[0].url).toContain("/v1/default/banks/mc-magic-context-abcdef12");
        const posts = requests.filter((r) => r.init.method === "POST");
        expect(posts[0].url).toContain("/v1/default/banks/mc-magic-context-abcdef12/memories");
        requests = [];
        await backend.retain([projectItem]);
        expect(requests.filter((r) => r.init.method === "PUT").length).toBe(0);
        expect(requests.filter((r) => r.init.method === "GET").length).toBe(0);
        expect(requests.filter((r) => r.init.method === "POST").length).toBe(1);
    });

    test("routes user items to main bank without ensure-create", async () => {
        const backend = makeBackend();
        const accepted = await backend.retain([userItem]);
        expect(accepted).toBe(1);
        const posts = requests.filter((r) => r.init.method === "POST");
        expect(posts.length).toBe(1);
        expect(posts[0].url).toContain("/v1/default/banks/main-memory/memories");
        expect(requests.filter((r) => r.init.method === "PUT").length).toBe(0);
        expect(requests.filter((r) => r.init.method === "GET").length).toBe(0);
    });

    test("payload shape: verbatim content, document_id, tags, async, auth", async () => {
        const backend = makeBackend();
        await backend.retain([projectItem]);
        const post = requests.find((r) => r.init.method === "POST");
        if (!post) throw new Error("no retain POST");
        const headers = post.init.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer tok-123");
        const body = JSON.parse(String(post.init.body));
        expect(body.async).toBe(true);
        const item = body.items[0];
        expect(item.content).toBe(projectItem.content);
        expect(item.document_id).toBe(
            `mc:git:abcdef1234567890:PROJECT_RULES:${computeNormalizedHash(projectItem.content)}`,
        );
        expect(item.context).toContain("magic-context");
        expect(item.metadata.category).toBe("PROJECT_RULES");
        expect(item.metadata.session_id).toBe("ses_1");
        expect(item.tags).toContain("source:magic-context");
        expect(item.tags).toContain("category:PROJECT_RULES");
        expect(item.tags).toContain("project:git:abcdef1234567890");
        expect(item.tags).toContain("project-name:magic-context");
        expect(item.tags).toContain("user:test");
        expect(item.tags).not.toContain("scope:project");
    });

    test("global item with origin: main-bank routing, origin-* tags, project named in context", async () => {
        const backend = makeBackend();
        await backend.retain([
            {
                content: "Homelab reverse proxy lives on 10.1.1.5 (caddy).",
                category: "ARCHITECTURE" as const,
                scope: "global" as const,
                projectIdentity: "git:abcdef1234567890",
                projectName: "magic-context",
                sourceType: "agent" as const,
            },
        ]);
        const post = requests.find((r) => r.init.method === "POST");
        if (!post) throw new Error("no retain POST");
        // Origin provenance must NOT change routing: main bank, global doc id.
        expect(post.url).toContain("main-memory/memories");
        const item = JSON.parse(String(post.init.body)).items[0];
        expect(item.document_id).toBe(
            `mc:global:ARCHITECTURE:${computeNormalizedHash(
                "Homelab reverse proxy lives on 10.1.1.5 (caddy).",
            )}`,
        );
        expect(item.tags).toContain("scope:global");
        // origin-* prefix, NOT project:* (the project-partition tag axis).
        expect(item.tags).toContain("origin-project:git:abcdef1234567890");
        expect(item.tags).toContain("origin-project-name:magic-context");
        expect(item.tags.some((t: string) => t.startsWith("project:"))).toBe(false);
        // Project named in the extraction context → entity linkage for
        // cross-project by-name recall.
        expect(item.context).toContain('"magic-context" project');
        expect(item.metadata.project_path).toBe("git:abcdef1234567890");
    });

    test("global item WITHOUT origin keeps the bare global shape", async () => {
        const backend = makeBackend();
        await backend.retain([
            {
                content: "bare global fact",
                category: "ARCHITECTURE" as const,
                scope: "global" as const,
                sourceType: "agent" as const,
            },
        ]);
        const post = requests.find((r) => r.init.method === "POST");
        const item = JSON.parse(String(post?.init.body)).items[0];
        expect(item.tags).toContain("scope:global");
        expect(item.tags.some((t: string) => t.startsWith("origin-"))).toBe(false);
        expect(item.context).not.toContain("recorded while working");
    });

    test("user item tags carry scope:user and no project tags", async () => {
        const backend = makeBackend();
        await backend.retain([userItem]);
        const post = requests.find((r) => r.init.method === "POST");
        const body = JSON.parse(String(post?.init.body));
        expect(body.items[0].tags).toContain("scope:user");
        expect(body.items[0].tags.some((t: string) => t.startsWith("project:"))).toBe(false);
        expect(body.items[0].document_id).toBe(
            `mc:user:USER_PROFILE:${computeNormalizedHash(userItem.content)}`,
        );
    });

    test("mixed batch groups by bank", async () => {
        const backend = makeBackend();
        const accepted = await backend.retain([projectItem, userItem]);
        expect(accepted).toBe(2);
        const posts = requests.filter((r) => r.init.method === "POST");
        expect(posts.length).toBe(2);
        const urls = posts.map((p) => p.url).join(" ");
        expect(urls).toContain("mc-magic-context-abcdef12/memories");
        expect(urls).toContain("main-memory/memories");
    });

    test("422 logs and does not throw, retry, or open circuit", async () => {
        responder = () => new Response("rejected", { status: 422 });
        const backend = makeBackend();
        const accepted = await backend.retain([userItem]);
        expect(accepted).toBe(0);
        expect(requests.filter((r) => r.init.method === "POST").length).toBe(1);
        expect(backend._getCircuitState()).toBe("closed");
    });

    test("never throws on network error", async () => {
        globalThis.fetch = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        const backend = makeBackend();
        await expect(backend.retain([userItem])).resolves.toBe(0);
    });

    test("circuit opens after repeated failures and short-circuits", async () => {
        globalThis.fetch = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        const backend = makeBackend();
        await backend.retain([userItem]);
        await backend.retain([userItem]);
        await backend.retain([userItem]);
        expect(backend._getCircuitState()).toBe("open");
    });

    test("initialize fails without endpoint", async () => {
        const backend = new HindsightMemoryBackend({
            provider: "hindsight",
            endpoint: "",
            project_bank: "mc-{name}-{id8}",
            main_bank: "main-memory",
            retain_sources: ["historian", "agent", "dreamer"],
            tags: [],
            recall: {
                enabled: true,
                timeout_ms: 3000,
                max_tokens: 2048,
                dedup_threshold: 0.85,
                global_tags: [],
                global_from_prompt: false,
                search: true,
                mental_models: false,
                profile_mental_models: ["user-preferences"],
            },
        });
        expect(await backend.initialize()).toBe(false);
        expect(await backend.retain([userItem])).toBe(0);
    });
});

describe("HindsightMemoryBackend recall/remove", () => {
    test("project recall hits project bank with types and no tags", async () => {
        responder = () =>
            okJson({
                results: [
                    { id: "1", text: "fact A", type: "world", tags: ["category:ARCHITECTURE"] },
                ],
            });
        const backend = makeBackend();
        const results = await backend.recall({
            query: "project rules",
            scope: "project",
            projectIdentity: "git:abcdef1234567890",
            projectName: "magic-context",
            maxTokens: 1024,
        });
        const post = requests.find((r) => r.init.method === "POST");
        if (!post) throw new Error("no recall POST");
        expect(post.url).toContain("/v1/default/banks/mc-magic-context-abcdef12/memories/recall");
        const body = JSON.parse(String(post.init.body));
        expect(body.query).toBe("project rules");
        expect(body.types).toEqual(["world", "observation"]);
        expect(body.budget).toBe("mid");
        expect(body.max_tokens).toBe(1024);
        expect(body.tags).toBeUndefined();
        expect(results).toEqual([
            { content: "fact A", score: undefined, category: "ARCHITECTURE" },
        ]);
    });

    test("user recall hits main bank with scope:user any_strict", async () => {
        responder = () => okJson({ results: [] });
        const backend = makeBackend();
        await backend.recall({ query: "user prefs", scope: "user" });
        const body = JSON.parse(String(requests[0].init.body));
        expect(requests[0].url).toContain("/v1/default/banks/main-memory/memories/recall");
        expect(body.tags).toEqual(["scope:user"]);
        expect(body.tags_match).toBe("any_strict");
    });

    test("global recall uses config global_tags with any match", async () => {
        responder = () => okJson({ results: [] });
        const backend = makeBackend();
        await backend.recall({ query: "homelab", scope: "global" });
        const body = JSON.parse(String(requests[0].init.body));
        expect(requests[0].url).toContain("/v1/default/banks/main-memory/memories/recall");
        expect(body.tags).toEqual(["user:test"]);
        expect(body.tags_match).toBe("any");
    });

    test("recall 404 (missing project bank) returns [] without opening circuit", async () => {
        responder = () => new Response("not found", { status: 404 });
        const backend = makeBackend();
        const results = await backend.recall({
            query: "q",
            scope: "project",
            projectIdentity: "git:abcdef1234567890",
            projectName: "magic-context",
        });
        expect(results).toEqual([]);
        expect(backend._getCircuitState()).toBe("closed");
    });

    test("recall never throws on network error", async () => {
        globalThis.fetch = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        const backend = makeBackend();
        await expect(backend.recall({ query: "q" })).resolves.toEqual([]);
    });

    test("remove DELETEs document by derived id; 404 counts as removed", async () => {
        responder = (url) =>
            url.includes("/documents/") ? new Response("gone", { status: 404 }) : okJson({});
        const backend = makeBackend();
        const removed = await backend.remove([
            {
                content: "Always run bun test from packages/plugin",
                category: "PROJECT_RULES",
                scope: "project",
                projectIdentity: "git:abcdef1234567890",
                projectName: "magic-context",
            },
        ]);
        expect(removed).toBe(1);
        const del = requests.find((r) => r.init.method === "DELETE");
        if (!del) throw new Error("no DELETE");
        const expectedId = `mc:git:abcdef1234567890:PROJECT_RULES:${computeNormalizedHash(
            "Always run bun test from packages/plugin",
        )}`;
        expect(del.url).toContain(
            `/v1/default/banks/mc-magic-context-abcdef12/documents/${encodeURIComponent(expectedId)}`,
        );
        expect(backend._getCircuitState()).toBe("closed");
    });

    test("retain item verifiedAt lands in metadata.verified_at", async () => {
        const backend = makeBackend();
        await backend.retain([{ ...userItem, verifiedAt: 1750000000000 }]);
        const post = requests.find((r) => r.init.method === "POST");
        const body = JSON.parse(String(post?.init.body));
        expect(body.items[0].metadata.verified_at).toBe(1750000000000);
    });

    test("recall never throws when results is not an array (malformed 200 body)", async () => {
        responder = () => okJson({ results: {} });
        const backend = makeBackend();
        await expect(backend.recall({ query: "q" })).resolves.toEqual([]);
    });

    test("recall never throws when an item's tags is not an array", async () => {
        responder = () =>
            okJson({
                results: [{ id: "1", text: "fact A", type: "world", tags: "not-an-array" }],
            });
        const backend = makeBackend();
        await expect(backend.recall({ query: "q" })).resolves.toEqual([{ content: "fact A" }]);
    });

    test("project scope without projectIdentity short-circuits to [] with zero fetch requests", async () => {
        const backend = makeBackend();
        const results = await backend.recall({ query: "q", scope: "project" });
        expect(results).toEqual([]);
        expect(requests.length).toBe(0);
    });

    test("remove skips project items without projectIdentity (no DELETE, returns 0)", async () => {
        const backend = makeBackend();
        const removed = await backend.remove([
            { content: "x", category: "PROJECT_RULES", scope: "project" },
        ]);
        expect(removed).toBe(0);
        expect(requests.filter((r) => r.init.method === "DELETE").length).toBe(0);
    });

    test("fetchFailedRetainCount returns total from the operations envelope", async () => {
        responder = () => okJson({ total: 7, operations: [] });
        const backend = makeBackend();
        expect(await backend.fetchFailedRetainCount()).toBe(7);
        const get = requests.find((r) => (r.init.method ?? "GET") === "GET");
        expect(get?.url).toContain("/v1/default/banks/main-memory/operations");
        expect(get?.url).toContain("type=retain");
        expect(get?.url).toContain("status=failed");
    });

    test("fetchFailedRetainCount returns null when envelope has no total (no operations.length fallback)", async () => {
        // A paginated `limit=N` slice can be smaller than the true total, so
        // using `operations.length` as a fallback would understate the count
        // and silently mask real backend failures. The hook is strict: only
        // an explicit `total: number` is treated as a valid count.
        responder = () =>
            okJson({
                operations: [
                    { id: "op1", status: "failed", task_type: "retain" },
                    { id: "op2", status: "failed", task_type: "retain" },
                ],
            });
        const backend = makeBackend();
        expect(await backend.fetchFailedRetainCount()).toBeNull();
    });

    test("fetchFailedRetainCount returns null when envelope is malformed", async () => {
        responder = () => okJson({ not: "the right shape" });
        const backend = makeBackend();
        expect(await backend.fetchFailedRetainCount()).toBeNull();
    });
});

describe("HindsightMemoryBackend mental models", () => {
    test("mentalModels fetches project bank MMs with content", async () => {
        responder = (url) => {
            if (url.includes("/mental-models")) {
                return okJson({
                    items: [
                        { id: "mm1", name: "project-conventions", content: "Conventions doc" },
                        { id: "mm2", name: "project-decisions", content: "" },
                    ],
                });
            }
            return okJson({});
        };
        const backend = makeMmBackend();
        const results = await backend.mentalModels({
            scope: "project",
            projectIdentity: "git:abcdef1234567890",
            projectName: "magic-context",
        });
        const get = requests.find((r) => (r.init.method ?? "GET") === "GET");
        expect(get?.url).toContain("/v1/default/banks/mc-magic-context-abcdef12/mental-models");
        expect(get?.url).toContain("detail=content");
        // empty-content MM excluded
        expect(results).toEqual([{ content: "Conventions doc", category: "project-conventions" }]);
    });

    test("mentalModels user scope filters main-bank MMs by configured names", async () => {
        responder = () =>
            okJson({
                items: [
                    { id: "a", name: "User-Preferences", content: "Prefers terse" },
                    { id: "b", name: "unrelated-model", content: "Noise" },
                ],
            });
        const backend = makeMmBackend();
        const results = await backend.mentalModels({ scope: "user" });
        expect(requests[0].url).toContain("/v1/default/banks/main-memory/mental-models");
        expect(results).toEqual([{ content: "Prefers terse", category: "User-Preferences" }]);
    });

    test("mentalModels never throws; [] on failure", async () => {
        globalThis.fetch = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        const backend = makeMmBackend();
        await expect(
            backend.mentalModels({ scope: "project", projectIdentity: "git:a", projectName: "x" }),
        ).resolves.toEqual([]);
    });

    test("first successful project retain seeds missing MMs once", async () => {
        const seeded: string[] = [];
        responder = (url) => {
            if (url.includes("/mental-models")) {
                const isPost = false; // overwritten by wrapped fetch
                void isPost;
                return okJson({ items: [] });
            }
            if (url.endsWith("/v1/default/banks")) {
                return okJson({ banks: [{ bank_id: "main-memory" }] });
            }
            return okJson({ success: true });
        };
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            requests.push({ url, init: init ?? {} });
            if (url.includes("/mental-models") && init?.method === "POST") {
                seeded.push(JSON.parse(String(init.body)).name);
                return okJson({ mental_model_id: "new", operation_id: "op" });
            }
            return responder(url);
        }) as typeof fetch;
        const backend = makeMmBackend();
        await backend.retain([projectItem]);
        await Bun.sleep(10); // seeding is fire-and-forget after retain
        expect(seeded.sort()).toEqual(["project-conventions", "project-decisions"]);
        seeded.length = 0;
        await backend.retain([projectItem]);
        await Bun.sleep(10);
        expect(seeded).toEqual([]); // cached, no re-seed
        globalThis.fetch = origFetch;
    });

    test("main bank retains never seed MMs", async () => {
        const backend = makeMmBackend();
        await backend.retain([userItem]);
        await Bun.sleep(10);
        expect(requests.some((r) => r.url.includes("/mental-models"))).toBe(false);
    });

    test("mental_models false disables fetch and seeding", async () => {
        const backend = makeBackend(); // mental_models: false
        const results = await backend.mentalModels({
            scope: "project",
            projectIdentity: "git:a",
            projectName: "x",
        });
        expect(results).toEqual([]);
        expect(requests.length).toBe(0);
    });
});
