// barua-lite: Postgres as a function.
//
// One Durable Object per database. Inside it, PGlite — Postgres compiled to
// WebAssembly, the real engine, not an imitation — with its data directory
// in memory. The directory is restored from R2 when the object opens and
// written back shortly after each change. While nobody is talking to it the
// object is evicted and costs nothing; there is no process to keep warm,
// because there is no process.
//
// Two doors: POST /db/<name>/query for JSON, and a WebSocket at
// /wire/<name> that carries raw Postgres wire-protocol messages, so a bridge
// can put psql, Prisma or Django in front of it unchanged.
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
import { PGlite } from "@electric-sql/pglite";
import pgliteWasm from "./pglite/pglite.wasm";
import initdbWasm from "./pglite/initdb.wasm";
import pgliteData from "./pglite/pglite.data";
// An empty, already-initialised data directory, built once in Node
// (scripts in /tmp/pglite-golden): every new database starts from it, so
// initdb - which needs to run a child process - never runs in the Worker.
import golden from "./pglite/golden.tar.gz";
import { BlockFS } from "./blockfs";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";
import pgDumpWasm from "./pglite/pg_dump.wasm";
// pg_dump compiled to WebAssembly, handed its module the same way (see
// scripts/patch-pglite.mjs): the logical form of a database, plain SQL,
// which is what moves to a Linode box or anywhere else Postgres runs.
(globalThis as { __pgDumpWasm?: WebAssembly.Module }).__pgDumpWasm = pgDumpWasm;

export interface Env {
  DATABASE: DurableObjectNamespace<Database>;
  HOME: R2Bucket;
  /** One shared secret for now; the control plane will issue per-database credentials later. */
  LITE_TOKEN?: string;
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
  snapshotBytes: number | null;
  savedAt: string | null;
  saves: number;
  queries: number;
  /** Random per class instance: changes whenever the platform resets the object. */
  instance: string;
  lastSaveMs: number | null;
};

export class Database extends DurableObject<Env> {
  #pg: Promise<PGlite> | null = null;
  #fs: BlockFS | null = null;
  #stats: Stats = { name: "", openedFromSnapshot: false, openMs: null, snapshotBytes: null, savedAt: null, saves: 0, queries: 0, instance: Math.random().toString(36).slice(2, 8), lastSaveMs: null };
  // One wire message at a time: PGlite is a single session.
  #chain: Promise<unknown> = Promise.resolve();

  get #name(): string {
    return this.ctx.id.name ?? "unnamed";
  }
  get #key(): string {
    return `dbs/${this.#name}/pgdata.tar.gz`;
  }

  async #open(): Promise<PGlite> {
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

  /** Every write already went through to storage; nothing to do. */
  async #touch() {}

  // ---- JSON door
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    const pg = await this.#db();
    const t0 = Date.now();
    // With parameters: one prepared statement. Without: a script, any number
    // of statements, the last one's result comes back.
    let r: { rows: unknown[]; fields: { name: string }[]; affectedRows?: number };
    if (params.length) r = await pg.query(sql, params);
    else { const all = await pg.exec(sql); r = all[all.length - 1] ?? { rows: [], fields: [] }; }
    this.#stats.queries++;
    return { rows: r.rows, fields: r.fields.map((f) => f.name), affected: r.affectedRows ?? 0, ms: Date.now() - t0 };
  }

  async stats(): Promise<Stats & { loaded: boolean; storage?: ReturnType<BlockFS["summary"]>; heapBytes?: number; logicalBytes?: number; files?: number }> {
    const base = { ...this.#stats, loaded: !!this.#pg, storage: this.#fs?.summary() };
    if (!this.#pg) return base;
    // The WASM heap, and the logical size of the /pglite tree (the data
    // directory itself lives in storage now; only the share files and the
    // block cache are in memory).
    const pg = await this.#pg;
    const mod = (pg as unknown as { Module: { HEAP8: Int8Array; FS: { readdir(p: string): string[]; stat(p: string): { size: number; mode: number }; isDir(m: number): boolean } } }).Module;
    let pgdataBytes = 0, files = 0;
    const walk = (dir: string) => {
      for (const n of mod.FS.readdir(dir)) {
        if (n === "." || n === "..") continue;
        const p = `${dir}/${n}`;
        const st = mod.FS.stat(p);
        if (mod.FS.isDir(st.mode)) walk(p); else { pgdataBytes += st.size; files++; }
      }
    };
    try { walk("/pglite"); } catch { /* best effort */ }
    return { ...base, heapBytes: mod.HEAP8.byteLength, logicalBytes: pgdataBytes, files };
  }

  /** The whole data directory as a tar.gz, consistent as of a checkpoint.
   *  This is the physical form: it restores onto another function engine
   *  (same wasm32 layout). A Linode box needs the logical form instead. */
  async exportTar(): Promise<ArrayBuffer> {
    const pg = await this.#db();
    await pg.exec("checkpoint");
    const blob = await this.#fs!.dumpTar();
    return blob.arrayBuffer();
  }

  /** The database as plain SQL - schema and INSERTs - via pg_dump. This is
   *  the form that restores on any Postgres, including a Linode box. */
  async dumpSql(): Promise<string> {
    const pg = await this.#db();
    const file = await pgDump({ pg, args: ["--no-owner", "--no-privileges"] });
    return file.text();
  }

  /** Forget the running engine: what eviction does, on demand. The data
   *  directory is in storage, so there is nothing to save first. */
  async reset(): Promise<{ closed: boolean }> {
    const had = !!this.#pg;
    if (this.#pg) await (await this.#pg).close().catch(() => {});
    this.#pg = null; this.#fs = null;
    return { closed: had };
  }

  // ---- wire door: raw Postgres protocol over a WebSocket
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.addEventListener("message", (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(ev.data);
      this.#chain = this.#chain.then(async () => {
        try {
          const pg = await this.#db();
          const out = await pg.execProtocolRaw(bytes);
          this.#stats.queries++;
          if (out.byteLength) server.send(out);
        } catch (e) {
          server.close(1011, String(e).slice(0, 120));
        }
      });
    });
    server.addEventListener("close", () => {});
    return new Response(null, { status: 101, webSocket: client });
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!allowed(request, url, env)) return json({ error: "a token is required" }, 401);
    const [, door, name, action] = url.pathname.split("/");
    if (!name || !/^[a-z][a-z0-9-]{0,40}$/.test(name)) return json({ error: "give a database name: /db/<name>/query or /wire/<name>" }, 400);
    const stub = env.DATABASE.getByName(name);

    if (door === "wire") return stub.fetch(request);
    if (door !== "db") return json({ error: "not found" }, 404);

    try {
      if (action === "query" && request.method === "POST") {
        const b = (await request.json()) as { sql?: string; params?: unknown[] };
        if (!b.sql) return json({ error: "sql is required" }, 400);
        return json(await stub.query(b.sql, b.params ?? []));
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
    } catch (e) {
      const err = e as Error;
      return json({ error: String(err), stack: (err.stack ?? "").split("\n").slice(0, 6) }, 500);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
