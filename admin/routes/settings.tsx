/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { bets } from "../../src/betting/schema.js";
import {
  clearNotifyChannel,
  getActivityPings,
  getNotifyChannel,
  setActivityPings,
  setNotifyChannel,
} from "../../src/store.js";
import { adminConfig } from "../config.js";
import { db, logAdminAction } from "../db.js";
import { fetchGuildChannels } from "../ipc.js";
import type { Env } from "../middleware.js";
import { Btn, Card, ChannelPicker, H1, H2, HiddenCsrf } from "../views/components.js";
import { page } from "../views/layout.js";

const router = new Hono<Env>();

// ── Guild list (index) ────────────────────────────────────────────────

router.get("/", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");

  // Known guilds = admin's configured one + anything we have bets under.
  const betGuilds = db
    .select({ guildId: bets.guildId })
    .from(bets)
    .groupBy(bets.guildId)
    .all()
    .map((r) => r.guildId);
  const known = Array.from(new Set([adminConfig.guildId, ...betGuilds])).sort();

  return c.html(
    page(
      "Settings",
      user.username,
      csrf,
      <>
        <H1>Settings</H1>
        <Card>
          <H2>Guilds</H2>
          <p class="text-xs text-gray-500 mb-3">
            Per-guild notification + activity config. Pick a guild to edit.
          </p>
          <ul class="space-y-1 text-sm">
            {known.map((g) => (
              <li>
                <a
                  href={`/settings/${g}`}
                  class="text-pink-400 hover:text-pink-300 font-mono text-xs"
                >
                  {g}
                </a>
                {g === adminConfig.guildId && (
                  <span class="ml-2 text-gray-500 text-xs">(admin guild)</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </>,
    ),
  );
});

// ── Single-guild settings ────────────────────────────────────────────

router.get("/:guildId", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");
  const guildId = c.req.param("guildId");
  const flash = c.req.query("flash");

  const currentChannel = getNotifyChannel(guildId);
  const activityOn = getActivityPings(guildId);
  const channels = await fetchGuildChannels(guildId);

  return c.html(
    page(
      "Guild settings",
      user.username,
      csrf,
      <>
        <div class="flex items-center gap-3 mb-4">
          <a href="/settings" class="text-gray-400 hover:text-white text-sm">
            ← Settings
          </a>
          <H1>Guild {guildId}</H1>
        </div>
        <Card>
          <H2>Notification channel</H2>
          <p class="text-xs text-gray-500 mb-3">
            Where match alerts, weekly leaderboards, and default market posts land.
            Mirrors the `/setchannel` slash command.
          </p>
          <form method="post" action={`/settings/${guildId}/channel`} class="space-y-3">
            <HiddenCsrf token={csrf} />
            <ChannelPicker channels={channels} current={currentChannel} />
            <div class="flex gap-2">
              <Btn label="Save channel" />
            </div>
          </form>
        </Card>

        <Card class="mt-4">
          <H2>Activity pings</H2>
          <p class="text-xs text-gray-500 mb-3">
            Mirrors `/market config activity:on|off` — toggles the first-YES / first-NO
            ping + Counter button on new markets.
          </p>
          <form
            method="post"
            action={`/settings/${guildId}/activity`}
            class="flex gap-2 items-center"
          >
            <HiddenCsrf token={csrf} />
            <label class="text-sm text-gray-300 flex items-center gap-2">
              <input
                type="checkbox"
                name="enabled"
                value="1"
                checked={activityOn}
                class="accent-pink-600"
              />
              Activity pings enabled
            </label>
            <Btn label="Save" variant="ghost" />
          </form>
        </Card>
      </>,
      flash ?? undefined,
    ),
  );
});

router.post("/:guildId/channel", async (c) => {
  const user = c.get("user");
  const guildId = c.req.param("guildId");
  const body = await c.req.parseBody();
  const raw = ((body.notify_channel_id as string) ?? "").trim();

  if (raw && !/^\d{15,25}$/.test(raw)) {
    return c.redirect(
      `/settings/${guildId}?flash=${encodeURIComponent("Invalid channel ID.")}`,
    );
  }
  if (raw) setNotifyChannel(guildId, raw);
  else clearNotifyChannel(guildId);
  logAdminAction(user.discordId, "guild-config-set", `guild:${guildId}`, {
    guildId,
    notifyChannelId: raw || null,
  });
  return c.redirect(`/settings/${guildId}?flash=Notification+channel+saved.`);
});

router.post("/:guildId/activity", async (c) => {
  const user = c.get("user");
  const guildId = c.req.param("guildId");
  const body = await c.req.parseBody();
  const enabled = body.enabled === "1";
  setActivityPings(guildId, enabled);
  logAdminAction(user.discordId, "guild-config-set", `guild:${guildId}`, {
    guildId,
    activityPings: enabled,
  });
  return c.redirect(`/settings/${guildId}?flash=Activity+pings+updated.`);
});

export default router;
