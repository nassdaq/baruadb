// Barua Tasks: durable background work for any application.
//
// One Durable Object per project holds that project's tasks in its own
// SQLite storage and runs them with its alarm. A task is delivered by
// POSTing it to the project's handler URL - the developer's own app, on
// any host. A 2xx finishes it; anything else retries with backoff until
// the attempts run out, and then it waits in the dead-letter where a
// person, or the agent that wrote the handler (over MCP), can read why.
//
// The object is the whole engine: single-threaded, state that survives
// anything, an alarm for a scheduler. There is nothing else to run, and
// nothing to pay for while there is nothing to do.
import { DurableObject } from "cloudflare:workers";
import { nextRun, parseCron } from "./cron";

export interface Env {
  QUEUE: DurableObjectNamespace<Queue>;
  /** Mints project keys. Without it no project can be created. */
  TASKS_ADMIN_TOKEN?: string;
}

// ---- the limits, stated plainly
const MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_ATTEMPTS = 5;
const MAX_ATTEMPTS = 25;
const MAX_DELAY_MS = 30 * 86_400_000;
/** Deliveries in flight per wake of the alarm. */
const BATCH = 10;
const DELIVERY_TIMEOUT_MS = 30_000;
/** How long finished tasks and their runs are kept. */
const RETENTION_MS = 7 * 86_400_000;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 3_600_000;
const KEEP_RESULT = 4000;
const KEEP_ERROR = 2000;

/** Exponential with jitter: ~10 s, 20 s, 40 s … capped at an hour, so a
 *  thousand failing tasks never line up and hit a handler in the same second. */
function backoff(failedAttempt: number): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failedAttempt - 1));
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomString(len: number): string {
  // Rejection sampling keeps the distribution uniform.
  const out: string[] = [];
  const limit = 256 - (256 % ALNUM.length);
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < limit && out.length < len) out.push(ALNUM[b % ALNUM.length]);
    }
  }
  return out.join("");
}

type Status = "pending" | "running" | "done" | "dead" | "cancelled";

/** What a payload may hold: plain JSON, which is also exactly what crosses
 *  the RPC boundary. Interfaces for the recursive parts, so the compiler
 *  evaluates them lazily instead of unrolling them against the RPC types. */
export type JsonPrimitive = string | number | boolean | null;
export interface JsonArray extends Array<Json> {}
export interface JsonObject { [key: string]: Json }
export type Json = JsonPrimitive | JsonArray | JsonObject;

type TaskRow = {
  id: string;
  name: string;
  payload: string;
  url: string | null;
  status: Status;
  attempts: number;
  max_attempts: number;
  next_run_at: number | null;
  cron: string | null;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  last_error: string | null;
  result: string | null;
};

type RunRow = {
  id: number;
  task_id: string;
  attempt: number;
  started_at: number;
  finished_at: number | null;
  status: string;
  http_status: number | null;
  error: string | null;
  ms: number | null;
};

export interface CreateInput {
  name?: string;
  payload?: Json;
  /** Deliver to this URL instead of the project's handler. */
  url?: string;
  /** Seconds from now. */
  delay?: number;
  /** ISO timestamp. */
  run_at?: string;
  /** Five-field cron, UTC: the task runs on every match, forever. */
  cron?: string;
  max_attempts?: number;
  /** Creating again with the same key returns the first task instead of a second. */
  idempotency_key?: string;
}

export interface TaskView {
  id: string;
  name: string;
  payload: Json;
  url: string | null;
  status: Status;
  attempts: number;
  max_attempts: number;
  next_run_at: string | null;
  cron: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  last_error: string | null;
  result: string | null;
  deduplicated?: boolean;
}

export interface RunView {
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  http_status: number | null;
  error: string | null;
  ms: number | null;
}

export interface Stats {
  handler_url: string;
  tasks: { pending: number; running: number; done: number; dead: number; cancelled: number };
  next_due: string | null;
  alarm: string | null;
}

const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());

