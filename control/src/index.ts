// BaruaDB control plane: accounts, databases and boxes live in D1; the
// Postgres work happens on the boxes, which this Worker drives over HTTPS.

import { agent, Box, deleteDns, Env, upsertDns } from "./infra";
import { openPassword, sealPassword } from "./secrets";
import {
  createSession,
  destroySession,
  hashPassword,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  User,
  userForSession,
  validateCredentials,
  verifyPassword,
} from "./auth";
import {
  bearer,
  body,
  checkName,
  HttpError,
  json,
  newId,
  newPassword,
  now,
  randomString,
  sha256,
  timingSafeEqual,
} from "./util";

interface DbRow {
  id: string;
  name: string;
  owner: string;
  user_id: string | null;
  box_id: string;
  parent_id: string | null;
  role: string;
  dbname: string;
  status: string;
  location: string;
  running: number;
  connections: number;
  dns_record_id: string | null;
  password_enc: string | null;
  created_at: string;
}

// Three ways to arrive: the operator's admin token, a signed-in person, or an
// API key belonging to one. A person and their keys share an owner id, so a
// database created in the dashboard is visible to that person's keys too.
type Caller =
  | { kind: "admin" }
  | { kind: "user"; id: string; isAdmin: boolean; user: User }
  | { kind: "key"; id: string };

const ONLINE_MS = 90_000;
const isOnline = (b: Box) => b.last_seen !== null && Date.now() - Date.parse(b.last_seen) < ONLINE_MS;

// ---------------------------------------------------------------- auth

async function caller(req: Request, env: Env): Promise<Caller> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) {
    const user = await userForSession(env.DB, cookie);
    if (user) return { kind: "user", id: user.id, isAdmin: user.is_admin === 1, user };
  }
  const token = bearer(req);
  if (!token) throw new HttpError(401, "sign in, or send Authorization: Bearer <api key>");
  if (env.ADMIN_TOKEN && timingSafeEqual(token, env.ADMIN_TOKEN)) return { kind: "admin" };
  const key = await env.DB.prepare("SELECT id FROM api_keys WHERE key_hash = ?").bind(await sha256(token)).first<{ id: string }>();
  if (!key) throw new HttpError(401, "invalid API key");
  return { kind: "key", id: key.id };
}

/** Box and fleet operations: the operator's token only. */
async function admin(req: Request, env: Env): Promise<void> {
  if ((await caller(req, env)).kind !== "admin") throw new HttpError(403, "admin token required");
}

/** The admin plane in the dashboard: the operator's token, or a user flagged
 *  as an admin. It can see who has an account and how much they use, never
 *  what is inside anyone's database. */
async function staff(req: Request, env: Env): Promise<Caller> {
  const c = await caller(req, env);
  if (c.kind === "admin" || (c.kind === "user" && c.isAdmin)) return c;
  throw new HttpError(403, "not allowed");
}

const ownerOf = (c: Caller) => (c.kind === "admin" ? "admin" : c.id);

async function loadDb(env: Env, c: Caller, id: string): Promise<DbRow> {
  const row = await env.DB.prepare("SELECT * FROM databases WHERE id = ?").bind(id).first<DbRow>();
  if (!row || (c.kind !== "admin" && row.owner !== c.id)) throw new HttpError(404, "database not found");
  return row;
}

async function loadBox(env: Env, id: string): Promise<Box> {
  const box = await env.DB.prepare("SELECT * FROM boxes WHERE id = ?").bind(id).first<Box>();
  if (!box) throw new HttpError(404, `box ${id} not found`);
  return box;
}

// ---------------------------------------------------------------- placement

/** The online, active box with the most headroom. */
async function pickBox(env: Env, prefer?: string): Promise<Box> {
  const { results } = await env.DB.prepare("SELECT * FROM boxes WHERE status = 'active'").all<Box>();
  const online = results.filter(isOnline);
  const preferred = online.find((b) => b.id === prefer);
  if (preferred) return preferred;
  online.sort((a, b) => score(b) - score(a));
  if (!online.length) throw new HttpError(503, "no box available; add one with deploy/install.sh");
  return online[0];
}

