/** @jsxImportSource hono/jsx */
import { and, count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
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

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
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
      </>,
    ),
  );
});

export default router;
