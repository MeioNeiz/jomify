/** @jsxImportSource hono/jsx */
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { accounts, bets, disputes, ledger, wagers } from "../../src/betting/schema.js";
import { adjustBalance } from "../../src/betting/store/accounts.js";
import { getCreatorStats } from "../../src/betting/store/bets.js";
import { db, logAdminAction } from "../db.js";
import type { Env } from "../middleware.js";
import {
  Badge,
  Btn,
  Card,
  fmtDate,
  H1,
  H2,
  HiddenCsrf,
  Pagination,
  Table,
  Td,
  Tr,
} from "../views/components.js";
import { page } from "../views/layout.js";

const router = new Hono<Env>();
const PAGE_SIZE = 25;
const LEDGER_PAGE = 20;

router.get("/", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");
  const page_ = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const offset = (page_ - 1) * PAGE_SIZE;

  const [{ total }] = db.select({ total: count() }).from(accounts).all();

  const rows = db
    .select({
      discordId: accounts.discordId,
      guildId: accounts.guildId,
      balance: accounts.balance,
    })
    .from(accounts)
    .orderBy(desc(accounts.balance))
    .limit(PAGE_SIZE)
    .offset(offset)
    .all();

  const wagerCounts = db
    .select({ discordId: wagers.discordId, n: count() })
    .from(wagers)
    .groupBy(wagers.discordId)
    .all()
    .reduce<Record<string, number>>((m, r) => {
      m[r.discordId] = r.n;
      return m;
    }, {});

  const disputesCounts = db
    .select({ discordId: disputes.openerDiscordId, n: count() })
    .from(disputes)
    .groupBy(disputes.openerDiscordId)
    .all()
    .reduce<Record<string, number>>((m, r) => {
      m[r.discordId] = r.n;
      return m;
    }, {});

  // Creator-LP net P&L per (guild, user) — one aggregate per row in the
  // page. Running this as a subquery-free JS map keeps the query flat;
  // page size is small enough that it won't hurt.
  const lpStats = rows.reduce<Record<string, { net: number; markets: number }>>(
    (acc, r) => {
      const s = getCreatorStats(r.discordId, r.guildId);
      acc[`${r.guildId}:${r.discordId}`] = {
        net: s.netPnL,
        markets: s.marketsCreated,
      };
      return acc;
    },
    {},
  );

  return c.html(
    page(
      "Users",
      user.username,
      csrf,
      <>
        <H1>Users</H1>
        <Card>
          <Table
            headers={[
              "Discord ID",
              "Guild ID",
              "Balance",
              "Wagers",
              "LP markets",
              "LP P&L",
              "Disputes",
              "",
            ]}
          >
            {rows.map((a) => {
              const lp = lpStats[`${a.guildId}:${a.discordId}`];
              const pnl = lp?.net ?? 0;
              const pnlClass =
                pnl > 0 ? "text-green-400" : pnl < 0 ? "text-red-400" : "text-gray-500";
              return (
                <Tr>
                  <Td>
                    <a
                      href={`/users/${a.guildId}/${a.discordId}`}
                      class="font-mono text-xs text-pink-400 hover:text-pink-300"
                    >
                      {a.discordId}
                    </a>
                  </Td>
                  <Td>
                    <span class="font-mono text-xs text-gray-400">{a.guildId}</span>
                  </Td>
                  <Td>
                    <span class="font-bold">{a.balance}</span>
                  </Td>
                  <Td>{wagerCounts[a.discordId] ?? 0}</Td>
                  <Td>{lp?.markets ?? 0}</Td>
                  <Td>
                    <span class={pnlClass}>
                      {pnl > 0 ? "+" : ""}
                      {pnl}
                    </span>
                  </Td>
                  <Td>{disputesCounts[a.discordId] ?? 0}</Td>
                  <Td>
                    <a
                      href={`/users/${a.guildId}/${a.discordId}`}
                      class="text-xs text-gray-400 hover:text-white"
                    >
                      Detail →
                    </a>
                  </Td>
                </Tr>
              );
            })}
          </Table>
          <Pagination page={page_} total={total} pageSize={PAGE_SIZE} url="/users" />
        </Card>
      </>,
    ),
  );
});