// Free memory minus ~100 MB for each awake database, plus a little for disk.
const score = (b: Box) => b.mem_available_mb - b.databases_awake * 100 + Math.min(b.disk_free_mb, 50_000) / 100;

/** Ask the box for live state and store it (heartbeats only run every 20 s). */
async function refresh(env: Env, db: DbRow): Promise<Record<string, unknown>> {
  const live = await agent(await loadBox(env, db.box_id), "GET", `/v1/databases/${db.id}`);
  db.status = live.status;
  db.location = live.location;
  db.running = live.running ? 1 : 0;
  db.connections = live.connections;
  await env.DB.prepare("UPDATE databases SET status = ?, location = ?, running = ?, connections = ? WHERE id = ?")
    .bind(db.status, db.location, db.running, db.connections, db.id)
    .run();
  return live;
}

// ---------------------------------------------------------------- views

function connectionUri(env: Env, db: DbRow, password?: string, pooled = false): string {
  const pw = password ? `:${encodeURIComponent(password)}` : "";
  const host = `${db.id}${pooled ? "-pooler" : ""}.${env.DB_DOMAIN}`;
  return `postgresql://${db.role}${pw}@${host}/${db.dbname}?sslmode=require`;
}

function dbView(env: Env, db: DbRow, c: Caller) {
  return {
    id: db.id,
    name: db.name,
    host: `${db.id}.${env.DB_DOMAIN}`,
    role: db.role,
    database: db.dbname,
    parent_id: db.parent_id,
    status: db.status,
    state: db.location === "cold" ? "cold" : db.running ? "awake" : "asleep",
    connections: db.connections,
    created_at: db.created_at,
    connection_uri: connectionUri(env, db),
    // Transaction pooling: many clients, few backends. Session state does not
    // survive a transaction, which is the price.
    pooled_uri: connectionUri(env, db, undefined, true),
    ...(c.kind === "admin" ? { box_id: db.box_id, owner: db.owner } : {}),
  };
}

// ---------------------------------------------------------------- databases

async function insertDb(env: Env, db: DbRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO databases (id, name, owner, user_id, box_id, parent_id, role, dbname, status, password_enc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
  )
    .bind(db.id, db.name, db.owner, db.user_id, db.box_id, db.parent_id, db.role, db.dbname, db.password_enc, db.created_at)
    .run();
}

async function setDns(env: Env, db: DbRow, box: Box): Promise<void> {
  const rec = await upsertDns(env, db.id, box.public_ip, db.dns_record_id);
  if (rec !== db.dns_record_id) {
    await env.DB.prepare("UPDATE databases SET dns_record_id = ? WHERE id = ?").bind(rec, db.id).run();
    db.dns_record_id = rec;
  }
}

async function createDatabase(req: Request, env: Env, c: Caller): Promise<Response> {
  const b = await body<{ name?: string; role?: string; database?: string }>(req);
  await checkQuota(env, c);
  const box = await pickBox(env);
  const db: DbRow = {
    id: newId("br-"),
    name: (b.name ?? "main").slice(0, 100),
    owner: ownerOf(c),
    user_id: c.kind === "user" ? c.id : null,
    box_id: box.id,
    parent_id: null,
    role: checkName("role", b.role ?? "app"),
    dbname: checkName("database", b.database ?? "app"),
    status: "creating",
    location: "local",
    running: 0,
    connections: 0,
    dns_record_id: null,
    password_enc: null,
    created_at: now(),
  };
  const password = newPassword();
  db.password_enc = await sealPassword(env.PASSWORD_KEY, password);
  await insertDb(env, db);
  try {
    await setDns(env, db, box);
    await agent(box, "POST", "/v1/databases", { id: db.id, role: db.role, database: db.dbname, password });
  } catch (e) {
    await env.DB.prepare("DELETE FROM databases WHERE id = ?").bind(db.id).run();
    await deleteDns(env, db.dns_record_id);
    throw e;
  }
  return json(
    {
      database: dbView(env, db, c),
      password,
      connection_uri: connectionUri(env, db, password),
      note: "Save the password now; it is not shown again. Status turns 'ready' within seconds.",
    },
    201,
  );
}

