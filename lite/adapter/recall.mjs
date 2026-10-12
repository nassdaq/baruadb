// Bring thread history back into context, formatted to be read by Claude.
//
//   node recall.mjs [search words] [--last N] [--session <id>] [--project <dir-name>]
import { query, settings } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const last = Number(opt("--last") ?? 40), session = opt("--session"), project = opt("--project");
const q = args.join(" ").trim();
const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "");
const one = (s, n = 700) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const threads = (await query(
  `select session_id, project, title, started_at, last_at, messages from threads ${project ? "where project = $1" : ""} order by last_at desc nulls last limit 12`,
  project ? [project] : [])).rows;
console.log(`# Threads in ${settings().db}\n`);
for (const t of threads) console.log(`- ${when(t.last_at)} · ${t.messages} msgs · ${t.title ?? "(untitled)"} · ${t.project} · ${t.session_id.slice(0, 8)}`);

const sid = session ?? threads[0]?.session_id;
if (sid) {
  const tail = (await query(
    `select role, kind, at, text, tool, tool_input, tool_output from messages
      where session_id = $1 and kind = 'text' and not sidechain order by at desc limit $2`, [sid, last])).rows.reverse();
  const tools = (await query(`select count(*) as n from messages where session_id = $1 and kind = 'tool_use'`, [sid])).rows[0]?.n;
  console.log(`\n# Latest thread ${sid.slice(0, 8)}: last ${tail.length} spoken turns (${tools} tool calls not shown)\n`);
  for (const m of tail) console.log(`- ${when(m.at)} **${m.role}**: ${one(m.text)}`);
}

if (q) {
  // All words first; if nothing has them all, any of them, best-ranked first.
  const search = (tsq, arg) => query(
    `select m.session_id, t.title, m.role, m.kind, m.at, m.text, m.tool_output,
            ts_rank_cd(to_tsvector('simple', coalesce(m.text,'') || ' ' || coalesce(m.tool_output,'')), ${tsq}) as rank
       from messages m join threads t on t.session_id = m.session_id
      where to_tsvector('simple', coalesce(m.text,'') || ' ' || coalesce(m.tool_output,'')) @@ ${tsq}
      order by rank desc, m.at desc limit 20`, [arg]).then((r) => r.rows);
  let hits = await search("plainto_tsquery('simple', $1)", q);
  if (hits.length === 0) hits = await search("to_tsquery('simple', $1)", q.split(/\s+/).map((w) => w.replace(/[^\w]/g, "")).filter(Boolean).join(" | "));
  console.log(`\n# Matches for "${q}": ${hits.length}\n`);
  for (const h of hits) {
    const body = h.text ?? h.tool_output ?? "";
    const i = Math.max(0, body.toLowerCase().indexOf(q.split(" ")[0].toLowerCase()) - 120);
    console.log(`- ${when(h.at)} · ${h.title ?? h.session_id.slice(0, 8)} · ${h.role}/${h.kind}: …${one(body.slice(i), 500)}…`);
  }
}
