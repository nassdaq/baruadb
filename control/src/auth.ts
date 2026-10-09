// Accounts and sessions. Everything here runs on Web Crypto, which is all a
// Worker has: PBKDF2 for passwords, random bytes for session tokens.
//
// Two rules worth keeping:
//   - the database stores only hashes, never a password or a usable session token;
//   - comparisons of secrets are constant time.

import { HttpError, newId, now, sha256, timingSafeEqual } from "./util";

export type User = {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  is_admin: number;
  db_quota: number;
  created_at: string;
  last_seen_at: string | null;
  device_id?: string | null;
  device_hash?: string | null;
  linked_to?: string | null;
};

export const SESSION_COOKIE = "barua_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return b64(bits);
}

/** `pbkdf2$<iterations>$<salt>$<hash>` — the parameters travel with the hash,
 *  so the cost can be raised later without locking out existing accounts. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt.buffer as ArrayBuffer)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const got = await pbkdf2(password, unb64(salt), Number(iterations));
  return timingSafeEqual(got, hash);
}

export function validateCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    throw new HttpError(400, "a valid email address is required");
  }
  if (typeof password !== "string" || password.length < 10) {
    throw new HttpError(400, "password must be at least 10 characters");
  }
  return { email: email.trim().toLowerCase(), password };
}

// ---------------------------------------------------------------- sessions

/** Returns the raw token for the cookie; only its hash is stored. */
export async function createSession(db: D1Database, userId: string, userAgent: string | null): Promise<string> {
  const token = newId("ses_", 32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, now(), expires, userAgent?.slice(0, 200) ?? null)
    .run();
  return token;
}

export async function userForSession(db: D1Database, token: string): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(await sha256(token), now())
    .first<User>();
  return row ?? null;
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(token: string | null): string {
  const base = `${SESSION_COOKIE}=${token ?? ""}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return token ? `${base}; Max-Age=${SESSION_DAYS * 86_400}` : `${base}; Max-Age=0`;
}