async function createBranch(req: Request, env: Env, c: Caller, parentId: string): Promise<Response> {
  const parent = await loadDb(env, c, parentId);
  if (parent.status !== "ready") await refresh(env, parent);
  if (parent.status !== "ready") throw new HttpError(409, `parent database is ${parent.status}`);
  const b = await body<{ name?: string; point_in_time?: string }>(req);
  const parentBox = await loadBox(env, parent.box_id);

  let target: unknown;
  if (b.point_in_time) {
    const t = new Date(b.point_in_time);
    if (isNaN(t.getTime()) || t.getTime() > Date.now()) throw new HttpError(400, "point_in_time must be a past ISO timestamp");
    target = { time: t.toISOString() };
  } else {
    // Make the parent's WAL up to "now" durable in R2, then branch at that LSN.
    const { lsn } = await agent<{ lsn: string | null }>(parentBox, "POST", `/v1/databases/${parent.id}/sync`);
    target = lsn ? { lsn } : "latest";
  }

  const box = await pickBox(env, parent.box_id);
  const db: DbRow = {
    ...parent,
    id: newId("br-"),
    name: (b.name ?? `${parent.name}-branch`).slice(0, 100),
    box_id: box.id,
    parent_id: parent.id,
    status: "creating",
    location: "local",
    running: 0,
    connections: 0,
    dns_record_id: null,
    created_at: now(),
  };
  await insertDb(env, db);
  try {
    await setDns(env, db, box);
    await agent(box, "POST", "/v1/databases", {
      id: db.id,
      role: db.role,
      database: db.dbname,
      parent: parent.id,
      restore: { source: parent.id, target },
    });
  } catch (e) {
    await env.DB.prepare("DELETE FROM databases WHERE id = ?").bind(db.id).run();
    await deleteDns(env, db.dns_record_id);
    throw e;
  }
  return json(
    { database: dbView(env, db, c), note: "A branch keeps the parent's roles and passwords as of the branch point." },
    201,
  );
}

async function deleteDatabase(env: Env, c: Caller, id: string): Promise<Response> {
  const db = await loadDb(env, c, id);
  const box = await loadBox(env, db.box_id);
  await agent(box, "DELETE", `/v1/databases/${db.id}?purge=true`).catch((e) => {
    if (!(e instanceof HttpError && e.status === 404)) throw e;
  });
  await deleteDns(env, db.dns_record_id);
  await env.DB.prepare("DELETE FROM databases WHERE id = ?").bind(db.id).run();
  return json({ deleted: db.id });
}

async function resetPassword(env: Env, c: Caller, id: string): Promise<Response> {
  const db = await loadDb(env, c, id);
  const password = newPassword();
  await agent(await loadBox(env, db.box_id), "POST", `/v1/databases/${db.id}/password`, { password });
  await env.DB.prepare("UPDATE databases SET password_enc = ? WHERE id = ?")
    .bind(await sealPassword(env.PASSWORD_KEY, password), db.id)
    .run();
  return json({ password, connection_uri: connectionUri(env, db, password) });
}

/** Move a database to another box (admin). With `force`, the source box is
 *  assumed dead: the database is rebuilt from R2 without asking it. */
async function moveDatabase(req: Request, env: Env, id: string): Promise<Response> {
  const b = await body<{ box_id?: string; force?: boolean }>(req);
  const db = await loadDb(env, { kind: "admin" }, id);
  const source = await loadBox(env, db.box_id);
  const target = b.box_id ? await loadBox(env, b.box_id) : await pickBox(env);
  if (target.id === source.id) throw new HttpError(400, "database is already on that box");
  if (!isOnline(target)) throw new HttpError(409, `box ${target.id} is offline`);

  if (!b.force) {
    // Flush everything to R2 and forget it on the source. Abort if this fails.
    await agent(source, "POST", `/v1/databases/${db.id}/release`);
  }
  // From here on heartbeats fence the database on the source box.
  await env.DB.prepare("UPDATE databases SET box_id = ?, status = 'creating' WHERE id = ?").bind(target.id, db.id).run();
  await agent(target, "POST", "/v1/databases", {
    id: db.id,
    role: db.role,
    database: db.dbname,
    parent: db.parent_id,
    restore: { source: db.id, target: "latest" },
  });
  await setDns(env, db, target);
  return json({ moved: db.id, from: source.id, to: target.id });
}

