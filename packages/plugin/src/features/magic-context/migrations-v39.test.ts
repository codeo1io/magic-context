/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v39 — external recall snapshot + m[0] marker", () => {
    test("adds external recall columns to session_meta on a fresh DB, idempotently", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            runMigrations(db);

            const columns = columnNames(db, "session_meta");
            expect(columns).toContain("external_recall_json");
            expect(columns).toContain("external_recall_state");
            expect(columns).toContain("external_recall_at");
            expect(columns).toContain("cached_m0_external_recall_hash");
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("external recall columns store and round-trip nulls (default absent state)", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            db.prepare("INSERT INTO session_meta (session_id, harness) VALUES (?, ?)").run(
                "ses_v39",
                "test-harness",
            );
            const row = db
                .prepare(
                    "SELECT external_recall_json, external_recall_state, external_recall_at, cached_m0_external_recall_hash FROM session_meta WHERE session_id = ?",
                )
                .get("ses_v39") as Record<string, unknown>;

            expect(row.external_recall_json).toBeNull();
            expect(row.external_recall_state).toBeNull();
            expect(row.external_recall_at).toBeNull();
            expect(row.cached_m0_external_recall_hash).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
