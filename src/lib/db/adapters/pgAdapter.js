import { AsyncLocalStorage } from "node:async_hooks";
import { TABLES } from "../schema.js";

// Postgres folds unquoted identifiers to lowercase, but the schema and all JS
// row consumers use camelCase (row.isActive, row.createdAt). Tables are created
// unquoted (so SQL keeps working verbatim) and result rows are mapped back to
// camelCase through this dictionary built from the declared schema.
const COLUMN_CASE_MAP = (() => {
  const map = {};
  for (const def of Object.values(TABLES)) {
    for (const col of Object.keys(def.columns)) {
      const lower = col.toLowerCase();
      if (lower !== col) map[lower] = col;
    }
  }
  return map;
})();

function mapRow(row) {
  if (!row) return row;
  let out = row;
  for (const key of Object.keys(row)) {
    const mapped = COLUMN_CASE_MAP[key];
    if (mapped) {
      if (out === row) out = { ...row };
      out[mapped] = out[key];
      delete out[key];
    }
  }
  return out;
}

// Rewrite `?` placeholders to `$1..$n`, skipping quoted strings. All SQL in
// this codebase is parameterized with `?` for SQLite compatibility.
const PLACEHOLDER_CACHE = new Map();
function toPgPlaceholders(sql) {
  let cached = PLACEHOLDER_CACHE.get(sql);
  if (cached) return cached;
  let out = "";
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") inString = !inString;
    if (ch === "?" && !inString) out += `$${++n}`;
    else out += ch;
  }
  PLACEHOLDER_CACHE.set(sql, out);
  return out;
}

export async function createPgAdapter(connectionString) {
  const { default: pg } = await import("pg");

  // COUNT(*)/SUM return int8/numeric as strings by default — the app compares
  // them as numbers (`row.c === 0`), so parse them.
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8
  pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric

  const pool = new pg.Pool({
    connectionString,
    max: parseInt(process.env.PG_POOL_SIZE || "10", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (e) => console.error("[DB][pg] idle client error:", e.message));

  // transaction(fn) pins one client for everything fn does; run/get/all/exec
  // called inside the callback route to that client via AsyncLocalStorage, so
  // existing closure-style transaction bodies keep working unchanged.
  const als = new AsyncLocalStorage();
  const executor = () => als.getStore() || pool;

  // Fail fast on boot if Postgres is unreachable.
  await pool.query("SELECT 1");

  return {
    driver: "postgres",
    dialect: "postgres",
    async run(sql, params = []) {
      const res = await executor().query(toPgPlaceholders(sql), params);
      return { changes: res.rowCount ?? 0 };
    },
    async get(sql, params = []) {
      const res = await executor().query(toPgPlaceholders(sql), params);
      return mapRow(res.rows[0]);
    },
    async all(sql, params = []) {
      const res = await executor().query(toPgPlaceholders(sql), params);
      return res.rows.map(mapRow);
    },
    async exec(sql) {
      // Multi-statement DDL uses the simple protocol (no params).
      await executor().query(sql);
    },
    async transaction(fn) {
      // Nested transaction (fn itself called inside a transaction): just run
      // in the outer client — SQLite's previous behavior was a single tx too.
      if (als.getStore()) return fn();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await als.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        throw e;
      } finally {
        client.release();
      }
    },
    async tableColumns(tableName) {
      const res = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
        [tableName.toLowerCase()]
      );
      return res.rows.map((r) => r.column_name);
    },
    checkpoint() {},
    async close() { await pool.end(); },
    raw: pool,
  };
}