// ---------------------------------------------------------------- boxes

interface Stats {
  cpus: number;
  mem_total_mb: number;
  mem_available_mb: number;
  disk_free_mb: number;
  databases_awake: number;
}

async function joinBox(req: Request, env: Env): Promise<Response> {
  if (!env.JOIN_TOKEN || !timingSafeEqual(bearer(req), env.JOIN_TOKEN)) throw new HttpError(401, "invalid join token");
  const b = await body<{ name?: string; public_ip?: string; stats?: Stats }>(req);
  if (!b.public_ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(b.public_ip)) throw new HttpError(400, "public_ip (IPv4) is required");
  const count = await env.DB.prepare("SELECT count(*) AS n FROM boxes").first<{ n: number }>();
  if ((count?.n ?? 0) > 0 && !(env.CF_API_TOKEN && env.CF_ZONE_ID)) {
    throw new HttpError(409, "a second box needs CF_API_TOKEN and CF_ZONE_ID so each database gets its own DNS record");
  }
  const id = newId("box-", 6);
  const token = randomString(40);
  const s = b.stats ?? ({} as Stats);
  const box: Box = {
    id,
    name: (b.name ?? id).slice(0, 100),
    public_ip: b.public_ip,
    api_url: env.AGENT_URL_TEMPLATE.replace("{box}", id),
    agent_token: token,
    status: "active",
    cpus: s.cpus ?? 0,
    mem_total_mb: s.mem_total_mb ?? 0,
    mem_available_mb: s.mem_available_mb ?? 0,
    disk_free_mb: s.disk_free_mb ?? 0,
    databases_awake: 0,
    dns_record_id: null,
    created_at: now(),
    last_seen: now(),
  };
  box.dns_record_id = await upsertDns(env, id, box.public_ip, null);
  await env.DB.prepare(
    `INSERT INTO boxes (id, name, public_ip, api_url, agent_token, status, cpus, mem_total_mb, mem_available_mb,
       disk_free_mb, databases_awake, dns_record_id, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(box.id, box.name, box.public_ip, box.api_url, token, box.cpus, box.mem_total_mb, box.mem_available_mb,
      box.disk_free_mb, box.dns_record_id, box.created_at, box.last_seen)
    .run();
  return json({ box_id: id, agent_token: token, api_url: box.api_url }, 201);
}

interface Beat {
  stats: Stats;
  databases: BeatDb[];
}

const SAMPLE_EVERY_MS = 55_000;
const METRIC_DAYS = 7;

/** Heartbeats are every 20 seconds, which is finer than any graph needs.
 *  Keep about one sample a minute so a week of history stays cheap. */
async function recordMetrics(env: Env, beats: BeatDb[]): Promise<void> {
  // A sleeping database has no backend and no counters: nothing to record.
  // It gets exactly one row at the moment it falls asleep (changed, not
  // running) so a graph can draw the edge, then silence until it wakes.
  const worth = beats.filter((d) => d.running || d.changed !== false);
  if (worth.length === 0) return;
  const at = now();
  const cutoff = new Date(Date.now() - SAMPLE_EVERY_MS).toISOString();
  const recent = await env.DB.prepare(
    `SELECT db_id, max(at) AS last FROM metrics WHERE at > ? GROUP BY db_id`,
  ).bind(cutoff).all<{ db_id: string; last: string }>();
  const seen = new Set(recent.results.map((r) => r.db_id));

  // Running databases are sampled about once a minute; an edge is always kept.
  const rows = worth.filter((d) => !d.running || !seen.has(d.id));
  if (rows.length === 0) return;
  await env.DB.batch(
    rows.map((d) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO metrics
           (db_id, at, running, connections, memory_bytes, cpu_usec,
            tup_inserted, tup_updated, tup_deleted, tup_fetched, deadlocks,
            blks_hit, blks_read, xact_commit, xact_rollback)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        d.id, at, d.running ? 1 : 0, d.connections,
        d.memory_bytes ?? null, d.cpu_usec ?? null,
        d.pg?.tup_inserted ?? null, d.pg?.tup_updated ?? null, d.pg?.tup_deleted ?? null,
        d.pg?.tup_fetched ?? null, d.pg?.deadlocks ?? null, d.pg?.blks_hit ?? null,
        d.pg?.blks_read ?? null, d.pg?.xact_commit ?? null, d.pg?.xact_rollback ?? null,
      ),
    ),
  );
}

async function heartbeat(req: Request, env: Env, id: string): Promise<Response> {
  const box = await loadBox(env, id);
  if (!timingSafeEqual(bearer(req), box.agent_token)) throw new HttpError(401, "invalid agent token");
  const b = await body<Beat>(req);
  const s = b.stats ?? ({} as Stats);
  const stmts = [
    env.DB.prepare(
      `UPDATE boxes SET cpus = ?, mem_total_mb = ?, mem_available_mb = ?, disk_free_mb = ?, databases_awake = ?,
         last_seen = ?, status = CASE WHEN status = 'offline' THEN 'active' ELSE status END WHERE id = ?`,
    ).bind(s.cpus ?? 0, s.mem_total_mb ?? 0, s.mem_available_mb ?? 0, s.disk_free_mb ?? 0, s.databases_awake ?? 0, now(), id),
    // A row is rewritten only for a database that moved. The agent leaves
    // unchanged sleeping databases out of the beat altogether, so what D1
    // writes here scales with what is awake, not with what exists.
    ...(b.databases ?? [])
      .filter((d) => d.changed !== false)
      .map((d) =>
        env.DB.prepare(
          "UPDATE databases SET status = ?, location = ?, running = ?, connections = ? WHERE id = ? AND box_id = ?",
        ).bind(d.status, d.location, d.running ? 1 : 0, d.connections, d.id, id),
      ),
  ];
  await env.DB.batch(stmts);
  await recordMetrics(env, b.databases ?? []);
  const { results } = await env.DB.prepare("SELECT id FROM databases WHERE box_id = ?").bind(id).all<{ id: string }>();
  return json({ databases: results.map((r) => r.id) });
}

function boxView(b: Box) {
  const { agent_token: _, ...rest } = b;
  return { ...rest, online: isOnline(b) };
}

// ---------------------------------------------------------------- router

// ---------------------------------------------------------------- accounts

/** A person may hold db_quota databases, branches included: a branch is a
 *  whole Postgres cluster on a box, not a cheap pointer. */
async function checkQuota(env: Env, c: Caller): Promise<void> {
  if (c.kind !== "user") return;
  const row = await env.DB.prepare("SELECT count(*) AS n FROM databases WHERE owner = ?")
    .bind(c.id).first<{ n: number }>();
  if ((row?.n ?? 0) >= c.user.db_quota) {
    throw new HttpError(403, `database limit reached (${c.user.db_quota}); delete one or ask for more`);
  }
}

const userView = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  is_admin: u.is_admin === 1,
  db_quota: u.db_quota,
  created_at: u.created_at,
  last_seen_at: u.last_seen_at,
});

/** A person's own page: who they are and how much of their allowance is used. */
async function account(env: Env, c: Caller): Promise<Response> {
  if (c.kind !== "user") throw new HttpError(401, "sign in to see your account");
  const use = await env.DB.prepare(
    `SELECT count(*) AS databases,
            sum(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) AS branches,
            sum(CASE WHEN running = 1 THEN 1 ELSE 0 END) AS awake,
            sum(CASE WHEN location = 'cold' THEN 1 ELSE 0 END) AS archived
       FROM databases WHERE owner = ?`).bind(c.id).first<Record<string, number | null>>();
  const sessions = await env.DB.prepare(
    "SELECT count(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?").bind(c.id, now()).first<{ n: number }>();
  return json({
    user: userView(c.user),
    usage: {
      databases: use?.databases ?? 0,
      branches: use?.branches ?? 0,
      awake: use?.awake ?? 0,
      archived: use?.archived ?? 0,
      quota: c.user.db_quota,
    },
    sessions: sessions?.n ?? 0,
  });
}

async function updateAccount(req: Request, env: Env, c: Caller): Promise<Response> {
  if (c.kind !== "user") throw new HttpError(401, "sign in to change your account");
  const b = await body<{ name?: string }>(req);
  const name = String(b.name ?? "").trim().slice(0, 100) || null;
  await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, c.id).run();
  return json({ user: userView({ ...c.user, name }) });
}

/** Everyone with an account, with how much each is using. Emails and counts
 *  only: an admin never sees inside another person's database from here. */
async function adminUsers(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, u.db_quota, u.created_at, u.last_seen_at,
            count(d.id)                                              AS databases,
            coalesce(sum(CASE WHEN d.parent_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS branches,
            coalesce(sum(d.running), 0)                              AS awake,
            coalesce(sum(d.connections), 0)                          AS connections
       FROM users u
       LEFT JOIN databases d ON d.owner = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC`).all<Record<string, unknown>>();
  return json(results.map((r) => ({ ...r, is_admin: r.is_admin === 1 })));
}

