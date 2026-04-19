/** @jsxImportSource hono/jsx */
import { count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bets, disputes, ledger, wagers } from "../../src/betting/schema.js";
import { cancelBet } from "../../src/betting/store/bets.js";
import { db, logAdminAction } from "../db.js";
import { notifyBot } from "../ipc.js";
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
  truncate,
} from "../views/components.js";
import { page } from "../views/layout.js";

const router = new Hono<Env>();
const PAGE_SIZE = 25;

router.get("/", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");
  const page_ = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const status = c.req.query("status") ?? "";
  const offset = (page_ - 1) * PAGE_SIZE;

  const where = status ? eq(bets.status, status) : sql`1=1`;

  const [{ total }] = db.select({ total: count() }).from(bets).where(where).all();

  const rows = db
    .select({
      id: bets.id,
      question: bets.question,
      status: bets.status,
      winningOutcome: bets.winningOutcome,
      createdAt: bets.createdAt,
      expiresAt: bets.expiresAt,
      resolverKind: bets.resolverKind,
      guildId: bets.guildId,
    })
    .from(bets)
    .where(where)
    .orderBy(desc(bets.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset)
    .all();

  const wagerCounts = db
    .select({ betId: wagers.betId, n: count() })
    .from(wagers)
    .groupBy(wagers.betId)
    .all()
    .reduce<Record<number, number>>((m, r) => {
      m[r.betId] = r.n;
      return m;
    }, {});

  const filterLink = (s: string) => `/markets?status=${s}&page=1`;

  return c.html(
    page(
      "Markets",
      user.username,
      csrf,
      <>
        <div class="flex items-center gap-4 mb-4">
          <H1>Markets</H1>
          <div class="flex gap-2 text-sm ml-auto">
            {["", "open", "resolved", "cancelled"].map((s) => (
              <a
                href={filterLink(s)}
                class={`px-2 py-1 rounded ${status === s ? "bg-pink-800 text-white" : "text-gray-400 hover:text-white"}`}
              >
                {s || "All"}
              </a>
            ))}
          </div>
        </div>
        <Card>
          <Table
            headers={[
              "#",
              "Question",
              "Status",
              "Resolver",
              "Wagers",
              "Created",
              "Expires",
              "",
            ]}
          >
            {rows.map((b) => (
              <Tr>
                <Td>
                  <a href={`/markets/${b.id}`} class="text-pink-400 hover:text-pink-300">
                    #{b.id}
                  </a>
                </Td>
                <Td>{truncate(b.question, 60)}</Td>
                <Td>
                  <Badge status={b.status} />
                  {b.winningOutcome && (
                    <span class="ml-1 text-xs text-gray-400">({b.winningOutcome})</span>
                  )}
                </Td>
                <Td>
                  {b.resolverKind ? (
                    <span class="text-xs text-blue-400">{b.resolverKind}</span>
                  ) : (
                    <span class="text-gray-600">—</span>
                  )}
                </Td>
                <Td>{wagerCounts[b.id] ?? 0}</Td>
                <Td>{fmtDate(b.createdAt)}</Td>
                <Td>{fmtDate(b.expiresAt)}</Td>
                <Td>
                  <a
                    href={`/markets/${b.id}`}
                    class="text-xs text-gray-400 hover:text-white"
                  >
                    Detail →
                  </a>
                </Td>
              </Tr>
            ))}
          </Table>
          <Pagination page={page_} total={total} pageSize={PAGE_SIZE} url="/markets" />
        </Card>
      </>,
    ),
  );
});

