import type { Database } from "../../../shared/sqlite";
import { getSkillMemoryNotes, type SkillMemoryNote } from "./storage";

export interface FlatRecallOptions {
    maxTokens: number;
    maxPinnedTokens: number;
}

// Rough token estimate: 1 token ≈ 4 chars (conservative for XML overhead)
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Flat recall (rungs 2 + 4): recency × hit_count, no embeddings.
 * Greedy fill by composite score up to maxTokens budget.
 * Pinned notes are always included (up to maxPinnedTokens).
 */
export function flatRecall(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    options: FlatRecallOptions,
): SkillMemoryNote[] {
    // Fetch a generous candidate set (2× budget as a heuristic)
    const candidates = getSkillMemoryNotes(db, skillId, tier, projectIdentity, 50);
    if (candidates.length === 0) return [];

    const pinned = candidates.filter((n) => n.pinned === 1);
    const unpinned = candidates.filter((n) => n.pinned === 0);

    const result: SkillMemoryNote[] = [];
    let pinnedTokens = 0;
    let totalTokens = 0;

    // Always include pinned notes (up to maxPinnedTokens)
    for (const note of pinned) {
        const tokens = estimateTokens(note.delta);
        if (pinnedTokens + tokens > options.maxPinnedTokens) break;
        result.push(note);
        pinnedTokens += tokens;
        totalTokens += tokens;
    }

    // Fill remaining budget with unpinned notes
    for (const note of unpinned) {
        if (totalTokens >= options.maxTokens) break;
        const tokens = estimateTokens(note.delta);
        if (totalTokens + tokens > options.maxTokens) break;
        result.push(note);
        totalTokens += tokens;
    }

    return result;
}

/**
 * Build the <skill-memory> XML block to append to the skill tool result.
 * Returns empty string for cold-start (no notes) — no empty stub injected.
 */
export function buildSkillMemoryBlock(
    skillId: string,
    mode: "no-intent" | "flat-fts",
    notes: SkillMemoryNote[],
    pinnedCount: number,
): string {
    if (notes.length === 0) return "";

    const noteXml = notes
        .map((n) => {
            const intentAttr = n.intent ? ` intent="${escapeXml(n.intent)}"` : "";
            const pinnedAttr = n.pinned === 1 ? ` pinned="true"` : ` pinned="false"`;
            return (
                `<note kind="${n.kind}"${intentAttr} hit_count="${n.hit_count}"${pinnedAttr}>\n` +
                `<delta>${escapeXml(n.delta)}</delta>\n` +
                `</note>`
            );
        })
        .join("\n");

    const footer =
        `\n\n---\n` +
        `*After using this skill, call \`ctx_skill_note\` — record only gotchas, novel discoveries, or error→fix; skip routine successes.*`;

    return (
        `<skill-memory skill="${escapeXml(skillId)}" mode="${mode}" count="${notes.length}" pinned="${pinnedCount}">\n` +
        noteXml +
        `\n</skill-memory>` +
        footer
    );
}

function escapeXml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
