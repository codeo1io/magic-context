import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { detectConfigFile, parseJsonc } from "../shared/jsonc-parser";
import { migrateLegacyAgentEnabledInMemory } from "./agent-disable";
import { migrateLegacyExperimental } from "./migrate-experimental";
import {
    dropInheritedEmbeddingKeyOnRedirect,
    stripUnsafeProjectConfigFields,
} from "./project-security";
import { pruneNestedConfigLeaf } from "./prune-config-leaf";
import { type MagicContextConfig, MagicContextConfigSchema } from "./schema/magic-context";
import { substituteConfigVariables } from "./variable";

export interface MagicContextPluginConfig extends MagicContextConfig {
    disabled_hooks?: string[];
    command?: Record<
        string,
        {
            template: string;
            description?: string;
            agent?: string;
            model?: string;
            subtask?: boolean;
        }
    >;
}

const CONFIG_FILE_BASENAME = "magic-context";

function getUserConfigBasePath(): string {
    const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(configRoot, "opencode", CONFIG_FILE_BASENAME);
}

function getProjectConfigBasePath(directory: string): string {
    return join(directory, ".opencode", CONFIG_FILE_BASENAME);
}

/**
 * When opencode runs INSIDE the user config directory (e.g. the user opens
 * `~/.config/opencode` itself to edit their setup), project-config discovery
 * resolves to the very same magic-context.jsonc as the trusted user config.
 * Loading it a second time as an "untrusted repo config" double-applies the
 * file and falsely triggers the project security strips ({file:} tokens,
 * memory.external) against the user's own config. Treat same-file as
 * user-config-only.
 */
function dropProjectConfigWhenSameAsUser(
    userDetected: ReturnType<typeof detectConfigFile>,
    projectDetected: ReturnType<typeof detectConfigFile>,
): ReturnType<typeof detectConfigFile> {
    if (userDetected.format === "none" || projectDetected.format === "none") {
        return projectDetected;
    }
    if (resolve(userDetected.path) === resolve(projectDetected.path)) {
        return { format: "none", path: projectDetected.path };
    }
    return projectDetected;
}

interface LoadedConfigFile {
    config: Record<string, unknown>;
    /** Warnings from {env:} / {file:} substitution, with config-path prefix applied. */
    warnings: string[];
}

export type LoadOutcome =
    | "ok"
    | "project-file-parse-error"
    | "project-file-io-error"
    | "schema-recovery"
    | "substitution-failure";

export interface LoadResultDetailed {
    config: MagicContextPluginConfig & { configWarnings?: string[] };
    loadOutcome: LoadOutcome;
    sources: {
        userConfig: LoadOutcome;
        projectConfig: LoadOutcome;
    };
    substitutionFailures: Array<{ keyPath: string; source: "user" | "project"; message: string }>;
    recoveredTopLevelKeys: string[];
}

interface LoadedConfigFileDetailed extends LoadedConfigFile {
    outcome: LoadOutcome;
    source: "user" | "project";
}

function loadConfigFile(configPath: string, isProjectConfig = false): LoadedConfigFile | null {
    try {
        if (!existsSync(configPath)) {
            return null;
        }
        const rawText = readFileSync(configPath, "utf-8");
        // Substitute {env:VAR} and {file:path} tokens on the raw text before
        // parsing so users can reference env vars (API keys) and external files
        // without leaking secrets into the config file itself. Matches OpenCode's
        // ConfigVariable.substitute semantics exactly.
        const substituted = substituteConfigVariables({
            text: rawText,
            configPath,
            isProjectConfig,
        });
        return {
            config: parseJsonc<Record<string, unknown>>(substituted.text),
            warnings: substituted.warnings.map((w) => `${configPath}: ${w}`),
        };
    } catch (error) {
        console.warn(
            `[magic-context] failed to load config from ${configPath}:`,
            error instanceof Error ? error.message : String(error),
        );
        return null;
    }
}

