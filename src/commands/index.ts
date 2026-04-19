import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import * as bet from "../betting/commands/bet.js";
import * as market from "../betting/commands/market.js";
import * as best from "../cs/commands/best.js";
import * as carry from "../cs/commands/carry.js";
import * as compare from "../cs/commands/compare.js";
import * as flash from "../cs/commands/flash.js";
import * as floatCmd from "../cs/commands/float.js";
import * as history from "../cs/commands/history.js";
import * as importCmd from "../cs/commands/import.js";
import * as inv from "../cs/commands/inv.js";
import * as kobe from "../cs/commands/kobe.js";
import * as leaderboard from "../cs/commands/leaderboard.js";
import * as link from "../cs/commands/link.js";
import * as maps from "../cs/commands/maps.js";
import * as shame from "../cs/commands/shame.js";
import * as stats from "../cs/commands/stats.js";
import * as sus from "../cs/commands/sus.js";
import * as suspects from "../cs/commands/suspects.js";
import * as team from "../cs/commands/team.js";
import * as track from "../cs/commands/track.js";
import * as jomify from "./jomify.js";
import * as metrics from "./metrics.js";
import * as say from "./say.js";
import * as setchannel from "./setchannel.js";

export type Command = {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  execute: (i: ChatInputCommandInteraction) => Promise<void>;
};

export const commands: [string, Command][] = [
  ["stats", stats],
  ["compare", compare],
  ["shame", shame],
  ["leaderboard", leaderboard],
  ["track", track],
  ["flash", flash],
  ["link", link],
  ["import", importCmd],
  ["sus", sus],
  ["suspects", suspects],
  ["inv", inv],
  ["maps", maps],
  ["float", floatCmd],
  ["kobe", kobe],
  ["team", team],
  ["carry", carry],
  ["best", best],
  ["history", history],
  ["jomify", jomify],
  ["setchannel", setchannel],
  ["metrics", metrics],
  ["say", say],
  ["market", market],
  ["bet", bet],
];
