// The Barua Tasks client. Web-standard - fetch and WebCrypto only - so it
// runs the same in Node 18+, Workers, Deno, Bun and a browser. No
// dependencies. Docs: https://barua.app/docs/tasks
//
//   npm install barua-tasks                      → import { … } from "barua-tasks"
//   curl -O https://barua-tasks.kelvineffect.workers.dev/sdk.mjs   (one file, vendor it)
//   import { … } from "https://barua-tasks.kelvineffect.workers.dev/sdk.mjs"   (Deno, browsers)
//
//   const tasks = createTasks({ key: process.env.BARUA_TASKS_KEY });
//   await tasks.create({ name: "send-welcome-email", payload: { userId: "user_123" } });
//   await tasks.create({ name: "nightly-report", cron: "0 2 * * *" });
//   await tasks.create({ name: "remind", payload: { id: 7 }, delay: 3600 });
//
// On the receiving side `handler` wraps your function as a fetch handler:
// it checks the signature, parses the task, and turns what you return into
// the right answer. Return a value (or nothing) to finish the task; throw to
// have it retried; throw with `status: 400` to fail it for good.

const DEFAULT_URL = "https://barua-tasks.kelvineffect.workers.dev";

export function createTasks({ key, url = DEFAULT_URL } = {}) {
  if (!key) throw new Error("createTasks: a project key is required");
  const base = url.replace(/\/$/, "");
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error ?? `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return data;
  };
  const qs = (q) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null) s.set(k, String(v));
    const t = s.toString();
    return t ? "?" + t : "";
  };
  return {
    /** { name, payload?, delay?, run_at?, cron?, max_attempts?, idempotency_key?, url? } */
    create: (task) => call("POST", "/tasks", task),
    get: (id) => call("GET", `/tasks/${id}`),
    list: (q) => call("GET", `/tasks${qs(q)}`).then((r) => r.tasks),
    /** The dead-letter. */
    failed: (limit = 20) => call("GET", `/tasks${qs({ status: "dead", limit })}`).then((r) => r.tasks),
    retry: (id) => call("POST", `/tasks/${id}/retry`),
    cancel: (id) => call("DELETE", `/tasks/${id}`),
    stats: () => call("GET", "/stats"),
    setHandler: (handler_url) => call("POST", "/handler", { handler_url }),
  };
}

const enc = new TextEncoder();
async function hmacHex(secret, body) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when `signature` (the x-barua-signature header) matches `body` under your project key. */
export async function verify({ key, body, signature }) {
  if (!key || typeof body !== "string" || !signature) return false;
  const want = await hmacHex(key, body);
  if (want.length !== signature.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ signature.charCodeAt(i);
  return d === 0;
}

/** Your task function as a fetch handler: Workers, Next.js route handlers, Hono, Deno, Bun. */
export function handler(key, fn) {
  const reply = (data, status) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  return async (request) => {
    const body = await request.text();
    if (!(await verify({ key, body, signature: request.headers.get("x-barua-signature") ?? "" }))) return reply({ error: "bad signature" }, 401);
    const task = JSON.parse(body);
    try {
      const out = await fn(task);
      return reply(out ?? { ok: true }, 200);
    } catch (e) {
      const status = e && typeof e.status === "number" ? e.status : 500;
      return reply({ error: e instanceof Error ? e.message : String(e) }, status);
    }
  };
}
