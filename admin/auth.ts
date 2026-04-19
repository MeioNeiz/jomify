import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export type SessionUser = {
  discordId: string;
  username: string;
  avatar: string | null;
  exp: number;
};

const SESSION_COOKIE = "jomify_admin";
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function sign(data: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

function encodeSession(payload: SessionUser, secret: string): string {
  const data = b64url(Buffer.from(JSON.stringify(payload)));
  return `${data}.${sign(data, secret)}`;
}

function decodeSession(cookie: string, secret: string): SessionUser | null {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return null;
  const data = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = sign(data, secret);
  try {
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expected, "base64url");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload as SessionUser;
  } catch {
    return null;
  }
}

export function setSession(c: Context, user: SessionUser, secret: string): void {
  const value = encodeSession(user, secret);
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function getSession(c: Context, secret: string): SessionUser | null {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  return decodeSession(raw, secret);
}

export function clearSession(c: Context): void {
  setCookie(c, SESSION_COOKIE, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
}

// ── Discord OAuth helpers ────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";
const MANAGE_GUILD = 0x20n;

export function buildOAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify guilds.members.read",
    state,
  });
  return `https://discord.com/oauth2/authorize?${p}`;
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function fetchIdentity(
  token: string,
): Promise<{ id: string; username: string; avatar: string | null }> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Identity fetch failed: ${res.status}`);
  return res.json() as Promise<{ id: string; username: string; avatar: string | null }>;
}

export async function hasManageGuild(token: string, guildId: string): Promise<boolean> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return false;
  const member = (await res.json()) as { permissions?: string };
  if (!member.permissions) return false;
  return (BigInt(member.permissions) & MANAGE_GUILD) !== 0n;
}
