import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function tableColumns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function indexNames(db: Database): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
            name: string;
        }>
    ).map((row) => row.name);
}

describe("migration v36 — session project ownership", () => {
    test("fresh DB schema includes session project ownership and schema fence version", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableColumns(db, "session_projects")).toEqual(
                expect.arrayContaining(["session_id", "harness", "project_path", "updated_at"]),
            );
            expect(indexNames(db)).toContain("idx_session_projects_project");
            expect(LATEST_SUPPORTED_VERSION).toBe(37);
            expect(LATEST_MIGRATION_VERSION).toBe(37);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: 37 });
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades a v35 database with the session ownership table", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (35, 'pre-v36 fixture', 1);
            `);

            runMigrations(db);

            expect(tableColumns(db, "session_projects")).toEqual(
                expect.arrayContaining(["session_id", "harness", "project_path", "updated_at"]),
            );
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: 37 });
        } finally {
            closeQuietly(db);
        }
    });

    test("v36 seeds ownership for already-chunk-embedded sessions, skipping ambiguous ones", () => {
        const db = new Database(":memory:");
        try {
            // A v35 DB whose chunk-embedding table predates the ownership map.
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (35, 'pre-v36 fixture', 1);
                CREATE TABLE compartment_chunk_embeddings (
                    compartment_id INTEGER NOT NULL,
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    project_path TEXT NOT NULL,
                    window_index INTEGER NOT NULL,
                    chunk_hash TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    vector BLOB NOT NULL
                );
                -- clean single-project session (two windows, same project): seed it
                INSERT INTO compartment_chunk_embeddings VALUES (1,'sesA','opencode','git:alpha',0,'h1','m',x'00');
                INSERT INTO compartment_chunk_embeddings VALUES (1,'sesA','opencode','git:alpha',1,'h2','m',x'00');
                -- same session id under a DIFFERENT harness: independent ownership row
                INSERT INTO compartment_chunk_embeddings VALUES (2,'sesA','pi','git:beta',0,'h3','m',x'00');
                -- ambiguous session (pre-scope bug split across two projects): skip
                INSERT INTO compartment_chunk_embeddings VALUES (3,'sesB','opencode','git:gamma',0,'h4','m',x'00');
                INSERT INTO compartment_chunk_embeddings VALUES (3,'sesB','opencode','git:delta',0,'h5','m',x'00');
            `);

            runMigrations(db);

            const rows = db
                .prepare(
                    "SELECT session_id, harness, project_path FROM session_projects ORDER BY session_id, harness",
                )
                .all();
            // sesA/opencode→alpha and sesA/pi→beta seeded; sesB skipped (ambiguous).
            expect(rows).toEqual([
                { session_id: "sesA", harness: "opencode", project_path: "git:alpha" },
                { session_id: "sesA", harness: "pi", project_path: "git:beta" },
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
