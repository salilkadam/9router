// Bun runtime adapter — uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
import { AsyncLocalStorage } from "node:async_hooks";
import { PRAGMA_SQL } from "../schema.js";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export async function createBunSqliteAdapter(filePath) {
  // Dynamic import — only resolves under Bun runtime
  const { Database } = await import("bun:sqlite");
  const db = new Database(filePath, { create: true });
  db.exec(PRAGMA_SQL);

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  const checkpointTimer = setInterval(() => {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", () => { onShutdown(); process.exit(0); });
  process.once("SIGTERM", () => { onShutdown(); process.exit(0); });

  const txAls = new AsyncLocalStorage();
  let txTail = Promise.resolve();

  return {
    driver: "bun:sqlite",
    dialect: "sqlite",
    run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      return prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return prepare(sql).all(...params);
    },
    exec(sql) { return db.exec(sql); },
    // SAVEPOINT instead of db.transaction(): callbacks may be async under the
    // shared adapter contract, which bun's transaction wrapper cannot run.
    // Serialized via a promise-chain mutex — async callbacks yield mid-tx, so
    // concurrent transactions would interleave savepoints. Nested calls join.
    async transaction(fn) {
      if (txAls.getStore()) return fn();
      const task = async () => {
        const sp = `sp_${Math.random().toString(36).slice(2)}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {
          const r = await txAls.run(true, fn);
          db.exec(`RELEASE ${sp}`);
          return r;
        } catch (e) {
          try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
          throw e;
        }
      };
      const p = txTail.then(task, task);
      txTail = p.then(() => {}, () => {});
      return p;
    },
    tableColumns(tableName) {
      return prepare(`PRAGMA table_info(${tableName})`).all().map((r) => r.name);
    },
    checkpoint() { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
