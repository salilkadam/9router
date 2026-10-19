// Regression guard for the recovered Postgres data layer.
//
// The deployment manifest sets DATABASE_URL from the CNPG secret. Before this
// code existed in git, an image built from main would have accepted that
// variable, ignored it, and silently served a local SQLite file instead — the
// running service and the repo disagreeing with no signal of any kind.
//
// Two properties are guarded here:
//   1. DATABASE_URL set  → the pg adapter is selected.
//   2. pg init failing   → getAdapter() THROWS. Absence and failure must not
//      share a representation: falling through to SQLite would look healthy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;

const SQLITE_DRIVERS = ["better-sqlite3", "node:sqlite", "sql.js", "bun:sqlite"];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pg-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.DATABASE_URL;
  delete global._dbAdapter;
  vi.resetModules();
  // Migrations are exercised by db-migration-chain.test.js; this file is about
  // which adapter gets chosen, so keep the fake adapter minimal.
  vi.doMock("@/lib/db/migrate.js", () => ({
    runMigrationOnce: vi.fn(async () => {}),
  }));
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  vi.doUnmock("@/lib/db/migrate.js");
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("DATABASE_URL selects Postgres", () => {
  it("picks the pg adapter when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgresql://user@example.invalid:5432/ninerouter";
    const createPgAdapter = vi.fn(async (url) => ({
      driver: "postgres",
      dialect: "postgres",
      url,
      run: async () => ({ changes: 0 }),
      get: async () => undefined,
      all: async () => [],
      exec: async () => {},
      transaction: async (fn) => fn(),
      tableColumns: async () => [],
      checkpoint() {},
      close: async () => {},
    }));
    vi.doMock("@/lib/db/adapters/pgAdapter.js", () => ({ createPgAdapter }));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    expect(db.driver).toBe("postgres");
    expect(db.dialect).toBe("postgres");
    expect(createPgAdapter).toHaveBeenCalledWith(process.env.DATABASE_URL);
    // The whole point: no SQLite file was opened instead.
    expect(SQLITE_DRIVERS).not.toContain(db.driver);
  });

  it("THROWS when DATABASE_URL is set but Postgres init fails — no silent SQLite fallback", async () => {
    process.env.DATABASE_URL = "postgresql://user@example.invalid:5432/ninerouter";
    vi.doMock("@/lib/db/adapters/pgAdapter.js", () => ({
      createPgAdapter: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
      }),
    }));

    const { getAdapter } = await import("@/lib/db/driver.js");

    let outcome;
    try {
      const db = await getAdapter();
      outcome = `resolved to driver "${db.driver}"`;
    } catch (e) {
      outcome = e;
    }

    expect(outcome, "getAdapter() must reject, not fall back to SQLite").toBeInstanceOf(Error);
    expect(outcome.message).toContain("DATABASE_URL is set but Postgres init failed");
    // The cause must survive into the message, or the operator cannot act on it.
    expect(outcome.message).toContain("ECONNREFUSED");
  });

  it("falls back to SQLite only when DATABASE_URL is absent", async () => {
    const createPgAdapter = vi.fn();
    vi.doMock("@/lib/db/adapters/pgAdapter.js", () => ({ createPgAdapter }));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    expect(SQLITE_DRIVERS).toContain(db.driver);
    expect(createPgAdapter).not.toHaveBeenCalled();
  });
});
