// Everything the UI knows about the control plane. Session cookie only: the
// browser never holds a database password or an API key.

export type Me = {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
  db_quota: number;
  created_at: string;
};

export type Database = {
  id: string;
  name: string;
  host: string;
  role: string;
  database: string;
  parent_id: string | null;
  status: "creating" | "ready" | "failed";
  state: "awake" | "asleep" | "cold";
  connections: number;
  created_at: string;
  connection_uri: string;
};

export type QueryResult = {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  rows_affected: number | null;
  ms: number;
};

export type Box = {
  id: string;
  name: string;
  public_ip: string;
  status: string;
  online: boolean;
  cpus: number;
  mem_total_mb: number;
  mem_available_mb: number;
  disk_free_mb: number;
  databases_awake: number;
  last_seen: string | null;
};

export type AdminStats = {
  users: { total: number; admins: number };
  databases: { total: number; awake: number; cold: number; failed: number; connections: number };
  boxes: { total: number; databases_awake: number };
  signups: { day: string; n: number }[];
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch("/v1" + path, {
    credentials: "same-origin",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => call<{ user: Me | null }>("/auth/me"),
  signUp: (email: string, password: string, name?: string) =>
    post<{ user: Me }>("/auth/signup", { email, password, name }),
  signIn: (email: string, password: string) => post<{ user: Me }>("/auth/login", { email, password }),
  signOut: () => post<{ ok: true }>("/auth/logout"),

  databases: () => call<Database[]>("/databases"),
  database: (id: string) => call<Database & { error?: string | null }>(`/databases/${id}`),
  createDatabase: (name: string) =>
    post<{ database: Database; password: string; connection_uri: string }>("/databases", { name }),
  deleteDatabase: (id: string) => call<{ deleted: string }>(`/databases/${id}`, { method: "DELETE" }),
  branch: (id: string, name: string) => post<{ database: Database }>(`/databases/${id}/branches`, { name }),
  resetPassword: (id: string) => post<{ password: string; connection_uri: string }>(`/databases/${id}/reset-password`),
  restorePoints: (id: string) =>
    call<{ earliest: string | null; snapshots: { taken_at: string; kind: string }[] }>(`/databases/${id}/restore-points`),
  query: (id: string, sql: string, limit?: number) => post<QueryResult>(`/databases/${id}/query`, { sql, limit }),

  boxes: () => call<Box[]>("/boxes"),
  adminStats: () => call<AdminStats>("/admin/stats"),
};

// ---------------------------------------------------------------- catalog
// Introspection SQL, in the spirit of supabase/postgres-meta (Apache-2.0):
// ask the catalog rather than keeping a model of the schema in the UI.

export const CATALOG = {
  schemas: `
    select n.nspname as name,
           pg_catalog.pg_get_userbyid(n.nspowner) as owner
      from pg_namespace n
     where n.nspname not in ('information_schema', 'pg_catalog', 'pg_toast')
       and n.nspname not like 'pg_temp_%' and n.nspname not like 'pg_toast_temp_%'
     order by n.nspname`,

  tables: (schema: string) => `
    select c.relname as name,
           case c.relkind when 'r' then 'table' when 'v' then 'view'
                          when 'm' then 'materialized view' when 'p' then 'partitioned table'
                          when 'f' then 'foreign table' else c.relkind::text end as kind,
           coalesce(c.reltuples, 0)::bigint as estimated_rows,
           pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)) as size,
           obj_description(c.oid, 'pg_class') as comment
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = ${literal(schema)} and c.relkind in ('r','v','m','p','f')
     order by c.relname`,

  columns: (schema: string, table: string) => `
    select a.attname as name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
           a.attnotnull as not_null,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_value,
           coalesce(pk.is_pk, false) as is_primary_key
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      left join (
        select conrelid, unnest(conkey) as attnum, true as is_pk
          from pg_constraint where contype = 'p'
      ) pk on pk.conrelid = c.oid and pk.attnum = a.attnum
     where n.nspname = ${literal(schema)} and c.relname = ${literal(table)}
       and a.attnum > 0 and not a.attisdropped
     order by a.attnum`,
};

/** Quote a string for inclusion in SQL we build for the catalog queries. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote an identifier (schema or table name) for a generated query. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
