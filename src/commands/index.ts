import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";

import * as stats from "./stats.js";
import * as compare from "./compare.js";
import * as shame from "./shame.js";
import * as leaderboard from "./leaderboard.js";
import * as track from "./track.js";
import * as flash from "./flash.js";
import * as link from "./link.js";
import * as setchannel from "./setchannel.js";
import * as importCmd from "./import.js";

export type Command = {
  data: SlashCommandBuilder;
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
];
