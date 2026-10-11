// A Postgres data directory kept in the Durable Object's own SQLite storage,
// eight kilobytes at a time.
//
// PGlite's filesystem contract is synchronous and so is Durable Object SQL,
// which makes this a straight mapping: a file is a row in fs_nodes and a
// run of 8 KB rows in fs_blocks. Every write goes through to storage as it
// happens, so a committed transaction is on disk when the request ends and
// nothing waits for a dump. A small cache keeps hot pages in memory; the
// directory tree lives in memory too, it is a thousand entries.
//
// Paths arrive relative to the data directory with a leading slash, the
// root as "". Errors carry a numeric errno in .code, which is what the
// Emscripten driver reads.
import { BaseFilesystem, ERRNO_CODES, type FsStats } from "@electric-sql/pglite/basefs";

export const BLOCK = 8192;
const DIR = 16384, FILE = 32768;

class FsErr extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}
const enoent = (p: string) => new FsErr(ERRNO_CODES.ENOENT, `no such file: ${p}`);

type Node = { dir: boolean; mode: number; size: number; mtime: number };
type NodeRow = { path: string; dir: number; mode: number; size: number; mtime: number };

export class BlockFS extends BaseFilesystem {
  #sql: SqlStorage;
  #golden: ArrayBuffer;
  #nodes = new Map<string, Node>();
  #fds = new Map<number, string>();
  #nextFd = 3;
  #cache = new Map<string, Uint8Array>();
  #cacheMax: number;
  readonly counters = { reads: 0, hits: 0, writes: 0, blocksWritten: 0, imported: 0 };

  constructor(sql: SqlStorage, golden: ArrayBuffer, cacheBlocks = 1024) {
    super("/");
    this.#sql = sql;
    this.#golden = golden;
    this.#cacheMax = cacheBlocks;
  }