function loadConfigFileDetailed(
    configPath: string,
    source: "user" | "project",
): LoadedConfigFileDetailed | null {
    if (!existsSync(configPath)) {
        return null;
    }

    let rawText: string;
    try {
        rawText = readFileSync(configPath, "utf-8");
    } catch (error) {
        return {
            config: {},
            warnings: [
                `${configPath}: failed to read config: ${error instanceof Error ? error.message : String(error)}`,
            ],
            outcome: "project-file-io-error",
            source,
        };
    }

    try {
        const substituted = substituteConfigVariables({
            text: rawText,
            configPath,
            isProjectConfig: source === "project",
        });
        return {
            config: parseJsonc<Record<string, unknown>>(substituted.text),
            warnings: substituted.warnings.map((w) => `${configPath}: ${w}`),
            outcome: substituted.warnings.length > 0 ? "substitution-failure" : "ok",
            source,
        };
    } catch (error) {
        return {
            config: {},
            warnings: [
                `${configPath}: failed to load config: ${error instanceof Error ? error.message : String(error)}`,
            ],
            outcome: "project-file-parse-error",
            source,
        };
    }
}

/**
 * Deep-merge two raw JSON objects. Both inputs must come from BEFORE Zod
 * parsing — otherwise Zod-filled defaults appear as if they were explicit
 * overrides and clobber genuine values from the other source.
 *
 * Plain object values merge recursively. Arrays, primitives, and `null` are
 * replaced atomically (override wins). This matches typical config-merge
 * semantics: arrays like `disabled_hooks` should be set whole, not interleaved
 * element-wise.
 *
 * `disabled_hooks` is the one exception: we union-merge it below so user
 * and project can both contribute hook IDs without one silently losing the
 * other's entries.
 */
function deepMergeRawConfig(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
        const baseVal = base[key];
        const overrideVal = override[key];
        if (
            baseVal !== null &&
            typeof baseVal === "object" &&
            !Array.isArray(baseVal) &&
            overrideVal !== null &&
            typeof overrideVal === "object" &&
            !Array.isArray(overrideVal)
        ) {
            result[key] = deepMergeRawConfig(
                baseVal as Record<string, unknown>,
                overrideVal as Record<string, unknown>,
            );
        } else if (
            key === "disabled_hooks" &&
            Array.isArray(baseVal) &&
            Array.isArray(overrideVal)
        ) {
            // Union-merge so user + project can both disable hooks without
            // one source erasing the other's entries.
            result[key] = [...new Set([...baseVal, ...overrideVal])];
        } else {
            result[key] = overrideVal;
        }
    }
    return result;
}

/**
 * Render a config value for a warning message in a way that never leaks resolved
 * secrets from `{env:API_KEY}` / `{file:...}` substitution.
 *
 * Strings, numbers, booleans, and nulls are shown as type-plus-length so the
 * user can still diagnose the problem ("string, 48 chars", "number 200001") but
 * never see the resolved content. Objects and arrays are shown as their
 * structural shape only. `undefined` / missing values are reported as
 * `<missing>`.
 */
function redactConfigValue(value: unknown): string {
    if (value === undefined) return "<missing>";
    if (value === null) return "null";
    if (typeof value === "string")
        return `string, ${value.length} char${value.length === 1 ? "" : "s"}`;
    if (typeof value === "number") return `number ${value}`;
    if (typeof value === "boolean") return `boolean ${value}`;
    if (Array.isArray(value)) return `array, ${value.length} item${value.length === 1 ? "" : "s"}`;
    if (typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>);
        return `object with keys [${keys.join(", ")}]`;
    }
    return typeof value;
}

