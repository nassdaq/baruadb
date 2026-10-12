// barua-lite: Postgres as a function.
//
// One Durable Object per database. Inside it, PGlite - Postgres compiled to
// WebAssembly, the real engine, not an imitation - with its data directory
// in the object's own storage (see blockfs.ts). While nobody is talking to
// it the object is evicted and costs nothing; there is no process to keep
// warm, because there is no process.
//
// Doors, all behind LITE_TOKEN:
//   POST /db/<name>/query      JSON in, rows out (a script when no params)
//   GET  /db/<name>/stats
//   GET  /db/<name>/dump       pg_dump, plain SQL - the form that moves anywhere
//   GET  /db/<name>/export     the data directory as a tarball (same-engine copies)
//   POST /db/<name>/restore    plain SQL in, played back statement by statement
//   POST /db/<name>/freeze     {frozen}: refuse sessions while a move is on
//   POST /db/<name>/destroy    drop everything, leave a tombstone
//   POST /db/<name>/reset      forget the running engine (what eviction does)
//   WS   /wire/<name>          raw Postgres wire protocol, byte for byte
//
// A database that the control plane knows about reports on itself to it
// every few minutes while it is busy (CONTROL_URL); the control plane uses
// that to decide when a database should move to a box.
import { DurableObject } from "cloudflare:workers";
// Emscripten's web branch reads self.location.href to find its files. A
// Worker has no location. Nothing is ever loaded from it - the modules are
// bundled - but it has to be a URL, and it has to exist before PGlite runs.
if (typeof (globalThis as { location?: unknown }).location === "undefined") {
  // A real URL: Emscripten reads .href and its file packager reads .pathname.
  (globalThis as { location?: unknown }).location = new URL("https://pglite.invalid/dist/index.js");
}
// Emscripten's addFunction compiles a one-function wrapper module per
// signature at runtime; Workers refuse that. The same modules are prebuilt
// (scripts/make-fn-wrappers.mjs) and the patched glue asks for them here,
// by the bytes it would have compiled.
import fnPi from "./pglite/fn-pi.wasm";
import fnPpp from "./pglite/fn-ppp.wasm";
import fnManifest from "./pglite/fn-wrappers.json";
const WRAPPERS: Record<string, WebAssembly.Module> = { pi: fnPi, ppp: fnPpp, iii: fnPpp, ppi: fnPpp };
(globalThis as { __wasmFnModule?: (bytes: ArrayLike<number>) => WebAssembly.Module | undefined }).__wasmFnModule = (bytes) => {
  const sig = (fnManifest as Record<string, string>)[Array.from(bytes).join(",")];
  return sig ? WRAPPERS[sig] : undefined;
};
// plpgsql is a loadable library: Postgres dlopens it on first use and
// Emscripten would compile it then. Precompiled here, handed over by name.
import plpgsqlWasm from "./pglite/plpgsql.wasm";
(globalThis as { __wasmDylib?: (name: string, bytes: unknown) => WebAssembly.Module | undefined }).__wasmDylib = (name) =>
  name.endsWith("/plpgsql.so") ? plpgsqlWasm : undefined;
import { PGlite } from "@electric-sql/pglite";
import pgliteWasm from "./pglite/pglite.wasm";
import initdbWasm from "./pglite/initdb.wasm";
import pgliteData from "./pglite/pglite.data";
// An empty, already-initialised data directory, built once in Node
// (scripts/make-golden.mjs): every new database starts from it, so initdb -
// which needs to run a child process - never runs in the Worker.
import golden from "./pglite/golden.tar.gz";
import { BlockFS } from "./blockfs";
import { SqlSplitter } from "./splitter";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";
import pgDumpWasm from "./pglite/pg_dump.wasm";
// pg_dump compiled to WebAssembly, handed its module the same way (see
// scripts/patch-pglite.mjs): the logical form of a database, plain SQL,
// which is what moves to a Linode box or anywhere else Postgres runs.
(globalThis as { __pgDumpWasm?: WebAssembly.Module }).__pgDumpWasm = pgDumpWasm;

export interface Env {
  DATABASE: DurableObjectNamespace<Database>;
  HOME: R2Bucket;
  /** One shared secret: callers show it to us, and we show it to the control plane. */
  LITE_TOKEN?: string;
  /** The control plane, told every few minutes what a busy database is doing. */
  CONTROL_URL?: string;
}

