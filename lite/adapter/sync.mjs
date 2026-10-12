// Push Claude Code transcripts into the thread database. Incremental: each
// session remembers how many lines of its JSONL have been seen, so a run
// after a long conversation sends only the new turns. Rows go up in batches.
//
//   node sync.mjs [--project <dir-name>] [--quiet]
//   node sync.mjs --hook       (as a Claude Code Stop hook: reads the hook's
//                               JSON from stdin and syncs only transcript_path)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { query, settings, SCHEMA } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const quiet = args.includes("--quiet");
const onlyProject = opt("--project");
const LIMIT = 8000, BATCH = 60;
const say = (...a) => { if (!quiet) console.log(...a); };

const asText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "");
// Postgres text cannot hold NUL; a few tool results carry one.
const clean = (s) => (typeof s === "string" ? s.replaceAll("\u0000", "") : s);
const clip = (s) => { s = clean(s); return s && s.length > LIMIT ? [s.slice(0, LIMIT), true] : [s ?? null, false]; };
const kindOfUserText = (t) => (/^\s*<(system-reminder|task-notification|local-command|command-name)/.test(t) ? "system" : "text");

/** One JSONL record -> zero or more message rows. */
function rowsOf(r) {
  if (r.type !== "user" && r.type !== "assistant") return [];
  const m = r.message; if (!m) return [];
  const base = { session_id: r.sessionId, parent_uuid: r.parentUuid ?? null, role: m.role, at: r.timestamp ?? null, sidechain: !!r.isSidechain };
  const out = [];
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
  blocks.forEach((b, i) => {
    const uuid = `${r.uuid}:${i}`;
    if (b.type === "text" && b.text?.trim()) {
      const [text, truncated] = clip(b.text);
      out.push({ ...base, uuid, kind: m.role === "user" ? kindOfUserText(b.text) : "text", text, truncated });
    } else if (b.type === "tool_use") {
      const [input, truncated] = clip(JSON.stringify(b.input ?? {}));
      out.push({ ...base, uuid, kind: "tool_use", tool: b.name ?? null, tool_input: input, truncated });
    } else if (b.type === "tool_result") {
      const [output, truncated] = clip(asText(b.content));
      if (output) out.push({ ...base, uuid, kind: "tool_result", tool_output: output, truncated });
    } else if (b.type === "image") {
      out.push({ ...base, uuid, kind: "image", text: "[image]", truncated: false });
    }
  });
  return out;
}

async function upsert(rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params = []; const tuples = [];
    for (const r of chunk) {
      const vals = [r.uuid, r.session_id, r.parent_uuid, r.role, r.kind, r.at, r.text ?? null, r.tool ?? null, r.tool_input ?? null, r.tool_output ?? null, r.sidechain, r.truncated];
      tuples.push(`(${vals.map(() => `$${params.push(null) && params.length}`).join(",")})`);
      vals.forEach((v, j) => (params[params.length - vals.length + j] = v));
    }
    await query(`insert into messages (uuid, session_id, parent_uuid, role, kind, at, text, tool, tool_input, tool_output, sidechain, truncated) values ${tuples.join(",")} on conflict (uuid) do nothing`, params);
  }
}

async function syncSession(project, file) {
  const session = basename(file, ".jsonl");
  const lines = readFileSync(file, "utf8").split("\n");
  const known = (await query("select synced_lines from threads where session_id = $1", [session])).rows[0];
  const from = known?.synced_lines ?? 0;
  if (lines.length <= from) return 0;
  let cwd = null, branch = null, first = null, last = null;
  // The title can change at any point in the file, so take the latest one
  // from the whole file every run; it is a cheap scan.
  let title = null, lastPrompt = null;
  for (const line of lines) {
    if (line.includes('"ai-title"') || line.includes('"last-prompt"')) {
      try { const r = JSON.parse(line); if (r.aiTitle) title = r.aiTitle; if (r.lastPrompt) lastPrompt = r.lastPrompt; } catch { /* skip */ }
    }
  }
  title = clean(title ?? lastPrompt?.slice(0, 80) ?? null);
  const rows = [];
  for (const line of lines.slice(from)) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.cwd) cwd = r.cwd; if (r.gitBranch) branch = r.gitBranch;
    if (r.timestamp) { first ??= r.timestamp; last = r.timestamp; }
    rows.push(...rowsOf(r));
  }
  await query(`insert into threads (session_id, project, cwd, branch, title, started_at, last_at, synced_lines)
    values ($1, $2, $3, $4, $5, $6, $7, 0)
    on conflict (session_id) do update set cwd = coalesce(excluded.cwd, threads.cwd), branch = coalesce(excluded.branch, threads.branch),
      title = coalesce(excluded.title, threads.title), started_at = coalesce(threads.started_at, excluded.started_at), last_at = coalesce(excluded.last_at, threads.last_at)`,
    [session, project, cwd, branch, title, first, last]);
  await upsert(rows);
  await query(`update threads set synced_lines = $2, messages = (select count(*) from messages where session_id = $1) where session_id = $1`, [session, lines.length]);
  return rows.length;
}

const { projects } = settings();
await query(SCHEMA);
let total = 0;
if (args.includes("--hook")) {
  // One file, the one that just grew. Anything odd about the payload: do nothing.
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no payload */ }
  const file = payload.transcript_path;
  if (typeof file === "string" && file.endsWith(".jsonl") && statSync(file, { throwIfNoEntry: false })?.isFile()) {
    const n = await syncSession(basename(dirname(file)), file);
    say(`synced ${n} new messages from ${basename(file)}`);
  }
  process.exit(0);
}
for (const project of readdirSync(projects)) {
  if (onlyProject && project !== onlyProject) continue;
  const dir = join(projects, project);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    const n = await syncSession(project, join(dir, f));
    if (n) say(`  ${project}/${f}: +${n} messages`);
    total += n;
  }
}
say(`synced ${total} new messages`);