async function signUp(req: Request, env: Env): Promise<Response> {
  if (env.SIGNUP === "closed") throw new HttpError(403, "sign-ups are closed");
  const b = await body<{ email?: string; password?: string; name?: string }>(req);
  const { email, password } = validateCredentials(b.email, b.password);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) throw new HttpError(409, "that email already has an account");

  // The first account to exist runs the place; everyone after is an ordinary user.
  const first = await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>();
  const user: User = {
    id: newId("usr_"),
    email,
    password_hash: await hashPassword(password),
    name: (b.name ?? "").slice(0, 100) || null,
    is_admin: (first?.n ?? 0) === 0 ? 1 : 0,
    db_quota: 3,
    created_at: now(),
    last_seen_at: now(),
  };
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, name, is_admin, db_quota, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(user.id, user.email, user.password_hash, user.name, user.is_admin, user.db_quota, user.created_at, user.last_seen_at).run();

  const token = await createSession(env.DB, user.id, req.headers.get("User-Agent"));
  return json({ user: userView(user) }, 201, { "Set-Cookie": sessionCookie(token) });
}

async function signIn(req: Request, env: Env): Promise<Response> {
  const b = await body<{ email?: string; password?: string }>(req);
  const email = String(b.email ?? "").trim().toLowerCase();
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
  // Same message either way: do not reveal which emails have accounts.
  const ok = user ? await verifyPassword(String(b.password ?? ""), user.password_hash) : false;
  if (!user || !ok) throw new HttpError(401, "wrong email or password");
  await env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now(), user.id).run();
  const token = await createSession(env.DB, user.id, req.headers.get("User-Agent"));
  return json({ user: userView(user) }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function signOut(req: Request, env: Env): Promise<Response> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) await destroySession(env.DB, cookie);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(null) });
}