export class Queue extends DurableObject<Env> {
  #ready = false;
  #handlerUrl = "";
  #secret = "";
  #wakes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`create table if not exists settings (key text primary key, value text not null)`);
      sql.exec(`create table if not exists tasks (
        id text primary key, name text not null, payload text not null, url text,
        status text not null, attempts integer not null default 0, max_attempts integer not null,
        next_run_at integer, cron text, idempotency_key text unique,
        created_at integer not null, updated_at integer not null, finished_at integer,
        last_error text, result text)`);
      sql.exec(`create index if not exists tasks_due on tasks (status, next_run_at)`);
      sql.exec(`create index if not exists tasks_made on tasks (created_at)`);
      sql.exec(`create table if not exists runs (
        id integer primary key autoincrement, task_id text not null, attempt integer not null,
        started_at integer not null, finished_at integer, status text not null,
        http_status integer, error text, ms integer)`);
      sql.exec(`create index if not exists runs_task on runs (task_id, id)`);
      const settings = Object.fromEntries(
        sql.exec<{ key: string; value: string }>("select key, value from settings").toArray().map((r) => [r.key, r.value]),
      );
      this.#ready = settings.provisioned === "1";
      this.#handlerUrl = settings.handler_url ?? "";
      this.#secret = settings.secret ?? "";
    });
  }

  #set(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
      key, value,
    );
  }

  /** Called once, when the project key is minted. The key doubles as the
   *  signing secret: the developer already holds it, so deliveries can be
   *  verified without a second secret to manage. */
  async provision(handlerUrl: string, secret: string): Promise<void> {
    new URL(handlerUrl);
    this.#set("provisioned", "1");
    this.#set("handler_url", handlerUrl);
    this.#set("secret", secret);
    this.#ready = true;
    this.#handlerUrl = handlerUrl;
    this.#secret = secret;
  }

  async setHandler(handlerUrl: string): Promise<void> {
    this.#require();
    new URL(handlerUrl);
    this.#set("handler_url", handlerUrl);
    this.#handlerUrl = handlerUrl;
  }

  #require() {
    if (!this.#ready) throw new Error("unauthorized: unknown project key");
  }

  #row(id: string): TaskRow {
    const r = this.ctx.storage.sql.exec<TaskRow>("select * from tasks where id = ?", id).toArray()[0];
    if (!r) throw new Error(`not found: task ${id}`);
    return r;
  }

  #view(r: TaskRow): TaskView {
    return {
      id: r.id,
      name: r.name,
      payload: JSON.parse(r.payload) as Json,
      url: r.url,
      status: r.status,
      attempts: r.attempts,
      max_attempts: r.max_attempts,
      next_run_at: iso(r.next_run_at),
      cron: r.cron,
      idempotency_key: r.idempotency_key,
      created_at: iso(r.created_at)!,
      updated_at: iso(r.updated_at)!,
      finished_at: iso(r.finished_at),
      last_error: r.last_error,
      result: r.result,
    };
  }

  async create(input: CreateInput): Promise<TaskView> {
    this.#require();
    const name = String(input.name ?? "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(name)) throw new Error("invalid: name is required (letters, digits, _ . : -)");
    const payload = JSON.stringify(input.payload ?? {});
    if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`invalid: payload is over ${MAX_PAYLOAD_BYTES} bytes`);
    if (input.url !== undefined) new URL(input.url);
    const maxAttempts = Math.min(MAX_ATTEMPTS, Math.max(1, Math.floor(Number(input.max_attempts ?? DEFAULT_ATTEMPTS)) || DEFAULT_ATTEMPTS));
    const now = Date.now();
    let nextRunAt = now;
    if (input.cron) {
      parseCron(input.cron);
      nextRunAt = nextRun(input.cron, now);
    } else if (input.run_at) {
      const t = Date.parse(input.run_at);
      if (Number.isNaN(t)) throw new Error("invalid: run_at must be an ISO timestamp");
      nextRunAt = Math.max(now, t);
    } else if (input.delay) {
      const ms = Number(input.delay) * 1000;
      if (!(ms >= 0) || ms > MAX_DELAY_MS) throw new Error("invalid: delay is in seconds, up to 30 days");
      nextRunAt = now + ms;
    }
    if (nextRunAt - now > MAX_DELAY_MS) throw new Error("invalid: a task can be scheduled at most 30 days out");
    const idem = input.idempotency_key ? String(input.idempotency_key).slice(0, 200) : null;
    if (idem) {
      const dup = this.ctx.storage.sql.exec<TaskRow>("select * from tasks where idempotency_key = ?", idem).toArray()[0];
      if (dup) return { ...this.#view(dup), deduplicated: true };
    }
    const id = "tsk_" + randomString(16);
    this.ctx.storage.sql.exec(
      `insert into tasks (id, name, payload, url, status, attempts, max_attempts, next_run_at, cron, idempotency_key, created_at, updated_at)
       values (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`,
      id, name, payload, input.url ?? null, maxAttempts, nextRunAt, input.cron ?? null, idem, now, now,
    );
    await this.#arm();
    return this.#view(this.#row(id));
  }

  async get(id: string): Promise<TaskView & { runs: RunView[] }> {
    this.#require();
    const r = this.#row(id);
    const runs = this.ctx.storage.sql
      .exec<RunRow>("select * from runs where task_id = ? order by id", id)
      .toArray()
      .map((x): RunView => ({
        attempt: x.attempt,
        started_at: iso(x.started_at),
        finished_at: iso(x.finished_at),
        status: x.status,
        http_status: x.http_status,
        error: x.error,
        ms: x.ms,
      }));
    return { ...this.#view(r), runs };
  }

  async list(q: { status?: string; name?: string; limit?: number }): Promise<TaskView[]> {
    this.#require();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.status) { where.push("status = ?"); args.push(q.status); }
    if (q.name) { where.push("name = ?"); args.push(q.name); }
    const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit ?? 50)) || 50));
    args.push(limit);
    return this.ctx.storage.sql
      .exec<TaskRow>(`select * from tasks ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc limit ?`, ...args)
      .toArray()
      .map((r) => this.#view(r));
  }

  /** Back in the queue, to run now - the thing to do once the handler is fixed. */
  async retry(id: string): Promise<TaskView> {
    this.#require();
    const r = this.#row(id);
    if (r.status === "pending" || r.status === "running") throw new Error(`invalid: task is already ${r.status}`);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "update tasks set status = 'pending', attempts = 0, next_run_at = ?, updated_at = ?, finished_at = null, last_error = null where id = ?",
      now, now, id,
    );
    await this.#arm();
    return this.#view(this.#row(id));
  }

  async cancel(id: string): Promise<TaskView> {
    this.#require();
    const r = this.#row(id);
    if (r.status === "done" || r.status === "dead") throw new Error(`invalid: task already finished (${r.status})`);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "update tasks set status = 'cancelled', next_run_at = null, updated_at = ?, finished_at = ? where id = ?",
      now, now, id,
    );
    await this.#arm();
    return this.#view(this.#row(id));
  }

  async stats(): Promise<Stats> {
    this.#require();
    const counts = Object.fromEntries(
      this.ctx.storage.sql.exec<{ status: string; n: number }>("select status, count(*) as n from tasks group by status").toArray().map((r) => [r.status, r.n]),
    );
    const next = this.ctx.storage.sql.exec<{ t: number | null }>("select min(next_run_at) as t from tasks where status = 'pending'").one().t;
    const alarm = await this.ctx.storage.getAlarm();
    return {
      handler_url: this.#handlerUrl,
      tasks: {
        pending: counts.pending ?? 0,
        running: counts.running ?? 0,
        done: counts.done ?? 0,
        dead: counts.dead ?? 0,
        cancelled: counts.cancelled ?? 0,
      },
      next_due: iso(next),
      alarm: iso(alarm),
    };
  }

  /** The alarm is the scheduler: it always points at the earliest pending task. */
  async #arm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ t: number | null }>("select min(next_run_at) as t from tasks where status = 'pending'").one().t;
    if (next == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec<TaskRow>("select * from tasks where status = 'pending' and next_run_at <= ? order by next_run_at limit ?", now, BATCH)
      .toArray();
    for (const t of due) this.ctx.storage.sql.exec("update tasks set status = 'running', updated_at = ? where id = ?", now, t.id);
    await Promise.allSettled(due.map((t) => this.#deliver(t)));
    if (++this.#wakes % 50 === 0) this.#prune();
    await this.#arm();
  }

  async #deliver(t: TaskRow): Promise<void> {
    const attempt = t.attempts + 1;
    const started = Date.now();
    const url = t.url ?? this.#handlerUrl;
    const body = JSON.stringify({
      id: t.id,
      name: t.name,
      payload: JSON.parse(t.payload),
      attempt,
      max_attempts: t.max_attempts,
      scheduled_at: iso(t.next_run_at ?? started),
    });
    let httpStatus: number | null = null;
    let error: string | null = null;
    let result: string | null = null;
    let retryable = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "barua-tasks/1",
          "x-barua-task-id": t.id,
          "x-barua-task-name": t.name,
          "x-barua-attempt": String(attempt),
          "x-barua-signature": await hmac(this.#secret, body),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      httpStatus = res.status;
      const text = (await res.text().catch(() => "")).slice(0, KEEP_RESULT);
      if (res.ok) result = text;
      else {
        error = `HTTP ${res.status}${text ? ": " + text.slice(0, KEEP_ERROR) : ""}`;
        // A handler that says "bad request" will say it again; only a
        // server-side or transient failure is worth another try.
        retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      }
    } catch (e) {
      error = (e instanceof Error ? (e.name === "TimeoutError" ? `timed out after ${DELIVERY_TIMEOUT_MS / 1000}s` : e.message) : String(e)).slice(0, KEEP_ERROR);
    }
    const finished = Date.now();
    const ms = finished - started;
    const sql = this.ctx.storage.sql;
    // Every update is guarded on status = 'running': a cancel that landed
    // while the delivery was in flight wins.
    if (error === null) {
      sql.exec("insert into runs (task_id, attempt, started_at, finished_at, status, http_status, ms) values (?, ?, ?, ?, 'ok', ?, ?)", t.id, attempt, started, finished, httpStatus, ms);
      if (t.cron) {
        sql.exec("update tasks set status = 'pending', attempts = 0, next_run_at = ?, updated_at = ?, last_error = null, result = ? where id = ? and status = 'running'", nextRun(t.cron, finished), finished, result, t.id);
      } else {
        sql.exec("update tasks set status = 'done', attempts = ?, next_run_at = null, updated_at = ?, finished_at = ?, last_error = null, result = ? where id = ? and status = 'running'", attempt, finished, finished, result, t.id);
      }
      return;
    }
    const exhausted = !retryable || attempt >= t.max_attempts;
    sql.exec("insert into runs (task_id, attempt, started_at, finished_at, status, http_status, error, ms) values (?, ?, ?, ?, ?, ?, ?, ?)", t.id, attempt, started, finished, exhausted ? "dead" : "retry", httpStatus, error, ms);
    if (!exhausted) {
      sql.exec("update tasks set status = 'pending', attempts = ?, next_run_at = ?, updated_at = ?, last_error = ? where id = ? and status = 'running'", attempt, finished + backoff(attempt), finished, error, t.id);
      return;
    }
    if (t.cron) {
      // A schedule never dies: the missed occurrence is on record, the next is booked.
      sql.exec("update tasks set status = 'pending', attempts = 0, next_run_at = ?, updated_at = ?, last_error = ? where id = ? and status = 'running'", nextRun(t.cron, finished), finished, error, t.id);
    } else {
      sql.exec("update tasks set status = 'dead', attempts = ?, next_run_at = null, updated_at = ?, finished_at = ?, last_error = ? where id = ? and status = 'running'", attempt, finished, finished, error, t.id);
    }
  }

  #prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    const sql = this.ctx.storage.sql;
    sql.exec("delete from runs where task_id in (select id from tasks where finished_at is not null and finished_at < ?)", cutoff);
    sql.exec("delete from tasks where finished_at is not null and finished_at < ?", cutoff);
    sql.exec("delete from runs where id in (select r.id from runs r join tasks t on t.id = r.task_id where t.cron is not null and r.started_at < ?)", cutoff);
  }
}

