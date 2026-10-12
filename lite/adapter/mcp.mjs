#!/usr/bin/env node
// MCP server over the Barua thread database (claude-threads). Read-only: it
// only ever runs the four SELECTs below, so Claude can recall past threads
// but never change them. stdio transport, newline-delimited JSON-RPC 2.0.
// The protocol channel is stdout; every log goes to stderr.
import { query, settings } from "./lib.mjs";

const PROTO = "2025-06-18";
const log = (...a) => process.stderr.write("[barua-threads] " + a.join(" ") + "\n");
const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "");
const one = (s, n = 600) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const TOOLS = [
  {
    name: "search_threads",
    description:
      "Full-text search across every past Claude Code conversation (all projects). Returns the best-matching turns with their thread, time, role and a snippet. Use to recall what was discussed or decided earlier.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "words to search for" },
        limit: { type: "integer", description: "max matches (default 20, max 50)" },
        project: { type: "string", description: "restrict to a project directory name, e.g. -Users-nassdaq-github-workingdb" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_threads",
    description: "List recent conversation threads, most recent first: session id, project, title, message count and times.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "max threads (default 20, max 100)" },
        project: { type: "string", description: "restrict to a project directory name" },
      },
    },
  },
  {
    name: "get_thread",
    description: "Return the spoken turns (user + assistant text, tool calls omitted) of one thread, chronological. Give a full or 8-character session id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "session id (full, or first 8 chars)" },
        limit: { type: "integer", description: "most recent N turns (default 50, max 400)" },
      },
      required: ["session_id"],
    },
  },
  { name: "thread_stats", description: "Totals for the thread database: messages, threads, size on disk.", inputSchema: { type: "object", properties: {} } },
];

async function searchThreads({ query: q, limit = 20, project }) {
  if (!q || !String(q).trim()) throw new Error("query is required");
  limit = Math.min(Math.max(1, (limit | 0) || 20), 50);
  const run = (tsq, arg) => {
    const params = [arg];
    let where = `to_tsvector('simple', coalesce(m.text,'') || ' ' || coalesce(m.tool_output,'')) @@ ${tsq}`;
    if (project) { params.push(project); where += ` and t.project = $${params.length}`; }
    params.push(limit);
    return query(
      `select m.session_id, t.title, t.project, m.role, m.kind, m.at, m.text, m.tool_output,
              ts_rank_cd(to_tsvector('simple', coalesce(m.text,'') || ' ' || coalesce(m.tool_output,'')), ${tsq}) as rank
         from messages m join threads t on t.session_id = m.session_id
        where ${where}
        order by rank desc, m.at desc limit $${params.length}`, params).then((r) => r.rows);
  };
  let hits = await run("plainto_tsquery('simple', $1)", String(q));
  if (!hits.length) {
    const or = String(q).split(/\s+/).map((w) => w.replace(/[^\w]/g, "")).filter(Boolean).join(" | ");
    if (or) hits = await run("to_tsquery('simple', $1)", or);
  }
  if (!hits.length) return `No matches for "${q}".`;
  return [`${hits.length} matches for "${q}":`, "", ...hits.map((h) => {
    const body = h.text ?? h.tool_output ?? "";
    return `- ${when(h.at)} · ${h.title ?? h.session_id.slice(0, 8)} (${h.session_id.slice(0, 8)}, ${h.project}) · ${h.role}/${h.kind}: ${one(body)}`;
  })].join("\n");
}

async function listThreads({ limit = 20, project }) {
  limit = Math.min(Math.max(1, (limit | 0) || 20), 100);
  const params = []; let where = "";
  if (project) { params.push(project); where = "where project = $1"; }
  params.push(limit);
  const rows = (await query(
    `select session_id, project, title, last_at, messages from threads ${where} order by last_at desc nulls last limit $${params.length}`, params)).rows;
  if (!rows.length) return "No threads yet.";
  return [`${rows.length} recent threads:`, "", ...rows.map((t) => `- ${when(t.last_at)} · ${t.messages} msgs · ${t.title ?? "(untitled)"} · ${t.project} · ${t.session_id.slice(0, 8)}`)].join("\n");
}

async function getThread({ session_id, limit = 50 }) {
  if (!session_id) throw new Error("session_id is required");
  limit = Math.min(Math.max(1, (limit | 0) || 50), 400);
  let sid = String(session_id);
  if (sid.length < 36) {
    const m = (await query(`select session_id from threads where session_id like $1 order by last_at desc limit 1`, [sid + "%"])).rows[0];
    if (!m) return `No thread starting with "${session_id}".`;
    sid = m.session_id;
  }
  const t = (await query(`select title, project from threads where session_id = $1`, [sid])).rows[0];
  const tail = (await query(
    `select role, at, text from messages where session_id = $1 and kind = 'text' and not sidechain order by at desc limit $2`, [sid, limit])).rows.reverse();
  const tools = (await query(`select count(*) as n from messages where session_id = $1 and kind = 'tool_use'`, [sid])).rows[0]?.n;
  if (!tail.length) return `Thread ${sid.slice(0, 8)} has no spoken turns yet.`;
  const head = `# ${t?.title ?? sid.slice(0, 8)} · ${t?.project ?? ""} · ${sid}\n${tail.length} spoken turns (${tools} tool calls not shown)\n`;
  return head + "\n" + tail.map((m) => `- ${when(m.at)} **${m.role}**: ${one(m.text, 900)}`).join("\n");
}

async function threadStats() {
  const r = (await query(`select count(*) as messages, count(distinct session_id) as threads, pg_size_pretty(pg_database_size(current_database())) as size from messages`)).rows[0];
  return `Thread database "${settings().db}": ${r.messages} messages across ${r.threads} threads, ${r.size}.`;
}

const HANDLERS = { search_threads: searchThreads, list_threads: listThreads, get_thread: getThread, thread_stats: threadStats };

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return reply(id, { protocolVersion: params?.protocolVersion || PROTO, capabilities: { tools: {} }, serverInfo: { name: "barua-threads", version: "1.0.0" } });
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "resources/list") return reply(id, { resources: [] });
  if (method === "prompts/list") return reply(id, { prompts: [] });
  if (method === "tools/call") {
    const fn = HANDLERS[params?.name];
    if (!fn) return reply(id, { content: [{ type: "text", text: `unknown tool ${params?.name}` }], isError: true });
    try { return reply(id, { content: [{ type: "text", text: await fn(params?.arguments ?? {}) }] }); }
    catch (e) { return reply(id, { content: [{ type: "text", text: "error: " + (e?.message ?? String(e)) }], isError: true }); }
  }
  if (method?.startsWith("notifications/")) return; // no reply to notifications
  if (id !== undefined) return fail(id, -32601, `method not found: ${method}`);
}

let buf = "";
let pending = 0, ended = false;
const drain = () => { if (ended && pending === 0) process.exit(0); };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { log("bad json:", line.slice(0, 80)); continue; }
    pending++;
    Promise.resolve(handle(msg))
      .catch((e) => { log("handler error:", e?.message); if (msg.id !== undefined) fail(msg.id, -32603, String(e?.message ?? e)); })
      .finally(() => { pending--; drain(); });
  }
});
// In real use the client keeps stdin open; only a test closes it. Finish any
// in-flight tool calls before exiting.
process.stdin.on("end", () => { ended = true; drain(); });
log("ready:", settings().url, settings().db);
