import { EmbedBuilder } from "discord.js";
import { commands } from "./commands/index.js";

const FAKE_GUILD = "cli-test-guild";
const DEFAULT_STEAM_ID = "76561198115898636";

function printEmbed(embed: EmbedBuilder) {
  const data = embed.data;
  if (data.title) console.log(`\n  ${data.title}`);
  if (data.description)
    console.log(`  ${data.description}`);
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
  subcommand?: string
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
    editReply: async (content: unknown) =>
      printContent(content),
    options: {
      getString: (name: string) =>
        args[name] ?? DEFAULT_STEAM_ID,
      getUser: () => null,
      getChannel: () => null,
      getSubcommand: () => subcommand ?? null,
    },
  } as any;
}

function usage() {
  console.log(`
Usage: bun run src/cli.ts <command> [options]

Commands:
  stats        [--steamid <id>]
  compare      [--player1 <id> --player2 <id>]
  shame
  leaderboard
  flash
  track        <add|remove|list|all> [--steamid <id>]
  link         --steamid <id>
  setchannel   (Discord only)
`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (!argv.length) usage();

const cmdName = argv[0];
const cmd = commands.find(([name]) => name === cmdName);
if (!cmd) {
  console.error(`Unknown command: ${cmdName}`);
  usage();
}

// Parse --key value pairs
const args: Record<string, string> = {};
let subcommand: string | undefined;

for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const key = argv[i].slice(2);
    args[key] = argv[++i];
  } else if (!subcommand) {
    subcommand = argv[i];
  }
}

const interaction = makeInteraction(
  cmdName, args, subcommand
);
await cmd[1].execute(interaction);
