export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  // A Headers object can carry two Set-Cookie lines; a plain record cannot.
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(data, null, 2), { status, headers: h });
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomString(len: number, alphabet = ALNUM): string {
  // Rejection sampling keeps the distribution uniform.
  const out: string[] = [];
  const limit = 256 - (256 % alphabet.length);
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < limit && out.length < len) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join("");
}

export const newId = (prefix: string, len = 10) => `${prefix}${randomString(len, ALPHABET)}`;
export const newPassword = () => randomString(24);

export async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export const now = () => new Date().toISOString();

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
export function checkName(what: string, v: string): string {
  if (!NAME.test(v)) throw new HttpError(400, `${what} must be 1-63 chars of a-z, 0-9 or _, starting with a letter`);
  return v;
}
