// Talking to box agents and to Cloudflare DNS.

import { HttpError } from "./util";

export interface Env {
  /** "open" (default) or "closed" — whether strangers may create accounts. */
  SIGNUP?: string;
  /** Encrypts stored database passwords. Without it, none are kept. */
  PASSWORD_KEY?: string;
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
