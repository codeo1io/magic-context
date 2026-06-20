import {
    cleanUserText,
    extractTexts,
    hasMeaningfulUserText,
} from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { removeSystemReminders } from "../../shared/system-directive";
import { runWriteTransaction } from "../../shared/write-transaction";
import { clearCompressionDepth } from "./compression-depth-storage";

interface MessageHistoryIndexRow {
    last_indexed_ordinal?: number;
}

const lastIndexedStatements = new WeakMap<Database, PreparedStatement>();
const insertMessageStatements = new WeakMap<Database, PreparedStatement>();
const upsertIndexStatements = new WeakMap<Database, PreparedStatement>();
const deleteFtsStatements = new WeakMap<Database, PreparedStatement>();
const deleteIndexStatements = new WeakMap<Database, PreparedStatement>();
const countIndexedMessageStatements = new WeakMap<Database, PreparedStatement>();

function normalizeIndexText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function getLastIndexedStatement(db: Database): PreparedStatement {
    let stmt = lastIndexedStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT last_indexed_ordinal FROM message_history_index WHERE session_id = ?",
        );
        lastIndexedStatements.set(db, stmt);
    }
    return stmt;
}

function getInsertMessageStatement(db: Database): PreparedStatement {
    let stmt = insertMessageStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        );
        insertMessageStatements.set(db, stmt);
    }
    return stmt;
}

function getUpsertIndexStatement(db: Database): PreparedStatement {
    let stmt = upsertIndexStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO message_history_index (session_id, last_indexed_ordinal, updated_at, harness) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = excluded.last_indexed_ordinal, updated_at = excluded.updated_at",
        );
        upsertIndexStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteFtsStatement(db: Database): PreparedStatement {
    let stmt = deleteFtsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM message_history_fts WHERE session_id = ?");
        deleteFtsStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteIndexStatement(db: Database): PreparedStatement {
    let stmt = deleteIndexStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM message_history_index WHERE session_id = ?");
        deleteIndexStatements.set(db, stmt);
    }
    return stmt;
}

function getCountIndexedMessageStatement(db: Database): PreparedStatement {
    let stmt = countIndexedMessageStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_id = ?",
        );
        countIndexedMessageStatements.set(db, stmt);
    }
    return stmt;
}

interface CountRow {
    count: number;
}

export function getLastIndexedOrdinal(db: Database, sessionId: string): number {
    const row = getLastIndexedStatement(db).get(sessionId) as MessageHistoryIndexRow | null;
    return typeof row?.last_indexed_ordinal === "number" ? row.last_indexed_ordinal : 0;
}

function isMessageAlreadyIndexed(db: Database, sessionId: string, messageId: string): boolean {
    const row = getCountIndexedMessageStatement(db).get(sessionId, messageId) as CountRow | null;
    return (typeof row?.count === "number" ? row.count : 0) > 0;
}

function advanceIndexWatermark(
    db: Database,
    sessionId: string,
    ordinal: number,
    now: number,
): void {
    const current = getLastIndexedOrdinal(db, sessionId);
    getUpsertIndexStatement(db).run(sessionId, Math.max(current, ordinal), now, getHarness());
}

export function deleteIndexedMessage(db: Database, sessionId: string, messageId: string): number {
    const row = getCountIndexedMessageStatement(db).get(sessionId, messageId) as CountRow | null;
    const count = typeof row?.count === "number" ? row.count : 0;

    // Full reindex on next search: ordinals are positional (not stable IDs), so removing
    // a message shifts all subsequent ordinals. Keeping a stale tracker would cause
    // ensureMessagesIndexed() to skip newly added messages when the count matches.
    // Clearing both FTS rows and the tracker forces a complete rebuild on next search.
    clearIndexedMessages(db, sessionId);
    return count;
}

export function clearIndexedMessages(db: Database, sessionId: string): void {
    db.transaction(() => {
        getDeleteFtsStatement(db).run(sessionId);
        getDeleteIndexStatement(db).run(sessionId);
        clearCompressionDepth(db, sessionId);
    })();
}

export function getIndexableContent(role: string, parts: unknown[]): string {
    if (role === "user") {
        if (!hasMeaningfulUserText(parts)) {
            return "";
        }

        return extractTexts(parts)
            .map(cleanUserText)
            .map(normalizeIndexText)
            .filter((text) => text.length > 0)
            .join(" / ");
    }

    if (role === "assistant") {
        return extractTexts(parts)
            .map(removeSystemReminders)
            .map(normalizeIndexText)
            .filter((text) => text.length > 0)
            .join(" / ");
    }

    return "";
}