function parsePluginConfig(
    rawConfig: Record<string, unknown>,
    recoveredTopLevelKeys: string[] = [],
): MagicContextPluginConfig & { configWarnings?: string[] } {
    // Pre-Zod shim: reshape legacy experimental.* graduated keys so the user's
    // opt-in/out state survives upgrades even when they never run `doctor`.
    const preMigrationWarnings: string[] = [];
    const migratedExperimental = migrateLegacyExperimental(rawConfig, preMigrationWarnings);
    const migrated = migrateLegacyAgentEnabledInMemory(migratedExperimental, preMigrationWarnings);
    const parsed = MagicContextConfigSchema.safeParse(migrated);
    const disabledHooks = Array.isArray(rawConfig.disabled_hooks)
        ? rawConfig.disabled_hooks.filter((value): value is string => typeof value === "string")
        : undefined;
    const command =
        typeof rawConfig.command === "object" && rawConfig.command !== null
            ? (rawConfig.command as MagicContextPluginConfig["command"])
            : undefined;

    if (parsed.success) {
        return {
            ...parsed.data,
            disabled_hooks: disabledHooks,
            command,
            ...(preMigrationWarnings.length > 0 ? { configWarnings: preMigrationWarnings } : {}),
        };
    }

    // Full parse failed — recover field-by-field using defaults for invalid fields.
    // Agent configs (historian, dreamer, sidekick) are dropped on error rather than defaulted
    // because wrong model config could run expensive models or fail silently.
    const defaults = MagicContextConfigSchema.parse({});
    const warnings: string[] = [];

    // Build a patched copy of rawConfig, replacing invalid fields with undefined
    // so Zod fills in defaults on the second parse.
    const errorPaths = new Set<string>();
    // Collect any custom Zod messages per top-level key so a field with an
    // explanatory `.max(..., "why")` / `.refine(..., "why")` message surfaces the
    // reason to the user instead of a bare "invalid value" (e.g. issue #111's
    // execute_threshold cache-safety explanation). Only non-default Zod messages
    // are kept — the generic "Too big"/"Invalid input" boilerplate adds nothing.
    const customMessagesByKey = new Map<string, string>();
    // Per top-level key, the set of FULL error paths (e.g. ["memory","auto_search"]).
    // Used to prune only the invalid nested leaf instead of the whole block.
    const issuePathsByKey = new Map<string, PropertyKey[][]>();
    const GENERIC_ZOD_PREFIXES = ["Too big", "Too small", "Invalid input", "Invalid", "Expected"];
    for (const issue of parsed.error.issues) {
        const topKey = issue.path[0];
        if (topKey !== undefined) {
            const key = String(topKey);
            errorPaths.add(key);
            const paths = issuePathsByKey.get(key) ?? [];
            paths.push([...issue.path]);
            issuePathsByKey.set(key, paths);
            const msg = issue.message;
            if (msg && !GENERIC_ZOD_PREFIXES.some((p) => msg.startsWith(p))) {
                if (!customMessagesByKey.has(key)) {
                    customMessagesByKey.set(key, msg);
                }
            }
        }
    }

    const patched: Record<string, unknown> = { ...rawConfig };
    for (const key of errorPaths) {
        recoveredTopLevelKeys.push(key);
        const isAgentConfig = key === "historian" || key === "dreamer" || key === "sidekick";
        if (isAgentConfig) {
            // Drop agent configs entirely on error — don't default them
            delete patched[key];
            warnings.push(
                `"${key}": invalid agent configuration, ignoring. Check your magic-context.jsonc.`,
            );
            continue;
        }

        // For object-valued keys (e.g. `memory`), prune ONLY the invalid nested
        // leaves and keep valid siblings, so one bad nested field doesn't wipe the
        // whole block — which would silently drop already-migrated graduated keys
        // like memory.auto_search / memory.git_commit_indexing. Falls back to
        // whole-key deletion when the issue is at the key itself or the value
        // isn't a prunable object.
        const issuePaths = issuePathsByKey.get(key) ?? [];
        const rawValue = rawConfig[key];
        const allNested =
            issuePaths.length > 0 &&
            issuePaths.every((p) => p.length >= 2) &&
            typeof rawValue === "object" &&
            rawValue !== null &&
            !Array.isArray(rawValue);
        if (allNested) {
            let prunedBlock: Record<string, unknown> = {
                ...(rawValue as Record<string, unknown>),
            };
            const prunedLeaves: string[] = [];
            for (const p of issuePaths) {
                // p is the full Zod issue path ([key, ...nested]); prune the
                // DEEPEST invalid leaf, not just the first child (p[1]), so a
                // 3-level path like memory.git_commit_indexing.since_days drops
                // only `since_days` and keeps a sibling `enabled: false`.
                const relative = p.slice(1);
                const result = pruneNestedConfigLeaf(prunedBlock, relative);
                if (result) {
                    prunedBlock = result.block;
                    prunedLeaves.push(result.removed);
                }
            }
            patched[key] = prunedBlock;
            const reason = customMessagesByKey.get(key);
            warnings.push(
                `"${key}": invalid nested field(s) ${prunedLeaves.map((l) => `"${l}"`).join(", ")}, using defaults for those.${reason ? ` ${reason}` : ""}`,
            );
            continue;
        }

        // Use Zod default for this field.
        // Intentional: redactConfigValue reports type+length, never the
        // resolved value itself, because `{env:...}` / `{file:...}`
        // substitution may have already expanded secrets into rawConfig.
        delete patched[key];
        const defaultVal = (defaults as unknown as Record<string, unknown>)[key];
        const reason = customMessagesByKey.get(key);
        warnings.push(
            `"${key}": invalid value (${redactConfigValue(rawConfig[key])}), using default ${JSON.stringify(defaultVal)}.${reason ? ` ${reason}` : ""}`,
        );
    }

    // Re-run migration on the field-recovered patched config so legacy
    // experimental blocks still migrate on the recovery path.
    const retryMigrated = migrateLegacyExperimental(patched, preMigrationWarnings);
    const retryParsed = MagicContextConfigSchema.safeParse(retryMigrated);
    if (retryParsed.success) {
        return {
            ...retryParsed.data,
            disabled_hooks: disabledHooks,
            command,
            configWarnings: [...preMigrationWarnings, ...warnings],
        };
    }

    // If even the patched version fails (shouldn't happen), fall back to full defaults
    // but keep enabled:true — the user intended to use the plugin.
    warnings.push("Config recovery failed, using all defaults.");
    return {
        ...defaults,
        disabled_hooks: disabledHooks,
        command,
        configWarnings: [...preMigrationWarnings, ...warnings],
    };
}

