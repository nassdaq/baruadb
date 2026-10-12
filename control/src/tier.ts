// Two engines, one hostname.
//
// A database on the box engine is a Postgres cluster on a Linode box, with
// its history in R2. A database on the function engine is Postgres compiled
// to WebAssembly inside a Durable Object, with its data directory in the
// object's storage: it costs nothing while nobody is talking to it. Both are
// reached through the same hostname; the box's proxy serves its own clusters
// and relays the rest.
//
// Nothing here is visible to a customer. A database moves up when its own
// numbers say the function engine has become the expensive place for it, and
// down when it has been quiet for weeks. The move is a logical copy (pg_dump,
// played back on the other side), checked table by table before the source
// is let go, and the source stays frozen - not deleted - until that check
// passes.

import { agent, Box, Env, lite, liteEnabled, liteFetch, loadBox, pickBox, setDns } from "./infra";
import { openPassword } from "./secrets";
import { DbRow } from "./types";
import { HttpError, now, randomString, sha256 } from "./util";

const MB = 1024 * 1024;
const DAY_MS = 86_400_000;

/** Run the measured part of the loop this often (the cron fires every 2 min). */
const PASS_EVERY_MS = 30 * 60_000;
/** Evidence window for a promotion, and the age a database must have before
 *  a burst on its first day counts. */
const UP_WINDOW_DAYS = 3;
/** A function costing more than this a month earns a box (a box slot is
 *  about $1/mo of RAM while awake, nothing while asleep). */
const UP_COST_PER_MONTH = 2;
/** Bigger than this and the move itself gets expensive; go up early. */
const UP_SIZE_BYTES = 64 * MB;
/** Quiet this long on a box and small enough to copy cheaply: go down. */
const DOWN_QUIET_DAYS = 14;
const DOWN_SIZE_BYTES = 160 * MB; // the whole cluster on disk; ~40 MB of it is Postgres itself
const MOVES_PER_PASS = 3;

// Cloudflare's prices for what a function uses, per unit.
const DO_ROW_WRITE = 1 / 1e6; // $ per row written; a block write is about two rows (block + node)
const DO_GB_SECOND = 12.5 / 1e6; // $ per GB-second of wall time while awake
const DO_GB = 0.128; // an isolate is billed at 128 MB

export async function verifierFor(password: string): Promise<string> {
  const salt = randomString(16);
  return `sha256$${salt}$${await sha256(`${salt}:${password}`)}`;
}

// ---------------------------------------------------------------- the copy

/** pg_dump output from one engine, made loadable by the other: psql
 *  meta-commands and settings the other version does not know. */
function portable(): TransformStream<string, string> {
  let rest = "";
  const keep = (line: string) =>
    !line.startsWith("\\restrict") && !line.startsWith("\\unrestrict") && !line.startsWith("SET transaction_timeout");
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      const out = lines.filter(keep);
      if (out.length) controller.enqueue(out.join("\n") + "\n");
    },
    flush(controller) {
      if (rest && keep(rest)) controller.enqueue(rest);
    },
  });
}

/** Exact row counts of every table, in one statement that runs on either engine. */
const COUNT_SQL = `
  select n.nspname || '.' || c.relname as t,
         (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text as n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
   order by 1`;

type Counts = Record<string, number>;

async function countsOnBox(box: Box, id: string): Promise<Counts> {
  const r = await agent<{ rows: (string | null)[][] }>(box, "POST", `/v1/databases/${id}/query`, { sql: COUNT_SQL, limit: 1000 });
  return Object.fromEntries(r.rows.map((row) => [String(row[0]), Number(row[1])]));
}

async function countsOnFunction(env: Env, id: string): Promise<Counts> {
  const r = await lite<{ rows: { t: string; n: string | number }[] }>(env, "POST", `/db/${id}/query?force=1`, { sql: COUNT_SQL });
  return Object.fromEntries(r.rows.map((row) => [row.t, Number(row.n)]));
}

/** The first difference between two copies, or null when they match. */
function differ(src: Counts, dst: Counts): string | null {
  for (const [t, n] of Object.entries(src)) {
    if (!(t in dst)) return `${t} is missing from the copy`;
    if (dst[t] !== n) return `${t} has ${dst[t]} rows in the copy, ${n} in the source`;
  }
  for (const t of Object.keys(dst)) if (!(t in src)) return `${t} appeared in the copy`;
  return null;
}

