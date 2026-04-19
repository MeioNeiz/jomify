/** @jsxImportSource hono/jsx */
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bets, disputes, disputeVotes } from "../../src/betting/schema.js";
import {
  cancelBet,
  getBet,
  markDisputeResolved,
  type Outcome,
  reopenBet,
  resolveBet,
} from "../../src/betting/store.js";
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

  const rows = db
    .select({
      id: disputes.id,
      betId: disputes.betId,
      question: bets.question,
      opener: disputes.openerDiscordId,
      status: disputes.status,
      finalAction: disputes.finalAction,
      openedAt: disputes.openedAt,
      resolvedAt: disputes.resolvedAt,
    })
    .from(disputes)
    .leftJoin(bets, eq(disputes.betId, bets.id))
    .orderBy(
      sql`CASE WHEN ${disputes.status} = 'open' THEN 0 ELSE 1 END`,
      desc(disputes.openedAt),
    )
    .all();

  return c.html(
    page(
      "Disputes",
      user.username,
      csrf,
      <>
        <H1>Disputes</H1>
        <Card>
          <Table
            headers={[
              "#",
              "Market",
              "Question",
              "Opener",
              "Status",
              "Action",
              "Opened",
              "",
            ]}
          >
            {rows.map((d) => (
              <Tr>
                <Td>
                  <a href={`/disputes/${d.id}`} class="text-pink-400 hover:text-pink-300">
                    #{d.id}
                  </a>
                </Td>
                <Td>
                  <a href={`/markets/${d.betId}`} class="text-gray-300 hover:text-white">
                    #{d.betId}
                  </a>
                </Td>
                <Td>{truncate(d.question ?? "", 50)}</Td>
                <Td mono>{d.opener}</Td>
                <Td>
                  <Badge status={d.status} />
                </Td>
                <Td>{d.finalAction ?? "—"}</Td>
                <Td>{fmtDate(d.openedAt)}</Td>
                <Td>
                  {d.status === "open" && (
                    <a
                      href={`/disputes/${d.id}`}
                      class="text-xs text-yellow-400 hover:text-yellow-300 font-medium"
                    >
                      Resolve →
                    </a>
                  )}
                </Td>
              </Tr>
            ))}
          </Table>
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

  const dispute = db.select().from(disputes).where(eq(disputes.id, id)).get();
  if (!dispute) return c.text("Dispute not found", 404);

  const bet = getBet(dispute.betId);

  const votes = db
    .select()
    .from(disputeVotes)
    .where(eq(disputeVotes.disputeId, id))
    .all();
  const overturn = votes.filter((v) => v.vote === "overturn").length;
  const keep = votes.filter((v) => v.vote === "keep").length;

  return c.html(
    page(
      `Dispute #${id}`,
      user.username,
      csrf,
      <>
        <div class="flex items-center gap-3 mb-4">
          <a href="/disputes" class="text-gray-400 hover:text-white text-sm">
            ← Disputes
          </a>
          <H1>Dispute #{id}</H1>
          <Badge status={dispute.status} />
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="space-y-4">
            <Card>
              <H2>Market context</H2>
              {bet ? (
                <div class="text-sm space-y-1">
                  <div>
                    <a
                      href={`/markets/${bet.id}`}
                      class="text-pink-400 hover:text-pink-300"
                    >
                      Market #{bet.id}
                    </a>{" "}
                    — {bet.question}
                  </div>
                  <div class="text-gray-400">
                    Status: <Badge status={bet.status} />
                    {bet.winningOutcome && (
                      <span class="ml-2 font-bold text-white">
                        → {bet.winningOutcome}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <p class="text-gray-400 text-sm">Market #{dispute.betId} not found</p>
              )}
            </Card>

            <Card>
              <H2>Dispute details</H2>
              <div class="text-sm space-y-2">
                <div>
                  Opened by:{" "}
                  <a
                    href={`/users/${dispute.openerDiscordId}`}
                    class="font-mono text-xs text-pink-400 hover:text-pink-300"
                  >
                    {dispute.openerDiscordId}
                  </a>
                </div>
                <div class="text-gray-400">Reason:</div>
                <blockquote class="border-l-2 border-gray-600 pl-3 text-gray-300">
                  {dispute.reason}
                </blockquote>
                <div class="text-gray-400">Opened: {fmtDate(dispute.openedAt)}</div>
                {dispute.resolvedAt && (
                  <div class="text-gray-400">
                    Resolved: {fmtDate(dispute.resolvedAt)}
                    {dispute.resolverDiscordId && (
                      <span class="ml-1">
                        by{" "}
                        <a
                          href={`/users/${dispute.resolverDiscordId}`}
                          class="font-mono text-xs text-pink-400"
                        >
                          {dispute.resolverDiscordId}
                        </a>
                      </span>
                    )}
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <H2>
                Vote tally ({overturn} overturn · {keep} keep)
              </H2>
              <Table headers={["Voter", "Vote"]}>
                {votes.map((v) => (
                  <Tr>
                    <Td mono>{v.discordId}</Td>
                    <Td>
                      <span
                        class={
                          v.vote === "overturn" ? "text-yellow-400" : "text-gray-400"
                        }
                      >
                        {v.vote}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          </div>

          {dispute.status === "open" && (
            <Card>
              <H2>Admin ruling</H2>
              <p class="text-sm text-gray-400 mb-4">
                Select a ruling and submit. This will immediately update balances and post
                the resolution in Discord.
              </p>
              <form method="post" action={`/disputes/${id}/resolve`} class="space-y-3">
                <HiddenCsrf token={csrf} />
                <div class="space-y-2">
                  <label class="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="radio" name="action" value="keep" class="mt-0.5" />
                    <div>
                      <div class="font-medium">Keep current ruling</div>
                      <div class="text-gray-400 text-xs">
                        Dismiss dispute; leave payouts as they are.
                      </div>
                    </div>
                  </label>
                  <label class="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="radio" name="action" value="flip-yes" class="mt-0.5" />
                    <div>
                      <div class="font-medium">Flip to Yes</div>
                      <div class="text-gray-400 text-xs">
                        Reverse payouts, re-resolve as Yes.
                      </div>
                    </div>
                  </label>
                  <label class="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="radio" name="action" value="flip-no" class="mt-0.5" />
                    <div>
                      <div class="font-medium">Flip to No</div>
                      <div class="text-gray-400 text-xs">
                        Reverse payouts, re-resolve as No.
                      </div>
                    </div>
                  </label>
                  <label class="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="radio" name="action" value="cancel" class="mt-0.5" />
                    <div>
                      <div class="font-medium">Cancel &amp; refund</div>
                      <div class="text-gray-400 text-xs">
                        Reverse payouts, refund every bet.
                      </div>
                    </div>
                  </label>
                </div>
                <Btn label="Apply ruling" variant="danger" />
              </form>
            </Card>
          )}

          {dispute.status === "resolved" && (
            <Card>
              <H2>Resolution</H2>
              <div class="text-sm">
                <span class="font-bold text-white">{dispute.finalAction}</span>
                {dispute.finalOutcome && (
                  <span class="ml-2 text-gray-300">→ {dispute.finalOutcome}</span>
                )}
              </div>
            </Card>
          )}
        </div>
      </>,
      flash ?? undefined,
    ),
  );
});

router.post("/:id/resolve", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody();
  const action = body.action as string;

  const dispute = db.select().from(disputes).where(eq(disputes.id, id)).get();
  if (!dispute || dispute.status !== "open") {
    return c.text("Dispute not found or already resolved", 400);
  }

  try {
    if (action === "keep") {
      const bet = getBet(dispute.betId);
      markDisputeResolved(
        id,
        "keep",
        (bet?.winningOutcome as Outcome) ?? null,
        user.discordId,
      );
    } else if (action === "flip-yes" || action === "flip-no") {
      const outcome: Outcome = action === "flip-yes" ? "yes" : "no";
      reopenBet(dispute.betId);
      resolveBet(dispute.betId, outcome);
      markDisputeResolved(id, "flip", outcome, user.discordId);
    } else if (action === "cancel") {
      reopenBet(dispute.betId);
      cancelBet(dispute.betId);
      markDisputeResolved(id, "cancel", null, user.discordId);
    } else {
      return c.text("Unknown action", 400);
    }

    logAdminAction(user.discordId, "dispute-resolve", `dispute:${id}`, {
      disputeId: id,
      betId: dispute.betId,
      action,
    });
    await notifyBot({ type: "dispute", id });
    await notifyBot({ type: "market", id: dispute.betId });
  } catch (err) {
    return c.text((err as Error).message, 400);
  }

  return c.redirect(`/disputes/${id}?flash=Ruling+applied.`);
});

export default router;
