import type { Database } from "../../../shared/sqlite";
import { runWriteTransaction } from "../../../shared/write-transaction";
import { deleteDreamState, getDreamState, setDreamState } from "./storage-dream-state";

const LEASE_HOLDER_KEY = "dreaming_lease_holder";
const LEASE_HEARTBEAT_KEY = "dreaming_lease_heartbeat";
const LEASE_EXPIRY_KEY = "dreaming_lease_expiry";
const LEASE_DURATION_MS = 2 * 60 * 1000; // 2 minutes — renewed periodically during task execution

function getLeaseExpiry(db: Database): number | null {
    const value = getDreamState(db, LEASE_EXPIRY_KEY);
    if (!value) {
        return null;
    }

    const expiry = Number(value);
    return Number.isFinite(expiry) ? expiry : null;
}

export function isLeaseActive(db: Database): boolean {
    const expiry = getLeaseExpiry(db);
    return expiry !== null && expiry > Date.now();
}

export function getLeaseHolder(db: Database): string | null {
    return getDreamState(db, LEASE_HOLDER_KEY);
}

export function peekLeaseHolderAndExpiry(db: Database, expectedHolder: string): boolean {
    const holder = getDreamState(db, LEASE_HOLDER_KEY);
    if (holder !== expectedHolder) return false;
    const expiryStr = getDreamState(db, LEASE_EXPIRY_KEY);
    if (!expiryStr) return false;
    const expiry = Number(expiryStr);
    return Number.isFinite(expiry) && expiry >= Date.now();
}

// The lease spans three dream_state rows (holder/heartbeat/expiry), so it can't
// be a single-statement CAS like compartment-lease.ts. Instead each mutation
// runs under BEGIN IMMEDIATE: the write lock is taken at BEGIN time (not at the
// first write, as the deferred BEGIN that db.transaction() emits would), so the
// read-then-write is atomic across the OpenCode+Pi processes that share this
// SQLite file. Without IMMEDIATE, two processes could both read isLeaseActive()
// = false under WAL snapshot isolation and both write — double-acquiring the
// lease and spawning duplicate dreamer workers. busy_timeout (set in
// initializeDatabase) makes the loser wait rather than throw SQLITE_BUSY.

export function acquireLease(db: Database, holderId: string): boolean {
    return runWriteTransaction(db, () => {
        if (isLeaseActive(db)) {
            const existingHolder = getLeaseHolder(db);
            if (existingHolder && existingHolder !== holderId) {
                return false;
            }
        }

        const now = Date.now();
        setDreamState(db, LEASE_HOLDER_KEY, holderId);
        setDreamState(db, LEASE_HEARTBEAT_KEY, String(now));
        setDreamState(db, LEASE_EXPIRY_KEY, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function renewLease(db: Database, holderId: string): boolean {
    return runWriteTransaction(db, () => {
        if (getLeaseHolder(db) !== holderId || !isLeaseActive(db)) {
            return false;
        }

        const now = Date.now();
        setDreamState(db, LEASE_HEARTBEAT_KEY, String(now));
        setDreamState(db, LEASE_EXPIRY_KEY, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function releaseLease(db: Database, holderId: string): void {
    runWriteTransaction(db, () => {
        if (getLeaseHolder(db) !== holderId) {
            return;
        }

        deleteDreamState(db, LEASE_HOLDER_KEY);
        deleteDreamState(db, LEASE_HEARTBEAT_KEY);
        deleteDreamState(db, LEASE_EXPIRY_KEY);
    });
}
