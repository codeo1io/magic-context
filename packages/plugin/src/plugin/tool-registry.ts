import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { isDreamerRunnable } from "../config/agent-disable";
import { DEFAULT_PROTECTED_TAGS } from "../features/magic-context/defaults";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import type { SkillLoadRegistry } from "../features/magic-context/skill-memory/provenance";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../features/magic-context/storage";
import type { Database } from "../shared/sqlite";
import { createCtxExpandTools } from "../tools/ctx-expand";
import { CTX_MEMORY_ACTIONS, createCtxMemoryTools } from "../tools/ctx-memory";
import { createCtxNoteTools } from "../tools/ctx-note";
import { createCtxReduceTools } from "../tools/ctx-reduce";
import { createCtxSearchTools } from "../tools/ctx-search";
import { CTX_SKILL_NOTE_TOOL_NAME, createCtxSkillNoteTool } from "../tools/ctx-skill-note";
import { CTX_SKILL_RECALL_TOOL_NAME, createCtxSkillRecallTool } from "../tools/ctx-skill-recall";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";
import { normalizeToolArgSchemas } from "./normalize-tool-arg-schemas";
import type { PluginContext } from "./types";

export function createToolRegistry(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    skillLoadRegistry: SkillLoadRegistry;
}): Record<string, ToolDefinition> {
    const { ctx, pluginConfig } = args;

    if (pluginConfig.enabled !== true) {
        return {};
    }

    // Storage failure (binary ABI mismatch, unwritable path, etc.) must
    // disable Magic Context cleanly instead of silently degrading. We never
    // expose ctx_* tools when storage isn't healthy — see openDatabase()
    // for the reasoning.
    let db: Database;
    try {
        const opened = openDatabase();
        // openDatabase returns null on the schema-fence path (DB newer than this
        // binary) and throws on a fatal open error — handle both as "storage
        // unavailable, disable tools cleanly".
        if (!opened || !isDatabasePersisted(opened)) {
            const reason = getDatabasePersistenceError(opened);
            console.warn(
                `[magic-context] persistent storage unavailable; disabling magic-context tools${reason ? `: ${reason}` : ""}`,
            );
            return {};
        }
        db = opened;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // console.warn intentional: this runs during plugin init before the file logger is
        // guaranteed to be ready, and storage failure is user-visible enough to warrant stderr.
        console.warn(
            `[magic-context] persistent storage unavailable; disabling magic-context tools: ${reason}`,
        );
        return {};
    }

    void ensureProjectRegisteredFromOpenCodeDirectory(ctx.directory, db);

    // Tools resolve project per-call from `toolContext.directory` because
    // OpenCode's top-level `ctx.directory` reflects the launch dir, not the
    // session's actual working directory (e.g. when launched via
    // `opencode -s <id>` from outside the project).
    const resolveProjectPath = (directory: string) => resolveProjectIdentity(directory);

    const ctxReduceEnabled = pluginConfig.ctx_reduce_enabled !== false;
    const allTools: Record<string, ToolDefinition> = {
        ...(ctxReduceEnabled
            ? createCtxReduceTools({
                  db,
                  protectedTags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
              })
            : {}),
        ...createCtxExpandTools({ db }),
        ...createCtxNoteTools({
            db,
            dreamerEnabled: isDreamerRunnable(pluginConfig),
            resolveProjectPath,
        }),
        ...createCtxSearchTools({
            db,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        }),
        ...createCtxMemoryTools({
            db,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
            // Primary agents get the full mutation surface (write/archive/update/
            // merge) on memories they can already see (with ids) in the injected
            // <project-memory> block. Only `list` (bulk enumeration) stays
            // dreamer-only — runtime-gated via toolContext.agent in tools.ts.
            allowedActions: [...CTX_MEMORY_ACTIONS],
        }),
        // ctx_skill_note: skill-specific memory tool. Reads the session-scoped
        // skillLoadRegistry to verify the skill was actually loaded this session
        // before allowing a note to be written. The fail-loud guard for a missing
        // registry lives in index.ts (the only place hooks.magicContext is in
        // scope) so a wiring regression is caught at startup, not at runtime.
        [CTX_SKILL_NOTE_TOOL_NAME]: createCtxSkillNoteTool({
            db,
            skillLoadRegistry: args.skillLoadRegistry,
        }),
        // ctx_skill_recall: explicit agent-callable recall tool. Registry-first
        // (reuses the already-parsed frontmatterConfig from the transparent path)
        // with disk-fallback for cold-start sessions where the skill hasn't been
        // loaded yet. projectDirectory is a fallback only — execute() prefers
        // toolContext.directory (the session's actual working dir) so `opencode -s`
        // from outside the project resolves correctly. No fail-loud guard needed:
        // skillLoadRegistry is optional for ctx_skill_recall.
        [CTX_SKILL_RECALL_TOOL_NAME]: createCtxSkillRecallTool({
            db,
            projectDirectory: ctx.directory,
            skillLoadRegistry: args.skillLoadRegistry,
        }),
    };

    // Patch arg schemas so property-level .describe() text survives JSON Schema serialization.
    // Without this, the LLM sees bare types with no description for each parameter.
    for (const toolDefinition of Object.values(allTools)) {
        normalizeToolArgSchemas(toolDefinition);
    }

    return allTools;
}
