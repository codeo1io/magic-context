export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_SEARCH_DESCRIPTION = `Your long-term recall for this project — search everything that ever happened here, not just what's currently visible.

Reach for it when something feels familiar but isn't in view: "did we solve this before?", "what did we decide about X?", "when did this break?", "where does Y live?". Results only contain things you CANNOT currently see — memories already shown in <project-memory>, the live conversation tail, and external knowledge already injected via <external-memory> are all filtered out.

Sources (omit for a broad search across all):
- memory: curated cross-session project knowledge — rules, constraints, conventions.
- message: the raw conversation behind your compacted history. Hits include message ordinals — expand the surrounding exchange with ctx_expand(start=N-10, end=N+5).
- git_commit: this repository's commit history.
- external: long-term knowledge from past sessions across projects (requires memory.external.recall.search=true; explicit ctx_search calls only).

Picking sources:
- "when did this change / was this working before" → ["git_commit", "message"]
- "did we discuss this earlier" → ["message"]
- "what's our convention / rule for X" → ["memory"]
- "is there anything relevant from prior sessions / other projects" → ["external"]`;
export const DEFAULT_CTX_SEARCH_LIMIT = 10;
