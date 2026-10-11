import { PGlite } from "@electric-sql/pglite";
import { writeFileSync } from "node:fs";
const t0 = Date.now();
const pg = await PGlite.create({ dataDir: "memory://", initDbStartParams: ["--wal-segsize=1"] });
await pg.query("select 1");
// Find PGDATA inside the in-memory filesystem (it holds PG_VERSION).
const FS = pg.Module.FS;
// PGDATA is the directory holding postgresql.conf (every database under
// base/ has its own PG_VERSION, so that file is not a marker).
const find = (d) => { for (const n of FS.readdir(d)) { if (n === "." || n === "..") continue; const p = `${d}/${n}`; if (n === "postgresql.conf") return d; if (FS.isDir(FS.stat(p).mode)) { const r = find(p); if (r) return r; } } };
const PGDATA = find("/pglite");
// Postgres sized for one person's app inside a 128 MB isolate, not for a
// server: the defaults initdb writes (128 MB of shared_buffers) are the
// reason the heap grew past the limit.
FS.writeFile(`${PGDATA}/postgresql.auto.conf`, `# Written by barua-lite's golden builder. Do not edit by hand.
shared_buffers = '4MB'
max_connections = '4'
work_mem = '8MB'
maintenance_work_mem = '4MB'
temp_buffers = '1MB'
temp_file_limit = '32MB'
effective_cache_size = '8MB'
wal_level = 'minimal'
max_wal_senders = '0'
max_wal_size = '16MB'
min_wal_size = '2MB'
autovacuum = 'off'
`);
// One tenant, one database: the two templates exist only for CREATE
// DATABASE, which this database will never run. Dropping them removes two
// of the three catalog copies - most of the directory.
const cur = (await pg.query("select current_database() as db")).rows[0].db;
for (const d of ["template0", "template1"]) {
  if (d === cur) continue;
  await pg.exec(`update pg_database set datistemplate = false where datname = '${d}'`);
  await pg.exec(`drop database ${d}`);
}
console.log("  running in:", cur, "· databases left:", (await pg.query("select string_agg(datname, ',') as l from pg_database")).rows[0].l);
await pg.exec("checkpoint");
const tar = await pg.dumpDataDir("gzip");
const buf = Buffer.from(await tar.arrayBuffer());
writeFileSync(process.argv[2], buf);
await pg.close();
console.log(`  golden: PGDATA=${PGDATA} · ${buf.length} bytes gz · built in ${Date.now() - t0} ms`);
