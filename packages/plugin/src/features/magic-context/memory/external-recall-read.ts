import { createHash } from "node:crypto";
import type { Database } from "../../../shared/sqlite";

export interface ExternalRecallSliceItem {
    content: string;
    category?: string;
}
export interface ExternalRecallSnapshot {
    project: ExternalRecallSliceItem[];
    profile: ExternalRecallSliceItem[];
    global: ExternalRecallSliceItem[];
}
export type ExternalRecallState = "pending" | "done" | "failed";

export function isSnapshotEmpty(snapshot: ExternalRecallSnapshot): boolean {
    return (
        snapshot.project.length === 0 &&
        snapshot.profile.length === 0 &&
        snapshot.global.length === 0
    );
}

/** Deterministic fingerprint of a snapshot; '' for empty/none. */
export function computeRecallSnapshotHash(snapshot: ExternalRecallSnapshot | null): string {
    if (!snapshot || isSnapshotEmpty(snapshot)) return "";
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
}

export function readExternalRecallSnapshot(
    db: Database,
    sessionId: string,
): { state: ExternalRecallState | null; snapshot: ExternalRecallSnapshot | null } {
    let row: { state?: unknown; json?: unknown } | null = null;
    try {
        row = db
            .prepare(
                "SELECT external_recall_state AS state, external_recall_json AS json FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { state?: unknown; json?: unknown } | null;
    } catch {
        return { state: null, snapshot: null }; // pre-migration DB — behave as never-started
    }
    const state =
        row?.state === "pending" || row?.state === "done" || row?.state === "failed"
            ? row.state
            : null;
    if (state !== "done" || typeof row?.json !== "string" || row.json.length === 0) {
        return { state, snapshot: null };
    }
    try {
        const parsed = JSON.parse(row.json) as Partial<ExternalRecallSnapshot>;
        return {
            state,
            snapshot: {
                project: sanitizeSlice(parsed.project),
                profile: sanitizeSlice(parsed.profile),
                global: sanitizeSlice(parsed.global),
            },
        };
    } catch {
        return { state, snapshot: null };
    }
}

/** Per-item validation: the JSON is self-written, but a corrupted row must
 *  degrade to "fewer items", never to a render-path throw (a non-string
 *  content would explode inside materializeM0's renderExternalLines). */
function sanitizeSlice(value: unknown): ExternalRecallSliceItem[] {
    if (!Array.isArray(value)) return [];
    const items: ExternalRecallSliceItem[] = [];
    for (const raw of value) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as { content?: unknown; category?: unknown };
        if (typeof item.content !== "string" || item.content.length === 0) continue;
        items.push({
            content: item.content,
            ...(typeof item.category === "string" && item.category.length > 0
                ? { category: item.category }
                : {}),
        });
    }
    return items;
}

/** Marker-capture helper: hash of the persisted DONE snapshot, '' otherwise. */
export function readExternalRecallHash(db: Database, sessionId: string): string {
    const { state, snapshot } = readExternalRecallSnapshot(db, sessionId);
    if (state !== "done") return "";
    return computeRecallSnapshotHash(snapshot);
}
