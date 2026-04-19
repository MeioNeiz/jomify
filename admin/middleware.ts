import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getSession, type SessionUser, setSession } from "./auth.js";
import { adminConfig } from "./config.js";

export type Env = {
  Variables: {
    user: SessionUser;
    csrf: string;
  };
};

// Double-submit cookie CSRF: cookie "csrf" must equal form field "_csrf".
export const csrfMiddleware = createMiddleware<Env>(async (c, next) => {
  let token = getCookie(c, "csrf") ?? "";
  if (!token) {
    token = crypto.randomUUID();
    setCookie(c, "csrf", token, {
      httpOnly: false,
      sameSite: "Strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  }
  c.set("csrf", token);

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const body = await c.req.parseBody();
    const formToken = body._csrf as string | undefined;
    if (!formToken || formToken !== token) {
      return c.text("Invalid CSRF token", 403);
    }
  }
  return next();
});

export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  const user = getSession(c, adminConfig.sessionSecret);
  if (!user) return c.redirect("/login");
  // Slide expiry on every request
  setSession(c, user, adminConfig.sessionSecret);
  c.set("user", user);
  return next();
});
