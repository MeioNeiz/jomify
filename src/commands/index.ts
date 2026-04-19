import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import * as bet from "../betting/commands/bet.js";
import * as best from "./best.js";
import * as carry from "./carry.js";
import * as compare from "./compare.js";
import * as flash from "./flash.js";
import * as floatCmd from "./float.js";
import * as history from "./history.js";
import * as importCmd from "./import.js";
import * as inv from "./inv.js";
import * as jomify from "./jomify.js";
import * as kobe from "./kobe.js";
import * as leaderboard from "./leaderboard.js";
import * as link from "./link.js";
import * as maps from "./maps.js";
import * as metrics from "./metrics.js";
import * as say from "./say.js";
import * as setchannel from "./setchannel.js";
import * as shame from "./shame.js";
import * as stats from "./stats.js";
import * as sus from "./sus.js";
import * as suspects from "./suspects.js";
import * as team from "./team.js";
import * as track from "./track.js";

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
  ["setchannel", setchannel],
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
  ["say", say],
  ["metrics", metrics],
  ["jomify", jomify],
  ["bet", bet],
];
