#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB = join(import.meta.dir, "..", "jomify.db");
const db = new Database(DB, { readonly: true });

const arg = process.argv.slice(2).join(" ").trim();

if (!arg || arg === "-h" || arg === "--help") {
  console.error("Usage: bun scripts/db.ts '<sql>'");
  console.error("       bun scripts/db.ts .tables        # list tables");
  console.error("       bun scripts/db.ts .schema <tbl>  # table schema");
  process.exit(1);
}

let sql = arg;
if (arg === ".tables") {
  sql = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
} else if (arg.startsWith(".schema ")) {
  const tbl = arg.slice(".schema ".length).trim();
  sql = `SELECT sql FROM sqlite_master WHERE name = '${tbl.replaceAll("'", "''")}'`;
}

const rows = db.query(sql).all();
if (!rows.length) {
  console.log("(no rows)");
} else {
  console.log(JSON.stringify(rows, null, 2));
}
