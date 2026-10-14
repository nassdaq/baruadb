// Talking to box agents, to the function engine, and to Cloudflare DNS.

import { DbRow } from "./types";
import { HttpError } from "./util";

export interface Env {
  /** "open" (default) or "closed" — whether strangers may create accounts. */
  SIGNUP?: string;
  /** Encrypts stored database passwords. Without it, none are kept. */
  PASSWORD_KEY?: string;
  /** The function engine (the barua-lite Worker) and the one secret both
   *  sides hold. Without them every database is born on a box. */
  LITE_URL?: string;
  LITE_TOKEN?: string;
  /** Where a new database is born: "function" (default when the engine is
   *  configured) or "box". */
  NEW_DB_ENGINE?: string;
  /** Barua Tasks (tasks/), the first add-on. The control plane mints one
   *  project per database that opts in, using the operator token. */
  TASKS_URL?: string;
  TASKS_ADMIN_TOKEN?: string;
  DB: D1Database;
  DB_DOMAIN: string;
  AGENT_URL_TEMPLATE: string;
  ADMIN_TOKEN: string;
  JOIN_TOKEN: string;
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
}

export interface Box {
  id: string;
  name: string;
  public_ip: string;
  api_url: string;
  agent_token: string;
  status: string;
  cpus: number;
  mem_total_mb: number;
  mem_available_mb: number;
  disk_free_mb: number;
  databases_awake: number;
  dns_record_id: string | null;
  created_at: string;
  last_seen: string | null;
  /** The region this box is in (e.g. 'eu', 'tz'); 'default' until set. */
  zone: string;
}

/** Call a box's agent API. Throws HttpError(502) when the box fails. */
export async function agent<T = any>(box: Box, method: string, path: string, payload?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${box.api_url}${path}`, {
      method,
      headers: { authorization: `Bearer ${box.agent_token}`, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new HttpError(502, `box ${box.id} unreachable: ${e}`);
  }
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `box ${box.id}: ${data.error ?? res.status}`);
  return data as T;
}

// ---------------------------------------------------------------- function engine

export const liteEnabled = (env: Env) => Boolean(env.LITE_URL && env.LITE_TOKEN);

/** A raw request to the function engine; the caller reads the body. */
export async function liteFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!liteEnabled(env)) throw new HttpError(503, "the function engine is not configured");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.LITE_TOKEN}`);
  try {
    return await fetch(`${env.LITE_URL}${path}`, { ...init, headers });
  } catch (e) {
    throw new HttpError(502, `function engine unreachable: ${e}`);
  }
}

/** A JSON call to the function engine. Throws HttpError(502) when it fails. */
export async function lite<T = any>(env: Env, method: string, path: string, payload?: unknown): Promise<T> {
  const res = await liteFetch(env, path, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `function engine: ${data.error ?? res.status}`);
  return data as T;
}

/** The WebSocket door of one database, for the box's proxy to relay to. */
export const wireUrl = (env: Env, id: string) => `${(env.LITE_URL ?? "").replace(/^http/, "ws")}/wire/${id}`;

// ---------------------------------------------------------------- add-ons

export const tasksEnabled = (env: Env) => Boolean(env.TASKS_URL && env.TASKS_ADMIN_TOKEN);

/** A call to Barua Tasks - as a project (bearer = its key) or as the
 *  operator. The tasks service's own 4xx is passed through; its failures
 *  become a 502 here. */
export async function tasks<T = any>(env: Env, key: string, method: string, path: string, payload?: unknown): Promise<T> {
  if (!env.TASKS_URL) throw new HttpError(503, "tasks are not configured");
  let res: Response;
  try {
    res = await fetch(`${env.TASKS_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new HttpError(502, `tasks unreachable: ${e}`);
  }
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : res.status, data.error ?? `tasks: ${res.status}`);
  return data as T;
}

// ---------------------------------------------------------------- boxes

const ONLINE_MS = 90_000;
export const isOnline = (b: Box) => b.last_seen !== null && Date.now() - Date.parse(b.last_seen) < ONLINE_MS;

export async function loadBox(env: Env, id: string): Promise<Box> {
  const box = await env.DB.prepare("SELECT * FROM boxes WHERE id = ?").bind(id).first<Box>();
  if (!box) throw new HttpError(404, `box ${id} not found`);
  return box;
}

// Free memory minus ~100 MB for each awake database, plus a little for disk.
const score = (b: Box) => b.mem_available_mb - b.databases_awake * 100 + Math.min(b.disk_free_mb, 50_000) / 100;

/** The online, active box with the most headroom, optionally within a region. */
export async function pickBox(env: Env, prefer?: string, zone?: string): Promise<Box> {
  const { results } = await env.DB.prepare("SELECT * FROM boxes WHERE status = 'active'").all<Box>();
  let online = results.filter(isOnline);
  if (zone) online = online.filter((b) => b.zone === zone);
  const preferred = online.find((b) => b.id === prefer);
  if (preferred) return preferred;
  online.sort((a, b) => score(b) - score(a));
  if (!online.length) throw new HttpError(503, zone ? `no box in region '${zone}' yet` : "no box available; add one with deploy/install.sh");
  return online[0];
}

export async function setDns(env: Env, db: DbRow, box: Box): Promise<void> {
  const rec = await upsertDns(env, db.id, box.public_ip, db.dns_record_id);
  if (rec !== db.dns_record_id) {
    await env.DB.prepare("UPDATE databases SET dns_record_id = ? WHERE id = ?").bind(rec, db.id).run();
    db.dns_record_id = rec;
  }
}

// ---------------------------------------------------------------- DNS

const dnsEnabled = (env: Env) => Boolean(env.CF_API_TOKEN && env.CF_ZONE_ID);

async function cf(env: Env, method: string, path: string, payload?: unknown): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data: any = await res.json();
  if (!data.success) throw new HttpError(502, `Cloudflare DNS: ${JSON.stringify(data.errors)}`);
  return data.result;
}

/**
 * Point `<label>.<DB_DOMAIN>` at an IP. Without CF_API_TOKEN this is a no-op
 * and the wildcard `*.pg.barua.tz` record (pointing at the single box) is used.
 * Returns the record id, or null.
 */
export async function upsertDns(env: Env, label: string, ip: string, recordId: string | null): Promise<string | null> {
  if (!dnsEnabled(env)) return null;
  const record = { type: "A", name: `${label}.${env.DB_DOMAIN}`, content: ip, ttl: 60, proxied: false };
  if (recordId) {
    await cf(env, "PATCH", `/dns_records/${recordId}`, record);
    return recordId;
  }
  return (await cf(env, "POST", "/dns_records", record)).id;
}

export async function deleteDns(env: Env, recordId: string | null): Promise<void> {
  if (!dnsEnabled(env) || !recordId) return;
  await cf(env, "DELETE", `/dns_records/${recordId}`).catch(() => {});
}