router.get("/:id", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");
  const id = parseInt(c.req.param("id"), 10);
  const flash = c.req.query("flash");

  const bet = db.select().from(bets).where(eq(bets.id, id)).get();
  if (!bet) return c.text("Market not found", 404);

  const wagerList = db
    .select({
      discordId: wagers.discordId,
      outcome: wagers.outcome,
      amount: wagers.amount,
      shares: wagers.shares,
      placedAt: wagers.placedAt,
    })
    .from(wagers)
    .where(eq(wagers.betId, id))
    .orderBy(desc(wagers.placedAt))
    .all();

  const ledgerRows = db
    .select()
    .from(ledger)
    .where(eq(ledger.ref, String(id)))
    .orderBy(desc(ledger.at))
    .limit(50)
    .all();

  const disputeList = db
    .select()
    .from(disputes)
    .where(eq(disputes.betId, id))
    .orderBy(desc(disputes.openedAt))
    .all();

  const pool = wagerList.reduce((s, w) => s + w.amount, 0);

  return c.html(
    page(
      `Market #${id}`,
      user.username,
      csrf,
      <>
        <div class="flex items-center gap-3 mb-4">
          <a href="/markets" class="text-gray-400 hover:text-white text-sm">
            ← Markets
          </a>
          <H1>Market #{id}</H1>
          <Badge status={bet.status} />
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div class="md:col-span-2 space-y-4">
            <Card>
              <H2>Question</H2>
              <p class="text-lg">{bet.question}</p>
              <div class="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-400">
                <div>
                  Created: <span class="text-gray-200">{fmtDate(bet.createdAt)}</span>
                </div>
                <div>
                  Expires: <span class="text-gray-200">{fmtDate(bet.expiresAt)}</span>
                </div>
                {bet.resolvedAt && (
                  <div>
                    Resolved: <span class="text-gray-200">{fmtDate(bet.resolvedAt)}</span>
                  </div>
                )}
                {bet.winningOutcome && (
                  <div>
                    Outcome:{" "}
                    <span class="font-bold text-white">{bet.winningOutcome}</span>
                  </div>
                )}
                <div>
                  Guild:{" "}
                  <span class="font-mono text-xs text-gray-300">{bet.guildId}</span>
                </div>
                <div>
                  Creator:{" "}
                  <a
                    href={`/users/${bet.creatorDiscordId}`}
                    class="font-mono text-xs text-pink-400 hover:text-pink-300"
                  >
                    {bet.creatorDiscordId}
                  </a>
                </div>
              </div>
            </Card>

            {bet.status === "open" && (
              <Card>
                <H2>Admin actions</H2>
                <form method="post" action={`/markets/${id}/cancel`}>
                  <HiddenCsrf token={csrf} />
                  <Btn label="Cancel & refund market" variant="danger" />
                </form>
              </Card>
            )}
          </div>

          <div class="space-y-4">
            <Card>
              <H2>LMSR state</H2>
              <div class="text-sm space-y-1 text-gray-300">
                <div>b = {bet.b}</div>
                <div>q_yes = {bet.qYes.toFixed(3)}</div>
                <div>q_no = {bet.qNo.toFixed(3)}</div>
                <div>initial_prob = {(bet.initialProb * 100).toFixed(0)}%</div>
                <div class="mt-2 text-white font-semibold">Pool: {pool} shekels</div>
              </div>
            </Card>
            {bet.resolverKind && (
              <Card>
                <H2>Auto-resolver</H2>
                <div class="text-sm font-mono text-blue-300">{bet.resolverKind}</div>
                {bet.resolverArgs && (
                  <pre class="text-xs text-gray-400 mt-2 overflow-x-auto">
                    {JSON.stringify(JSON.parse(bet.resolverArgs), null, 2)}
                  </pre>
                )}
              </Card>
            )}
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <H2>Wagers ({wagerList.length})</H2>
            <Table headers={["User", "Side", "Amount", "Shares", "Placed"]}>
              {wagerList.map((w) => (
                <Tr>
                  <Td>
                    <a
                      href={`/users/${w.discordId}`}
                      class="font-mono text-xs text-pink-400 hover:text-pink-300"
                    >
                      {w.discordId}
                    </a>
                  </Td>
                  <Td>
                    <span class={w.outcome === "yes" ? "text-green-400" : "text-red-400"}>
                      {w.outcome}
                    </span>
                  </Td>
                  <Td>{w.amount}</Td>
                  <Td>{w.shares.toFixed(3)}</Td>
                  <Td>{fmtDate(w.placedAt)}</Td>
                </Tr>
              ))}
            </Table>
          </Card>

          <div class="space-y-4">
            {disputeList.length > 0 && (
              <Card>
                <H2>Disputes</H2>
                <Table headers={["#", "Status", "Action", "Opened"]}>
                  {disputeList.map((d) => (
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
                        <Badge status={d.status} />
                      </Td>
                      <Td>{d.finalAction ?? "—"}</Td>
                      <Td>{fmtDate(d.openedAt)}</Td>
                    </Tr>
                  ))}
                </Table>
              </Card>
            )}

            <Card>
              <H2>Ledger ({ledgerRows.length})</H2>
              <Table headers={["User", "Delta", "Reason", "At"]}>
                {ledgerRows.map((r) => (
                  <Tr>
                    <Td>
                      <a
                        href={`/users/${r.discordId}`}
                        class="font-mono text-xs text-pink-400 hover:text-pink-300"
                      >
                        {r.discordId}
                      </a>
                    </Td>
                    <Td>
                      <span class={r.delta >= 0 ? "text-green-400" : "text-red-400"}>
                        {r.delta >= 0 ? "+" : ""}
                        {r.delta}
                      </span>
                    </Td>
                    <Td>{r.reason}</Td>
                    <Td>{fmtDate(r.at)}</Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          </div>
        </div>
      </>,
      flash ?? undefined,
    ),
  );
});

router.post("/:id/cancel", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"), 10);
  try {
    cancelBet(id);
    logAdminAction(user.discordId, "market-cancel", `bet:${id}`, { betId: id });
    await notifyBot({ type: "market", id });
  } catch (err) {
    return c.html(
      page(
        `Market #${id}`,
        user.username,
        c.get("csrf"),
        <p class="text-red-400">{(err as Error).message}</p>,
      ),
      400,
    );
  }
  return c.redirect(`/markets/${id}?flash=Market+cancelled+and+refunded.`);
});

export default router;