/** The admin plane: how much is being used, never whose. */
async function adminStats(env: Env): Promise<Response> {
  const [users, dbs, boxes] = await Promise.all([
    env.DB.prepare("SELECT count(*) AS total, sum(is_admin) AS admins FROM users").first<{ total: number; admins: number }>(),
    env.DB.prepare(
      `SELECT count(*) AS total,
              sum(CASE WHEN running = 1 THEN 1 ELSE 0 END) AS awake,
              sum(CASE WHEN location = 'cold' THEN 1 ELSE 0 END) AS cold,
              sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              sum(connections) AS connections
         FROM databases`).first<Record<string, number>>(),
    env.DB.prepare("SELECT count(*) AS total, sum(databases_awake) AS awake FROM boxes").first<Record<string, number>>(),
  ]);
  const signups = await env.DB.prepare(
    "SELECT date(created_at) AS day, count(*) AS n FROM users GROUP BY day ORDER BY day DESC LIMIT 30").all<{ day: string; n: number }>();
  return json({
    users: { total: users?.total ?? 0, admins: users?.admins ?? 0 },
    databases: {
      total: dbs?.total ?? 0, awake: dbs?.awake ?? 0, cold: dbs?.cold ?? 0,
      failed: dbs?.failed ?? 0, connections: dbs?.connections ?? 0,
    },
    boxes: { total: boxes?.total ?? 0, databases_awake: boxes?.awake ?? 0 },
    signups: signups.results,
  });
}

