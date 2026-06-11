/**
 * Auto-configure tui.json with magic-context TUI plugin entry.
 * Called from the server plugin at startup so the TUI sidebar loads on next restart.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "comment-json";
import { log } from "./logger";
import { getOpenCodeConfigPaths } from "./opencode-config-dir";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY = `${PLUGIN_NAME}@latest`;

function isMagicContextEntry(entry: string): boolean {
    if (!entry) return false;
    if (entry === PLUGIN_NAME) return true;
    if (entry.startsWith(`${PLUGIN_NAME}@`)) return true;
    // Tarball or any path containing the full npm package name.
    if (entry.includes("opencode-magic-context")) return true;
    // Local dev directory paths (absolute, relative, or file:// URLs):
    // ".../magic-context" or ".../magic-context/packages/plugin".
    // Match "magic-context" as a whole path segment so unrelated entries
    // (e.g. "not-magic-contexts") don't false-positive.
    if (/(^|\/)magic-context(\/|$)/.test(entry)) return true;
    return false;
}

function resolveTuiConfigPath(): string {
    const configDir = getOpenCodeConfigPaths({ binary: "opencode" }).configDir;
    const jsoncPath = join(configDir, "tui.jsonc");
    const jsonPath = join(configDir, "tui.json");

    if (existsSync(jsoncPath)) return jsoncPath;
    if (existsSync(jsonPath)) return jsonPath;
    return jsonPath; // default: create tui.json
}

/**
 * Ensure tui.json has the magic-context TUI plugin entry.
 * Creates tui.json if it doesn't exist. Silently skips if already present.
 */
export function ensureTuiPluginEntry(): boolean {
    try {
        const configPath = resolveTuiConfigPath();

        let config: Record<string, unknown> = {};
        if (existsSync(configPath)) {
            const raw = readFileSync(configPath, "utf-8");
            config = (parse(raw) as Record<string, unknown>) ?? {};
        }

        const plugins = Array.isArray(config.plugin)
            ? config.plugin.filter((p): p is string => typeof p === "string")
            : [];

        const existingIdx = plugins.findIndex(isMagicContextEntry);
        if (existingIdx >= 0) {
            const existing = plugins[existingIdx];
            if (existing === PLUGIN_ENTRY) {
                return false; // Already @latest
            }
            // Only upgrade the bare versionless npm name to @latest.
            // Pinned versions (e.g. @0.8.10), local dev paths
            // (~/Work/OSS/magic-context/packages/plugin), and
            // file:// URLs are all left as-is — the user chose them
            // intentionally and overwriting their dev-loop entry would
            // either double-load the plugin (npm + dev) or replace
            // their working directory pointer.
            if (existing === PLUGIN_NAME) {
                plugins[existingIdx] = PLUGIN_ENTRY;
            } else {
                return false;
            }
        } else {
            plugins.push(PLUGIN_ENTRY);
        }
        config.plugin = plugins;

        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, `${stringify(config, null, 2)}\n`);
        log(`[magic-context] updated TUI plugin entry in ${configPath}`);
        return true;
    } catch (error) {
        log(
            `[magic-context] failed to update tui.json: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}