export function loadPluginConfig(
    directory: string,
): MagicContextPluginConfig & { configWarnings?: string[] } {
    const userDetected = detectConfigFile(getUserConfigBasePath());
    // Check project root first, then .opencode/ — root takes precedence
    const rootDetected = detectConfigFile(join(directory, CONFIG_FILE_BASENAME));
    const dotOpenCodeDetected = detectConfigFile(getProjectConfigBasePath(directory));
    let projectDetected = rootDetected.format !== "none" ? rootDetected : dotOpenCodeDetected;
    projectDetected = dropProjectConfigWhenSameAsUser(userDetected, projectDetected);

    const userLoaded = userDetected.format === "none" ? null : loadConfigFile(userDetected.path);
    const projectLoaded =
        projectDetected.format === "none" ? null : loadConfigFile(projectDetected.path, true);

    const allWarnings: string[] = [];
    let mergedRaw: Record<string, unknown> = {};

    if (userLoaded) {
        // Variable-substitution warnings surface first so users see missing
        // env vars before any downstream schema-validation warnings.
        allWarnings.push(...userLoaded.warnings.map((w) => `[user config] ${w}`));
        mergedRaw = deepMergeRawConfig(mergedRaw, userLoaded.config);
    }

    if (projectLoaded) {
        allWarnings.push(...projectLoaded.warnings.map((w) => `[project config] ${w}`));

        // Harden the repo-supplied (untrusted) project config before merging it
        // over the trusted user config: strip auto_update + hidden-agent
        // prompt/permission/tools (privilege-escalation vectors).
        const projectRaw = { ...projectLoaded.config };
        for (const warning of stripUnsafeProjectConfigFields(projectRaw)) {
            allWarnings.push(`[project config] ${warning}`);
        }

        mergedRaw = deepMergeRawConfig(mergedRaw, projectRaw);

        // Post-merge: prevent a redirected embedding endpoint from inheriting
        // the user's api_key (exfiltration guard). Pass the user config so a
        // project that only repeats the user's own endpoint (to change model,
        // etc.) is not treated as a redirect.
        for (const warning of dropInheritedEmbeddingKeyOnRedirect(
            projectRaw,
            mergedRaw,
            userLoaded?.config,
        )) {
            allWarnings.push(`[project config] ${warning}`);
        }
    }

    // Parse the merged raw config ONCE. Critical: parsing must run AFTER the
    // raw merge so Zod fills defaults only for keys neither user nor project
    // explicitly set. The previous design parsed each source separately then
    // merged the parsed (defaults-filled) results, which let a project
    // config that didn't mention `embedding` silently override a user's
    // explicit openai-compatible config with the local Zod default. See
    // regression discussion 2026-05-12.
    const config = parsePluginConfig(mergedRaw);

    if (config.configWarnings?.length) {
        // Tag schema-validation warnings against whichever source set the
        // bad field. We can't always tell which one set what after merging,
        // so use a generic prefix when the offending key appears in both.
        allWarnings.push(
            ...config.configWarnings.map((w) => {
                if (userLoaded && projectLoaded) return `[config] ${w}`;
                if (userLoaded) return `[user config] ${w}`;
                return `[project config] ${w}`;
            }),
        );
    }

    if (allWarnings.length > 0) {
        config.configWarnings = allWarnings;
    } else if ("configWarnings" in config) {
        // Don't leak an empty configWarnings field through to callers when
        // the merge was clean.
        config.configWarnings = undefined;
    }

    return config;
}

