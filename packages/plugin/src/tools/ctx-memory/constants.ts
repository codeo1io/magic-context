export const CTX_MEMORY_TOOL_NAME = "ctx_memory";
export const CTX_MEMORY_DESCRIPTION = `Durable project knowledge shared across every session on this project.

Your active memories are already visible in <project-memory> (each with its id), and every future session starts with them — write one when you learn something future sessions must know: a project rule, an architectural fact, a hard-won constraint, a config value, or a naming convention. Keep each memory one standalone fact, phrased to make sense without this session's context.

Actions:
- write: save a new memory (content + category). Optional scope: "project" (default) for this project's store, or "global" for cross-project facts (infrastructure, tooling, environment) stored only in the external long-term memory backend.
- update: rewrite one memory whose fact changed (ids: [one], content).
- archive: retire wrong or obsolete memories (ids: [one or more], optional reason).
- merge: collapse duplicates into one memory (ids: [two or more], content).

Example: ctx_memory(action="write", category="CONSTRAINTS", content="Pi stores sessions as JSONL under ~/.pi/agent/sessions/, not SQLite")`;
export const DEFAULT_SEARCH_LIMIT = 10;