  // ---- lifecycle
  async init(pg: Parameters<BaseFilesystem["init"]>[0], opts: Parameters<BaseFilesystem["init"]>[1]) {
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS fs_nodes (
      path TEXT PRIMARY KEY, dir INTEGER NOT NULL, mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL)`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS fs_blocks (
      path TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, idx))`);
    const n = this.#sql.exec<{ n: number }>("SELECT count(*) AS n FROM fs_nodes").one().n;
    if (n === 0) await this.#importGolden();
    for (const r of this.#sql.exec<NodeRow>("SELECT path, dir, mode, size, mtime FROM fs_nodes")) {
      this.#nodes.set(r.path, { dir: r.dir === 1, mode: r.mode, size: r.size, mtime: r.mtime });
    }
    return super.init(pg, opts);
  }

  /** The empty, initialised directory every database starts from, unpacked
   *  from its tarball straight into storage. Once per database, ever. */
  async #importGolden() {
    const raw = new Uint8Array(await new Response(new Blob([this.#golden]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const now = Date.now();
    const dec = new TextDecoder();
    const field = (at: number, len: number) => dec.decode(raw.subarray(at, at + len)).replace(/\0.*$/s, "");
    const octal = (at: number, len: number) => parseInt(field(at, len).trim() || "0", 8);
    this.#mkdirRow("", now);
    let longName: string | null = null;
    for (let at = 0; at + 512 <= raw.length; ) {
      if (raw[at] === 0) break; // two zero blocks end the archive
      const size = octal(at + 124, 12), type = String.fromCharCode(raw[at + 156]!);
      const prefix = field(at + 345, 155);
      let name = longName ?? (prefix ? `${prefix}/${field(at, 100)}` : field(at, 100));
      longName = null;
      const body = raw.subarray(at + 512, at + 512 + size);
      at += 512 + Math.ceil(size / 512) * 512;
      if (type === "L") { longName = dec.decode(body).replace(/\0.*$/s, ""); continue; }
      name = name.replace(/^\.?\/+/, "").replace(/\/+$/, "");
      if (!name) continue;
      const path = "/" + name;
      this.#ensureParents(path, now);
      if (type === "5") { this.#mkdirRow(path, now, octal(at - 512 - Math.ceil(size / 512) * 512 + 100, 8) || 0o700); continue; }
      if (type !== "0" && type !== "\0" && type !== "") continue;
      this.#sql.exec("INSERT OR REPLACE INTO fs_nodes (path, dir, mode, size, mtime) VALUES (?, 0, ?, ?, ?)", path, FILE | 0o600, size, now);
      for (let i = 0; i * BLOCK < size; i++) {
        const chunk = body.subarray(i * BLOCK, Math.min(size, (i + 1) * BLOCK));
        const blk = new Uint8Array(BLOCK); blk.set(chunk);
        this.#sql.exec("INSERT OR REPLACE INTO fs_blocks (path, idx, data) VALUES (?, ?, ?)", path, i, blk.buffer);
      }
      this.counters.imported++;
    }
  }
  #mkdirRow(path: string, now: number, perm = 0o700) {
    this.#sql.exec("INSERT OR IGNORE INTO fs_nodes (path, dir, mode, size, mtime) VALUES (?, 1, ?, 0, ?)", path, DIR | perm, now);
  }
  #ensureParents(path: string, now: number) {
    const parts = path.split("/").slice(1, -1);
    let p = "";
    for (const part of parts) { p += "/" + part; this.#mkdirRow(p, now); }
  }

  // ---- helpers
  #node(path: string): Node {
    const n = this.#nodes.get(path);
    if (!n) throw enoent(path);
    return n;
  }
  #file(path: string): Node {
    const n = this.#node(path);
    if (n.dir) throw new FsErr(ERRNO_CODES.EISDIR, `is a directory: ${path}`);
    return n;
  }
  #parentOf(path: string) {
    const i = path.lastIndexOf("/");
    return i <= 0 ? "" : path.slice(0, i);
  }
  #saveNode(path: string, n: Node) {
    this.#sql.exec("UPDATE fs_nodes SET mode = ?, size = ?, mtime = ? WHERE path = ?", n.mode, n.size, n.mtime, path);
  }
  #block(path: string, idx: number): Uint8Array {
    const key = `${path}\0${idx}`;
    const hit = this.#cache.get(key);
    this.counters.reads++;
    if (hit) { this.counters.hits++; return hit; }
    const row = this.#sql.exec<{ data: ArrayBuffer }>("SELECT data FROM fs_blocks WHERE path = ? AND idx = ?", path, idx).toArray()[0];
    const blk = row ? new Uint8Array(row.data) : new Uint8Array(BLOCK);
    this.#remember(key, blk);
    return blk;
  }
  #remember(key: string, blk: Uint8Array) {
    if (this.#cache.size >= this.#cacheMax) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(key, blk);
  }
  #putBlock(path: string, idx: number, blk: Uint8Array) {
    this.#sql.exec("INSERT OR REPLACE INTO fs_blocks (path, idx, data) VALUES (?, ?, ?)", path, idx, blk.buffer.slice(blk.byteOffset, blk.byteOffset + BLOCK));
    this.#remember(`${path}\0${idx}`, blk);
    this.counters.blocksWritten++;
  }
  #forgetBlocks(path: string, fromIdx = 0) {
    for (const k of [...this.#cache.keys()]) {
      const [p, i] = k.split("\0");
      if (p === path && Number(i) >= fromIdx) this.#cache.delete(k);
    }
  }

  // ---- the contract
  chmod(path: string, mode: number): void {
    const n = this.#node(path); n.mode = mode; this.#saveNode(path, n);
  }
  utimes(path: string, _atime: number, mtime: number): void {
    const n = this.#node(path); n.mtime = mtime; this.#saveNode(path, n);
  }
  lstat(path: string): FsStats {
    const n = this.#node(path);
    return { dev: 0, ino: 0, mode: n.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size: n.size, blksize: BLOCK,
      blocks: Math.ceil(n.size / BLOCK), atime: n.mtime, mtime: n.mtime, ctime: n.mtime };
  }
  fstat(fd: number): FsStats {
    const p = this.#fds.get(fd);
    if (p === undefined) throw new FsErr(ERRNO_CODES.EBADF, `bad fd ${fd}`);
    return this.lstat(p);
  }
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    if (this.#nodes.has(path)) throw new FsErr(ERRNO_CODES.EEXIST, `exists: ${path}`);
    const parent = this.#parentOf(path);
    if (!this.#nodes.has(parent)) {
      if (options?.recursive) this.mkdir(parent, options); else throw enoent(parent);
    }
    const n: Node = { dir: true, mode: (options?.mode ?? 0o700) | DIR, size: 0, mtime: Date.now() };
    this.#sql.exec("INSERT INTO fs_nodes (path, dir, mode, size, mtime) VALUES (?, 1, ?, 0, ?)", path, n.mode, n.mtime);
    this.#nodes.set(path, n);
  }
  readdir(path: string): string[] {
    const n = this.#node(path);
    if (!n.dir) throw new FsErr(ERRNO_CODES.ENOTDIR, `not a directory: ${path}`);
    const prefix = path + "/";
    const out: string[] = [];
    for (const p of this.#nodes.keys()) {
      if (p.startsWith(prefix) && !p.includes("/", prefix.length)) out.push(p.slice(prefix.length));
    }
    return out;
  }
  open(path: string): number {
    this.#file(path);
    const fd = this.#nextFd++;
    this.#fds.set(fd, path);
    return fd;
  }
  close(fd: number): void {
    this.#fds.delete(fd);
  }
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const path = this.#fds.get(fd);
    if (path === undefined) throw new FsErr(ERRNO_CODES.EBADF, `bad fd ${fd}`);
    const n = this.#file(path);
    if (position >= n.size) return 0;
    const end = Math.min(n.size, position + length);
    const dst = new Uint8Array(buffer.buffer, offset, length);
    let pos = position, out = 0;
    while (pos < end) {
      const idx = Math.floor(pos / BLOCK), within = pos % BLOCK;
      const take = Math.min(BLOCK - within, end - pos);
      dst.set(this.#block(path, idx).subarray(within, within + take), out);
      pos += take; out += take;
    }
    return out;
  }
  write(fd: number, buffer: Uint8Array | ArrayBuffer, offset: number, length: number, position: number): number {
    const path = this.#fds.get(fd);
    if (path === undefined) throw new FsErr(ERRNO_CODES.EBADF, `bad fd ${fd}`);
    const n = this.#file(path);
    // The driver hands write() the heap's ArrayBuffer and read() a view on it.
    const src = buffer instanceof ArrayBuffer ? new Uint8Array(buffer, offset, length) : new Uint8Array(buffer.buffer, offset, length);
    let pos = position, done = 0;
    while (done < length) {
      const idx = Math.floor(pos / BLOCK), within = pos % BLOCK;
      const take = Math.min(BLOCK - within, length - done);
      const blk = take === BLOCK ? new Uint8Array(BLOCK) : this.#block(path, idx);
      blk.set(src.subarray(done, done + take), within);
      this.#putBlock(path, idx, blk);
      pos += take; done += take;
    }
    this.counters.writes++;
    n.size = Math.max(n.size, position + length); n.mtime = Date.now();
    this.#saveNode(path, n);
    return length;
  }
  truncate(path: string, len = 0): void {
    const n = this.#file(path);
    if (len < n.size) {
      const keep = len === 0 ? 0 : Math.floor((len - 1) / BLOCK) + 1;
      this.#sql.exec("DELETE FROM fs_blocks WHERE path = ? AND idx >= ?", path, keep);
      this.#forgetBlocks(path, keep);
      if (len % BLOCK !== 0) {
        const last = this.#block(path, keep - 1);
        last.fill(0, len % BLOCK);
        this.#putBlock(path, keep - 1, last);
      }
    }
    n.size = len; n.mtime = Date.now();
    this.#saveNode(path, n);
  }
  unlink(path: string): void {
    this.#file(path);
    this.#sql.exec("DELETE FROM fs_blocks WHERE path = ?", path);
    this.#sql.exec("DELETE FROM fs_nodes WHERE path = ?", path);
    this.#forgetBlocks(path);
    this.#nodes.delete(path);
  }
  rmdir(path: string): void {
    const n = this.#node(path);
    if (!n.dir) throw new FsErr(ERRNO_CODES.ENOTDIR, `not a directory: ${path}`);
    if (this.readdir(path).length) throw new FsErr(ERRNO_CODES.ENOTEMPTY, `not empty: ${path}`);
    this.#sql.exec("DELETE FROM fs_nodes WHERE path = ?", path);
    this.#nodes.delete(path);
  }
  rename(oldPath: string, newPath: string): void {
    const n = this.#node(oldPath);
    if (this.#nodes.has(newPath)) { if (this.#nodes.get(newPath)!.dir) this.rmdir(newPath); else this.unlink(newPath); }
    if (n.dir) {
      const prefix = oldPath + "/";
      const moved = [...this.#nodes.keys()].filter((p) => p === oldPath || p.startsWith(prefix));
      for (const p of moved) {
        const q = newPath + p.slice(oldPath.length);
        this.#sql.exec("UPDATE fs_nodes SET path = ? WHERE path = ?", q, p);
        this.#sql.exec("UPDATE fs_blocks SET path = ? WHERE path = ?", q, p);
        this.#nodes.set(q, this.#nodes.get(p)!); this.#nodes.delete(p);
      }
      this.#cache.clear();
    } else {
      this.#sql.exec("UPDATE fs_nodes SET path = ? WHERE path = ?", newPath, oldPath);
      this.#sql.exec("UPDATE fs_blocks SET path = ? WHERE path = ?", newPath, oldPath);
      this.#nodes.set(newPath, n); this.#nodes.delete(oldPath);
      this.#forgetBlocks(oldPath);
      for (const [fd, p] of this.#fds) if (p === oldPath) this.#fds.set(fd, newPath);
    }
  }
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): void {
    if (!this.#nodes.has(path)) {
      const n: Node = { dir: false, mode: (options?.mode ?? 0o600) | FILE, size: 0, mtime: Date.now() };
      this.#sql.exec("INSERT INTO fs_nodes (path, dir, mode, size, mtime) VALUES (?, 0, ?, 0, ?)", path, n.mode, n.mtime);
      this.#nodes.set(path, n);
    } else {
      this.truncate(path, 0);
    }
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.byteLength) {
      const fd = this.open(path);
      this.write(fd, bytes, bytes.byteOffset, bytes.byteLength, 0);
      this.close(fd);
    }
  }
  async dumpTar(): Promise<Blob> {
    throw new Error("dumpTar: export from storage is not implemented yet");
  }

  /** For /stats: what is in storage and how the cache is doing. */
  summary() {
    const blocks = this.#sql.exec<{ n: number }>("SELECT count(*) AS n FROM fs_blocks").one().n;
    return { files: this.#nodes.size, blocks, storedBytes: blocks * BLOCK, cachedBlocks: this.#cache.size, ...this.counters };
  }
}