function collectEmptyStringPaths(value: unknown, prefix = ""): string[] {
    if (typeof value === "string") {
        return value === "" && prefix ? [prefix] : [];
    }
    if (Array.isArray(value) || value === null || typeof value !== "object") {
        return [];
    }

    const paths: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        paths.push(...collectEmptyStringPaths(child, nextPrefix));
    }
    return paths;
}

function bindSubstitutionFailures(
    loaded: LoadedConfigFileDetailed | null,
): Array<{ keyPath: string; source: "user" | "project"; message: string }> {
    if (!loaded || loaded.warnings.length === 0 || loaded.outcome !== "substitution-failure") {
        return [];
    }

    const emptyPaths = collectEmptyStringPaths(loaded.config);
    return loaded.warnings.map((message) => {
        const matchedPath = emptyPaths.find((path) => {
            const tail = path.split(".").at(-1) ?? path;
            return message.includes(path) || message.toLowerCase().includes(tail.toLowerCase());
        });
        return { keyPath: matchedPath ?? "<unknown>", source: loaded.source, message };
    });
}

function combinedOutcome(args: {
    sources: LoadResultDetailed["sources"];
    substitutionFailures: LoadResultDetailed["substitutionFailures"];
    recoveredTopLevelKeys: string[];
}): LoadOutcome {
    const sourceOutcomes = Object.values(args.sources);
    if (sourceOutcomes.includes("project-file-parse-error")) return "project-file-parse-error";
    if (sourceOutcomes.includes("project-file-io-error")) return "project-file-io-error";
    if (args.recoveredTopLevelKeys.length > 0) return "schema-recovery";
    if (args.substitutionFailures.length > 0) return "substitution-failure";
    return "ok";
}

export function loadPluginConfigDetailed(directory: string): LoadResultDetailed {
    const userDetected = detectConfigFile(getUserConfigBasePath());
    const rootDetected = detectConfigFile(join(directory, CONFIG_FILE_BASENAME));
    const dotOpenCodeDetected = detectConfigFile(getProjectConfigBasePath(directory));
    let projectDetected = rootDetected.format !== "none" ? rootDetected : dotOpenCodeDetected;
    projectDetected = dropProjectConfigWhenSameAsUser(userDetected, projectDetected);

    const userLoaded =
        userDetected.format === "none" ? null : loadConfigFileDetailed(userDetected.path, "user");
    const projectLoaded =
        projectDetected.format === "none"
            ? null
            : loadConfigFileDetailed(projectDetected.path, "project");

    const allWarnings: string[] = [];
    let mergedRaw: Record<string, unknown> = {};

    if (userLoaded) {
        allWarnings.push(...userLoaded.warnings.map((w) => `[user config] ${w}`));
        mergedRaw = deepMergeRawConfig(mergedRaw, userLoaded.config);
    }

    if (projectLoaded) {
        allWarnings.push(...projectLoaded.warnings.map((w) => `[project config] ${w}`));
        const projectRaw = { ...projectLoaded.config };
        for (const warning of stripUnsafeProjectConfigFields(projectRaw)) {
            allWarnings.push(`[project config] ${warning}`);
        }
        mergedRaw = deepMergeRawConfig(mergedRaw, projectRaw);
        for (const warning of dropInheritedEmbeddingKeyOnRedirect(
            projectRaw,
            mergedRaw,
            userLoaded?.config,
        )) {
            allWarnings.push(`[project config] ${warning}`);
        }
    }

    const recoveredTopLevelKeys: string[] = [];
    const config = parsePluginConfig(mergedRaw, recoveredTopLevelKeys);
    if (config.configWarnings?.length) {
        allWarnings.push(
            ...config.configWarnings.map((w) => {
                if (userLoaded && projectLoaded) return `[config] ${w}`;
                if (userLoaded) return `[user config] ${w}`;
                return `[project config] ${w}`;
            }),
        );
    }
    if (allWarnings.length > 0) {
        config.configWarnings = allWarnings;
    } else if ("configWarnings" in config) {
        config.configWarnings = undefined;
    }

    const substitutionFailures = [
        ...bindSubstitutionFailures(userLoaded),
        ...bindSubstitutionFailures(projectLoaded),
    ];
    const sources = {
        userConfig: userLoaded?.outcome ?? ("ok" as LoadOutcome),
        projectConfig: projectLoaded?.outcome ?? ("ok" as LoadOutcome),
    };

    return {
        config,
        loadOutcome: combinedOutcome({ sources, substitutionFailures, recoveredTopLevelKeys }),
        sources,
        substitutionFailures,
        recoveredTopLevelKeys,
    };
}