// ---------------------------------------------------------------- HTTP

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json", ...CORS } });
const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const statusOf = (msg: string) =>
  msg.startsWith("unauthorized") ? 401 : msg.startsWith("invalid") ? 400 : msg.startsWith("not found") ? 404 : 500;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (p === "/" || p === "/health") return json({ service: "barua-tasks", ok: true });

    // Minting a project: the operator's token and a handler URL in, a key out.
    // The key is the project: it names the object and signs its deliveries.
    if (p === "/projects" && m === "POST") {
      if (!env.TASKS_ADMIN_TOKEN || !constantTimeEqual(bearer(request), env.TASKS_ADMIN_TOKEN)) return json({ error: "admin token required" }, 401);
      const b = (await request.json().catch(() => ({}))) as { handler_url?: string };
      if (!b.handler_url) return json({ error: "handler_url is required: where tasks are delivered" }, 400);
      try { new URL(b.handler_url); } catch { return json({ error: "handler_url must be a URL" }, 400); }
      const key = "tk_" + randomString(32);
      await env.QUEUE.getByName(await sha256(key)).provision(b.handler_url, key);
      return json({ project_key: key, handler_url: b.handler_url, note: "Save the key: it is the project, and deliveries are signed with it (x-barua-signature)." }, 201);
    }

    const key = bearer(request);
    if (!key) return json({ error: "a project key is required: Authorization: Bearer tk_…" }, 401);
    const stub = env.QUEUE.getByName(await sha256(key));
    try {
      if (p === "/mcp" && m === "POST") return mcp(request, stub);
      if (p === "/tasks" && m === "POST") {
        const r = await stub.create((await request.json().catch(() => ({}))) as CreateInput);
        return json(r, r.deduplicated ? 200 : 201);
      }
      if (p === "/tasks" && m === "GET") {
        return json({
          tasks: await stub.list({
            status: url.searchParams.get("status") ?? undefined,
            name: url.searchParams.get("name") ?? undefined,
            limit: Number(url.searchParams.get("limit") ?? 50),
          }),
        });
      }
      if (p === "/stats" && m === "GET") return json(await stub.stats());
      if (p === "/handler" && m === "POST") {
        const b = (await request.json().catch(() => ({}))) as { handler_url?: string };
        if (!b.handler_url) return json({ error: "handler_url is required" }, 400);
        await stub.setHandler(b.handler_url);
        return json({ handler_url: b.handler_url });
      }
      const mt = /^\/tasks\/([a-z0-9_]+)(?:\/(retry))?$/.exec(p);
      if (mt) {
        const [, id, action] = mt;
        if (action === "retry" && m === "POST") return json(await stub.retry(id));
        if (!action && m === "GET") return json(await stub.get(id));
        if (!action && m === "DELETE") return json(await stub.cancel(id));
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, statusOf(msg));
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- MCP
// The same queue as a set of tools, so the agent that wrote a handler can
// see its tasks fail, read why, fix the code and put them back.

const TOOLS = [
  {
    name: "failed_tasks",
    description: "The dead-letter: tasks that ran out of attempts or hit a non-retryable error, each with its last error and payload. Read this first to find what to fix.",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
  },
  {
    name: "get_task",
    description: "One task with every delivery attempt - when it ran, the HTTP status, the error text. Exactly why a task failed.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_tasks",
    description: "This project's tasks, newest first; filter by status (pending, running, done, dead, cancelled) and/or name.",
    inputSchema: { type: "object", properties: { status: { type: "string" }, name: { type: "string" }, limit: { type: "integer" } } },
  },
  {
    name: "retry_task",
    description: "Put a dead, done or cancelled task back in the queue to run now - the thing to do after fixing the handler.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_task",
    description: "Enqueue a task: name, JSON payload, and optionally delay (seconds), run_at (ISO), cron (5 fields, UTC), max_attempts, idempotency_key.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }, payload: { type: "object" }, delay: { type: "number" }, run_at: { type: "string" },
        cron: { type: "string" }, max_attempts: { type: "integer" }, idempotency_key: { type: "string" },
      },
      required: ["name"],
    },
  },
  { name: "cancel_task", description: "Cancel a pending task.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "queue_stats", description: "Counts by status, the handler URL, and when the next task is due.", inputSchema: { type: "object", properties: {} } },
];

