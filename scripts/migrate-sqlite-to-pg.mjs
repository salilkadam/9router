#!/usr/bin/env node
// One-time SQLite → Postgres data migration.
//
// Run inside the deployed container (both the sqlite file volume and
// DATABASE_URL are present there):
//   node scripts/migrate-sqlite-to-pg.mjs [path/to/data.sqlite]
//
// Idempotent: rows are upserted, so re-running after a partial failure is
// safe. The target schema is created by the app's own migration layer first.
// The sqlite file is left untouched.
import path from "node:path";
import fs from "node:fs";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || "~", ".9router");
const sqliteFile = process.argv[2] || path.join(dataDir, "db", "data.sqlite");
if (!fs.existsSync(sqliteFile)) {
  console.error(`SQLite file not found: ${sqliteFile}`);
  process.exit(1);
}

// Create the Postgres schema from the app's own declarative schema module
// (schema.js and pgAdapter.js are the two db modules with no "@/" alias
// imports, so they load under plain node). Equivalent to migration 001.
const here = path.dirname(new URL(import.meta.url).pathname);
const { createPgAdapter } = await import(path.join(here, "../src/lib/db/adapters/pgAdapter.js"));
const { TABLES, buildCreateTableSql } = await import(path.join(here, "../src/lib/db/schema.js"));
const pgDb = await createPgAdapter(DATABASE_URL);
for (const [name, def] of Object.entries(TABLES)) {
  await pgDb.exec(buildCreateTableSql(name, def, "postgres"));
  for (const idx of def.indexes || []) await pgDb.exec(idx);
}
// Stamp versions so app boot's migration runner sees an initialized DB.
const stamp = `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
await pgDb.run(stamp, ["schemaVersion", "1"]);
await pgDb.run(stamp, ["backupSchemaVersion", "1"]);

const { default: Database } = await import("better-sqlite3");
const lite = new Database(sqliteFile, { readonly: true });

function upsertSql(table, cols, conflictTarget) {
  const updates = cols.filter((c) => !conflictTarget.includes(c)).map((c) => `${c} = excluded.${c}`);
  return `INSERT INTO ${table}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})
          ON CONFLICT(${conflictTarget.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
}

// table → conflict target; column lists come from the live sqlite rows.
const PLAIN_TABLES = {
  _meta: ["key"],
  settings: ["id"],
  providerConnections: ["id"],
  providerNodes: ["id"],
  proxyPools: ["id"],
  apiKeys: ["id"],
  combos: ["id"],
  kv: ["scope", "key"],
  usageDaily: ["dateKey"],
  requestDetails: ["id"],
  usageHistory: ["id"], // explicit ids kept; identity is BY DEFAULT so this works
};

let grandTotal = 0;
for (const [table, conflict] of Object.entries(PLAIN_TABLES)) {
  const rows = lite.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) {
    console.log(`${table}: 0 rows`);
    continue;
  }
  const cols = Object.keys(rows[0]);
  const sql = upsertSql(table, cols, conflict);
  let n = 0;
  await pgDb.transaction(async () => {
    for (const row of rows) {
      await pgDb.run(sql, cols.map((c) => row[c]));
      n++;
    }
  });
  grandTotal += n;
  console.log(`${table}: ${n} rows migrated`);
}

// Make config tables authoritative: drop rows the app may have auto-created
// against the empty Postgres DB before this migration ran (e.g. the
// first-boot auto-provisioned API key) that don't exist in the source.
for (const table of ["providerConnections", "providerNodes", "proxyPools", "apiKeys", "combos"]) {
  const srcIds = lite.prepare(`SELECT id FROM ${table}`).all().map((r) => r.id);
  const pgRows = await pgDb.all(`SELECT id FROM ${table}`);
  const stale = pgRows.filter((r) => !srcIds.includes(r.id));
  for (const r of stale) {
    await pgDb.run(`DELETE FROM ${table} WHERE id = ?`, [r.id]);
    console.log(`${table}: removed row ${r.id} not present in sqlite source`);
  }
}

// Bump the identity sequence past the copied usageHistory ids.
const maxId = (await pgDb.get(`SELECT MAX(id) as m FROM usageHistory`))?.m;
if (maxId) {
  await pgDb.exec(`SELECT setval(pg_get_serial_sequence('usagehistory', 'id'), ${Number(maxId)})`);
  console.log(`usageHistory sequence set to ${maxId}`);
}

// Sanity check a few counts.
for (const table of ["providerConnections", "apiKeys", "usageHistory"]) {
  const src = lite.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
  const dst = (await pgDb.get(`SELECT COUNT(*) as c FROM ${table}`)).c;
  const ok = src === dst ? "OK" : "MISMATCH";
  console.log(`verify ${table}: sqlite=${src} pg=${dst} ${ok}`);
  if (src !== dst) process.exitCode = 2;
}

lite.close();
await pgDb.close();
console.log(`Done. ${grandTotal} rows total.`);
