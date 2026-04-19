/** @jsxImportSource hono/jsx */
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { ledger } from "../../src/betting/schema.js";
import { db } from "../db.js";
import type { Env } from "../middleware.js";
import { Card, fmtDate, H1, Pagination, Table, Td, Tr } from "../views/components.js";
import { page } from "../views/layout.js";

const router = new Hono<Env>();
const PAGE_SIZE = 50;

router.get("/", async (c) => {
  const user = c.get("user");
  const csrf = c.get("csrf");
  const page_ = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const offset = (page_ - 1) * PAGE_SIZE;

  const discordId = c.req.query("discord_id") ?? "";
  const reason = c.req.query("reason") ?? "";
  const ref = c.req.query("ref") ?? "";
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";

  const conditions = [
    discordId ? eq(ledger.discordId, discordId) : null,
    reason ? eq(ledger.reason, reason) : null,
    ref ? eq(ledger.ref, ref) : null,
    from ? gte(ledger.at, from) : null,
    to ? lte(ledger.at, `${to} 23:59:59`) : null,
  ].filter(Boolean);

  const where = conditions.length
    ? and(...(conditions as Parameters<typeof and>))
    : sql`1=1`;

  const [{ total }] = db.select({ total: count() }).from(ledger).where(where).all();

  const rows = db
    .select()
    .from(ledger)
    .where(where)
    .orderBy(desc(ledger.at))
    .limit(PAGE_SIZE)
    .offset(offset)
    .all();

  const reasons = db
    .selectDistinct({ reason: ledger.reason })
    .from(ledger)
    .orderBy(ledger.reason)
    .all()
    .map((r) => r.reason);

  const buildUrl = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({
      ...(discordId && { discord_id: discordId }),
      ...(reason && { reason }),
      ...(ref && { ref }),
      ...(from && { from }),
      ...(to && { to }),
      page: "1",
      ...extra,
    });
    return `/ledger?${p}`;
  };

  return c.html(
    page(
      "Ledger",
      user.username,
      csrf,
      <>
        <H1>Ledger</H1>

        <form method="get" class="flex flex-wrap gap-2 mb-4 text-sm">
          <input
            type="text"
            name="discord_id"
            value={discordId}
            placeholder="Discord ID"
            class="bg-gray-800 border border-gray-700 rounded px-2 py-1 w-48 text-white"
          />
          <select
            name="reason"
            class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
          >
            <option value="">All reasons</option>
            {reasons.map((r) => (
              <option value={r} selected={r === reason}>
                {r}
              </option>
            ))}
          </select>
          <input
            type="text"
            name="ref"
            value={ref}
            placeholder="Ref (bet id)"
            class="bg-gray-800 border border-gray-700 rounded px-2 py-1 w-32 text-white"
          />
          <input
            type="date"
            name="from"
            value={from}
            class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
          />
          <input
            type="date"
            name="to"
            value={to}
            class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
          />
          <button
            type="submit"
            class="bg-pink-700 hover:bg-pink-600 text-white px-3 py-1 rounded"
          >
            Filter
          </button>
          {(discordId || reason || ref || from || to) && (
            <a href="/ledger" class="text-gray-400 hover:text-white px-2 py-1">
              Clear
            </a>
          )}
        </form>

        <Card>
          <div class="text-xs text-gray-400 mb-2">{total} rows</div>
          <Table headers={["ID", "User", "Delta", "Reason", "Ref", "At"]}>
            {rows.map((r) => (
              <Tr>
                <Td mono>{r.id}</Td>
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
                <Td>
                  {r.ref ? (
                    <a href={`/markets/${r.ref}`} class="text-gray-300 hover:text-white">
                      {r.ref}
                    </a>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>{fmtDate(r.at)}</Td>
              </Tr>
            ))}
          </Table>
          <Pagination page={page_} total={total} pageSize={PAGE_SIZE} url={buildUrl()} />
        </Card>
      </>,
    ),
  );
});

export default router;