async function waitReady(box: Box, id: string, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const live = await agent<{ status: string; error?: string }>(box, "GET", `/v1/databases/${id}`);
    if (live.status === "ready") return;
    if (live.status === "failed") throw new HttpError(502, `box could not create the database: ${live.error ?? "unknown"}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new HttpError(504, "box did not finish creating the database in time");
}

async function record(env: Env, db: string, direction: "up" | "down", reason: string, ok: boolean, detail: string | null, ms: number) {
  await env.DB.prepare("INSERT INTO moves (db_id, direction, reason, ok, detail, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(db, direction, reason, ok ? 1 : 0, detail, ms, now())
    .run()
    .catch(() => {});
}

// ---------------------------------------------------------------- moves

/** Function -> box. The function is frozen first, so nothing written during
 *  the copy is lost; the box copy is born frozen, so nobody sees it half
 *  filled; the function is tombstoned only once the counts agree. */
export async function promote(env: Env, db: DbRow, reason: string, target?: Box): Promise<Box> {
  if (db.engine !== "function") throw new HttpError(409, "this database is already on a box");
  const password = await openPassword(env.PASSWORD_KEY, db.password_enc);
  if (!password) throw new HttpError(409, "no stored password for this database; reset it first");
  const box = target ?? (await pickBox(env, db.box_id, db.zone ?? undefined));
  const t0 = Date.now();
  await lite(env, "POST", `/db/${db.id}/freeze`, { frozen: true });
  let created = false;
  try {
    await agent(box, "POST", "/v1/databases", { id: db.id, role: db.role, database: db.dbname, password, frozen: true });
    created = true;
    await waitReady(box, db.id);

    const dump = await liteFetch(env, `/db/${db.id}/dump?force=1`);
    if (!dump.ok || !dump.body) throw new HttpError(502, `function engine: dump ${dump.status} ${await dump.text()}`);
    const loaded = await fetch(`${box.api_url}/v1/databases/${db.id}/load`, {
      method: "POST",
      headers: { authorization: `Bearer ${box.agent_token}`, "content-type": "application/sql" },
      body: dump.body.pipeThrough(new TextDecoderStream()).pipeThrough(portable()).pipeThrough(new TextEncoderStream()),
    });
    if (!loaded.ok) throw new HttpError(502, `box ${box.id}: ${await loaded.text()}`);

    const [src, dst] = await Promise.all([countsOnFunction(env, db.id), countsOnBox(box, db.id)]);
    const diff = differ(src, dst);
    if (diff) throw new HttpError(500, `the copy does not match: ${diff}`);

    await env.DB.prepare(
      "UPDATE databases SET engine = 'box', engine_since = ?, box_id = ?, status = 'ready', location = 'local', auth_verifier = NULL WHERE id = ?",
    ).bind(now(), box.id, db.id).run();
    await agent(box, "POST", `/v1/databases/${db.id}/freeze`, { frozen: false });
    if (box.id !== db.box_id) await setDns(env, db, box);
    // What is left in the object is a stale copy: tombstone it, so a client
    // that still has the old route is refused rather than shown an empty one.
    await lite(env, "POST", `/db/${db.id}/destroy`).catch((e) => console.warn(`destroy ${db.id} after promote: ${e}`));
    await record(env, db.id, "up", reason, true, `${Object.keys(dst).length} tables`, Date.now() - t0);
    return box;
  } catch (e) {
    if (created) await agent(box, "DELETE", `/v1/databases/${db.id}?purge=true`).catch(() => {});
    await lite(env, "POST", `/db/${db.id}/freeze`, { frozen: false }).catch(() => {});
    await record(env, db.id, "up", reason, false, String(e), Date.now() - t0);
    throw e;
  }
}

/** Box -> function. Same shape in reverse; the box copy is deleted only
 *  after the row has flipped, and a leftover frozen copy is inert. */
export async function demote(env: Env, db: DbRow, reason: string): Promise<void> {
  if (db.engine !== "box") throw new HttpError(409, "this database is already a function");
  if (db.parent_id) throw new HttpError(409, "branches stay with the full engine");
  const kids = await env.DB.prepare("SELECT count(*) AS n FROM databases WHERE parent_id = ?").bind(db.id).first<{ n: number }>();
  if (kids?.n) throw new HttpError(409, "a database with branches stays with the full engine");
  const password = await openPassword(env.PASSWORD_KEY, db.password_enc);
  if (!password) throw new HttpError(409, "no stored password for this database; reset it first");
  const box = await loadBox(env, db.box_id);
  const t0 = Date.now();

  await agent(box, "POST", `/v1/databases/${db.id}/freeze`, { frozen: true });
  let restored = false;
  let flipped = false;
  try {
    const ext = await agent<{ rows: (string | null)[][] }>(box, "POST", `/v1/databases/${db.id}/query`, {
      sql: "select extname from pg_extension where extname <> 'plpgsql'",
    });
    if (ext.rows.length) throw new HttpError(409, `uses extensions (${ext.rows.map((r) => r[0]).join(", ")}), which the function engine cannot load`);

    const dump = await fetch(`${box.api_url}/v1/databases/${db.id}/dump?inserts=true`, {
      headers: { authorization: `Bearer ${box.agent_token}` },
    });
    if (!dump.ok || !dump.body) throw new HttpError(502, `box ${box.id}: dump ${dump.status} ${await dump.text()}`);
    const r = await liteFetch(env, `/db/${db.id}/restore`, { method: "POST", headers: { "content-type": "application/sql" }, body: dump.body });
    if (!r.ok) throw new HttpError(502, `function engine: ${await r.text()}`);
    restored = true;

    const [src, dst] = await Promise.all([countsOnBox(box, db.id), countsOnFunction(env, db.id)]);
    const diff = differ(src, dst);
    if (diff) throw new HttpError(500, `the copy does not match: ${diff}`);

    await env.DB.prepare(
      `UPDATE databases SET engine = 'function', engine_since = ?, auth_verifier = ?, status = 'ready', location = 'local',
         running = 0, connections = 0 WHERE id = ?`,
    ).bind(now(), await verifierFor(password), db.id).run();
    flipped = true;
  } catch (e) {
    if (restored) await lite(env, "POST", `/db/${db.id}/destroy`).catch(() => {});
    await agent(box, "POST", `/v1/databases/${db.id}/freeze`, { frozen: false }).catch(() => {});
    await record(env, db.id, "down", reason, false, String(e), Date.now() - t0);
    throw e;
  }
  // From here the function is the database. The box copy is frozen, so even
  // if this delete fails it can never be served; it just sits there.
  let note = "";
  await agent(box, "DELETE", `/v1/databases/${db.id}?purge=true`).catch((e) => {
    note = `; box copy not deleted: ${e}`;
  });
  if (flipped) await record(env, db.id, "down", reason, true, `moved${note}`, Date.now() - t0);
}

// ---------------------------------------------------------------- the loop

interface UpCandidate {
  db: DbRow;
  reason: string;
}

/** Functions whose own numbers say a box would be cheaper, or that have
 *  grown past the point where moving is cheap. */
async function upCandidates(env: Env): Promise<UpCandidate[]> {
  const since = new Date(Date.now() - UP_WINDOW_DAYS * DAY_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT d.*, sum(m.blocks_written) AS blocks, sum(m.active_ms) AS active, max(m.storage_bytes) AS storage, min(m.at) AS first_at
       FROM databases d JOIN metrics m ON m.db_id = d.id AND m.at > ?
      WHERE d.engine = 'function' AND d.status = 'ready'
      GROUP BY d.id`,
  ).bind(since).all<DbRow & { blocks: number | null; active: number | null; storage: number | null; first_at: string }>();
  const out: UpCandidate[] = [];
  for (const r of results) {
    const born = Date.parse(r.engine_since ?? r.created_at);
    const days = Math.max(0.5, Math.min(UP_WINDOW_DAYS, (Date.now() - Math.max(born, Date.parse(r.first_at))) / DAY_MS));
    const rowsPerDay = ((r.blocks ?? 0) * 2) / days;
    const activeSecPerDay = (r.active ?? 0) / 1000 / days;
    const perMonth = rowsPerDay * 30 * DO_ROW_WRITE + activeSecPerDay * 30 * DO_GB * DO_GB_SECOND;
    if ((r.storage ?? 0) >= UP_SIZE_BYTES) {
      out.push({ db: r, reason: `grew to ${Math.round((r.storage ?? 0) / MB)} MB` });
    } else if (perMonth >= UP_COST_PER_MONTH && days >= 1) {
      out.push({
        db: r,
        reason: `~$${perMonth.toFixed(2)}/mo as a function (${Math.round(rowsPerDay)} rows/day, ${(activeSecPerDay / 3600).toFixed(1)} h/day awake)`,
      });
    }
  }
  return out;
}

