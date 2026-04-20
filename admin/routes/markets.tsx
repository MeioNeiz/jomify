/** @jsxImportSource hono/jsx */
import { count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { DEFAULT_EXPIRY_HOURS } from "../../src/betting/config.js";
import { bets, disputes, ledger, wagers } from "../../src/betting/schema.js";
import {
  cancelBet,
  createBet,
  reopenBet,
  resolveBet,
} from "../../src/betting/store/bets.js";
import { getTicksForBet, type Tick } from "../../src/betting/store.js";
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

// ── Price history chart ────────────────────────────────────────────────
// Pure SVG, no JS deps. Y-axis = LMSR YES probability; X-axis = time
// from market creation to resolution (or now). Each tick becomes a dot
// coloured by the side that was bought; a line connects them in order.
function parseIsoMs(iso: string): number {
  // Stored as "YYYY-MM-DD HH:MM:SS" (UTC, no suffix). Append Z so Date
  // parses as UTC across runtimes.
  return new Date(`${iso.replace(" ", "T")}Z`).getTime();
}

function PriceChart({
  ticks,
  initialProb,
  startMs,
  endMs,
}: {
  ticks: Tick[];
  initialProb: number;
  startMs: number;
  endMs: number;
}) {
  const W = 600;
  const H = 220;
  const P = { top: 16, right: 16, bottom: 32, left: 44 };
  const plotW = W - P.left - P.right;
  const plotH = H - P.top - P.bottom;
  const span = Math.max(endMs - startMs, 1);

  const xAt = (ms: number): number =>
    P.left + ((Math.max(ms, startMs) - startMs) / span) * plotW;
  const yAt = (p: number): number => P.top + (1 - p) * plotH;

  type Pt = { x: number; y: number; t: Tick | null };
  const points: Pt[] = [{ x: xAt(startMs), y: yAt(initialProb), t: null }];
  for (const t of ticks) {
    points.push({ x: xAt(parseIsoMs(t.occurredAt)), y: yAt(t.probYesAfter), t });
  }
  const lastProb = ticks.length > 0 ? ticks[ticks.length - 1]!.probYesAfter : initialProb;
  points.push({ x: xAt(endMs), y: yAt(lastProb), t: null });

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  const gridY = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      class="w-full h-auto"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Market price history</title>
      <rect x={0} y={0} width={W} height={H} fill="transparent" />
      {gridY.map((g) => (
        <g>
          <line
            x1={P.left}
            x2={W - P.right}
            y1={yAt(g)}
            y2={yAt(g)}
            stroke="#374151"
            stroke-dasharray={g === 0.5 ? "0" : "2 3"}
          />
          <text
            x={P.left - 6}
            y={yAt(g) + 4}
            font-size="10"
            fill="#9ca3af"
            text-anchor="end"
          >
            {Math.round(g * 100)}%
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke="#60a5fa" stroke-width="1.5" />
      {points.slice(1, -1).map((p) => (
        <circle
          cx={p.x}
          cy={p.y}
          r={3.5}
          fill={p.t?.outcome === "yes" ? "#34d399" : "#f87171"}
          stroke="#0f172a"
          stroke-width={1}
        >
          <title>
            {p.t?.outcome?.toUpperCase()} · {p.t?.amount} shekels · prob{" "}
            {Math.round((p.t?.probYesAfter ?? 0) * 100)}% · {p.t?.occurredAt}
          </title>
        </circle>
      ))}
      <text x={P.left} y={H - 10} font-size="10" fill="#9ca3af" text-anchor="start">
        {new Date(startMs).toISOString().slice(0, 16).replace("T", " ")}
      </text>
      <text x={W - P.right} y={H - 10} font-size="10" fill="#9ca3af" text-anchor="end">
        {new Date(endMs).toISOString().slice(0, 16).replace("T", " ")}
      </text>
    </svg>
  );
}

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
            <a
              href="/markets/create"
              class="px-2 py-1 rounded bg-pink-700 hover:bg-pink-600 text-white"
            >
              + New
            </a>
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

// ── Create market ───────────────────────────────────────────────────

function expiryIso(hours: number): string {
  const when = new Date(Date.now() + hours * 3600 * 1000);
  return when.toISOString().replace("T", " ").replace(/\..+$/, "");
}

router.get("/create", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");
  const flash = c.req.query("flash");
  const error = c.req.query("error");

  // Distinct guilds we already know about, to make life easier.
  const guildRows = db
    .select({ guildId: bets.guildId })
    .from(bets)
    .groupBy(bets.guildId)
    .orderBy(bets.guildId)
    .all();

  return c.html(
    page(
      "Create market",
      user.username,
      csrf,
      <>
        <div class="flex items-center gap-3 mb-4">
          <a href="/markets" class="text-gray-400 hover:text-white text-sm">
            ← Markets
          </a>
          <H1>Create market</H1>
        </div>
        {error && (
          <div class="mb-4 bg-red-900 border border-red-700 text-red-200 px-4 py-2 rounded text-sm">
            {error}
          </div>
        )}
        <Card>
          <form method="post" action="/markets/create" class="space-y-4">
            <HiddenCsrf token={csrf} />
            <div>
              <label for="guild_id" class="block text-xs text-gray-400 mb-1">
                Guild ID (required)
              </label>
              <input
                id="guild_id"
                type="text"
                name="guild_id"
                required
                list="guild-options"
                class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white font-mono"
                placeholder="e.g. 123456789012345678"
              />
              <datalist id="guild-options">
                {guildRows.map((g) => (
                  <option value={g.guildId} />
                ))}
              </datalist>
            </div>
            <div>
              <label for="creator_discord_id" class="block text-xs text-gray-400 mb-1">
                Creator Discord ID (required — admin acts on behalf)
              </label>
              <input
                id="creator_discord_id"
                type="text"
                name="creator_discord_id"
                required
                class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white font-mono"
                placeholder="e.g. 123456789012345678"
              />
            </div>
            <div>
              <label for="question" class="block text-xs text-gray-400 mb-1">
                Question (required)
              </label>
              <input
                id="question"
                type="text"
                name="question"
                required
                maxlength={200}
                class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white"
                placeholder="What are you predicting on?"
              />
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="initial_prob_pct" class="block text-xs text-gray-400 mb-1">
                  Initial probability % (1–99)
                </label>
                <input
                  id="initial_prob_pct"
                  type="number"
                  name="initial_prob_pct"
                  min={1}
                  max={99}
                  value={50}
                  class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white"
                />
              </div>
              <div>
                <label for="duration_hours" class="block text-xs text-gray-400 mb-1">
                  Duration hours (default {DEFAULT_EXPIRY_HOURS})
                </label>
                <input
                  id="duration_hours"
                  type="number"
                  name="duration_hours"
                  min={1}
                  placeholder={String(DEFAULT_EXPIRY_HOURS)}
                  class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white"
                />
              </div>
            </div>
            <p class="text-xs text-gray-500">
              Manual-resolution market — no auto-resolver is attached.
            </p>
            <div class="flex gap-2">
              <Btn label="Create market" />
              <a
                href="/markets"
                class="px-3 py-1.5 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600 text-gray-200"
              >
                Cancel
              </a>
            </div>
          </form>
        </Card>
      </>,
      flash ?? undefined,
    ),
  );
});

router.post("/create", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const guildId = ((body.guild_id as string) ?? "").trim();
  const creatorDiscordId = ((body.creator_discord_id as string) ?? "").trim();
  const question = ((body.question as string) ?? "").trim().slice(0, 200);
  const probPctRaw = parseInt((body.initial_prob_pct as string) ?? "50", 10);
  const durationRaw = (body.duration_hours as string) ?? "";
  const durationHours = durationRaw.trim()
    ? parseInt(durationRaw, 10)
    : DEFAULT_EXPIRY_HOURS;

  const fail = (msg: string) =>
    c.redirect(`/markets/create?error=${encodeURIComponent(msg)}`);

  if (!guildId) return fail("Guild ID is required.");
  if (!creatorDiscordId) return fail("Creator Discord ID is required.");
  if (!question) return fail("Question is required.");
  if (Number.isNaN(probPctRaw) || probPctRaw < 1 || probPctRaw > 99) {
    return fail("Initial probability must be between 1 and 99.");
  }
  if (Number.isNaN(durationHours) || durationHours < 1) {
    return fail("Duration must be a positive integer (hours).");
  }

  const expiresAt = expiryIso(durationHours);
  let newId: number;
  try {
    newId = createBet(guildId, creatorDiscordId, question, expiresAt, {
      initialProb: probPctRaw / 100,
    });
  } catch (err) {
    return fail((err as Error).message);
  }

  logAdminAction(user.discordId, "market-create", `bet:${newId}`, {
    betId: newId,
    guildId,
    creatorDiscordId,
    question,
    initialProbPct: probPctRaw,
    durationHours,
    expiresAt,
  });
  try {
    await notifyBot({ type: "market", id: newId });
  } catch {
    /* non-fatal */
  }

  return c.redirect(`/markets/${newId}?flash=Market+created.`);
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

  // Price history: only meaningful on LMSR markets (b > 0). Legacy
  // pari-mutuel markets have no continuous price curve.
  const ticks = bet.b > 0 ? getTicksForBet(id) : [];
  const startMs = parseIsoMs(bet.createdAt);
  const endMs = bet.resolvedAt ? parseIsoMs(bet.resolvedAt) : Date.now();

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

            {bet.status === "resolved" && (
              <Card>
                <H2>Reopen & re-settle</H2>
                <p class="text-xs text-gray-400 mb-3">
                  Reverses payouts, then either cancels (full refund) or flips the winning
                  outcome. Reason is logged.
                </p>
                <form
                  method="post"
                  action={`/markets/${id}/reopen-cancel`}
                  class="space-y-2 mb-4"
                >
                  <HiddenCsrf token={csrf} />
                  <textarea
                    name="reason"
                    required
                    maxlength={200}
                    rows={2}
                    class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white"
                    placeholder="Reason (required) — why are we refunding?"
                  />
                  <Btn label="Reopen + cancel (full refund)" variant="danger" />
                </form>
                <form
                  method="post"
                  action={`/markets/${id}/reopen-flip`}
                  class="space-y-2"
                >
                  <HiddenCsrf token={csrf} />
                  <textarea
                    name="reason"
                    required
                    maxlength={200}
                    rows={2}
                    class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white"
                    placeholder="Reason (required) — why are we flipping?"
                  />
                  <div class="flex gap-2">
                    <Btn label="Reopen + flip to YES" name="outcome" value="yes" />
                    <Btn
                      label="Reopen + flip to NO"
                      name="outcome"
                      value="no"
                      variant="danger"
                    />
                  </div>
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

        {bet.b > 0 && (
          <Card>
            <H2>Price history</H2>
            {ticks.length === 0 ? (
              <p class="text-sm text-gray-400">
                No trades yet — price sits at the creator's initial estimate of{" "}
                <span class="font-semibold text-white">
                  {Math.round(bet.initialProb * 100)}% YES
                </span>
                .
              </p>
            ) : (
              <div>
                <PriceChart
                  ticks={ticks}
                  initialProb={bet.initialProb}
                  startMs={startMs}
                  endMs={endMs}
                />
                <div class="text-xs text-gray-400 mt-2 flex items-center gap-4">
                  <span>
                    <span class="inline-block w-2 h-2 rounded-full bg-green-400 mr-1" />
                    YES buy
                  </span>
                  <span>
                    <span class="inline-block w-2 h-2 rounded-full bg-red-400 mr-1" />
                    NO buy
                  </span>
                  <span class="ml-auto">{ticks.length} trades</span>
                </div>
              </div>
            )}
          </Card>
        )}

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
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

router.post("/:id/reopen-cancel", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody();
  const reason = ((body.reason as string) ?? "").trim().slice(0, 200);

  if (!reason) {
    return c.redirect(
      `/markets/${id}?flash=${encodeURIComponent("Reason is required.")}`,
    );
  }

  try {
    reopenBet(id);
    cancelBet(id);
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

  logAdminAction(user.discordId, "market-reopen-cancel", `bet:${id}`, {
    betId: id,
    reason,
  });
  try {
    await notifyBot({ type: "market", id });
  } catch {
    /* non-fatal */
  }

  return c.redirect(`/markets/${id}?flash=Market+reopened+and+refunded.`);
});

router.post("/:id/reopen-flip", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody();
  const reason = ((body.reason as string) ?? "").trim().slice(0, 200);
  const outcome = (body.outcome as string) ?? "";

  if (!reason) {
    return c.redirect(
      `/markets/${id}?flash=${encodeURIComponent("Reason is required.")}`,
    );
  }
  if (outcome !== "yes" && outcome !== "no") {
    return c.redirect(`/markets/${id}?flash=${encodeURIComponent("Invalid outcome.")}`);
  }

  try {
    reopenBet(id);
    resolveBet(id, outcome);
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

  logAdminAction(user.discordId, "market-reopen-flip", `bet:${id}`, {
    betId: id,
    outcome,
    reason,
  });
  try {
    await notifyBot({ type: "market", id });
  } catch {
    /* non-fatal */
  }

  return c.redirect(`/markets/${id}?flash=Market+flipped+to+${outcome.toUpperCase()}.`);
});

export default router;
