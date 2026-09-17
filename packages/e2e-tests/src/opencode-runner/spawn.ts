/**
 * Spawn an isolated `opencode serve` process with:
 * - its own config/data directories (no pollution of the user's real setup)
 * - a custom mock-anthropic provider pointed at our mock server
 * - the magic-context plugin loaded from local source via `file://` spec
 *
 * Returns the server URL and a handle with `kill()` for test cleanup.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
// Prefer the bundled `dist/index.js` (what published users actually run)
// over raw `src/index.ts`. The bundled file is one ~5MB file with all imports
// inlined; loading it is fast even on cold runners. The TS-source path
// triggers Bun's runtime TS transpile + dynamic resolution across hundreds
// of submodule imports — on slow Linux CI runners this can take long enough
// to make `opencode serve` appear hung when it's just blocked in plugin
// load. Production never loads from src/, so testing src/ doesn't reflect
// reality and exposes us to a slowness path users never see.
const PLUGIN_DIST_ENTRY = join(REPO_ROOT, "packages/plugin/dist/index.js");
const PLUGIN_SRC_ENTRY = join(REPO_ROOT, "packages/plugin/src/index.ts");
const PLUGIN_ENTRY = existsSync(PLUGIN_DIST_ENTRY) ? PLUGIN_DIST_ENTRY : PLUGIN_SRC_ENTRY;

export interface IsolatedEnv {
    homeDir: string;
    configDir: string;
    dataDir: string;
    cacheDir: string;
    workdir: string;
}

export interface SpawnedOpencode {
    url: string;
    port: number;
    env: IsolatedEnv;
    kill: () => Promise<void>;
    stdout: () => string;
    stderr: () => string;
}

export interface SpawnOptions {
    /** URL of the mock Anthropic server, e.g. "http://127.0.0.1:12345" */
    mockProviderURL: string;
    /** Port for opencode serve. Default: random available */
    port?: number;
    /** magic-context.jsonc overrides. Defaults keep most features on. */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json provider/model config, merged with defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
}

/**
 * Pick a random free port by asking the OS for one. Uses Bun.serve + immediate stop.
 */
async function pickFreePort(): Promise<number> {
    const server = Bun.serve({ port: 0, fetch: () => new Response() });
    const port: number = server.port ?? 0;
    server.stop(true);
    if (!port) throw new Error("could not allocate a free port");
    return port;
}

/**
 * Create isolated config/data/cache dirs under a unique temp subdir.
 */
function createIsolatedEnv(): IsolatedEnv {
    const unique = `opencode-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base = join(tmpdir(), unique);
    const homeDir = join(base, "home");
    const configDir = join(base, "config");
    const dataDir = join(base, "data");
    const cacheDir = join(base, "cache");
    const workdir = join(base, "work");
    for (const d of [homeDir, configDir, dataDir, cacheDir, workdir]) {
        mkdirSync(d, { recursive: true });
    }
    return { homeDir, configDir, dataDir, cacheDir, workdir };
}

/**
 * Write opencode.json + magic-context.jsonc + tui.json into config/workdir.
 *
 * - opencode.json: registers our plugin via file:// spec, defines a mock-anthropic
 *   provider and a mock model, sets provider.mock-anthropic.options.baseURL to the
 *   mock server's URL.
 * - magic-context.jsonc: starts with small thresholds so tests trigger historian
 *   deterministically with modest scripted token counts.
 */
function writeConfigs(
    env: IsolatedEnv,
    mockProviderURL: string,
    opts: SpawnOptions,
): void {
    const pluginSpec = `file://${PLUGIN_ENTRY}`;

    const opencodeConfig: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
        plugin: [pluginSpec],
        // Disable telemetry-style checks that could reach out.
        autoupdate: false,
        // Match what `setup`/`doctor` writes for real users. OpenCode compaction
        // defaults to enabled; if we leave it on, magic-context's conflict
        // detector disables itself and the plugin becomes a no-op.
        compaction: { auto: false, prune: false },
        provider: {
            "mock-anthropic": {
                api: "@ai-sdk/anthropic",
                name: "Mock Anthropic",
                npm: "@ai-sdk/anthropic",
                env: [],
                options: {
                    apiKey: "test-key-not-real",
                    baseURL: mockProviderURL,
                },
                models: {
                    "mock-sonnet": {
                        id: "mock-sonnet",
                        name: "Mock Sonnet",
                        cost: { input: 0, output: 0 },
                        limit: { context: opts.modelContextLimit ?? 200000, output: 8192 },
                        // Advertise image + pdf input support so OpenCode does
                        // not substitute inline file parts with "this model
                        // does not support X input" text messages. Matches the
                        // real Sonnet capabilities this mock is standing in for.
                        modalities: {
                            input: ["text", "image", "pdf"],
                            output: ["text"],
                        },
                        options: {},
                    },
                },
            },
        },
        ...(opts.openCodeConfigExtra ?? {}),
    };

    // magic-context defaults tuned for fast triggering in tests.
    const magicContext = {
        $schema:
            "https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json",
        execute_threshold_percentage: 40,
        history_budget_percentage: 0.15,
        dreamer: { disable: true },
        sidekick: { disable: true },
        ...(opts.magicContextConfig ?? {}),
    };

    writeFileSync(join(env.configDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));

    // The plugin's loadPluginConfig() looks for magic-context.jsonc under
    // ${XDG_CONFIG_HOME}/opencode/magic-context.jsonc (user config) or
    // <workdir>/magic-context.jsonc (project root).
    //
    // We set XDG_CONFIG_HOME=env.configDir in the child env, so the user
    // config path resolves to env.configDir/opencode/magic-context.jsonc.
    // Put the file there; a sibling one in env.configDir is never read.
    const userConfigDir = join(env.configDir, "opencode");
    mkdirSync(userConfigDir, { recursive: true });
    writeFileSync(
        join(userConfigDir, "magic-context.jsonc"),
        JSON.stringify(magicContext, null, 2),
    );

    // tui.json: not needed for headless serve, but harmless to emit nothing for now.
}

