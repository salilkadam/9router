import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { PRAGMA_SQL } from "../schema.js";

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export function createBetterSqliteAdapter(filePath) {
  const db = new Database(filePath);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  const stmtCache = new Map();

  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // Truncate WAL periodically so file stays small for backup/copy
  const checkpointTimer = setInterval(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  // Ensure WAL is flushed and -wal/-shm files removed on shutdown
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", () => { onShutdown(); process.exit(0); });
  process.once("SIGTERM", () => { onShutdown(); process.exit(0); });

  const txAls = new AsyncLocalStorage();
  let txTail = Promise.resolve();

  return {
    driver: "better-sqlite3",
    dialect: "sqlite",
    run(sql, params = []) { return prepare(sql).run(...params); },
    get(sql, params = []) { return prepare(sql).get(...params); },
    all(sql, params = []) { return prepare(sql).all(...params); },
    exec(sql) { return db.exec(sql); },
    // SAVEPOINT instead of db.transaction(): the adapter contract is now
    // async-compatible (callbacks may await), which better-sqlite3's
    // transaction wrapper rejects. Because async callbacks yield to the event
    // loop mid-transaction, concurrent transactions on this single shared
    // connection would interleave savepoints — so they are serialized through
    // a promise-chain mutex. Nested transaction() calls join the outer one.
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
      return db.prepare(`PRAGMA table_info(${tableName})`).all().map((r) => r.name);
    },
    checkpoint() { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