async function mcp(request: Request, stub: DurableObjectStub<Queue>): Promise<Response> {
  let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };
  try {
    msg = (await request.json()) as typeof msg;
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  const { id, method, params } = msg;
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id, result });
  if (method === "initialize") return reply({ protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "barua-tasks", version: "1.0.0" } });
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: TOOLS });
  if (method === "resources/list") return reply({ resources: [] });
  if (method === "prompts/list") return reply({ prompts: [] });
  if (method?.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (method === "tools/call") {
    const a = params?.arguments ?? {};
    const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
    try {
      switch (params?.name) {
        case "failed_tasks": {
          const dead = await stub.list({ status: "dead", limit: Number(a.limit ?? 20) });
          return reply(text(dead.length ? dead.map((t) => ({ id: t.id, name: t.name, attempts: t.attempts, last_error: t.last_error, payload: t.payload, finished_at: t.finished_at })) : "No failed tasks."));
        }
        case "get_task": return reply(text(await stub.get(String(a.id))));
        case "list_tasks": return reply(text(await stub.list({ status: a.status as string | undefined, name: a.name as string | undefined, limit: Number(a.limit ?? 50) })));
        case "retry_task": return reply(text(await stub.retry(String(a.id))));
        case "create_task": return reply(text(await stub.create(a as CreateInput)));
        case "cancel_task": return reply(text(await stub.cancel(String(a.id))));
        case "queue_stats": return reply(text(await stub.stats()));
        default: return reply({ content: [{ type: "text", text: `unknown tool ${params?.name}` }], isError: true });
      }
    } catch (e) {
      return reply({ content: [{ type: "text", text: "error: " + (e instanceof Error ? e.message : String(e)) }], isError: true });
    }
  }
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `method not found: ${method}` } });
}