function indexSingleMessageInTransaction(
    db: Database,
    sessionId: string,
    message: RawMessage,
    now: number,
): boolean {
    if (message.role !== "user" && message.role !== "assistant") {
        advanceIndexWatermark(db, sessionId, message.ordinal, now);
        return false;
    }

    const content = getIndexableContent(message.role, message.parts);
    if (content.length === 0) {
        advanceIndexWatermark(db, sessionId, message.ordinal, now);
        return false;
    }

    if (isMessageAlreadyIndexed(db, sessionId, message.id)) {
        advanceIndexWatermark(db, sessionId, message.ordinal, now);
        return false;
    }

    getInsertMessageStatement(db).run(
        sessionId,
        message.ordinal,
        message.id,
        message.role,
        content,
    );
    advanceIndexWatermark(db, sessionId, message.ordinal, now);
    return true;
}

export function indexSingleMessage(db: Database, sessionId: string, message: RawMessage): boolean {
    return db.transaction(() =>
        indexSingleMessageInTransaction(db, sessionId, message, Date.now()),
    )();
}

export function indexMessagesAfterOrdinal(
    db: Database,
    sessionId: string,
    messages: RawMessage[],
    lastIndexedOrdinal: number,
    finalWatermark: number = messages.length,
): number {
    const now = Date.now();
    let inserted = 0;

    // Cross-process dedup is the WATERMARK, re-read INSIDE a BEGIN IMMEDIATE
    // transaction — NOT a UNIQUE constraint. message_history_fts is a plain
    // FTS5 virtual table; FTS5 cannot enforce UNIQUE(session_id, message_id)
    // (the columns are UNINDEXED), so a duplicate insert is silently accepted,
    // never raised — the old try/catch on SQLITE_CONSTRAINT_UNIQUE could never
    // fire. The caller reads `lastIndexedOrdinal` OUTSIDE any transaction, so
    // under WAL two processes reconciling the same session could both read
    // watermark=0 and double-insert every row (and bloat the FTS table).
    //
    // BEGIN IMMEDIATE takes the writer lock up front, so the second process
    // serializes behind the first (busy_timeout makes it wait). We then re-read
    // the watermark inside the lock: whatever the first process already indexed
    // is reflected, so the second skips those ordinals and inserts nothing
    // duplicate. The bulk SELECT of existing message-ids is still avoided (it
    // held the writer lock too long on ~30k-row sessions).
    return runWriteTransaction(db, () => {
        // Re-read under the lock: another process may have advanced the
        // watermark between the caller's out-of-transaction read and now.
        const effectiveWatermark = Math.max(
            lastIndexedOrdinal,
            getLastIndexedOrdinal(db, sessionId),
        );
        const insertMessage = getInsertMessageStatement(db);
        for (const message of messages) {
            if (message.ordinal <= effectiveWatermark) {
                continue;
            }
            if (message.role !== "user" && message.role !== "assistant") {
                continue;
            }
            const content = getIndexableContent(message.role, message.parts);
            if (content.length === 0) {
                continue;
            }
            insertMessage.run(sessionId, message.ordinal, message.id, message.role, content);
            inserted++;
        }
        // Never regress a higher watermark a concurrent writer may have set.
        const newWatermark = Math.max(effectiveWatermark, finalWatermark);
        getUpsertIndexStatement(db).run(sessionId, newWatermark, now, getHarness());
        return inserted;
    });
}

export function ensureMessagesIndexed(
    db: Database,
    sessionId: string,
    readMessages: (sessionId: string) => RawMessage[],
): void {
    const messages = readMessages(sessionId);

    if (messages.length === 0) {
        db.transaction(() => clearIndexedMessages(db, sessionId))();
        return;
    }

    let lastIndexedOrdinal = getLastIndexedOrdinal(db, sessionId);
    if (lastIndexedOrdinal > messages.length) {
        db.transaction(() => clearIndexedMessages(db, sessionId))();
        lastIndexedOrdinal = 0;
    }

    if (lastIndexedOrdinal >= messages.length) {
        return;
    }

    indexMessagesAfterOrdinal(db, sessionId, messages, lastIndexedOrdinal, messages.length);
}
