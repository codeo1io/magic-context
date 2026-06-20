/**
 * Centralized write-transaction helper for the shared context.db.
 *
 * Why: the plugin issues 100+ write transactions across 40+ files against ONE
 * shared SQLite file, opened by multiple processes (OpenCode + Pi, or two
 * OpenCode instances). Each `BEGIN IMMEDIATE` contends for the single WAL
 * writer lock. Three problems arose:
 *
 *   1. SQLITE_BUSY propagation: when a sibling process holds the writer lock
 *      past busy_timeout, the thrown SQLITE_BUSY propagated up and surfaced
 *      as "failed to load plugin ... database is locked" or "Hit a transient
 *      issue comparting history this turn". The plugin would disable itself
 *      for the run instead of waiting.
 *
 *   2. Duplicated transaction plumbing: every BEGIN IMMEDIATE site
 *      reimplemented the same try/commit/finally-rollback pattern, slightly
 *      differently, sometimes without the rollback path. Bugs leaked in at
 *      the edges.
 *
 *   3. Inconsistent busy-retry behavior: some sites retried, some didn't,
 *      some swallowed, some propagated. The result was unpredictable under
 *      real multi-process load.
 *
 * Solution: a single `runWriteTransaction(db, body)` helper that wraps the
 * BEGIN IMMEDIATE / COMMIT in a bounded SQLITE_BUSY retry loop, so a
 * long-running sibling transaction (large migration, dreamer run, bulk
 * Channel-2 delivery) makes us wait-and-retry instead of throwing. This
 * centralizes the transaction plumbing and the retry policy in one place.
 *
 * Cross-process fairness is still handled by SQLite's own WAL writer lock
 * plus busy_timeout (set in storage-db.ts initializeDatabase); this helper
 * just makes every call site a well-behaved writer that absorbs transient
 * BUSY errors instead of propagating them into plugin-disable paths.
 *
 * Usage (replaces hand-rolled BEGIN IMMEDIATE / COMMIT blocks):
 *
 *   const result = runWriteTransaction(db, () => {
 *       db.prepare("INSERT ...").run(...);
 *       return computeResult(db);
 *   });
 *
 * For bodies that must do async work between writes, use the async form:
 *
 *   const result = await runWriteTransactionAsync(db, async () => {
 *       await someAsyncThing();
 *       db.prepare("INSERT ...").run(...);
 *   });
 *
 * Composition: if called inside an existing transaction (db.transaction or
 * another runWriteTransaction), the body runs inline WITHOUT issuing a nested
 * BEGIN (SQLite doesn't allow nested BEGIN; the outer transaction already
 * holds the writer lock). This makes the helper safe to compose.
 */

import { getErrorMessage } from "./error-message";
import { log } from "./logger";
import type { Database } from "./sqlite";

/** Bounded retry on transient lock errors. */
const WRITE_RETRY_MAX_ATTEMPTS = 4;
const WRITE_RETRY_BACKOFF_MS = 100;

function isTransientBusy(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const e = error as { code?: unknown; message?: unknown };
    if (typeof e.code === "string") {
        if (
            e.code === "SQLITE_BUSY" ||
            e.code === "SQLITE_LOCKED" ||
            e.code === "SQLITE_BUSY_SNAPSHOT" ||
            e.code === "SQLITE_BUSY_RECOVERY"
        ) {
            return true;
        }
    }
    if (typeof e.message === "string") {
        return /database is locked/i.test(e.message) || /sqlite_(busy|locked)/i.test(e.message);
    }
    return false;
}

function sleepSync(ms: number): void {
    // Synchronous SQLite backends can't await; the durations are tiny (100ms
    // cap) and only happen on transient cross-process contention.
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // spin
    }
}

function isInTransaction(db: Database): boolean {
    // bun:sqlite and better-sqlite3 expose `inTransaction`; the node:sqlite
    // shim in sqlite.ts sets `isTransaction` during savepoint-wrapper
    // transactions. Respect either so this helper composes correctly when
    // called from inside an existing db.transaction(() => { ... })() block.
    const candidate = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
    return candidate.inTransaction === true || candidate.isTransaction === true;
}

/**
 * Run a synchronous write body inside a BEGIN IMMEDIATE transaction, retried
 * on transient SQLITE_BUSY.
 *
 * - If called inside an existing transaction, the body runs inline WITHOUT
 *   issuing a nested BEGIN (SQLite doesn't allow nested BEGIN; the outer
 *   transaction already holds the writer lock).
 * - Otherwise: issue BEGIN IMMEDIATE, run the body, COMMIT. On a transient
 *   SQLITE_BUSY the whole sequence is retried up to WRITE_RETRY_MAX_ATTEMPTS
 *   times with backoff.
 */
export function runWriteTransaction<T>(db: Database, body: () => T): T {
    if (isInTransaction(db)) {
        return body();
    }
    return runWithBusyRetry(() => {
        db.exec("BEGIN IMMEDIATE");
        let committed = false;
        try {
            const result = body();
            db.exec("COMMIT");
            committed = true;
            return result;
        } finally {
            if (!committed) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // transaction may already be closed by SQLite after an error
                }
            }
        }
    });
}

/**
 * Async form of runWriteTransaction. Use this from any async call site; the
 * body may itself be async. Same retry and composition semantics.
 */
export async function runWriteTransactionAsync<T>(
    db: Database,
    body: () => T | Promise<T>,
): Promise<T> {
    if (isInTransaction(db)) {
        return body();
    }
    return runWithBusyRetryAsync(async () => {
        db.exec("BEGIN IMMEDIATE");
        let committed = false;
        try {
            const result = await body();
            db.exec("COMMIT");
            committed = true;
            return result;
        } finally {
            if (!committed) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // already closed
                }
            }
        }
    });
}

function runWithBusyRetry<T>(fn: () => T): T {
    let lastError: unknown;
    for (let attempt = 0; attempt < WRITE_RETRY_MAX_ATTEMPTS; attempt += 1) {
        try {
            return fn();
        } catch (error) {
            lastError = error;
            if (!isTransientBusy(error) || attempt === WRITE_RETRY_MAX_ATTEMPTS - 1) {
                throw error;
            }
            log(
                `[magic-context] write txn attempt ${attempt + 1}/${WRITE_RETRY_MAX_ATTEMPTS} hit transient lock; retrying in ${WRITE_RETRY_BACKOFF_MS}ms: ${getErrorMessage(error)}`,
            );
            sleepSync(WRITE_RETRY_BACKOFF_MS);
        }
    }
    throw lastError;
}

async function runWithBusyRetryAsync<T>(fn: () => T | Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < WRITE_RETRY_MAX_ATTEMPTS; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (!isTransientBusy(error) || attempt === WRITE_RETRY_MAX_ATTEMPTS - 1) {
                throw error;
            }
            log(
                `[magic-context] write txn attempt ${attempt + 1}/${WRITE_RETRY_MAX_ATTEMPTS} hit transient lock; retrying in ${WRITE_RETRY_BACKOFF_MS}ms: ${getErrorMessage(error)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_BACKOFF_MS));
        }
    }
    throw lastError;
}