/** Bearer header for the JSON door; ?token= for the WebSocket door, which
 *  cannot carry headers from a browser-style client. Constant-time compare. */
function allowed(request: Request, url: URL, env: Env): boolean {
  if (!env.LITE_TOKEN) return false; // no secret set: closed, not open
  const given = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
  if (given.length !== env.LITE_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.LITE_TOKEN.charCodeAt(i);
  return diff === 0;
}

type Stats = {
  name: string;
  openedFromSnapshot: boolean;
  openMs: number | null;
  queries: number;
  /** Random per class instance: changes whenever the platform resets the object. */
  instance: string;
};

/** Kept in storage, so they survive eviction. */
type Flags = {
  /** A move is on: refuse sessions until it is over. */
  frozen?: boolean;
  /** Moved away (or deleted): refuse forever, and never open the golden
   *  directory as if this were a new database. */
  tombstone?: string | null;
  /** False once the control plane has said it does not know this name. */
  managed?: boolean;
};

/** What has happened since the last report to the control plane. */
type Beat = { queries: number; sessions: number; blocksWritten: number; activeMs: number; since: string };
const freshBeat = (): Beat => ({ queries: 0, sessions: 0, blocksWritten: 0, activeMs: 0, since: new Date().toISOString() });

const BEAT_EVERY_MS = 5 * 60_000;
/** Cloudflare caps a WebSocket message at 1 MiB; responses go out in pieces. */
const FRAME = 256 * 1024;
const MAX_STARTUP = 10_000;

export class Database extends DurableObject<Env> {
  #pg: Promise<PGlite> | null = null;
  #fs: BlockFS | null = null;
  #stats: Stats = { name: "", openedFromSnapshot: false, openMs: null, queries: 0, instance: Math.random().toString(36).slice(2, 8) };
  // One wire message at a time: PGlite is a single session.
  #chain: Promise<unknown> = Promise.resolve();
  #flags: Flags = {};
  #beat: Beat = freshBeat();
  #beatDirty = 0;
  #alarmSet = false;
  #sockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.#flags = (await ctx.storage.get<Flags>("flags")) ?? {};
      this.#beat = (await ctx.storage.get<Beat>("beat")) ?? freshBeat();
      this.#alarmSet = (await ctx.storage.getAlarm()) !== null;
    });
  }

  get #name(): string {
    return this.ctx.id.name ?? "unnamed";
  }

  async #setFlags(patch: Flags) {
    this.#flags = { ...this.#flags, ...patch };
    await this.ctx.storage.put("flags", this.#flags);
  }

  #refuse(force = false) {
    if (this.#flags.tombstone) throw new Error("moved: this database now lives elsewhere");
    if (this.#flags.frozen && !force) throw new Error("moving: this database is being moved, try again in a moment");
  }

  async #open(): Promise<PGlite> {
    if (this.#flags.tombstone) throw new Error("moved: this database now lives elsewhere");
    const t0 = Date.now();
    // The data directory is the object's own storage; nothing is fetched.
    // A database that has never opened gets the golden directory unpacked
    // into storage on the way in.
    const fs = new BlockFS(this.ctx.storage.sql, golden);
    const pg = await PGlite.create({
      fs,
      pgliteWasmModule: pgliteWasm,
      initdbWasmModule: initdbWasm,
      fsBundle: new Blob([pgliteData]),
      initialMemory: 512 * 65536,
    });
    this.#fs = fs;
    this.#stats.name = this.#name;
    this.#stats.openedFromSnapshot = fs.counters.imported === 0;
    this.#stats.openMs = Date.now() - t0;
    return pg;
  }

  #db(): Promise<PGlite> {
    if (!this.#pg) {
      this.#pg = this.#open().catch((e: Error) => {
        console.error("pglite open failed:", e.stack ?? String(e));
        this.#pg = null;
        throw e;
      });
    }
    return this.#pg;
  }

  // ---- what the control plane hears

  /** Count a unit of work; make sure a report is scheduled. */
  #worked(ms: number, what: "query" | "session" = "query") {
    if (what === "query") this.#beat.queries++;
    else this.#beat.sessions++;
    this.#beat.activeMs += ms;
    this.#stats.queries++;
    // The counters live in memory and are written back now and then, so an
    // eviction loses at most a few; the alarm is what must not be lost.
    if (++this.#beatDirty >= 25) {
      this.#beatDirty = 0;
      void this.ctx.storage.put("beat", this.#beat);
    }
    this.#schedule();
  }

  #schedule() {
    if (this.#alarmSet || !this.env.CONTROL_URL || this.#flags.managed === false) return;
    this.#alarmSet = true;
    void this.ctx.storage.setAlarm(Date.now() + BEAT_EVERY_MS);
  }

  async alarm() {
    this.#alarmSet = false;
    if (this.#fs) {
      this.#beat.blocksWritten += this.#fs.counters.blocksWritten;
      this.#fs.counters.blocksWritten = 0;
    }
    const busy = this.#beat.queries > 0 || this.#beat.sessions > 0 || this.#beat.blocksWritten > 0 || this.#sockets.size > 0;
    if (busy) await this.#report();
    this.#beat = freshBeat();
    this.#beatDirty = 0;
    await this.ctx.storage.put("beat", this.#beat);
    // An open session keeps the reports coming; otherwise the object sleeps
    // and the next query schedules the next one.
    if (this.#sockets.size > 0) this.#schedule();
  }

  async #report() {
    const url = this.env.CONTROL_URL;
    if (!url || !this.env.LITE_TOKEN) return;
    const storage = this.#fs?.summary().storedBytes ?? null;
    try {
      const res = await fetch(`${url}/v1/functions/beat`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.LITE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: this.#name,
          queries: this.#beat.queries,
          sessions: this.#beat.sessions,
          open_sessions: this.#sockets.size,
          blocks_written: this.#beat.blocksWritten,
          active_ms: this.#beat.activeMs,
          storage_bytes: storage,
          since: this.#beat.since,
          at: new Date().toISOString(),
        }),
      });
      if (!res.ok) return;
      const r = (await res.json()) as { exists?: boolean; engine?: string };
      // Not the control plane's: stop reporting. (The thread database is one
      // of these; it is never touched from here.)
      if (r.exists === false) await this.#setFlags({ managed: false });
      // Moved up while this object slept: the box has it now.
      else if (r.engine && r.engine !== "function" && !this.#flags.tombstone) await this.destroy();
    } catch (e) {
      console.warn("beat failed:", String(e));
    }
  }

  // ---- JSON door
  async query(sql: string, params: unknown[] = [], force = false): Promise<unknown> {
    this.#refuse(force);
    const pg = await this.#db();
    const t0 = Date.now();
    // With parameters: one prepared statement. Without: a script, any number
    // of statements, the last one's result comes back.
    let r: { rows: unknown[]; fields: { name: string }[]; affectedRows?: number };
    if (params.length) r = await pg.query(sql, params);
    else {
      const all = await pg.exec(sql);
      r = all[all.length - 1] ?? { rows: [], fields: [] };
    }
    const ms = Date.now() - t0;
    this.#worked(ms);
    return { rows: r.rows, fields: r.fields.map((f) => f.name), affected: r.affectedRows ?? 0, ms };
  }

  async stats(): Promise<Stats & { loaded: boolean; flags: Flags; beat: Beat; openSessions: number; alarm: boolean; storage?: ReturnType<BlockFS["summary"]>; heapBytes?: number; logicalBytes?: number; files?: number }> {
    const base = {
      ...this.#stats,
      loaded: !!this.#pg,
      flags: this.#flags,
      beat: this.#beat,
      openSessions: this.#sockets.size,
      alarm: this.#alarmSet,
      storage: this.#fs?.summary(),
    };
    if (!this.#pg) return base;
    // The WASM heap, and the logical size of the /pglite tree (the data
    // directory itself lives in storage; only the share files and the block
    // cache are in memory).
    const pg = await this.#pg;
    const mod = (pg as unknown as { Module: { HEAP8: Int8Array; FS: { readdir(p: string): string[]; stat(p: string): { size: number; mode: number }; isDir(m: number): boolean } } }).Module;
    let pgdataBytes = 0, files = 0;
    const walk = (dir: string) => {
      for (const n of mod.FS.readdir(dir)) {
        if (n === "." || n === "..") continue;
        const p = `${dir}/${n}`;
        const st = mod.FS.stat(p);
        if (mod.FS.isDir(st.mode)) walk(p);
        else { pgdataBytes += st.size; files++; }
      }
    };
    try { walk("/pglite"); } catch { /* best effort */ }
    return { ...base, heapBytes: mod.HEAP8.byteLength, logicalBytes: pgdataBytes, files };
  }

  /** The whole data directory as a tar.gz, consistent as of a checkpoint.
   *  This is the physical form: it restores onto another function engine
   *  (same wasm32 layout). A Linode box needs the logical form instead. */
  async exportTar(): Promise<ArrayBuffer> {
    if (this.#flags.tombstone) throw new Error("moved: this database now lives elsewhere");
    const pg = await this.#db();
    await pg.exec("checkpoint");
    const blob = await this.#fs!.dumpTar();
    return blob.arrayBuffer();
  }

  /** The database as plain SQL - schema and INSERTs - via pg_dump. This is
   *  the form that restores on any Postgres, including a Linode box. Allowed
   *  while frozen: it is how a move takes its copy. */
  async dumpSql(): Promise<string> {
    if (this.#flags.tombstone) throw new Error("moved: this database now lives elsewhere");
    const pg = await this.#db();
    const file = await pgDump({ pg, args: ["--no-owner", "--no-privileges"] });
    return file.text();
  }

  /** Forget the running engine: what eviction does, on demand. The data
   *  directory is in storage, so there is nothing to save first. */
  async reset(): Promise<{ closed: boolean }> {
    const had = !!this.#pg;
    if (this.#pg) await (await this.#pg).close().catch(() => {});
    this.#pg = null;
    this.#fs = null;
    return { closed: had };
  }

  #closeSessions(code: number, reason: string) {
    for (const ws of this.#sockets) {
      try { ws.close(code, reason); } catch { /* already gone */ }
    }
    this.#sockets.clear();
  }

  /** A move is on (or over). Frozen, new sessions are refused and open ones
   *  are cut, so nothing is written here that the move would not carry. */
  async freeze(frozen: boolean): Promise<Flags> {
    await this.#setFlags({ frozen });
    if (frozen) this.#closeSessions(4013, "moving");
    return this.#flags;
  }

  /** Gone: the database was deleted, or it moved to a box. Everything is
   *  dropped except a tombstone, so a client with a stale route is refused
   *  rather than handed an empty database under the old name. */
  async destroy(): Promise<{ destroyed: boolean }> {
    this.#closeSessions(4001, "moved");
    await this.reset();
    await this.ctx.storage.deleteAlarm();
    this.#alarmSet = false;
    await this.ctx.storage.deleteAll();
    this.#flags = { tombstone: new Date().toISOString() };
    await this.ctx.storage.put("flags", this.#flags);
    this.#beat = freshBeat();
    return { destroyed: true };
  }

  // ---- restore: three calls, so the Worker can stream the SQL through
  async beginRestore(): Promise<void> {
    this.#closeSessions(4013, "moving");
    await this.reset();
    await this.ctx.storage.deleteAll();
    this.#flags = { frozen: true };
    await this.ctx.storage.put("flags", this.#flags);
    await this.#db(); // a fresh golden directory
  }

  async exec(sql: string): Promise<void> {
    const pg = await this.#db();
    const t0 = Date.now();
    await pg.exec(sql);
    this.#beat.activeMs += Date.now() - t0;
  }

  async endRestore(info: { statements: number; bytes: number }): Promise<unknown> {
    const pg = await this.#db();
    await pg.exec("checkpoint");
    // The engine is one session: what pg_dump's preamble SET (an empty
    // search_path, for one) would otherwise follow every client in.
    await pg.exec("discard all");
    await this.#setFlags({ frozen: false });
    this.#schedule();
    return { ...info, storage: this.#fs?.summary() };
  }

  // ---- wire door: raw Postgres protocol over a WebSocket
  //
  // (Close codes are 1000 or 4xxx: those are the ones a Worker may send.)
  // Frames and messages are different things: a client may send half a
  // message in one frame and three in the next. The engine wants whole
  // messages, one call each, so bytes are gathered here and cut on message
  // boundaries - the first message is the untyped startup packet, every one
  // after it is a type byte and a length.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    if (this.#flags.tombstone) {
      server.close(4001, "moved");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (this.#flags.frozen) {
      server.close(4013, "moving");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.#sockets.add(server);
    const opened = Date.now();
    this.#worked(0, "session");
    // One engine session serves every client in turn, so a client starts
    // with the settings the previous one left behind unless they are reset
    // here. (Best effort: RESET is allowed mid-transaction, and two clients
    // open at once still share state - the price of a single session.)
    this.#chain = this.#chain.then(async () => {
      try { await (await this.#db()).exec("reset all"); } catch { /* the startup message will say why */ }
    });

    let buf = new Uint8Array(0);
    let started = false;
    const append = (more: Uint8Array) => {
      const next = new Uint8Array(buf.length + more.length);
      next.set(buf);
      next.set(more, buf.length);
      buf = next;
    };
    const send = (out: Uint8Array) => {
      for (let i = 0; i < out.length; i += FRAME) server.send(out.subarray(i, Math.min(i + FRAME, out.length)));
    };
    const run = (msg: Uint8Array) => {
      this.#chain = this.#chain.then(async () => {
        if (server.readyState !== WebSocket.READY_STATE_OPEN) return;
        try {
          const pg = await this.#db();
          const t0 = Date.now();
          const out = await pg.execProtocolRaw(msg);
          this.#worked(Date.now() - t0);
          if (out.byteLength) send(out);
        } catch (e) {
          server.close(4011, String(e).slice(0, 120));
        }
      });
    };

    server.addEventListener("message", (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      append(new Uint8Array(ev.data));
      for (;;) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        if (!started) {
          if (buf.length < 4) return;
          const len = view.getUint32(0);
          if (len < 8 || len > MAX_STARTUP) return server.close(4002, "bad startup packet");
          if (buf.length < len) return;
          run(buf.slice(0, len));
          buf = buf.slice(len);
          started = true;
          continue;
        }
        if (buf.length < 5) return;
        const len = view.getUint32(1) + 1;
        if (buf.length < len) return;
        const msg = buf.slice(0, len);
        buf = buf.slice(len);
        // Terminate: the session is over. Not handed to the engine, which
        // would take it as the end of its one and only session.
        if (msg[0] === 0x58) {
          this.#chain = this.#chain.then(() => server.close(1000, "terminated"));
          return;
        }
        run(msg);
      }
    });
    const gone = () => {
      if (this.#sockets.delete(server)) this.#beat.activeMs += Math.min(Date.now() - opened, BEAT_EVERY_MS);
    };
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);
    return new Response(null, { status: 101, webSocket: client });
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });


// ---- MCP over HTTP: the thread database as a tool Claude can call directly.
// Read-only (four SELECTs), authed by LITE_TOKEN like every other door. The
// Streamable-HTTP transport: a JSON-RPC request per POST, a JSON response back.
const MCP_DB = "claude-threads";
const MCP_PROTO = "2025-06-18";
const mcpWhen = (t: unknown) => (t ? new Date(String(t)).toISOString().replace("T", " ").slice(0, 16) : "");
const mcpOne = (x: unknown, n = 600) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function mcpRows(env: Env, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const r = (await env.DATABASE.getByName(MCP_DB).query(sql, params)) as { rows: Record<string, unknown>[] };
  return r.rows ?? [];
}

const MCP_TOOLS = [
  {
    name: "search_threads",
    description:
      "Full-text search across every past Claude Code conversation (all projects). Returns the best-matching turns with their thread, time, role and a snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "words to search for" },
        limit: { type: "integer", description: "max matches (default 20, max 50)" },
        project: { type: "string", description: "restrict to a project directory name" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_threads",
    description: "List recent conversation threads, most recent first: session id, project, title, message count and times.",
    inputSchema: { type: "object", properties: { limit: { type: "integer" }, project: { type: "string" } } },
  },
  {
    name: "get_thread",
    description: "Return the spoken turns (user + assistant text) of one thread, chronological. Full or 8-char session id.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, limit: { type: "integer" } }, required: ["session_id"] },
  },
  { name: "thread_stats", description: "Totals for the thread database: messages, threads, size.", inputSchema: { type: "object", properties: {} } },
];

const MCP_HANDLERS: Record<string, (env: Env, a: Record<string, unknown>) => Promise<string>> = {
  async search_threads(env, a) {
    const q = String(a.query ?? "").trim();
    if (!q) throw new Error("query is required");
    const limit = Math.min(Math.max(1, Number(a.limit) || 20), 50);
    const project = a.project ? String(a.project) : null;
    const run = (tsq: string, arg: string) => {
      const params: unknown[] = [arg];
      let where = `to_tsvector('simple', coalesce(m.text,'') || ' ' || coalesce(m.tool_output,'')) @@ ${tsq}`;
      if (project) { params.push(project); where += ` and t.project = $${params.length}`; }
      params.push(limit);
      return mcpRows(env,
        `select m.session_id, t.title, t.project, m.role, m.kind, m.at, m.text, m.tool_output,
                ts_rank_cd(to_tsvector('simple', coalesce(m.text,'') || ' ' || coalesce(m.tool_output,'')), ${tsq}) as rank
           from messages m join threads t on t.session_id = m.session_id
          where ${where} order by rank desc, m.at desc limit $${params.length}`, params);
    };
    let hits = await run("plainto_tsquery('simple', $1)", q);
    if (!hits.length) {
      const or = q.split(/\s+/).map((w) => w.replace(/[^\w]/g, "")).filter(Boolean).join(" | ");
      if (or) hits = await run("to_tsquery('simple', $1)", or);
    }
    if (!hits.length) return `No matches for "${q}".`;
    return [`${hits.length} matches for "${q}":`, "", ...hits.map((h) =>
      `- ${mcpWhen(h.at)} · ${h.title ?? String(h.session_id).slice(0, 8)} (${String(h.session_id).slice(0, 8)}, ${h.project}) · ${h.role}/${h.kind}: ${mcpOne(h.text ?? h.tool_output)}`)].join("\n");
  },
  async list_threads(env, a) {
    const limit = Math.min(Math.max(1, Number(a.limit) || 20), 100);
    const project = a.project ? String(a.project) : null;
    const params: unknown[] = []; let where = "";
    if (project) { params.push(project); where = "where project = $1"; }
    params.push(limit);
    const rows = await mcpRows(env, `select session_id, project, title, last_at, messages from threads ${where} order by last_at desc nulls last limit $${params.length}`, params);
    if (!rows.length) return "No threads yet.";
    return [`${rows.length} recent threads:`, "", ...rows.map((t) => `- ${mcpWhen(t.last_at)} · ${t.messages} msgs · ${t.title ?? "(untitled)"} · ${t.project} · ${String(t.session_id).slice(0, 8)}`)].join("\n");
  },
  async get_thread(env, a) {
    let sid = String(a.session_id ?? "");
    if (!sid) throw new Error("session_id is required");
    const limit = Math.min(Math.max(1, Number(a.limit) || 50), 400);
    if (sid.length < 36) {
      const m = (await mcpRows(env, `select session_id from threads where session_id like $1 order by last_at desc limit 1`, [sid + "%"]))[0];
      if (!m) return `No thread starting with "${a.session_id}".`;
      sid = String(m.session_id);
    }
    const t = (await mcpRows(env, `select title, project from threads where session_id = $1`, [sid]))[0];
    const tail = (await mcpRows(env, `select role, at, text from messages where session_id = $1 and kind = 'text' and not sidechain order by at desc limit $2`, [sid, limit])).reverse();
    const tools = (await mcpRows(env, `select count(*) as n from messages where session_id = $1 and kind = 'tool_use'`, [sid]))[0]?.n;
    if (!tail.length) return `Thread ${sid.slice(0, 8)} has no spoken turns yet.`;
    return `# ${t?.title ?? sid.slice(0, 8)} · ${t?.project ?? ""} · ${sid}\n${tail.length} spoken turns (${tools} tool calls not shown)\n\n` +
      tail.map((m) => `- ${mcpWhen(m.at)} **${m.role}**: ${mcpOne(m.text, 900)}`).join("\n");
  },
  async thread_stats(env) {
    const r = (await mcpRows(env, `select count(*) as messages, count(distinct session_id) as threads, pg_size_pretty(pg_database_size(current_database())) as size from messages`))[0];
    return `Thread database "${MCP_DB}": ${r.messages} messages across ${r.threads} threads, ${r.size}.`;
  },
};

const mcpCors = (r: Response) => {
  r.headers.set("access-control-allow-origin", "*");
  r.headers.set("access-control-allow-methods", "POST, OPTIONS");
  r.headers.set("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
  return r;
};

async function mcpHandle(request: Request, env: Env): Promise<Response> {
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { msg = (await request.json()) as typeof msg; } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  const { id, method, params } = msg;
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id, result });
  if (method === "initialize")
    return reply({ protocolVersion: (params?.protocolVersion as string) || MCP_PROTO, capabilities: { tools: {} }, serverInfo: { name: "barua-threads", version: "1.0.0" } });
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (method === "resources/list") return reply({ resources: [] });
  if (method === "prompts/list") return reply({ prompts: [] });
  if (method?.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (method === "tools/call") {
    const fn = MCP_HANDLERS[String(params?.name)];
    if (!fn) return reply({ content: [{ type: "text", text: `unknown tool ${params?.name}` }], isError: true });
    try { return reply({ content: [{ type: "text", text: await fn(env, (params?.arguments as Record<string, unknown>) ?? {}) }] }); }
    catch (e) { return reply({ content: [{ type: "text", text: "error: " + String((e as Error)?.message ?? e) }], isError: true }); }
  }
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `method not found: ${method}` } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The MCP door: its own CORS + preflight, then the shared token check.
    if (url.pathname === "/mcp") {
      if (request.method === "OPTIONS") return mcpCors(new Response(null, { status: 204 }));
      if (!allowed(request, url, env)) return mcpCors(json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "a token is required" } }, 401));
      return mcpCors(await mcpHandle(request, env));
    }
    if (!allowed(request, url, env)) return json({ error: "a token is required" }, 401);
    const [, door, name, action] = url.pathname.split("/");
    if (!name || !/^[a-z][a-z0-9-]{0,40}$/.test(name)) return json({ error: "give a database name: /db/<name>/query or /wire/<name>" }, 400);
    const stub = env.DATABASE.getByName(name);
    const force = url.searchParams.get("force") === "1";

    if (door === "wire") return stub.fetch(request);
    if (door !== "db") return json({ error: "not found" }, 404);

    try {
      if (action === "query" && request.method === "POST") {
        const b = (await request.json()) as { sql?: string; params?: unknown[] };
        if (!b.sql) return json({ error: "sql is required" }, 400);
        return json(await stub.query(b.sql, b.params ?? [], force));
      }
      if (action === "stats") return json(await stub.stats());
      if (action === "dump" && request.method === "GET") {
        const sql = await stub.dumpSql();
        return new Response(sql, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}.sql"` } });
      }
      if (action === "export" && request.method === "GET") {
        const buf = await stub.exportTar();
        return new Response(buf, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}.tar.gz"`, "content-length": String(buf.byteLength) } });
      }
      if (action === "reset" && request.method === "POST") return json(await stub.reset());
      if (action === "freeze" && request.method === "POST") {
        const b = (await request.json().catch(() => ({}))) as { frozen?: boolean };
        return json(await stub.freeze(b.frozen !== false));
      }
      if (action === "destroy" && request.method === "POST") return json(await stub.destroy());
      if (action === "restore" && request.method === "POST") {
        if (!request.body) return json({ error: "a SQL body is required" }, 400);
        await stub.beginRestore();
        const splitter = new SqlSplitter();
        const reader = request.body.pipeThrough(new TextDecoderStream()).getReader();
        let statements = 0, bytes = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            for (const chunk of splitter.push(value)) {
              await stub.exec(chunk.sql);
              statements += chunk.count;
            }
          }
          const last = splitter.flush();
          if (last.sql.trim()) {
            await stub.exec(last.sql);
            statements += last.count;
          }
        } catch (e) {
          // Half a database is worse than none: leave a tombstone, not a stub.
          await stub.destroy().catch(() => {});
          return json({ error: `restore failed after ${statements} statements: ${String(e).slice(0, 300)}` }, 500);
        }
        return json(await stub.endRestore({ statements, bytes }));
      }
    } catch (e) {
      const err = e as Error;
      const msg = String(err);
      const status = msg.includes("moved:") ? 410 : msg.includes("moving:") ? 409 : 500;
      return json({ error: msg, stack: status === 500 ? (err.stack ?? "").split("\n").slice(0, 6) : undefined }, status);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