/**
 * Wait until the opencode server responds to GET /doc (an endpoint that exists in
 * OpenCode's server). Polls for up to `timeoutMs`.
 *
 * Implementation note — Bun fetch timeout flake:
 *   Bun's default `fetch()` has a hardcoded ~5 minute timeout that ignores
 *   AbortSignal.timeout values longer than the limit
 *   (https://github.com/oven-sh/bun/issues/16682). If we don't bound each
 *   fetch attempt explicitly, a single hung request can hold the loop for
 *   the entire ~5 minute window, blowing past our overall deadline before
 *   we get any chance to retry. Pass a short AbortSignal.timeout on every
 *   attempt so one bad fetch can't starve the deadline.
 */
// Default bumped from 30s → 300s. GitHub-hosted runners can take much longer
// than 30s for `opencode serve` to bind its port + finish plugin init + complete
// opencode's own one-time SQLite migration (which opencode itself warns "may
// take a few minutes" on first boot per fresh CI XDG_DATA_HOME). Local hardware
// finishes in <2s. The bump to 300s covers CI cold-start without papering over
// genuine readiness failures — 5 minutes is still far above any realistic boot.
async function waitForReady(url: string, timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const FETCH_TIMEOUT_MS = 2_000;
    let lastFetchErr: unknown = null;
    let fetchAttempts = 0;

    while (Date.now() < deadline) {
        try {
            fetchAttempts++;
            const res = await fetch(`${url}/doc`, {
                method: "GET",
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.ok || res.status === 404 || res.status === 401) {
                // Server is responding — any HTTP response means it booted.
                return;
            }
        } catch (err) {
            lastFetchErr = err;
        }
        await Bun.sleep(200);
    }
    throw new Error(
        `opencode serve did not become ready in ${timeoutMs}ms.\n` +
            `  url=${url}/doc\n` +
            `  fetchAttempts=${fetchAttempts}\n` +
            `  fetchLastErr=${String(lastFetchErr)}`,
    );
}

export async function spawnOpencode(opts: SpawnOptions): Promise<SpawnedOpencode> {
    const env = createIsolatedEnv();
    const port = opts.port ?? (await pickFreePort());

    writeConfigs(env, opts.mockProviderURL, opts);

    // Explicitly strip any inherited OPENCODE_SERVER_PASSWORD from the parent shell —
    // our tests run unsecured on a random localhost port, and inherited auth would
    // force every SDK request to carry Basic auth headers we don't set.
    // Also strip NODE_ENV=test: Bun's test runner sets it automatically and the
    // plugin's logger (src/shared/logger.ts) silences all output when NODE_ENV=test.
    // We want the subprocess to behave like a real install, so the log file gets
    // populated normally for diagnostics.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (key === "OPENCODE_SERVER_PASSWORD") continue;
        if (key === "OPENCODE_SERVER_USERNAME") continue;
        if (key === "NODE_ENV") continue;
        childEnv[key] = value;
    }
    childEnv.OPENCODE_CONFIG_DIR = env.configDir;
    childEnv.HOME = env.homeDir;
    childEnv.XDG_CONFIG_HOME = env.configDir;
    childEnv.XDG_DATA_HOME = env.dataDir;
    childEnv.XDG_CACHE_HOME = env.cacheDir;
    // Ensure anthropic doesn't bail for missing env vars — we use a fake key.
    childEnv.ANTHROPIC_API_KEY = "test-key-not-real";

    // Bind to 0.0.0.0 (all interfaces) instead of 127.0.0.1 — empirically on
    // GitHub-hosted runners, opencode binding to 127.0.0.1 sometimes results
    // in Bun's `fetch()` timing out even though `curl` succeeds. Binding all
    // interfaces removes any loopback-specific stack-resolution edge case
    // (IPv4-only AF_INET vs IPv4-mapped IPv6, AF_UNSPEC name resolution, etc.).
    // Clients still connect to `127.0.0.1:${port}` — only the listen socket
    // changes. Safe locally too: process is short-lived, port is random.
    const child: ChildProcess = spawn(
        "opencode",
        ["serve", "--port", String(port), "--hostname", "0.0.0.0"],
        {
            cwd: env.workdir,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
    });

    const url = `http://127.0.0.1:${port}`;
    try {
        await waitForReady(url);
    } catch (err) {
        // Surface captured output on boot failure to help debugging.
        child.kill("SIGTERM");
        throw new Error(
            `opencode serve failed to start.\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}\n\n${String(err)}`,
        );
    }

    return {
        url,
        port,
        env,
        stdout: () => stdoutBuf,
        stderr: () => stderrBuf,
        kill: async () => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
                await new Promise<void>((resolveKill) => {
                    const timer = setTimeout(() => {
                        child.kill("SIGKILL");
                        resolveKill();
                    }, 3000);
                    child.once("exit", () => {
                        clearTimeout(timer);
                        resolveKill();
                    });
                });
            }
        },
    };
}
