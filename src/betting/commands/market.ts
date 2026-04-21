import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type MessageEditOptions,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { requireLinkedUser, wrapCommand } from "../../commands/handler.js";
import { registerComponent } from "../../components.js";
import { getLatestSnapshot, getSteamId, getTrackedPlayers } from "../../cs/store.js";
import log from "../../logger.js";
import { getActivityPings, setActivityPings } from "../../store.js";
import { embed } from "../../ui.js";
import { fetchGammaMarket } from "../resolvers/polymarket.js";
// Side-effect import: registers the dispute component handlers. Kept
// here (not commands/index.ts) so the market module owns the
// surfaces that share its lifecycle.
import "../disputes.js";
import {
  CHALLENGE_MIN_STAKE,
  CREATOR_STAKE_TIERS,
  DEFAULT_CREATOR_STAKE,
  DEFAULT_EXPIRY_HOURS,
  DISPUTE_COST,
  LMSR_RAKE,
  TRADER_BONUS_CAP,
  tierFor,
} from "../config.js";
import { lmsrExpectedPayout, lmsrProb, lmsrSellRefund } from "../lmsr.js";
import { lookup } from "../resolvers/index.js";
import {
  cancelBet,
  createBet,
  extendBet,
  getBalance,
  getBet,
  getOpenDisputeForBet,
  getWagersForBet,
  listOpenBets,
  type Outcome,
  placeWager,
  resolveBet,
  sellWager,
  setBetMessage,
} from "../store.js";
import {
  CURRENCY,
  MARKET_BUTTONS,
  MARKET_COPY,
  MARKET_DURATIONS,
  MARKET_EMBED_COLOUR,
  MARKET_EMOJI,
} from "../ui.js";

