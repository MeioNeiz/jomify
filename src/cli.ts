import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { commands } from "./commands/index.js";

const FAKE_GUILD = "cli-test-guild";
const _DEFAULT_STEAM_ID = "76561198115898636";

function printEmbed(embed: EmbedBuilder) {
  const data = embed.data;
  if (data.title) console.log(`\n  ${data.title}`);
  if (data.description) console.log(`  ${data.description}`);
  if (data.fields?.length) {
    for (const f of data.fields) {
      console.log(`  ${f.name}: ${f.value}`);
    }
  }
  console.log();
}

function printContent(content: unknown) {
  if (typeof content === "string") {
    console.log(`\n  ${content}\n`);
  } else {
    const obj = content as { embeds?: EmbedBuilder[] };
    obj.embeds?.forEach(printEmbed);
  }
}

function makeInteraction(
  cmdName: string,
  args: Record<string, string>,
  subcommand?: string,
) {
  return {
    commandName: cmdName,
    guildId: FAKE_GUILD,
    deferred: false,
    replied: false,
    user: { id: "cli-user" },
    isChatInputCommand: () => true,
    deferReply: async () => {},
    reply: async (content: unknown) => printContent(content),
    editReply: async (content: unknown) => printContent(content),
    options: {
      getString: (name: string) => args[name] ?? null,
      getUser: () => null,
      getChannel: () => null,
      getSubcommand: () => subcommand ?? null,
    },
  } as unknown as ChatInputCommandInteraction;
}

function usage() {
  console.log(`
Usage: bun run src/cli.ts <command> [options]

Commands:
  stats        [--user <id>]
  compare      --user1 <id> --user2 <id> [--focus <area>]
  sus          [--user <id>]
  shame        [--user <id>]
  leaderboard
  flash
  inv          [--user <id>]
  maps         <team|player> [--user <id>]
  track        <add|remove|list|all> [--steamid <id>]
  link         --steamid <id>

Admin (CLI only):
  usage        [days]  — API usage report
`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (!argv.length) usage();

const cmdName = argv[0];

// Built-in CLI-only commands
if (cmdName === "usage") {
  const { getApiUsage } = await import("./store.js");
  const days = parseInt(argv[1] ?? "7", 10);
  const rows = getApiUsage(days);
  if (!rows.length) {
    console.log("\n  No API usage recorded.\n");
  } else {
    console.log(`\n  API usage (last ${days} days):\n`);
    let currentDay = "";
    for (const r of rows) {
      if (r.day !== currentDay) {
        currentDay = r.day;
        console.log(`  ${r.day}`);
      }
      console.log(`    ${r.endpoint}: ${r.count}`);
    }
    const total = rows.reduce((s, r) => s + r.count, 0);
    console.log(`\n  Total: ${total} calls\n`);
  }
  process.exit(0);
}

const cmd = commands.find(([name]) => name === cmdName);
if (!cmd) {
  console.error(`Unknown command: ${cmdName}`);
  usage();
}

// Parse --key value pairs
const args: Record<string, string> = {};
let subcommand: string | undefined;

for (let i = 1; i < argv.length; i++) {
  const tok = argv[i]!;
  if (tok.startsWith("--")) {
    const key = tok.slice(2);
    const val = argv[++i];
    if (val == null) {
      console.error(`Missing value for --${key}`);
      process.exit(1);
    }
    args[key] = val;
  } else if (!subcommand) {
    subcommand = tok;
  }
}

if (!cmdName) usage();
const interaction = makeInteraction(cmdName, args, subcommand);
await cmd![1].execute(interaction);