router.get("/:guildId/:discordId", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");
  const discordId = c.req.param("discordId");
  const guildId = c.req.param("guildId");
  const lPage = Math.max(1, parseInt(c.req.query("lpage") ?? "1", 10));
  const flash = c.req.query("flash");

  const acct = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
    .get();
  if (!acct) return c.text("User not found", 404);

  const lOffset = (lPage - 1) * LEDGER_PAGE;
  const [{ lTotal }] = db
    .select({ lTotal: count() })
    .from(ledger)
    .where(and(eq(ledger.discordId, discordId), eq(ledger.guildId, guildId)))
    .all();

  const ledgerRows = db
    .select()
    .from(ledger)
    .where(and(eq(ledger.discordId, discordId), eq(ledger.guildId, guildId)))
    .orderBy(desc(ledger.at))
    .limit(LEDGER_PAGE)
    .offset(lOffset)
    .all();

  const openWagers = db
    .select({
      betId: wagers.betId,
      outcome: wagers.outcome,
      amount: wagers.amount,
      question: bets.question,
      status: bets.status,
      placedAt: wagers.placedAt,
    })
    .from(wagers)
    .leftJoin(bets, eq(wagers.betId, bets.id))
    .where(eq(wagers.discordId, discordId))
    .orderBy(desc(wagers.placedAt))
    .limit(20)
    .all();

  const userDisputes = db
    .select({
      id: disputes.id,
      betId: disputes.betId,
      status: disputes.status,
      finalAction: disputes.finalAction,
      openedAt: disputes.openedAt,
    })
    .from(disputes)
    .where(eq(disputes.openerDiscordId, discordId))
    .orderBy(desc(disputes.openedAt))
    .limit(10)
    .all();

  return c.html(
    page(
      `User ${discordId}`,
      user.username,
      csrf,
      <>
        <div class="flex items-center gap-3 mb-4">
          <a href="/users" class="text-gray-400 hover:text-white text-sm">
            ← Users
          </a>
          <H1>User</H1>
          <code class="text-pink-400 text-sm">{discordId}</code>
          <span class="text-gray-500 text-xs">guild {guildId}</span>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <Card>
            <H2>Balance</H2>
            <div class="text-4xl font-bold mb-1">{acct.balance}</div>
            <div class="text-xs text-gray-400">shekels</div>
          </Card>

          <Card class="md:col-span-2">
            <H2>Adjust balance</H2>
            <form
              method="post"
              action={`/users/${guildId}/${discordId}/adjust`}
              class="flex gap-2 items-end"
            >
              <HiddenCsrf token={csrf} />
              <div>
                <label for="delta" class="block text-xs text-gray-400 mb-1">
                  Delta (positive or negative)
                </label>
                <input
                  id="delta"
                  type="number"
                  name="delta"
                  required
                  class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-28 text-white"
                  placeholder="+/-"
                />
              </div>
              <div class="flex-1">
                <label for="reason" class="block text-xs text-gray-400 mb-1">
                  Reason (required)
                </label>
                <input
                  id="reason"
                  type="text"
                  name="reason"
                  required
                  maxlength={80}
                  class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white"
                  placeholder="e.g. correction for match #123"
                />
              </div>
              <Btn label="Adjust" />
            </form>
          </Card>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="space-y-4">
            <Card>
              <H2>Ledger</H2>
              <Table headers={["Delta", "Reason", "Ref", "At"]}>
                {ledgerRows.map((r) => (
                  <Tr>
                    <Td>
                      <span class={r.delta >= 0 ? "text-green-400" : "text-red-400"}>
                        {r.delta >= 0 ? "+" : ""}
                        {r.delta}
                      </span>
                    </Td>
                    <Td>{r.reason}</Td>
                    <Td mono>{r.ref ?? "—"}</Td>
                    <Td>{fmtDate(r.at)}</Td>
                  </Tr>
                ))}
              </Table>
              <Pagination
                page={lPage}
                total={lTotal}
                pageSize={LEDGER_PAGE}
                url={`/users/${guildId}/${discordId}?`}
              />
            </Card>
          </div>

          <div class="space-y-4">
            <Card>
              <H2>Wagers ({openWagers.length})</H2>
              <Table headers={["Market", "Side", "Amount", "Status", "Placed"]}>
                {openWagers.map((w) => (
                  <Tr>
                    <Td>
                      <a
                        href={`/markets/${w.betId}`}
                        class="text-pink-400 hover:text-pink-300"
                      >
                        #{w.betId}
                      </a>
                    </Td>
                    <Td>
                      <span
                        class={w.outcome === "yes" ? "text-green-400" : "text-red-400"}
                      >
                        {w.outcome}
                      </span>
                    </Td>
                    <Td>{w.amount}</Td>
                    <Td>{w.status ? <Badge status={w.status} /> : "—"}</Td>
                    <Td>{fmtDate(w.placedAt)}</Td>
                  </Tr>
                ))}
              </Table>
            </Card>

            {userDisputes.length > 0 && (
              <Card>
                <H2>Disputes opened</H2>
                <Table headers={["#", "Market", "Status", "Action", "Opened"]}>
                  {userDisputes.map((d) => (
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
                        <a href={`/markets/${d.betId}`} class="text-gray-300">
                          #{d.betId}
                        </a>
                      </Td>
                      <Td>
                        <Badge status={d.status} />
                      </Td>
                      <Td>{d.finalAction ?? "—"}</Td>
                      <Td>{fmtDate(d.openedAt)}</Td>
                    </Tr>
                  ))}
                </Table>
              </Card>
            )}
          </div>
        </div>
      </>,
      flash ?? undefined,
    ),
  );
});

router.post("/:guildId/:discordId/adjust", async (c) => {
  const user = c.get("user");
  const discordId = c.req.param("discordId");
  const guildId = c.req.param("guildId");
  const body = await c.req.parseBody();
  const delta = parseInt(body.delta as string, 10);
  const reason = ((body.reason as string) ?? "").trim().slice(0, 80);

  if (Number.isNaN(delta) || delta === 0) {
    return c.text("Invalid delta", 400);
  }
  if (!reason) {
    return c.text("Reason required", 400);
  }

  adjustBalance(discordId, guildId, delta, `admin:${reason}`);
  logAdminAction(user.discordId, "balance-adjust", `user:${discordId}:${guildId}`, {
    delta,
    reason,
    guildId,
  });

  return c.redirect(
    `/users/${guildId}/${discordId}?flash=Balance+adjusted+by+${delta > 0 ? "+" : ""}${delta}.`,
  );
});

export default router;
