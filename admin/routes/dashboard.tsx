/** @jsxImportSource hono/jsx */
import { and, count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { accounts, bets, disputes } from "../../src/betting/schema.js";
import { db, recentAdminActions } from "../db.js";
import type { Env } from "../middleware.js";
import {
  Badge,
  Card,
  fmtDate,
  H1,
  H2,
  Stat,
  Table,
  Td,
  Tr,
  truncate,
} from "../views/components.js";
import { page } from "../views/layout.js";

const router = new Hono<Env>();

// Per-guild economy summary over the trailing window. Created = net mint
// (grants, match bonuses, creator-trader bonuses, plus positive admin
// adjustments). Destroyed = net burn (dispute-fee forfeits + negative
// admin adjustments). Trader net = bet-payout − bet-placed (positive
// means traders extracted value from creators; negative means the
// house / creators came out ahead).
type EconRow = {
  guild_id: string;
  created: number;
  destroyed: number;
  trader_net: number;
};

function getEconPerGuild(windowDays = 30): EconRow[] {
  return db.all<EconRow>(sql`
    SELECT
      guild_id,
      SUM(CASE
        WHEN reason IN ('starting-grant','match','creator-trader-bonus')
          THEN delta
        WHEN reason LIKE 'admin:%' AND delta > 0 THEN delta
        ELSE 0
      END) AS created,
      SUM(CASE
        WHEN reason = 'dispute-fee' THEN delta
        WHEN reason LIKE 'admin:%' AND delta < 0 THEN delta
        ELSE 0
      END) AS destroyed,
      SUM(CASE
        WHEN reason IN ('bet-payout','bet-placed') THEN delta
        ELSE 0
      END) AS trader_net
    FROM ledger
    WHERE at >= datetime('now', ${`-${windowDays} days`})
    GROUP BY guild_id
    ORDER BY guild_id
  `);
}

// Daily reason breakdown for one guild. One row per (day, reason).
type DailyRow = { day: string; reason: string; delta: number };

function getGuildDaily(guildId: string, windowDays = 30): DailyRow[] {
  return db.all<DailyRow>(sql`
    SELECT date(at) AS day, reason, SUM(delta) AS delta
    FROM ledger
    WHERE guild_id = ${guildId}
      AND at >= date('now', ${`-${windowDays} days`})
    GROUP BY day, reason
    ORDER BY day
  `);
}

function listEconGuilds(): string[] {
  const rows = db.all<{ guild_id: string }>(sql`
    SELECT DISTINCT guild_id FROM ledger ORDER BY guild_id
  `);
  return rows.map((r) => r.guild_id);
}

// Deterministic HSL hue per reason so colours stay stable across renders.
function hueFor(reason: string): number {
  let h = 0;
  for (let i = 0; i < reason.length; i++) {
    h = (h * 31 + reason.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
function colourFor(reason: string): string {
  return `hsl(${hueFor(reason)} 65% 55%)`;
}

function fmtSigned(n: number): string {
  if (!n) return "0";
  return n > 0 ? `+${n}` : String(n);
}

// ── Stacked reasons chart ─────────────────────────────────────────────
// Pure SVG. One column per day across the window; positive deltas stack
// upward from the zero line, negatives stack downward. Y-axis auto-
// scales to the larger of |+max| / |−max| so both directions share one
// unit. Matches PriceChart's styling (gray grid, 10px labels).
function ReasonsStackChart({
  rows,
  windowDays,
  nowMs,
}: {
  rows: DailyRow[];
  windowDays: number;
  nowMs: number;
}) {
  const W = 700;
  const H = 240;
  const P = { top: 16, right: 16, bottom: 32, left: 48 };
  const plotW = W - P.left - P.right;
  const plotH = H - P.top - P.bottom;

  // Build list of days (UTC, YYYY-MM-DD) from (today - windowDays + 1) to today.
  const days: string[] = [];
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }

  // Group rows by day.
  const byDay = new Map<string, DailyRow[]>();
  for (const r of rows) {
    const arr = byDay.get(r.day) ?? [];
    arr.push(r);
    byDay.set(r.day, arr);
  }

  // Day totals split into positive / negative segments.
  let maxPos = 0;
  let maxNeg = 0;
  for (const day of days) {
    const dr = byDay.get(day) ?? [];
    let pos = 0;
    let neg = 0;
    for (const r of dr) {
      if (r.delta >= 0) pos += r.delta;
      else neg += r.delta;
    }
    if (pos > maxPos) maxPos = pos;
    if (neg < maxNeg) maxNeg = neg;
  }
  const yMax = Math.max(maxPos, -maxNeg, 1);
  const zeroY = P.top + plotH / 2;
  const unit = plotH / 2 / yMax;

  const colW = plotW / days.length;
  const barW = Math.max(2, colW - 2);

  const gridVals = [yMax, yMax / 2, 0, -yMax / 2, -yMax];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      class="w-full h-auto"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Ledger reasons by day</title>
      <rect x={0} y={0} width={W} height={H} fill="transparent" />
      {gridVals.map((g) => {
        const y = zeroY - g * unit;
        return (
          <g>
            <line
              x1={P.left}
              x2={W - P.right}
              y1={y}
              y2={y}
              stroke="#374151"
              stroke-dasharray={g === 0 ? "0" : "2 3"}
            />
            <text
              x={P.left - 6}
              y={y + 3}
              font-size="10"
              fill="#9ca3af"
              text-anchor="end"
            >
              {Math.round(g)}
            </text>
          </g>
        );
      })}
      {days.map((day, i) => {
        const dr = (byDay.get(day) ?? []).slice().sort((a, b) => b.delta - a.delta);
        const x = P.left + i * colW + (colW - barW) / 2;
        let posCursor = zeroY;
        let negCursor = zeroY;
        const segs: Child[] = [];
        for (const r of dr) {
          if (r.delta === 0) continue;
          const h = Math.abs(r.delta) * unit;
          if (r.delta > 0) {
            posCursor -= h;
            segs.push(
              <rect
                x={x}
                y={posCursor}
                width={barW}
                height={h}
                fill={colourFor(r.reason)}
              >
                <title>
                  {day} · {r.reason} · {fmtSigned(r.delta)}
                </title>
              </rect>,
            );
          } else {
            segs.push(
              <rect
                x={x}
                y={negCursor}
                width={barW}
                height={h}
                fill={colourFor(r.reason)}
              >
                <title>
                  {day} · {r.reason} · {fmtSigned(r.delta)}
                </title>
              </rect>,
            );
            negCursor += h;
          }
        }
        return <g>{segs}</g>;
      })}
      {days.map((day, i) => {
        if (i % 5 !== 0 && i !== days.length - 1) return null;
        const x = P.left + i * colW + colW / 2;
        return (
          <text x={x} y={H - 10} font-size="10" fill="#9ca3af" text-anchor="middle">
            {day.slice(5)}
          </text>
        );
      })}
    </svg>
  );
}

router.get("/", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");

  const [openMarkets] = db
    .select({ n: count() })
    .from(bets)
    .where(eq(bets.status, "open"))
    .all();

  const [openDisputes] = db
    .select({ n: count() })
    .from(disputes)
    .where(eq(disputes.status, "open"))
    .all();

  const openDisputeList = db
    .select({
      id: disputes.id,
      betId: disputes.betId,
      question: bets.question,
      opener: disputes.openerDiscordId,
      openedAt: disputes.openedAt,
    })
    .from(disputes)
    .leftJoin(bets, eq(disputes.betId, bets.id))
    .where(eq(disputes.status, "open"))
    .orderBy(desc(disputes.openedAt))
    .limit(10)
    .all();

  const recentActivity = db
    .select({
      id: bets.id,
      question: bets.question,
      status: bets.status,
      winningOutcome: bets.winningOutcome,
      resolvedAt: bets.resolvedAt,
    })
    .from(bets)
    .where(and(sql`status != 'open'`, sql`resolved_at IS NOT NULL`))
    .orderBy(desc(bets.resolvedAt))
    .limit(10)
    .all();

  const topBalances = db
    .select({
      discordId: accounts.discordId,
      guildId: accounts.guildId,
      balance: accounts.balance,
    })
    .from(accounts)
    .orderBy(desc(accounts.balance))
    .limit(5)
    .all();

  const adminLog = recentAdminActions(10);

  // Economy dashboard data.
  const WINDOW_DAYS = 30;
  const econRows = getEconPerGuild(WINDOW_DAYS);
  const econGuilds = listEconGuilds();
  const requestedGuild = c.req.query("econ_guild") ?? "";
  const econGuild =
    requestedGuild && econGuilds.includes(requestedGuild)
      ? requestedGuild
      : (econGuilds[0] ?? "");
  const dailyRows = econGuild ? getGuildDaily(econGuild, WINDOW_DAYS) : [];
  const legendTotals = new Map<string, number>();
  for (const r of dailyRows) {
    legendTotals.set(r.reason, (legendTotals.get(r.reason) ?? 0) + r.delta);
  }
  const legend = [...legendTotals.entries()].sort(
    (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
  );

  // Preserve other query params when switching guild via the picker.
  const otherParams = new URLSearchParams();
  for (const [k, v] of Object.entries(c.req.query())) {
    if (k !== "econ_guild") otherParams.set(k, v);
  }

  return c.html(
    page(
      "Dashboard",
      user.username,
      csrf,
      <>
        <H1>Dashboard</H1>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <Card>
            <Stat label="Open markets" value={openMarkets?.n ?? 0} />
          </Card>
          <Card class={openDisputes?.n ? "border-yellow-700" : ""}>
            <Stat label="Open disputes" value={openDisputes?.n ?? 0} />
          </Card>
        </div>

        <Card class="mb-6">
          <div class="flex items-baseline gap-2 mb-3">
            <H2>Money created vs earned per guild</H2>
            <span class="text-xs text-gray-500">30d</span>
          </div>
          {econRows.length === 0 ? (
            <div class="text-sm text-gray-500">No ledger activity in window.</div>
          ) : (
            <Table headers={["Guild", "Created", "Destroyed", "Trader net"]}>
              {econRows.map((r) => (
                <Tr>
                  <Td mono>{r.guild_id || "(none)"}</Td>
                  <Td>
                    <span
                      class={
                        r.created > 0
                          ? "text-green-400"
                          : r.created < 0
                            ? "text-red-400"
                            : "text-gray-400"
                      }
                    >
                      {fmtSigned(r.created)}
                    </span>
                  </Td>
                  <Td>
                    <span
                      class={
                        r.destroyed < 0
                          ? "text-red-400"
                          : r.destroyed > 0
                            ? "text-green-400"
                            : "text-gray-400"
                      }
                    >
                      {fmtSigned(r.destroyed)}
                    </span>
                  </Td>
                  <Td>
                    <span
                      class={
                        r.trader_net > 0
                          ? "text-green-400"
                          : r.trader_net < 0
                            ? "text-red-400"
                            : "text-gray-400"
                      }
                    >
                      {fmtSigned(r.trader_net)}
                    </span>
                  </Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>

        {openDisputeList.length > 0 && (
          <Card class="mb-6">
            <H2>Open disputes — needs action</H2>
            <Table headers={["#", "Market", "Opener", "Opened"]}>
              {openDisputeList.map((d) => (
                <Tr>
                  <Td>
                    <a
                      href={`/disputes/${d.id}`}
                      class="text-pink-400 hover:text-pink-300"
                    >
                      #{d.id}
                    </a>
                  </Td>
                  <Td>
                    <a
                      href={`/markets/${d.betId}`}
                      class="text-gray-300 hover:text-white"
                    >
                      #{d.betId} {truncate(d.question ?? "", 50)}
                    </a>
                  </Td>
                  <Td mono>{d.opener}</Td>
                  <Td>{fmtDate(d.openedAt)}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
        )}

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div class="md:col-span-2">
            <Card>
              <H2>Recent market activity</H2>
              <Table headers={["#", "Question", "Status", "Resolved"]}>
                {recentActivity.map((b) => (
                  <Tr>
                    <Td>
                      <a
                        href={`/markets/${b.id}`}
                        class="text-pink-400 hover:text-pink-300"
                      >
                        #{b.id}
                      </a>
                    </Td>
                    <Td>{truncate(b.question, 55)}</Td>
                    <Td>
                      <Badge status={b.status} />
                      {b.winningOutcome && (
                        <span class="ml-1 text-xs text-gray-400">
                          ({b.winningOutcome})
                        </span>
                      )}
                    </Td>
                    <Td>{fmtDate(b.resolvedAt)}</Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          </div>

          <div class="space-y-4">
            <Card>
              <H2>Top balances</H2>
              {topBalances.map((a, i) => (
                <div class="flex justify-between py-1 text-sm border-b border-gray-800 last:border-0">
                  <a
                    href={`/users/${a.guildId}/${a.discordId}`}
                    class="text-gray-300 hover:text-white font-mono text-xs truncate max-w-[140px]"
                  >
                    #{i + 1} {a.discordId}
                  </a>
                  <span class="font-bold ml-2">{a.balance}</span>
                </div>
              ))}
            </Card>

            {adminLog.length > 0 && (
              <Card>
                <H2>Recent admin actions</H2>
                {adminLog.map((a) => (
                  <div class="text-xs py-1 border-b border-gray-800 last:border-0">
                    <span class="text-gray-400">{fmtDate(a.at)}</span>{" "}
                    <span class="text-pink-300">{a.action}</span>{" "}
                    <span class="text-gray-300">{a.target}</span>
                  </div>
                ))}
              </Card>
            )}
          </div>
        </div>

        <Card>
          <div class="flex flex-wrap items-baseline gap-3 mb-3">
            <H2>Ledger reasons over time</H2>
            <span class="text-xs text-gray-500">30d</span>
            {econGuilds.length > 0 && (
              <form method="get" class="ml-auto flex items-center gap-2 text-sm">
                {[...otherParams.entries()].map(([k, v]) => (
                  <input type="hidden" name={k} value={v} />
                ))}
                <label for="econ_guild" class="text-gray-400 text-xs">
                  Guild
                </label>
                <select
                  id="econ_guild"
                  name="econ_guild"
                  onchange="this.form.submit()"
                  class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 font-mono text-xs"
                >
                  {econGuilds.map((g) => (
                    <option value={g} selected={g === econGuild}>
                      {g || "(none)"}
                    </option>
                  ))}
                </select>
              </form>
            )}
          </div>
          {econGuild && dailyRows.length > 0 ? (
            <>
              <ReasonsStackChart
                rows={dailyRows}
                windowDays={WINDOW_DAYS}
                nowMs={Date.now()}
              />
              <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {legend.map(([reason, total]) => (
                  <div class="flex items-center gap-1.5">
                    <span
                      class="inline-block w-3 h-3 rounded-sm"
                      style={`background:${colourFor(reason)}`}
                    />
                    <span class="text-gray-300">{reason}</span>
                    <span class={total >= 0 ? "text-green-400" : "text-red-400"}>
                      {fmtSigned(total)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div class="text-sm text-gray-500">No ledger activity in window.</div>
          )}
        </Card>
      </>,
    ),
  );
});

export default router;
