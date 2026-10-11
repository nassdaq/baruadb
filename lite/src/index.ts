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

export interface Env {
  DATABASE: DurableObjectNamespace<Database>;
  HOME: R2Bucket;
}

const SAVE_AFTER_MS = 300;

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
  #dirty = false;
  #saving: Promise<void> | null = null;
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
    const snap = await this.env.HOME.get(this.#key);
    const bytes = snap ? await snap.arrayBuffer() : null;
    const pg = await PGlite.create({
      dataDir: "memory://",
      pgliteWasmModule: pgliteWasm,
      initdbWasmModule: initdbWasm,
      fsBundle: new Blob([pgliteData]),
      loadDataDir: new Blob([bytes ?? golden]),
      relaxedDurability: true,
      initialMemory: 512 * 65536,
    });
    this.#stats.name = this.#name;
    this.#stats.openedFromSnapshot = !!bytes;
    this.#stats.snapshotBytes = bytes?.byteLength ?? null;
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

  /** Something may have changed: write the directory back soon. */
  async #touch() {
    this.#dirty = true;
    await this.ctx.storage.setAlarm(Date.now() + SAVE_AFTER_MS);
  }

  async #save() {
    if (!this.#dirty || !this.#pg) return;
    this.#dirty = false;
    const pg = await this.#pg;
    const t0 = Date.now();
    // Uncompressed: the tar is built in memory either way, and gzip's
    // buffers on top of it were enough to tip the isolate over its limit.
    const tar = await pg.dumpDataDir("none");
    const buf = await tar.arrayBuffer();
    await this.env.HOME.put(this.#key, buf);
    this.#stats.lastSaveMs = Date.now() - t0;
    console.log(`save ${this.#name}: ${buf.byteLength} bytes in ${this.#stats.lastSaveMs} ms (instance ${this.#stats.instance})`);
    this.#stats.saves++;
    this.#stats.savedAt = new Date().toISOString();
    this.#stats.snapshotBytes = buf.byteLength;
  }

  async alarm() {
    await this.#save();
    if (this.#dirty) await this.ctx.storage.setAlarm(Date.now() + SAVE_AFTER_MS);
  }

  // ---- JSON door
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    const pg = await this.#db();
    const t0 = Date.now();
    const r = await pg.query(sql, params);
    this.#stats.queries++;
    await this.#touch();
    return { rows: r.rows, fields: r.fields.map((f) => f.name), affected: r.affectedRows ?? 0, ms: Date.now() - t0 };
  }

  async stats(): Promise<Stats & { loaded: boolean; dirty: boolean; heapBytes?: number; pgdataBytes?: number; files?: number }> {
    const base = { ...this.#stats, loaded: !!this.#pg, dirty: this.#dirty };
    if (!this.#pg) return base;
    // What the memory is spent on: the WASM heap, and the data directory
    // held in the in-memory filesystem.
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
    return { ...base, heapBytes: mod.HEAP8.byteLength, pgdataBytes, files };
  }

  /** Save and forget the in-memory database: what eviction does, on demand. */
  async reset(): Promise<{ saved: boolean }> {
    const had = !!this.#pg;
    await this.#save();
    if (this.#pg) await (await this.#pg).close();
    this.#pg = null;
    return { saved: had };
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
          await this.#touch();
        } catch (e) {
          server.close(1011, String(e).slice(0, 120));
        }
      });
    });
    server.addEventListener("close", () => void this.#save());
    return new Response(null, { status: 101, webSocket: client });
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
      if (action === "reset" && request.method === "POST") return json(await stub.reset());
    } catch (e) {
      const err = e as Error;
      return json({ error: String(err), stack: (err.stack ?? "").split("\n").slice(0, 6) }, 500);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
