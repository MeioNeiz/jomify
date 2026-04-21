import { Hono } from "hono";
import {
  buildOAuthUrl,
  clearSession,
  exchangeCode,
  fetchIdentity,
  hasManageGuild,
  setSession,
} from "./auth.js";
import { adminConfig } from "./config.js";
import { csrfMiddleware, type Env, requireAdmin } from "./middleware.js";
import dashboardRoute from "./routes/dashboard.js";
import disputesRoute from "./routes/disputes.js";
import ledgerRoute from "./routes/ledger.js";
import marketsRoute from "./routes/markets.js";
import settingsRoute from "./routes/settings.js";
import usersRoute from "./routes/users.js";

const app = new Hono<Env>();

// ── Auth (no requireAdmin) ────────────────────────────────────────────

app.get("/login", (c) => {
  const state = crypto.randomUUID();
  const url = buildOAuthUrl(
    adminConfig.discordClientId,
    `${adminConfig.baseUrl}/auth/callback`,
    state,
  );
  return c.redirect(url);
});

app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("Missing code", 400);
  try {
    const token = await exchangeCode(
      code,
      adminConfig.discordClientId,
      adminConfig.discordClientSecret,
      `${adminConfig.baseUrl}/auth/callback`,
    );
    const identity = await fetchIdentity(token);
    const allowed = await hasManageGuild(token, adminConfig.guildId);
    if (!allowed) {
      return c.html(
        "<html><body>Not authorised. You need Manage Server in the configured guild.</body></html>",
        403,
      );
    }
    setSession(
      c,
      {
        discordId: identity.id,
        username: identity.username,
        avatar: identity.avatar,
        exp: Date.now() + 3600_000,
      },
      adminConfig.sessionSecret,
    );
    return c.redirect("/");
  } catch (err) {
    return c.text(`Auth failed: ${(err as Error).message}`, 500);
  }
});

app.get("/logout", (c) => {
  clearSession(c);
  return c.redirect("/login");
});

// ── Protected routes ──────────────────────────────────────────────────

app.use("/*", csrfMiddleware);
app.use("/*", requireAdmin);

app.route("/", dashboardRoute);
app.route("/markets", marketsRoute);
app.route("/disputes", disputesRoute);
app.route("/users", usersRoute);
app.route("/ledger", ledgerRoute);
app.route("/settings", settingsRoute);

// ── Start server ──────────────────────────────────────────────────────

const port = adminConfig.port;
console.log(`Jomify Admin listening on http://localhost:${port}`);

export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