interface LiveDb {
  id: string;
  status: string;
  location: string;
  running: boolean;
  frozen?: boolean;
  last_used_at: string;
  pgdata_bytes?: number | null;
}

/** Box databases nobody has touched for weeks, small enough to copy. */
async function downCandidates(env: Env): Promise<UpCandidate[]> {
  const cutoff = new Date(Date.now() - DOWN_QUIET_DAYS * DAY_MS).toISOString();
  const { results: boxes } = await env.DB.prepare("SELECT * FROM boxes WHERE status = 'active'").all<Box>();
  const out: UpCandidate[] = [];
  for (const box of boxes) {
    let live: LiveDb[];
    try {
      live = await agent<LiveDb[]>(box, "GET", "/v1/databases");
    } catch {
      continue; // an unreachable box moves nothing
    }
    const byId = new Map(live.map((d) => [d.id, d]));
    const { results } = await env.DB.prepare(
      `SELECT * FROM databases
        WHERE engine = 'box' AND status = 'ready' AND parent_id IS NULL AND password_enc IS NOT NULL AND zone IS NULL AND box_id = ?
          AND coalesce(engine_since, created_at) < ?
          AND id NOT IN (SELECT parent_id FROM databases WHERE parent_id IS NOT NULL)`,
    ).bind(box.id, cutoff).all<DbRow>();
    for (const db of results) {
      const l = byId.get(db.id);
      if (!l || l.status !== "ready" || l.running || l.frozen || l.location !== "local") continue;
      if (l.last_used_at > cutoff) continue;
      if (l.pgdata_bytes == null || l.pgdata_bytes > DOWN_SIZE_BYTES) continue;
      const quiet = Math.floor((Date.now() - Date.parse(l.last_used_at)) / DAY_MS);
      out.push({ db, reason: `quiet for ${quiet} days, ${Math.round(l.pgdata_bytes / MB)} MB on disk` });
    }
  }
  return out;
}

