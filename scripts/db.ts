#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { join } from "node:path";

const DBS = {
  core: "jomify.db",
  cs: "jomify-cs.db",
  betting: "jomify-betting.db",
} as const;
type Which = keyof typeof DBS;

const argv = process.argv.slice(2);
let which: Which = "core";
const filtered: string[] = [];
for (const a of argv) {
  if (a === "--cs") which = "cs";
  else if (a === "--betting") which = "betting";
  else if (a === "--core") which = "core";
  else filtered.push(a);
}

const arg = filtered.join(" ").trim();
if (!arg || arg === "-h" || arg === "--help") {
  console.error("Usage: bun scripts/db.ts [--cs|--betting] '<sql>'");
  console.error("       bun scripts/db.ts [--cs|--betting] .tables");
  console.error("       bun scripts/db.ts [--cs|--betting] .schema <tbl>");
  console.error(
    "Default DB: core (jomify.db). --cs → jomify-cs.db, --betting → jomify-betting.db.",
  );
  process.exit(1);
}

const DB = join(import.meta.dir, "..", DBS[which]);
const db = new Database(DB, { readonly: true });

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