type BeatDb = {
  id: string;
  status: string;
  location: string;
  running: boolean;
  connections: number;
  /** Set by the agent when status/location/running/connections moved since
   *  the beat we last accepted. Absent from older agents, which reads as
   *  "always", so they keep working. */
  changed?: boolean;
  memory_bytes?: number;
  cpu_usec?: number;
  pg?: Record<string, number>;
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["v1", "databases", id, action]
  const m = req.method;
  if (parts[0] !== "v1") {
    if (url.pathname === "/health") return json({ service: "barua-control", ok: true });
    // Everything else is the dashboard, served from ui/dist as static assets.
    throw new HttpError(404, "not found");
  }
  const [, resource, id, action] = parts;

  if (resource === "auth") {
    if (id === "signup" && m === "POST") return signUp(req, env);
    if (id === "login" && m === "POST") return signIn(req, env);
    if (id === "logout" && m === "POST") return signOut(req, env);
    if (id === "me" && m === "GET") {
      const c = await caller(req, env);
      if (c.kind !== "user") return json({ user: null, kind: c.kind });
      return json({ user: userView(c.user) });
    }
    if (id === "account" && m === "GET") return account(env, await caller(req, env));
    if (id === "account" && m === "PATCH") return updateAccount(req, env, await caller(req, env));
    throw new HttpError(404, "not found");
  }

  if (resource === "admin") {
    await staff(req, env);
    if (id === "stats" && m === "GET") return adminStats(env);
    if (id === "users" && m === "GET") return adminUsers(env);
    throw new HttpError(404, "not found");
  }

  if (resource === "boxes") {
    if (id === "join" && m === "POST") return joinBox(req, env);
    if (id && action === "heartbeat" && m === "POST") return heartbeat(req, env, id);
    await admin(req, env);
    if (!id && m === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM boxes ORDER BY created_at").all<Box>();
      return json(results.map(boxView));
    }
    if (id && !action && m === "GET") return json(boxView(await loadBox(env, id)));
    if (id && action === "drain" && m === "POST") {
      const { draining = true } = await body<{ draining?: boolean }>(req);
      await env.DB.prepare("UPDATE boxes SET status = ? WHERE id = ?").bind(draining ? "draining" : "active", id).run();
      return json(boxView(await loadBox(env, id)));
    }
    if (id && !action && m === "DELETE") {
      const n = await env.DB.prepare("SELECT count(*) AS n FROM databases WHERE box_id = ?").bind(id).first<{ n: number }>();
      if (n?.n) throw new HttpError(409, `box still hosts ${n.n} databases; move them first`);
      const box = await loadBox(env, id);
      await deleteDns(env, box.dns_record_id);
      await env.DB.prepare("DELETE FROM boxes WHERE id = ?").bind(id).run();
      return json({ deleted: id });
    }
  }

  if (resource === "api-keys" && m === "POST" && !id) {
    await admin(req, env);
    const { name = "default" } = await body<{ name?: string }>(req);
    const key = `bk_${randomString(32)}`;
    const keyId = newId("key-", 8);
    await env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(keyId, name, await sha256(key), now())
      .run();
    return json({ id: keyId, name, key, note: "Save the key now; it is not shown again." }, 201);
  }

  if (resource === "databases") {
    const c = await caller(req, env);
    if (!id && m === "POST") return createDatabase(req, env, c);
    if (!id && m === "GET") {
      const q = c.kind === "admin"
        ? env.DB.prepare("SELECT * FROM databases ORDER BY created_at")
        : env.DB.prepare("SELECT * FROM databases WHERE owner = ? ORDER BY created_at").bind(c.id);
      return json((await q.all<DbRow>()).results.map((d) => dbView(env, d, c)));
    }
    if (id && !action && m === "GET") {
      const db = await loadDb(env, c, id);
      let extra: Record<string, unknown> = {};
      try {
        const live = await refresh(env, db);
        extra = { error: live.error, last_snapshot_at: live.last_snapshot_at };
      } catch {
        extra = { box_reachable: false };
      }
      return json({ ...dbView(env, db, c), ...extra });
    }
    if (id && !action && m === "DELETE") return deleteDatabase(env, c, id);
    if (id && action === "branches" && m === "POST") return createBranch(req, env, c, id);
    if (id && action === "reset-password" && m === "POST") return resetPassword(env, c, id);
    if (id && action === "suspend" && m === "POST") {
      const db = await loadDb(env, c, id);
      return json(await agent(await loadBox(env, db.box_id), "POST", `/v1/databases/${db.id}/suspend?force=true`));
    }
    // SQL on behalf of the owner. The agent runs it as the database's own
    // role, so this grants nothing the owner does not already have.
    if (id && action === "dump" && m === "GET") {
      const db = await loadDb(env, c, id);
      const box = await loadBox(env, db.box_id);
      const res = await fetch(`${box.api_url}/v1/databases/${db.id}/dump`, {
        headers: { authorization: `Bearer ${box.agent_token}` },
      });
      if (!res.ok) throw new HttpError(502, `box ${box.id}: ${await res.text()}`);
      // Streamed straight through; nothing is buffered in the Worker.
      return new Response(res.body, {
        headers: {
          "content-type": "application/sql",
          "content-disposition": `attachment; filename="${db.name}-${new Date().toISOString().slice(0, 10)}.sql"`,
        },
      });
    }

    if (id && action === "query" && m === "POST") {
      const db = await loadDb(env, c, id);
      const b = await body<{ sql?: string; limit?: number }>(req);
      if (typeof b.sql !== "string" || !b.sql.trim()) throw new HttpError(400, "sql is required");
      if (b.sql.length > 100_000) throw new HttpError(413, "query too long");
      return json(
        await agent(await loadBox(env, db.box_id), "POST", `/v1/databases/${db.id}/query`, {
          sql: b.sql,
          limit: b.limit,
        }),
      );
    }

    // The full connection string, password included. Same authority as the
    // database itself: only its owner, never another user.
    if (id && action === "connection" && m === "GET") {
      const db = await loadDb(env, c, id);
      const password = await openPassword(env.PASSWORD_KEY, db.password_enc);
      if (!password) {
        throw new HttpError(
          409,
          "this password predates stored credentials, or the key changed; reset the password to get a new one",
        );
      }
      return json({
        password,
        connection_uri: connectionUri(env, db, password),
        pooled_uri: connectionUri(env, db, password, true),
      });
    }

    if (id && action === "metrics" && m === "GET") {
      const db = await loadDb(env, c, id);
      const hours = Math.min(Number(url.searchParams.get("hours") ?? 1) || 1, 24 * METRIC_DAYS);
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const { results } = await env.DB.prepare(
        "SELECT * FROM metrics WHERE db_id = ? AND at >= ? ORDER BY at",
      ).bind(db.id, since).all();
      return json({ hours, samples: results });
    }

    if (id && action === "restore-points" && m === "GET") {
      const db = await loadDb(env, c, id);
      const snaps = await agent<{ taken_at: string; kind: string }[]>(
        await loadBox(env, db.box_id), "GET", `/v1/databases/${db.id}/snapshots`);
      return json({
        earliest: snaps[0]?.taken_at ?? null,
        snapshots: snaps.map((s) => ({ taken_at: s.taken_at, kind: s.kind })),
        note: "Branch with point_in_time anywhere from 'earliest' until now.",
      });
    }
    if (id && action === "move" && m === "POST") {
      await admin(req, env);
      return moveDatabase(req, env, id);
    }
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },

  // Mark boxes that stopped sending heartbeats as offline.
  async scheduled(_: ScheduledController, env: Env): Promise<void> {
    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    await env.DB.prepare("UPDATE boxes SET status = 'offline' WHERE status = 'active' AND last_seen < ?").bind(cutoff).run();
    // History is for graphs, not for keeping: drop anything past the window.
    await env.DB.prepare("DELETE FROM metrics WHERE at < ?")
      .bind(new Date(Date.now() - METRIC_DAYS * 86_400_000).toISOString())
      .run();
  },
} satisfies ExportedHandler<Env>;