/** One pass of the loop. Cheap bookkeeping every call; the measured part
 *  (which asks every box for its list) every PASS_EVERY_MS. */
export async function tierPass(env: Env, budgetMs = 10 * 60_000): Promise<string[]> {
  const log: string[] = [];
  if (!liteEnabled(env)) return log;
  // A function nobody has heard from for a while is not awake.
  await env.DB.prepare(
    "UPDATE databases SET running = 0, connections = 0 WHERE engine = 'function' AND running = 1 AND id NOT IN (SELECT db_id FROM metrics WHERE at > ?)",
  ).bind(new Date(Date.now() - 12 * 60_000).toISOString()).run();

  const last = await env.DB.prepare("SELECT value FROM kv WHERE key = 'tier_pass_at'").first<{ value: string }>();
  if (last && Date.now() - Date.parse(last.value) < PASS_EVERY_MS) return log;
  await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('tier_pass_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(now()).run();

  const deadline = Date.now() + budgetMs;
  let moves = 0;
  for (const c of await upCandidates(env)) {
    if (moves >= MOVES_PER_PASS || Date.now() > deadline) break;
    moves++;
    try {
      await promote(env, c.db, c.reason);
      log.push(`up ${c.db.id}: ${c.reason}`);
    } catch (e) {
      log.push(`up ${c.db.id} failed: ${e}`);
    }
  }
  for (const c of await downCandidates(env)) {
    if (moves >= MOVES_PER_PASS || Date.now() > deadline) break;
    moves++;
    try {
      await demote(env, c.db, c.reason);
      log.push(`down ${c.db.id}: ${c.reason}`);
    } catch (e) {
      log.push(`down ${c.db.id} failed: ${e}`);
    }
  }
  for (const line of log) console.log(`tier: ${line}`);
  return log;
}
