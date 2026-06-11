/**
 * In-memory child→parent session registry.
 *
 * Child sessions (sidekick, dreamer, user task subagents) execute tools with
 * their OWN session id, but several session-scoped reads only make sense
 * against the conversation the child was spawned FROM:
 *
 *   - ctx_search's message-history source: the child session has no indexed
 *     messages and no compartment boundary, so searching by the child id
 *     returns nothing — the user-visible conversation history lives on the
 *     root session.
 *   - ctx_search's "already visible" filters (memory_block_ids, the injected
 *     <external-memory> snapshot): both are persisted on the root session's
 *     session_meta; reading them by the child id silently disables the
 *     filter and re-surfaces content the parent conversation already shows.
 *
 * Population: the `session.created` event carries `parentID` for every child
 * session, so the event handler registers all parentage centrally. Lookups
 * walk to the root (depth-capped, cycle-safe) so nested children resolve to
 * the user's conversation.
 *
 * Posture: best-effort, in-memory only (parentage never spans a restart —
 * a restarted process has no in-flight children). Bounded LRU per the
 * module-singleton convention; unknown ids resolve to themselves, so every
 * caller degrades to current behavior when the registry has no entry (e.g.
 * the Pi harness, whose subagents run in separate processes).
 */

import { BoundedSessionMap } from "../../shared/bounded-session-map";

const MAX_TRACKED_SESSIONS = 500;
/** Defensive cap on parent-chain walks (cycles cannot be created via
 *  session.created ordering, but a corrupt registration must not loop). */
const MAX_PARENT_DEPTH = 5;

const parentBySession = new BoundedSessionMap<string>(MAX_TRACKED_SESSIONS);

export function registerSessionParent(childSessionId: string, parentSessionId: string): void {
    if (!childSessionId || !parentSessionId) return;
    if (childSessionId === parentSessionId) return;
    parentBySession.set(childSessionId, parentSessionId);
}

export function unregisterSessionParent(childSessionId: string): void {
    parentBySession.delete(childSessionId);
}

/**
 * Resolve a session id to its root (the user's conversation). Returns the
 * input unchanged when no parent is registered — safe to call on main
 * sessions and on harnesses that never register parentage.
 */
export function resolveRootSessionId(sessionId: string): string {
    let current = sessionId;
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
        const parent = parentBySession.peek(current);
        if (!parent || parent === current) return current;
        current = parent;
    }
    return current;
}

export function _resetSessionParentRegistryForTests(): void {
    parentBySession.clear();
}
