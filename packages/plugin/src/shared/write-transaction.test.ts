import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWriteTransaction, runWriteTransactionAsync } from "./write-transaction.js";

/**
 * Minimal fake Database that records exec calls and simulates SQLITE_BUSY on
 * the first N attempts. Only the surface area write-transaction.ts uses.
 */
function makeFakeDb(opts: {
    inTransaction?: boolean;
    isTransaction?: boolean;
    busyTimes?: number;
}) {
    const calls: string[] = [];
    let busyRemaining = opts.busyTimes ?? 0;
    const db = {
        inTransaction: opts.inTransaction,
        isTransaction: opts.isTransaction,
        exec(sql: string) {
            calls.push(sql);
            if (sql === "BEGIN IMMEDIATE" && busyRemaining > 0) {
                busyRemaining -= 1;
                const err: Error & { code?: string } = new Error("database is locked");
                err.code = "SQLITE_BUSY";
                throw err;
            }
        },
        _calls: calls,
    };
    return db;
}

describe("runWriteTransaction", () => {
    beforeEach(() => {
        // node:test doesn't have a global mock restore; we rely on per-test fakes.
    });

    it("issues BEGIN IMMEDIATE / COMMIT around the body", () => {
        const db = makeFakeDb({});
        const order: string[] = [];
        runWriteTransaction(db as any, () => {
            order.push("body");
            return 42;
        });
        assert.deepEqual(db._calls, ["BEGIN IMMEDIATE", "COMMIT"]);
        assert.deepEqual(order, ["body"]);
    });

    it("returns the body's return value", () => {
        const db = makeFakeDb({});
        const result = runWriteTransaction(db as any, () => "ok");
        assert.equal(result, "ok");
    });

    it("rolls back when the body throws", () => {
        const db = makeFakeDb({});
        assert.throws(
            () =>
                runWriteTransaction(db as any, () => {
                    throw new Error("body failed");
                }),
            /body failed/,
        );
        assert.deepEqual(db._calls, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    });

    it("retries on transient SQLITE_BUSY and succeeds", () => {
        const db = makeFakeDb({ busyTimes: 1 });
        const result = runWriteTransaction(db as any, () => "recovered");
        // First attempt: BEGIN IMMEDIATE throws SQLITE_BUSY (no ROLLBACK — the
        // BEGIN itself failed, so there's no transaction to roll back).
        // Second attempt: BEGIN IMMEDIATE + COMMIT succeed.
        assert.deepEqual(db._calls, ["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "COMMIT"]);
        assert.equal(result, "recovered");
    });

    it("gives up after WRITE_RETRY_MAX_ATTEMPTS transient failures", () => {
        const db = makeFakeDb({ busyTimes: 99 });
        assert.throws(() => runWriteTransaction(db as any, () => "never"), /database is locked/);
        // 4 attempts, all on BEGIN IMMEDIATE.
        assert.deepEqual(db._calls, [
            "BEGIN IMMEDIATE",
            "BEGIN IMMEDIATE",
            "BEGIN IMMEDIATE",
            "BEGIN IMMEDIATE",
        ]);
    });

    it("does NOT issue nested BEGIN when already in a transaction", () => {
        const db = makeFakeDb({ inTransaction: true });
        const result = runWriteTransaction(db as any, () => "inline");
        assert.deepEqual(db._calls, []);
        assert.equal(result, "inline");
    });

    it("does NOT issue nested BEGIN when node:sqlite isTransaction flag is set", () => {
        const db = makeFakeDb({ isTransaction: true });
        const result = runWriteTransaction(db as any, () => "inline");
        assert.deepEqual(db._calls, []);
        assert.equal(result, "inline");
    });

    it("non-transient errors are not retried", () => {
        let attempts = 0;
        const db = {
            exec() {
                attempts += 1;
                throw new Error("disk I/O error");
            },
        };
        assert.throws(() => runWriteTransaction(db as any, () => "never"), /disk I\/O error/);
        assert.equal(attempts, 1);
    });
});

describe("runWriteTransactionAsync", () => {
    it("issues BEGIN IMMEDIATE / COMMIT around an async body", async () => {
        const db = makeFakeDb({});
        const result = await runWriteTransactionAsync(db as any, async () => {
            return "async-ok";
        });
        assert.deepEqual(db._calls, ["BEGIN IMMEDIATE", "COMMIT"]);
        assert.equal(result, "async-ok");
    });

    it("rolls back when the async body throws", async () => {
        const db = makeFakeDb({});
        await assert.rejects(
            runWriteTransactionAsync(db as any, async () => {
                throw new Error("async body failed");
            }),
            /async body failed/,
        );
        assert.deepEqual(db._calls, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    });

    it("retries on transient SQLITE_BUSY", async () => {
        const db = makeFakeDb({ busyTimes: 1 });
        const result = await runWriteTransactionAsync(db as any, async () => "recovered");
        assert.deepEqual(db._calls, ["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "COMMIT"]);
        assert.equal(result, "recovered");
    });

    it("does NOT issue nested BEGIN when already in a transaction", async () => {
        const db = makeFakeDb({ inTransaction: true });
        const result = await runWriteTransactionAsync(db as any, async () => "inline");
        assert.deepEqual(db._calls, []);
        assert.equal(result, "inline");
    });
});