export const data = new SlashCommandBuilder()
  .setName("market")
  .setDescription("LMSR prediction markets — back yes or no, odds shift as bets arrive")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Open a new prediction market")
      .addStringOption((opt) =>
        opt
          .setName("question")
          .setDescription("What are people predicting on?")
          .setRequired(true)
          .setMaxLength(200),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Auto-close + refund after this long (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      })
      .addIntegerOption((opt) => {
        opt
          .setName("stake")
          .setDescription(
            `Your LP stake — max loss, deeper markets need bigger stakes (default: ${DEFAULT_CREATOR_STAKE})`,
          );
        for (const t of CREATOR_STAKE_TIERS) {
          opt.addChoices({ name: `${t.stake} shekels`, value: t.stake });
        }
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cs-next-match")
      .setDescription("Auto-resolving market on a tracked player's next match")
      .addUserOption((opt) =>
        opt
          .setName("player")
          .setDescription("Linked Discord user to watch (must be tracked in this server)")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("outcome")
          .setDescription("What decides yes/no")
          .setRequired(true)
          .addChoices(
            { name: "win (yes if they win)", value: "win" },
            { name: "kills above threshold", value: "kills-above" },
          ),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addNumberOption((opt) =>
        opt
          .setName("threshold")
          .setDescription("Required for rating-above / kills-above"),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Auto-cancel + refund if no match lands in this window (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      })
      .addIntegerOption((opt) => {
        opt
          .setName("stake")
          .setDescription(
            `Your LP stake — max loss on this market (default: ${DEFAULT_CREATOR_STAKE})`,
          );
        for (const t of CREATOR_STAKE_TIERS) {
          opt.addChoices({ name: `${t.stake} shekels`, value: t.stake });
        }
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cs-rating-goal")
      .setDescription(
        "Market: will a player reach a target Leetify rating by the deadline?",
      )
      .addUserOption((opt) =>
        opt
          .setName("player")
          .setDescription("Linked Discord user to watch (must be tracked in this server)")
          .setRequired(true),
      )
      .addNumberOption((opt) =>
        opt
          .setName("threshold")
          .setDescription("Target Leetify rating (e.g. 0.15)")
          .setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Deadline — resolves NO if rating not hit in time (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      })
      .addIntegerOption((opt) => {
        opt
          .setName("stake")
          .setDescription(
            `Your LP stake — max loss on this market (default: ${DEFAULT_CREATOR_STAKE})`,
          );
        for (const t of CREATOR_STAKE_TIERS) {
          opt.addChoices({ name: `${t.stake} shekels`, value: t.stake });
        }
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cs-premier")
      .setDescription(
        "Market: will a player reach a target Premier rating by the deadline?",
      )
      .addUserOption((opt) =>
        opt
          .setName("player")
          .setDescription("Linked Discord user to watch (must be tracked in this server)")
          .setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("target")
          .setDescription("Target Premier rating (e.g. 12000)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(35000),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Deadline — resolves NO if rating not hit in time (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      })
      .addIntegerOption((opt) => {
        opt
          .setName("stake")
          .setDescription(
            `Your LP stake — max loss on this market (default: ${DEFAULT_CREATOR_STAKE})`,
          );
        for (const t of CREATOR_STAKE_TIERS) {
          opt.addChoices({ name: `${t.stake} shekels`, value: t.stake });
        }
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("first-to")
      .setDescription(
        "Market: who'll be first to hit a CS milestone — scope your own server",
      )
      .addStringOption((opt) =>
        opt
          .setName("stat")
          .setDescription("Which milestone decides yes")
          .setRequired(true)
          .addChoices(
            { name: "ace (first 5k in a match)", value: "ace" },
            { name: "thirty-bomb (30+ kills in a match)", value: "thirty-bomb" },
            { name: "win-streak (N wins in a row)", value: "win-streak" },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName("scope")
          .setDescription("Who counts — any tracked player or a named few")
          .setRequired(true)
          .addChoices(
            { name: "guild (any tracked player)", value: "guild" },
            { name: "list (named players only)", value: "list" },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName("players")
          .setDescription(
            "Required when scope=list: @mention each player (space or comma separated)",
          )
          .setMaxLength(500),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("threshold")
          .setDescription("Required for win-streak: how many wins in a row (≥ 2)")
          .setMinValue(2)
          .setMaxValue(20),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Deadline — refunds both sides if no one hits it (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      })
      .addIntegerOption((opt) => {
        opt
          .setName("stake")
          .setDescription(
            `Your LP stake — max loss on this market (default: ${DEFAULT_CREATOR_STAKE})`,
          );
        for (const t of CREATOR_STAKE_TIERS) {
          opt.addChoices({ name: `${t.stake} shekels`, value: t.stake });
        }
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("stock")
      .setDescription(
        "Auto-resolving market on a stock price target (requires ALPHA_VANTAGE_KEY)",
      )
      .addStringOption((opt) =>
        opt
          .setName("ticker")
          .setDescription("Stock ticker symbol (e.g. AAPL, TSLA)")
          .setRequired(true)
          .setMaxLength(10),
      )
      .addStringOption((opt) =>
        opt
          .setName("direction")
          .setDescription("What has to happen for YES")
          .setRequired(true)
          .addChoices(
            { name: "above price", value: "above" },
            { name: "below price", value: "below" },
            { name: "% move up", value: "pct-up" },
            { name: "% move down", value: "pct-down" },
          ),
      )
      .addNumberOption((opt) =>
        opt
          .setName("target")
          .setDescription("Target price (e.g. 200) or % move (e.g. 5)")
          .setRequired(true)
          .setMinValue(0.01),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Deadline — resolves NO if not hit in time (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      })
      .addIntegerOption((opt) => {
        opt
          .setName("stake")
          .setDescription(
            `Your LP stake — max loss on this market (default: ${DEFAULT_CREATOR_STAKE})`,
          );
        for (const t of CREATOR_STAKE_TIERS) {
          opt.addChoices({ name: `${t.stake} shekels`, value: t.stake });
        }
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("crypto")
      .setDescription("Auto-resolving market on a crypto price target (via CoinGecko)")
      .addStringOption((opt) =>
        opt
          .setName("symbol")
          .setDescription("Crypto symbol (e.g. BTC, ETH, SOL, DOGE)")
          .setRequired(true)
          .setMaxLength(15),
      )
      .addStringOption((opt) =>
        opt
          .setName("direction")
          .setDescription("What has to happen for YES")
          .setRequired(true)
          .addChoices(
            { name: "above price", value: "above" },
            { name: "below price", value: "below" },
            { name: "% move up", value: "pct-up" },
            { name: "% move down", value: "pct-down" },
          ),
      )
      .addNumberOption((opt) =>
        opt
          .setName("target")
          .setDescription("Target price (e.g. 80000) or % move (e.g. 5)")
          .setRequired(true)
          .setMinValue(0.000001),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Deadline — resolves NO if not hit in time (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      })
      .addIntegerOption((opt) => {
        opt
          .setName("stake")
          .setDescription(
            `Your LP stake — max loss on this market (default: ${DEFAULT_CREATOR_STAKE})`,
          );
        for (const t of CREATOR_STAKE_TIERS) {
          opt.addChoices({ name: `${t.stake} shekels`, value: t.stake });
        }
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("mirror")
      .setDescription(
        "Mirror an external prediction market (Polymarket / Kalshi) using shekels",
      )
      .addStringOption((opt) =>
        opt
          .setName("source")
          .setDescription("Which platform to mirror")
          .setRequired(true)
          .addChoices(
            { name: "Polymarket", value: "polymarket" },
            { name: "Kalshi", value: "kalshi" },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName("ref")
          .setDescription("Slug (Polymarket) or ticker (Kalshi)")
          .setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("challenge")
      .setDescription("Challenge another user to a head-to-head prediction market")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("The user to challenge").setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("question")
          .setDescription("What are you predicting on?")
          .setRequired(true)
          .setMaxLength(200),
      )
      .addStringOption((opt) =>
        opt
          .setName("my-side")
          .setDescription("Which side do you want?")
          .setRequired(true)
          .addChoices({ name: "YES", value: "yes" }, { name: "NO", value: "no" }),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("amount")
          .setDescription("Shekels to stake now")
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Market closes after this long (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      })
      .addIntegerOption((opt) => {
        opt
          .setName("stake")
          .setDescription(
            `Your LP stake — challenges stake at least ${CHALLENGE_MIN_STAKE} (default: ${CHALLENGE_MIN_STAKE})`,
          );
        for (const t of CREATOR_STAKE_TIERS) {
          if (t.stake < CHALLENGE_MIN_STAKE) continue;
          opt.addChoices({ name: `${t.stake} shekels`, value: t.stake });
        }
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("config")
      .setDescription("Configure market settings for this server (admin only)")
      .addStringOption((opt) =>
        opt
          .setName("activity")
          .setDescription("Post a ping when the first YES or NO position is taken")
          .setRequired(true)
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Show open markets in this server"),
  );

// ── Market view rendering ────────────────────────────────────────────

function button(
  customId: string,
  cfg: { style: number; label: string; emoji?: string },
): ButtonBuilder {
  const b = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(cfg.label)
    .setStyle(cfg.style);
  if (cfg.emoji) b.setEmoji(cfg.emoji);
  return b;
}

export function renderMarketView(
  betId: number,
): MessageEditOptions & InteractionReplyOptions {
  const bet = getBet(betId);
  if (!bet) {
    return { content: `Market #${betId} doesn't exist.`, embeds: [], components: [] };
  }

  const allWagers = getWagersForBet(betId);
  let yesAmount = 0;
  let noAmount = 0;
  for (const w of allWagers) {
    if (w.outcome === "yes") yesAmount += w.amount;
    else noAmount += w.amount;
  }
  const total = yesAmount + noAmount;

  // ── Header lines ─────────────────────────────────────────────────────
  const descLines: string[] = [];

  if (bet.status === "open" && bet.b > 0) {
    // Live LMSR probability — this is what the market thinks, shifting
    // with each bet. Show it first so it's the most prominent signal.
    const p = lmsrProb(bet.qYes, bet.qNo, bet.b);
    const pctYes = Math.round(p * 100);
    const pctNo = 100 - pctYes;
    descLines.push(`📊 YES **${pctYes}%** · NO **${pctNo}%**`);
  }

  if (bet.status === "resolved") {
    descLines.push(
      `${MARKET_EMOJI.resolved} ${MARKET_COPY.resolvedPrefix}: **${bet.winningOutcome?.toUpperCase()}**`,
    );
  } else if (bet.status === "cancelled") {
    descLines.push(MARKET_COPY.cancelledLine);
  } else {
    descLines.push(
      `${MARKET_COPY.volumeLabel}: ${MARKET_EMOJI.yes} **${yesAmount}** yes · ` +
        `${MARKET_EMOJI.no} **${noAmount}** no (**${total}** total)`,
    );
  }

  descLines.push(
    `${MARKET_COPY.creatorPrefix} <@${bet.creatorDiscordId}>` +
      (bet.creatorStake > 0 ? ` · staked **${bet.creatorStake}** as LP` : ""),
  );

  if (bet.status === "open" && bet.creatorStake > 0) {
    const uniqueTraders = new Set(allWagers.map((w) => w.discordId)).size;
    const { perTraderBonus } = tierFor(bet.creatorStake);
    const lockedBonus = Math.floor(
      Math.min(uniqueTraders, TRADER_BONUS_CAP) * perTraderBonus,
    );
    descLines.push(
      `📒 LP: **${uniqueTraders}** trader${uniqueTraders === 1 ? "" : "s"}` +
        ` · bonus at resolution: **${lockedBonus}**`,
    );
  }

  if (bet.challengeTargetDiscordId) {
    const acceptByUnix = bet.challengeAcceptBy
      ? Math.floor(new Date(`${bet.challengeAcceptBy}Z`).getTime() / 1000)
      : null;
    if (acceptByUnix && Date.now() / 1000 < acceptByUnix) {
      descLines.push(
        `⚔️ <@${bet.challengeTargetDiscordId}> has been challenged — accept <t:${acceptByUnix}:R>.`,
      );
    } else {
      descLines.push("Challenge expired — open to everyone.");
    }
  }

  if (bet.status === "open" && bet.resolverKind) {
    const resolver = lookup(bet.resolverKind);
    const args = bet.resolverArgs ? (JSON.parse(bet.resolverArgs) as unknown) : null;
    descLines.push(
      resolver?.describe?.(args) ?? "Auto-resolves when its upstream event lands.",
    );
    if (bet.resolverKind === "external:polymarket" && args) {
      const slug = (args as { slug?: string }).slug;
      if (slug)
        descLines.push(`[View on Polymarket](https://polymarket.com/event/${slug})`);
    }
    if (bet.resolverKind === "external:kalshi" && args) {
      const ticker = (args as { ticker?: string }).ticker;
      if (ticker)
        descLines.push(
          `[View on Kalshi](https://kalshi.com/markets/${ticker.toLowerCase()})`,
        );
    }
  }
  if (bet.status === "open" && bet.expiresAt) {
    const unix = Math.floor(new Date(`${bet.expiresAt}Z`).getTime() / 1000);
    descLines.push(`Closes <t:${unix}:R>`);
  }

  const openDispute = bet.status === "resolved" ? getOpenDisputeForBet(bet.id) : null;
  if (openDispute) {
    descLines.push(`\u26A0\uFE0F Dispute #${openDispute.id} pending admin ruling.`);
  }

  // ── Bet lines ─────────────────────────────────────────────────────────
  descLines.push("", `__${MARKET_COPY.betsLabel}__`);
  if (allWagers.length === 0) {
    descLines.push(MARKET_COPY.emptyBets);
  } else {
    for (const w of allWagers) {
      const side = w.outcome === "yes" ? MARKET_EMOJI.yes : MARKET_EMOJI.no;
      if (bet.b > 0 && w.shares > 0) {
        descLines.push(
          `${side} <@${w.discordId}> \u2014 **${w.amount}** \u21a6 **${w.shares.toFixed(1)}** shares`,
        );
      } else {
        descLines.push(
          `${side} <@${w.discordId}> \u2014 **${w.amount}** on ${w.outcome}`,
        );
      }
    }
  }

  if (bet.status === "open") descLines.push("", MARKET_COPY.footerOpen);

  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(MARKET_COPY.title(bet.id, bet.question))
    .setDescription(descLines.join("\n"));

  if (bet.status === "resolved" && !openDispute) {
    const reportRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`dispute:report:${bet.id}`)
        .setLabel(`Report (${DISPUTE_COST} shekels)`)
        .setEmoji("\u26A0\uFE0F")
        .setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [e], components: [reportRow] };
  }
  if (bet.status !== "open") {
    return { embeds: [e], components: [] };
  }

  const betRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`market:wager:${bet.id}:yes`, MARKET_BUTTONS.betYes),
    button(`market:wager:${bet.id}:no`, MARKET_BUTTONS.betNo),
    button(`market:sell:${bet.id}`, MARKET_BUTTONS.sell),
  );
  const extendBtn = button(`market:extend:${bet.id}`, MARKET_BUTTONS.extend);
  if (bet.resolverKind) {
    const extendRow = new ActionRowBuilder<ButtonBuilder>().addComponents(extendBtn);
    return { embeds: [e], components: [betRow, extendRow] };
  }
  const resolveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`market:resolve:${bet.id}:yes`, MARKET_BUTTONS.resolveYes),
    button(`market:resolve:${bet.id}:no`, MARKET_BUTTONS.resolveNo),
    extendBtn,
  );
  return { embeds: [e], components: [betRow, resolveRow] };
}

// ── Slash handlers ───────────────────────────────────────────────────

function durationHours(choice: string | null): number {
  if (!choice) return DEFAULT_EXPIRY_HOURS;
  return MARKET_DURATIONS.find((d) => d.name === choice)?.hours ?? DEFAULT_EXPIRY_HOURS;
}

function expiryIso(hours: number): string {
  const when = new Date(Date.now() + hours * 3600 * 1000);
  return when.toISOString().replace("T", " ").replace(/\..+$/, "");
}

async function handleCreate(interaction: ChatInputCommandInteraction, guildId: string) {
  const question = interaction.options.getString("question", true);
  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));
  const stake = interaction.options.getInteger("stake") ?? DEFAULT_CREATOR_STAKE;

  let id: number;
  try {
    id = createBet(guildId, interaction.user.id, question, expiresAt, {
      initialProb: probPct / 100,
      stake,
    });
  } catch (err) {
    await interaction.editReply((err as Error).message);
    return;
  }
  await interaction.editReply(renderMarketView(id));

  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

async function handleCsRatingGoal(
  interaction: ChatInputCommandInteraction,
  guildId: string,
) {
  const resolved = await requireLinkedUser(interaction, "player");
  if (!resolved) return;
  const threshold = interaction.options.getNumber("threshold", true);

  const tracked = new Set(getTrackedPlayers(guildId));
  if (!tracked.has(resolved.steamId)) {
    await interaction.editReply(
      `${resolved.label} isn't tracked here. Add them with \`/track\` first.`,
    );
    return;
  }

  const question = `Will ${resolved.label} hit a Leetify rating ≥ ${threshold.toFixed(2)} before the deadline?`;
  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const id = createBet(guildId, interaction.user.id, question, expiresAt, {
    resolverKind: "cs:rating-goal",
    resolverArgs: { steamId: resolved.steamId, threshold },
    initialProb: probPct / 100,
    stake: interaction.options.getInteger("stake") ?? DEFAULT_CREATOR_STAKE,
  });
  await interaction.editReply(renderMarketView(id));
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

const CS_NEXT_MATCH_KIND = {
  win: "cs:next-match-win",
  "rating-above": "cs:next-match-rating-above",
  "kills-above": "cs:next-match-kills-above",
} as const;

async function handleCsNextMatch(
  interaction: ChatInputCommandInteraction,
  guildId: string,
) {
  const resolved = await requireLinkedUser(interaction, "player");
  if (!resolved) return;
  const outcomeChoice = interaction.options.getString("outcome", true);
  const kind = CS_NEXT_MATCH_KIND[outcomeChoice as keyof typeof CS_NEXT_MATCH_KIND];
  if (!kind) {
    await interaction.editReply(`Unknown outcome: ${outcomeChoice}`);
    return;
  }
  const threshold = interaction.options.getNumber("threshold");
  if (kind !== "cs:next-match-win" && threshold === null) {
    await interaction.editReply(
      `\`${outcomeChoice}\` needs a \`threshold\`. Try a rating like 0.05 or a kill count like 20.`,
    );
    return;
  }

  const tracked = new Set(getTrackedPlayers(guildId));
  if (!tracked.has(resolved.steamId)) {
    await interaction.editReply(
      `${resolved.label} isn't tracked here. Add them with \`/track\` first.`,
    );
    return;
  }

  const question = (() => {
    if (kind === "cs:next-match-win")
      return `Will ${resolved.label} win their next match?`;
    if (kind === "cs:next-match-rating-above")
      return `Will ${resolved.label}'s next match rating be ≥ ${threshold}?`;
    return `Will ${resolved.label} get more than ${threshold} kills next match?`;
  })();

  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const id = createBet(guildId, interaction.user.id, question, expiresAt, {
    resolverKind: kind,
    resolverArgs: {
      steamId: resolved.steamId,
      ...(threshold !== null ? { threshold } : {}),
    },
    initialProb: probPct / 100,
    stake: interaction.options.getInteger("stake") ?? DEFAULT_CREATOR_STAKE,
  });
  await interaction.editReply(renderMarketView(id));
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

async function handleMirror(interaction: ChatInputCommandInteraction, guildId: string) {
  const source = interaction.options.getString("source", true);
  const ref = interaction.options.getString("ref", true).trim();
  const probPct = interaction.options.getInteger("probability") ?? 50;

  let question: string;
  let resolverKind: string;
  let resolverArgs: unknown;

  if (source === "polymarket") {
    const upstream = await fetchGammaMarket(ref);
    if (!upstream) {
      await interaction.editReply(
        `Couldn't fetch Polymarket slug \`${ref}\`. Check the slug from the market URL and try again.`,
      );
      return;
    }
    if (upstream.resolvedOutcome && upstream.resolvedOutcome !== "Unresolved") {
      await interaction.editReply(
        `That market has already resolved **${upstream.resolvedOutcome}** — can't mirror it.`,
      );
      return;
    }
    question = upstream.question ?? `Mirror of polymarket.com/event/${ref}`;
    resolverKind = "external:polymarket";
    resolverArgs = { slug: ref };
  } else if (source === "kalshi") {
    question = `Mirror of Kalshi market ${ref.toUpperCase()}`;
    resolverKind = "external:kalshi";
    resolverArgs = { ticker: ref.toUpperCase() };
  } else {
    await interaction.editReply(
      "Unknown source — only `polymarket` and `kalshi` are supported.",
    );
    return;
  }

  const id = createBet(guildId, interaction.user.id, question, null, {
    resolverKind,
    resolverArgs,
    initialProb: probPct / 100,
    stake: interaction.options.getInteger("stake") ?? DEFAULT_CREATOR_STAKE,
  });
  await interaction.editReply(renderMarketView(id));
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

async function handleStock(interaction: ChatInputCommandInteraction, guildId: string) {
  const ticker = interaction.options.getString("ticker", true).toUpperCase().trim();
  const direction = interaction.options.getString("direction", true);
  const target = interaction.options.getNumber("target", true);
  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const kindMap: Record<string, string> = {
    above: "stock:price-above",
    below: "stock:price-below",
    "pct-up": "stock:pct-move",
    "pct-down": "stock:pct-move",
  };
  const resolverKind = kindMap[direction];
  if (!resolverKind) {
    await interaction.editReply(`Unknown direction: ${direction}`);
    return;
  }

  const resolverArgs =
    resolverKind === "stock:pct-move"
      ? { ticker, pct: target, direction: direction === "pct-up" ? "up" : "down" }
      : { ticker, target };

  const question = (() => {
    if (direction === "above")
      return `Will ${ticker} close above $${target.toFixed(2)} before the deadline?`;
    if (direction === "below")
      return `Will ${ticker} fall below $${target.toFixed(2)} before the deadline?`;
    const dir = direction === "pct-up" ? "up" : "down";
    return `Will ${ticker} move ${dir} ≥ ${target}% before the deadline?`;
  })();

  const id = createBet(guildId, interaction.user.id, question, expiresAt, {
    resolverKind,
    resolverArgs,
    initialProb: probPct / 100,
    stake: interaction.options.getInteger("stake") ?? DEFAULT_CREATOR_STAKE,
  });
  await interaction.editReply(renderMarketView(id));
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

async function handleCrypto(interaction: ChatInputCommandInteraction, guildId: string) {
  const symbol = interaction.options.getString("symbol", true).toUpperCase().trim();
  const direction = interaction.options.getString("direction", true);
  const target = interaction.options.getNumber("target", true);
  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const kindMap: Record<string, string> = {
    above: "crypto:price-above",
    below: "crypto:price-below",
    "pct-up": "crypto:pct-move",
    "pct-down": "crypto:pct-move",
  };
  const resolverKind = kindMap[direction];
  if (!resolverKind) {
    await interaction.editReply(`Unknown direction: ${direction}`);
    return;
  }

  const resolverArgs =
    resolverKind === "crypto:pct-move"
      ? { symbol, pct: target, direction: direction === "pct-up" ? "up" : "down" }
      : { symbol, target };

  const question = (() => {
    if (direction === "above")
      return `Will ${symbol} trade above $${target.toLocaleString()} before the deadline?`;
    if (direction === "below")
      return `Will ${symbol} fall below $${target.toLocaleString()} before the deadline?`;
    const dir = direction === "pct-up" ? "up" : "down";
    return `Will ${symbol} move ${dir} ≥ ${target}% before the deadline?`;
  })();

  const id = createBet(guildId, interaction.user.id, question, expiresAt, {
    resolverKind,
    resolverArgs,
    initialProb: probPct / 100,
    stake: interaction.options.getInteger("stake") ?? DEFAULT_CREATOR_STAKE,
  });
  await interaction.editReply(renderMarketView(id));
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

async function handleChallenge(
  interaction: ChatInputCommandInteraction,
  guildId: string,
) {
  const targetUser = interaction.options.getUser("user", true);
  if (targetUser.id === interaction.user.id) {
    await interaction.editReply("You can't challenge yourself.");
    return;
  }
  const question = interaction.options.getString("question", true);
  const mySide = interaction.options.getString("my-side", true) as Outcome;
  const amount = interaction.options.getInteger("amount", true);
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const pickedStake = interaction.options.getInteger("stake") ?? CHALLENGE_MIN_STAKE;
  if (pickedStake < CHALLENGE_MIN_STAKE) {
    await interaction.editReply(
      `Challenge markets need at least ${CHALLENGE_MIN_STAKE} shekels of LP stake.`,
    );
    return;
  }
  const balance = getBalance(interaction.user.id, guildId);
  const needed = pickedStake + amount;
  if (balance < needed) {
    await interaction.editReply(
      `You only have **${balance}** shekels — need **${needed}** (${pickedStake} LP + ${amount} stake).`,
    );
    return;
  }

  let id: number;
  try {
    id = createBet(guildId, interaction.user.id, question, expiresAt, {
      challengeTargetDiscordId: targetUser.id,
      stake: pickedStake,
    });
  } catch (err) {
    await interaction.editReply((err as Error).message);
    return;
  }
  try {
    placeWager(id, interaction.user.id, mySide, amount);
  } catch (err) {
    cancelBet(id);
    await interaction.editReply((err as Error).message);
    return;
  }

  await interaction.editReply(renderMarketView(id));
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

async function handleConfig(interaction: ChatInputCommandInteraction, guildId: string) {
  if (!interaction.memberPermissions?.has("ManageGuild")) {
    await interaction.editReply("Only admins can change market config.");
    return;
  }
  const activity = interaction.options.getString("activity", true);
  setActivityPings(guildId, activity === "on");
  await interaction.editReply(`Activity pings **${activity}**.`);
}

async function handleCsPremier(
  interaction: ChatInputCommandInteraction,
  guildId: string,
) {
  const resolved = await requireLinkedUser(interaction, "player");
  if (!resolved) return;
  const target = interaction.options.getInteger("target", true);

  const tracked = new Set(getTrackedPlayers(guildId));
  if (!tracked.has(resolved.steamId)) {
    await interaction.editReply(
      `${resolved.label} isn't tracked here. Add them with \`/track\` first.`,
    );
    return;
  }

  const question = `Will ${resolved.label} reach Premier rating ${target.toLocaleString()} before the deadline?`;
  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const id = createBet(guildId, interaction.user.id, question, expiresAt, {
    resolverKind: "cs:premier-milestone",
    resolverArgs: { steamId: resolved.steamId, target },
    initialProb: probPct / 100,
    stake: interaction.options.getInteger("stake") ?? DEFAULT_CREATOR_STAKE,
  });
  await interaction.editReply(renderMarketView(id));
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

// ── /market first-to ─────────────────────────────────────────────────
//
// Creator self-dealing rule applies: the creator ideally shouldn't be
// allowed to stake YES on a market seeded with their own players. That
// rule isn't enforced anywhere in the codebase yet — documenting here
// so the next pass can plug it in uniformly across all CS markets.

const MENTION_RE = /<@!?(\d+)>/g;

function parsePlayerMentions(raw: string): string[] {
  const ids: string[] = [];
  for (const m of raw.matchAll(MENTION_RE)) {
    if (m[1] && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

function labelForSteamId(steamId: string): string {
  const snap = getLatestSnapshot(steamId);
  return snap?.name ?? steamId;
}

async function handleFirstTo(interaction: ChatInputCommandInteraction, guildId: string) {
  const stat = interaction.options.getString("stat", true) as
    | "ace"
    | "thirty-bomb"
    | "win-streak";
  const scope = interaction.options.getString("scope", true) as "guild" | "list";
  const playersRaw = interaction.options.getString("players");
  const threshold = interaction.options.getInteger("threshold");

  if (stat === "win-streak" && (threshold === null || threshold < 2)) {
    await interaction.editReply(
      "`win-streak` needs a `threshold` of at least 2 — how many wins in a row?",
    );
    return;
  }

  const tracked = new Set(getTrackedPlayers(guildId));
  if (tracked.size === 0) {
    await interaction.editReply(
      "No tracked players in this server yet — add some with `/track` first.",
    );
    return;
  }

  // Resolve the player list (scope=list only). Mentioned users must
  // have linked Steam accounts AND be tracked here — otherwise the
  // market would reference someone the CS watcher ignores.
  let steamIds: string[] | undefined;
  const labels: string[] = [];
  if (scope === "list") {
    if (!playersRaw || playersRaw.trim().length === 0) {
      await interaction.editReply(
        "`scope=list` needs a `players` option — @mention the shortlist.",
      );
      return;
    }
    const discordIds = parsePlayerMentions(playersRaw);
    if (discordIds.length === 0) {
      await interaction.editReply(
        "Couldn't parse any @mentions from `players`. Mention each player directly.",
      );
      return;
    }
    steamIds = [];
    const notLinked: string[] = [];
    const notTracked: string[] = [];
    for (const discordId of discordIds) {
      const steamId = getSteamId(discordId);
      if (!steamId) {
        notLinked.push(`<@${discordId}>`);
        continue;
      }
      if (!tracked.has(steamId)) {
        notTracked.push(`<@${discordId}>`);
        continue;
      }
      if (!steamIds.includes(steamId)) {
        steamIds.push(steamId);
        labels.push(labelForSteamId(steamId));
      }
    }
    if (notLinked.length > 0) {
      await interaction.editReply(
        `These players haven't linked their Steam: ${notLinked.join(", ")}. Ask them to run \`/link\`.`,
      );
      return;
    }
    if (notTracked.length > 0) {
      await interaction.editReply(
        `These players aren't tracked here: ${notTracked.join(", ")}. Add them with \`/track\`.`,
      );
      return;
    }
    if (steamIds.length === 0) {
      await interaction.editReply(
        "None of the mentioned players are tracked in this server.",
      );
      return;
    }
  }

  // Question text — tuned to feel natural in British English.
  const question = (() => {
    if (scope === "guild") {
      if (stat === "ace") {
        return "First tracked player to land an ace in this server";
      }
      if (stat === "thirty-bomb") {
        return "First tracked player to drop 30+ kills in a match";
      }
      return `First tracked player to win ${threshold} in a row`;
    }
    // scope = list
    const list =
      labels.length <= 3
        ? labels.join(", ")
        : `${labels.slice(0, 3).join(", ")} + ${labels.length - 3} more`;
    if (stat === "ace") return `First of {${list}} to land an ace`;
    if (stat === "thirty-bomb") return `First of {${list}} to go 30+ in a match`;
    return `First of {${list}} to win ${threshold} in a row`;
  })();

  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const id = createBet(guildId, interaction.user.id, question, expiresAt, {
    resolverKind: "cs:first-to",
    resolverArgs: {
      stat,
      scope,
      guildId,
      ...(steamIds ? { steamIds } : {}),
      ...(stat === "win-streak" && threshold !== null ? { threshold } : {}),
    },
    initialProb: probPct / 100,
    stake: interaction.options.getInteger("stake") ?? DEFAULT_CREATOR_STAKE,
  });
  await interaction.editReply(renderMarketView(id));
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

async function handleList(interaction: ChatInputCommandInteraction, guildId: string) {
  const open = listOpenBets(guildId);
  if (!open.length) {
    await interaction.editReply("No open markets. Start one with `/market create`.");
    return;
  }
  const options = open.slice(0, 25).map((b) => {
    const allWagers = getWagersForBet(b.id);
    let yes = 0;
    let no = 0;
    for (const w of allWagers) {
      if (w.outcome === "yes") yes += w.amount;
      else no += w.amount;
    }
    const total = yes + no;
    const q = b.question.length > 90 ? `${b.question.slice(0, 89)}\u2026` : b.question;
    const pctStr =
      b.b > 0 ? ` · ${Math.round(lmsrProb(b.qYes, b.qNo, b.b) * 100)}% YES` : "";
    return new StringSelectMenuOptionBuilder()
      .setLabel(`#${b.id} ${q}`)
      .setValue(String(b.id))
      .setDescription(`${yes} yes / ${no} no (${total} total)${pctStr}`);
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId("market:pick")
    .setPlaceholder("Pick a market to view…")
    .addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle("Open markets")
    .setDescription(`${open.length} open. Pick one to bet on or resolve.`);
  await interaction.editReply({ embeds: [e], components: [row] });
}

export const execute = wrapCommand(async (interaction) => {
  const sub = interaction.options.getSubcommand(true);
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  if (sub === "create") await handleCreate(interaction, guildId);
  else if (sub === "cs-next-match") await handleCsNextMatch(interaction, guildId);
  else if (sub === "cs-rating-goal") await handleCsRatingGoal(interaction, guildId);
  else if (sub === "cs-premier") await handleCsPremier(interaction, guildId);
  else if (sub === "first-to") await handleFirstTo(interaction, guildId);
  else if (sub === "mirror") await handleMirror(interaction, guildId);
  else if (sub === "stock") await handleStock(interaction, guildId);
  else if (sub === "crypto") await handleCrypto(interaction, guildId);
  else if (sub === "challenge") await handleChallenge(interaction, guildId);
  else if (sub === "config") await handleConfig(interaction, guildId);
  else if (sub === "list") await handleList(interaction, guildId);
  else await interaction.editReply(`Unknown subcommand: ${sub}`);
});

// ── Component handlers ───────────────────────────────────────────────
//
// customId grammar:
//   market:wager:<id>:<outcome>             — button, opens amount modal
//   market:modal:<id>:<outcome>             — modal submit, places position
//   market:resolve:<id>:<outcome>           — button, creator-only resolve
//   market:pick                             — select menu, posts market view
//   market:counter:<id>:<side>:<amount>     — activity ping counter button
registerComponent("market", async (interaction) => {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "pick" && interaction.isStringSelectMenu()) {
    const betId = Number(interaction.values[0]);
    if (!Number.isInteger(betId)) return;
    await interaction.reply({ ...renderMarketView(betId) });
    return;
  }

  if (action === "wager" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const outcome = parts[3] as Outcome;
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.reply({
        content: "This market is closed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const balance = getBalance(interaction.user.id, interaction.guildId!);
    // Show current odds in the modal title so the user knows what they're
    // stepping into before they commit an amount.
    const oddsStr =
      bet.b > 0 ? ` — ${Math.round(lmsrProb(bet.qYes, bet.qNo, bet.b) * 100)}% YES` : "";
    const modal = new ModalBuilder()
      .setCustomId(`market:modal:${betId}:${outcome}`)
      .setTitle(`Bet ${outcome.toUpperCase()}${oddsStr} #${betId}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel(`${CURRENCY.label} to stake (you have ${balance})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("e.g. 10")
            .setMinLength(1)
            .setMaxLength(6),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (action === "modal" && interaction.isModalSubmit()) {
    const betId = Number(parts[2]);
    const outcome = parts[3] as Outcome;
    const raw = interaction.fields.getTextInputValue("amount").trim();
    const amount = Number(raw);
    if (!Number.isInteger(amount) || amount <= 0) {
      await interaction.reply({
        content: `\`${raw}\` isn't a positive whole number.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Snapshot odds BEFORE placing (for the confirmation message).
    const betBefore = getBet(betId);
    const expectedPayout =
      betBefore?.b && betBefore.b > 0
        ? lmsrExpectedPayout(
            betBefore.qYes,
            betBefore.qNo,
            betBefore.b,
            amount,
            outcome,
            LMSR_RAKE,
          )
        : null;

    // Check before placing: is this the first wager of this outcome?
    const isFirstOfOutcome =
      betBefore?.status === "open" &&
      !getWagersForBet(betId).some((w) => w.outcome === outcome);

    try {
      placeWager(betId, interaction.user.id, outcome, amount);
    } catch (err) {
      await interaction.reply({
        content: (err as Error).message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const balance = getBalance(interaction.user.id, interaction.guildId!);
    if (interaction.isFromMessage()) {
      await interaction.update(renderMarketView(betId));
    }

    const payoutStr =
      expectedPayout !== null
        ? ` → **~${expectedPayout}** shekels if ${outcome.toUpperCase()} resolves`
        : "";
    await interaction.followUp({
      content: `Staked **${amount}** on **${outcome}**${payoutStr}. Balance: **${balance}**.`,
      flags: MessageFlags.Ephemeral,
    });

    // Activity ping: first YES or NO on this market.
    if (isFirstOfOutcome && betBefore?.channelId && betBefore.guildId) {
      if (getActivityPings(betBefore.guildId)) {
        const oppSide = outcome === "yes" ? "no" : "yes";
        const counterRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(`market:counter:${betId}:${outcome}:${amount}`, {
            style: ButtonStyle.Secondary,
            label: `Counter ${oppSide.toUpperCase()}`,
            emoji: "⚔️",
          }),
        );
        try {
          const ch = await interaction.client.channels.fetch(betBefore.channelId);
          if (ch?.isTextBased() && "send" in ch) {
            await ch.send({
              content: `<@${interaction.user.id}> took the first **${outcome.toUpperCase()}** on market #${betId} — who's countering?`,
              components: [counterRow],
            });
          }
        } catch (err) {
          log.warn({ err, betId }, "Couldn't send activity ping");
        }
      }
    }
    return;
  }

  if (action === "counter" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const firstSide = parts[3] as Outcome;
    const firstAmount = Number(parts[4]);
    const oppSide: Outcome = firstSide === "yes" ? "no" : "yes";
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.reply({
        content: "This market is closed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const balance = getBalance(interaction.user.id, interaction.guildId!);
    const modal = new ModalBuilder()
      .setCustomId(`market:modal:${betId}:${oppSide}`)
      .setTitle(`Counter ${oppSide.toUpperCase()} #${betId}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel(`${CURRENCY.label} to stake (you have ${balance})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(Number.isFinite(firstAmount) ? String(firstAmount) : "")
            .setPlaceholder("e.g. 10")
            .setMinLength(1)
            .setMaxLength(6),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (action === "resolve" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const outcome = parts[3] as Outcome;
    const bet = getBet(betId);
    if (!bet) {
      await interaction.reply({
        content: `Market #${betId} doesn't exist.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (bet.resolverKind) {
      await interaction.reply({
        content: "This market auto-resolves — admins can step in via the dispute flow.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (bet.creatorDiscordId !== interaction.user.id) {
      await interaction.reply({
        content: "Only the creator can resolve this market.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (bet.status !== "open") {
      await interaction.reply({
        content: `Market #${betId} is already ${bet.status}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      resolveBet(betId, outcome);
    } catch (err) {
      await interaction.reply({
        content: (err as Error).message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.update(renderMarketView(betId));
    return;
  }

  if (action === "sell" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.reply({
        content: "This market is closed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (bet.creatorDiscordId === interaction.user.id && bet.creatorStake > 0) {
      await interaction.reply({
        content: "You're the LP — your stake settles at resolution, no position to sell.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const wager = getWagersForBet(betId).find((w) => w.discordId === interaction.user.id);
    if (!wager) {
      await interaction.reply({
        content: "You don't have a position on this market yet.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const heldStr = wager.shares.toFixed(3);
    const fullRefund = lmsrSellRefund(
      bet.qYes,
      bet.qNo,
      bet.b,
      wager.shares,
      wager.outcome,
      LMSR_RAKE,
    );
    const modal = new ModalBuilder()
      .setCustomId(`market:sellmodal:${betId}`)
      .setTitle(`Sell ${wager.outcome.toUpperCase()} #${betId}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("shares")
            .setLabel(`Shares (you hold ${heldStr} ≈ ${fullRefund} back)`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(heldStr)
            .setMinLength(1)
            .setMaxLength(12),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (action === "sellmodal" && interaction.isModalSubmit()) {
    const betId = Number(parts[2]);
    const raw = interaction.fields.getTextInputValue("shares").trim();
    const shares = Number(raw);
    if (!Number.isFinite(shares) || shares <= 0) {
      await interaction.reply({
        content: `\`${raw}\` isn't a positive number.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    let result: { refund: number; sharesRemaining: number };
    try {
      result = sellWager(betId, interaction.user.id, shares);
    } catch (err) {
      await interaction.reply({
        content: (err as Error).message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.isFromMessage()) {
      await interaction.update(renderMarketView(betId));
    }
    const balance = getBalance(interaction.user.id, interaction.guildId!);
    const tail =
      result.sharesRemaining > 0
        ? `Remaining position: **${result.sharesRemaining.toFixed(3)}** shares.`
        : "Fully exited.";
    await interaction.followUp({
      content: `Sold for **${result.refund}** shekels. ${tail} Balance: **${balance}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "extend" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.reply({
        content: "This market is closed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (
      bet.creatorDiscordId !== interaction.user.id &&
      !interaction.memberPermissions?.has("ManageGuild")
    ) {
      await interaction.reply({
        content: "Only the creator or an admin can extend this market.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const options = MARKET_DURATIONS.map((d) =>
      new StringSelectMenuOptionBuilder().setLabel(d.name).setValue(d.name),
    );
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`market:extendpick:${betId}`)
      .setPlaceholder("Extend deadline by…")
      .addOptions(options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await interaction.reply({
      content: "Pick how far to push the deadline:",
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "extendpick" && interaction.isStringSelectMenu()) {
    const betId = Number(parts[2]);
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.update({ content: "This market is closed.", components: [] });
      return;
    }
    const durationName = interaction.values[0];
    const hours =
      MARKET_DURATIONS.find((d) => d.name === durationName)?.hours ??
      DEFAULT_EXPIRY_HOURS;
    const newExpiry = expiryIso(hours);
    try {
      extendBet(betId, newExpiry);
    } catch (err) {
      await interaction.update({ content: (err as Error).message, components: [] });
      return;
    }
    // Dismiss the ephemeral picker.
    await interaction.update({
      content: `Deadline pushed forward by **${durationName}**.`,
      components: [],
    });
    // Best-effort: edit the original market message so the new expiry timestamp
    // shows immediately without anyone else needing to interact with it.
    if (bet.channelId && bet.messageId) {
      try {
        const channel = await interaction.client.channels.fetch(bet.channelId);
        if (channel?.isTextBased()) {
          const msg = await channel.messages.fetch(bet.messageId);
          await msg.edit(renderMarketView(betId));
        }
      } catch (err) {
        log.warn({ err, betId }, "Couldn't edit market message after extend");
      }
    }
    return;
  }

  log.warn({ customId: interaction.customId }, "Unhandled market action");
});

// Re-exported so the expiry watcher can drive auto-cancel without
// routing through the component dispatcher.
export { cancelBet };
