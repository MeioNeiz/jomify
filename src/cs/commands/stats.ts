import { SlashCommandBuilder } from "discord.js";
import {
  requireLinkedUser,
  respondWithRevalidate,
  wrapCommand,
} from "../../commands/handler.js";
import { fmt, freshnessSuffix } from "../../helpers.js";
import { embed } from "../../ui.js";
import { getProfile } from "../leetify/client.js";
import { getLatestSnapshot } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Show a player's CS2 stats")
  .addUserOption((opt) => opt.setName("user").setDescription("Player to look up"));

type View = {
  name: string;
  premier: number | null;
  leetify: number | null;
  aim: number;
  positioning: number;
  utility: number;
  clutch: number;
};

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const s = getLatestSnapshot(resolved.steamId);
      if (!s) return null;
      return {
        data: {
          name: s.name,
          premier: s.premier,
          leetify: s.leetify,
          aim: s.aim,
          positioning: s.positioning,
          utility: s.utility,
          clutch: s.clutch,
        },
        snapshotAt: s.recordedAt,
      };
    },
    fetchFresh: async () => {
      const p = await getProfile(resolved.steamId);
      return {
        name: p.name,
        premier: p.ranks?.premier ?? null,
        leetify: p.ranks?.leetify ?? null,
        aim: p.rating?.aim ?? 0,
        positioning: p.rating?.positioning ?? 0,
        utility: p.rating?.utility ?? 0,
        clutch: p.rating?.clutch ?? 0,
      };
    },
    render: (v, { cached, snapshotAt }) => {
      const e = embed()
        .setTitle(v.name)
        .addFields(
          { name: "Leetify Rating", value: fmt(v.leetify), inline: true },
          { name: "Premier", value: v.premier?.toLocaleString() ?? "N/A", inline: true },
          { name: "Aim", value: fmt(v.aim), inline: true },
          { name: "Positioning", value: fmt(v.positioning), inline: true },
          { name: "Utility", value: fmt(v.utility), inline: true },
          { name: "Clutch", value: fmt(v.clutch, 2), inline: true },
        );
      if (cached) {
        e.setDescription(freshnessSuffix(snapshotAt, "snapshot from").trim());
      }
      return { embeds: [e] };
    },
  });
});
