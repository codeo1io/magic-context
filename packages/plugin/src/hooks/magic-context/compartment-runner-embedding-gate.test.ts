/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { executeContextRecomp } from "./compartment-runner";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;

    const dumpDir = join(tmpdir(), "magic-context-historian");
    try {
        rmSync(dumpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        // Ignore
    }
});

describe("compartment embedding gate (provider, not memory)", () => {
    it("runs embedding when memory is off but embedding provider is on", async () => {
        useTempDataHome("magic-embedding-gate-mem-off-");
        createOpenCodeDb("ses-mem-off", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);

        const db = openDatabase();
        const client = createRecompClient(
            '<compartment start="1" end="2" title="Recovered">Summary</compartment>',
        );
        const ensureProjectRegistered = mock(async () => {});

        await executeContextRecomp({
            client,
            db,
            sessionId: "ses-mem-off",
            historianChunkTokens: 10_000,
            directory: "/tmp",
            // Memory feature is OFF but the embedding PROVIDER is ON.
            // Embedding is the ctx_search substrate, independent of memory.
            memoryEnabled: false,
            autoPromote: false,
            embeddingEnabled: true,
            ensureProjectRegistered,
        });

        // The recomp runner gates project registration + embedding on the
        // embedding provider, not the memory feature. With embeddingEnabled=true
        // and memoryEnabled=false, project registration must still fire.
        expect(ensureProjectRegistered).toHaveBeenCalled();
    });

    it("skips embedding when the embedding provider is off (even with memory on)", async () => {
        useTempDataHome("magic-embedding-gate-emb-off-");
        createOpenCodeDb("ses-emb-off", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);

        const db = openDatabase();
        const client = createRecompClient(
            '<compartment start="1" end="2" title="Recovered">Summary</compartment>',
        );
        const ensureProjectRegistered = mock(async () => {});

        await executeContextRecomp({
            client,
            db,
            sessionId: "ses-emb-off",
            historianChunkTokens: 10_000,
            directory: "/tmp",
            // Memory is fully on (enabled + auto_promote) but the embedding
            // provider is OFF. No project registration, no embedding endpoint hit.
            memoryEnabled: true,
            autoPromote: true,
            embeddingEnabled: false,
            ensureProjectRegistered,
        });

        // embeddingEnabled=false is the new gate. Project registration must NOT fire.
        expect(ensureProjectRegistered).not.toHaveBeenCalled();
    });
});

function createRecompClient(output: string): PluginContext["client"] {
    return {
        session: {
            get: mock(async () => ({ data: { directory: "/tmp" } })),
            create: mock(async () => ({ data: { id: "ses-historian-child" } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [{ type: "text", text: output }],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
}

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; text: string }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);

    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );

        messages.forEach((message, index) => {
            const timestamp = index + 1;
            insertMessage.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            insertPart.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ type: "text", text: message.text }),
            );
        });
    } finally {
        closeQuietly(db);
    }
}
