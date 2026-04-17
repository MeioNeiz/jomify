import {
  type APIApplicationCommandBasicOption,
  type APIApplicationCommandOption,
  type APIApplicationCommandSubcommandOption,
  ApplicationCommandOptionType,
  SlashCommandBuilder,
} from "discord.js";
import { embed } from "../ui.js";
import { wrapCommand } from "./handler.js";
import { type Command, commands } from "./index.js";

/**
 * Category layout for the overview. Ordering within each list decides
 * the display order; anything not listed falls into "Other" so newly
 * added commands surface in /jomify without needing a code change here.
 */
const CATEGORIES: { title: string; commands: string[] }[] = [
  {
    title: "Stats",
    commands: ["stats", "compare", "history", "best", "carry", "team"],
  },
  {
    title: "Guild",
    commands: ["leaderboard", "shame", "flash", "kobe", "maps"],
  },
  {
    title: "Social",
    commands: ["sus", "suspects", "inv", "float"],
  },
  {
    title: "Admin",
    commands: ["track", "link", "setchannel", "import", "say", "jomify"],
  },
];

function categorise(
  all: [string, Command][],
): { title: string; entries: [string, Command][] }[] {
  const remaining = new Map(all);
  const out: { title: string; entries: [string, Command][] }[] = [];
  for (const cat of CATEGORIES) {
    const entries: [string, Command][] = [];
    for (const name of cat.commands) {
      const cmd = remaining.get(name);
      if (cmd) {
        entries.push([name, cmd]);
        remaining.delete(name);
      }
    }
    if (entries.length) out.push({ title: cat.title, entries });
  }
  if (remaining.size) {
    out.push({ title: "Other", entries: [...remaining.entries()] });
  }
  return out;
}

function optionTypeLabel(type: ApplicationCommandOptionType): string {
  switch (type) {
    case ApplicationCommandOptionType.String:
      return "string";
    case ApplicationCommandOptionType.Integer:
      return "integer";
    case ApplicationCommandOptionType.Number:
      return "number";
    case ApplicationCommandOptionType.Boolean:
      return "boolean";
    case ApplicationCommandOptionType.User:
      return "user";
    case ApplicationCommandOptionType.Channel:
      return "channel";
    case ApplicationCommandOptionType.Role:
      return "role";
    case ApplicationCommandOptionType.Mentionable:
      return "mentionable";
    case ApplicationCommandOptionType.Attachment:
      return "attachment";
    default:
      return "value";
  }
}

function isSubcommand(
  opt: APIApplicationCommandOption,
): opt is APIApplicationCommandSubcommandOption {
  return opt.type === ApplicationCommandOptionType.Subcommand;
}

function describeOption(opt: APIApplicationCommandBasicOption): {
  name: string;
  value: string;
} {
  const required = opt.required ? "required" : "optional";
  const type = optionTypeLabel(opt.type);
  const bits: string[] = [`${type}, ${required}`];
  // `choices` exists on string/integer/number options. Other basic
  // options (user/channel/etc) have no choices list.
  const choices =
    "choices" in opt && Array.isArray(opt.choices) && opt.choices.length > 0
      ? opt.choices
      : null;
  if (choices) {
    const rendered = choices.map((c) => c.name).join(", ");
    bits.push(`choices: ${rendered}`);
  }
  const desc = opt.description?.trim() || "No description.";
  return {
    name: `\`${opt.name}\``,
    value: `${desc}\n-# ${bits.join(" \u2014 ")}`,
  };
}

type CommandJSON = ReturnType<SlashCommandBuilder["toJSON"]>;

// No `.addChoices` on the `command` option: Discord caps choice lists at
// 25 and we'd have to hand-maintain it here every time a command is
// added. Users type the name freely instead — autocomplete from Discord
// handles typos fine and new commands show up in /help automatically.
export const data = new SlashCommandBuilder()
  .setName("jomify")
  .setDescription("List Jomify commands or show details for one")
  .addStringOption((opt) =>
    opt.setName("command").setDescription("Command name for a detailed view"),
  );

function renderOverview() {
  const grouped = categorise(commands);
  const e = embed().setTitle("Jomify Commands");
  for (const group of grouped) {
    const lines = group.entries.map(([name, cmd]) => {
      const json = cmd.data.toJSON() as CommandJSON;
      const desc = json.description?.trim() || "No description.";
      return `\`/${name}\` \u2014 ${desc}`;
    });
    e.addFields({ name: group.title, value: lines.join("\n") });
  }
  e.setDescription("-# Use `/jomify command:<name>` for details on any command.");
  return e;
}

function renderDetail(name: string, cmd: Command) {
  const json = cmd.data.toJSON() as CommandJSON;
  const desc = json.description?.trim() || "No description.";
  const e = embed().setTitle(`/${name}`).setDescription(desc);

  const opts = json.options ?? [];
  const subcommands = opts.filter(isSubcommand);
  const basicOpts = opts.filter(
    (o): o is APIApplicationCommandBasicOption =>
      !isSubcommand(o) && o.type !== ApplicationCommandOptionType.SubcommandGroup,
  );

  if (subcommands.length) {
    for (const sub of subcommands) {
      const subDesc = sub.description?.trim() || "No description.";
      const parts = [subDesc];
      for (const subOpt of sub.options ?? []) {
        const rendered = describeOption(subOpt);
        parts.push(`  ${rendered.name}: ${rendered.value.replace(/\n/g, "\n  ")}`);
      }
      e.addFields({ name: `/${name} ${sub.name}`, value: parts.join("\n") });
    }
  }

  for (const opt of basicOpts) {
    e.addFields(describeOption(opt));
  }

  if (!subcommands.length && !basicOpts.length) {
    e.addFields({ name: "Usage", value: `\`/${name}\` takes no options.` });
  }

  return e;
}

export const execute = wrapCommand(async (interaction) => {
  const target = interaction.options.getString("command");

  if (!target) {
    await interaction.editReply({ embeds: [renderOverview()] });
    return;
  }

  const found = commands.find(([name]) => name === target);
  if (!found) {
    await interaction.editReply(`No command called \`/${target}\`.`);
    return;
  }
  await interaction.editReply({ embeds: [renderDetail(found[0], found[1])] });
});
