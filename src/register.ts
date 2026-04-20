import { createHash } from "node:crypto";
import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";
import { config } from "./config.js";
import { sqlite } from "./db.js";

// Discord slash-command caps. Warn if we're close so we don't get
// surprised by a 400 next time someone adds a command.
const DISCORD_COMMAND_LIMIT = 100;
const WARN_THRESHOLD = 90;

const force = process.argv.includes("--force");
const rest = new REST().setToken(config.discordToken);
const body = commands.map(([, cmd]) => cmd.data.toJSON());
const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");

console.log(`${body.length} command(s) defined: ${body.map((c) => c.name).join(", ")}`);
if (body.length >= WARN_THRESHOLD) {
  console.warn(
    `⚠️  ${body.length}/${DISCORD_COMMAND_LIMIT} commands — approaching Discord's limit.`,
  );
}

sqlite.run(`
  CREATE TABLE IF NOT EXISTS command_registrations (
    scope         TEXT PRIMARY KEY,
    hash          TEXT NOT NULL,
    count         INTEGER NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

function needsRegister(scope: string): boolean {
  if (force) return true;
  const row = sqlite
    .query<{ hash: string }, [string]>(
      "SELECT hash FROM command_registrations WHERE scope = ?",
    )
    .get(scope);
  return row?.hash !== hash;
}

function markRegistered(scope: string): void {
  sqlite.run(
    `INSERT INTO command_registrations (scope, hash, count, registered_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(scope) DO UPDATE SET
       hash = excluded.hash,
       count = excluded.count,
       registered_at = excluded.registered_at`,
    [scope, hash, body.length],
  );
}

// ── Global scope ─────────────────────────────────────────────────────
if (needsRegister("global")) {
  console.log(`Registering ${body.length} commands globally...`);
  await rest.put(Routes.applicationCommands(config.discordClientId), { body });
  markRegistered("global");
} else {
  console.log("Global commands unchanged — skipping Discord API call.");
}

// ── Dev guild ────────────────────────────────────────────────────────
// Duplicates the global set for instant updates during dev; merges in
// the picker so no UX cost. Clear with `bun run register:clean`.
const guildId = config.devGuildId;
if (guildId) {
  const scope = `guild:${guildId}`;
  if (needsRegister(scope)) {
    console.log(`Registering to dev guild ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), {
      body,
    });
    markRegistered(scope);
  } else {
    console.log(`Dev guild ${guildId} commands unchanged — skipping.`);
  }
}

console.log(force ? "Done (forced)." : "Done!");
