// Shared by sync and recall: where the thread database is and how to ask it.
// Settings come from ~/.barua-lite.env (LITE_URL, LITE_TOKEN, THREADS_DB) or
// the environment. Everything goes through the engine's JSON door.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");

export function settings() {
  const out = {};
  try {
    for (const line of readFileSync(join(homedir(), ".barua-lite.env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* no file: environment only */ }
  return {
    url: process.env.LITE_URL ?? out.LITE_URL ?? "https://barua-lite.kelvineffect.workers.dev",
    token: process.env.LITE_TOKEN ?? out.LITE_TOKEN ?? "",
    db: process.env.THREADS_DB ?? out.THREADS_DB ?? "claude-threads",
    projects: process.env.CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects"),
  };
}

export async function query(sql, params = []) {
  const { url, token, db } = settings();
  const r = await fetch(`${url}/db/${db}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ sql, params }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}

export const SCHEMA = `
create table if not exists threads (
  session_id text primary key,
  project text not null,
  cwd text, branch text, title text,
  started_at timestamptz, last_at timestamptz,
  messages int not null default 0,
  synced_lines bigint not null default 0
);
create table if not exists messages (
  uuid text primary key,
  session_id text not null references threads(session_id) on delete cascade,
  parent_uuid text, role text not null, kind text not null,
  at timestamptz, text text, tool text, tool_input text, tool_output text,
  sidechain boolean not null default false, truncated boolean not null default false
);
create index if not exists messages_session_at on messages (session_id, at);
-- the first cut used the 'english' configuration, whose stemmer is a dynamic
-- library the Worker cannot load; 'simple' needs none.
drop index if exists messages_fts;
create index if not exists messages_fts_simple on messages using gin (to_tsvector('simple', coalesce(text, '') || ' ' || coalesce(tool_output, '')));
`;
