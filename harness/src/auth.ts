import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "./config.ts";

const COOKIE = "harness_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;
// Rotates on restart, which signs everyone out. Fine for a single user.
const secret = randomBytes(32);

function sign(value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a compare so timing does not leak length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function checkPassword(input: string): boolean {
  return safeEqual(sign(input), sign(config.password));
}

export function issueCookie(c: Context): void {
  const expires = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${expires}`;
  setCookie(c, COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: !!config.podId,
    sameSite: "Strict",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearCookie(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

function isAuthed(c: Context): boolean {
  const raw = getCookie(c, COOKIE);
  if (!raw) return false;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac || !safeEqual(mac, sign(payload))) return false;
  return Number(payload) > Date.now();
}

export async function requireAuth(c: Context, next: Next) {
  if (isAuthed(c)) return next();
  if (c.req.path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
  return c.redirect("/login");
}

// 5 attempts per minute per client IP.
const attempts = new Map<string, number[]>();

export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > 5;
}
