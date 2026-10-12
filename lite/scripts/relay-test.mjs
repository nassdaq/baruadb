// Exercises the box's relay to a light-tier database the way a pooled app
// does: two connections with the same statement name, session settings, a
// quiet spell long enough for the relay to let the engine go, then the
// cached statements again - which only work if the resume replayed them.
//
//   node scripts/relay-test.mjs "postgresql://app:…@br-xxx.pg.barua.app/app?sslmode=require" [quiet seconds]
import pg from "pg";

const { Client } = pg;
const uri = process.argv[2];
const quiet = Number(process.argv[3] ?? 60);
if (!uri) {
  console.error("give a connection string");
  process.exit(2);
}
const open = async () => {
  const c = new Client({ connectionString: uri, ssl: { rejectUnauthorized: true } });
  await c.connect();
  return c;
};

const a = await open();
const b = await open();
// The same name with different SQL on two connections: in one engine
// session these would collide unless the relay renames them.
const ra = await a.query({ name: "s0", text: "select $1::int + 1 as v", values: [1] });
const rb = await b.query({ name: "s0", text: "select $1::int * 10 as v", values: [2] });
console.log("named s0 on A:", ra.rows[0].v, "| on B:", rb.rows[0].v, "(expect 2 | 20)");

await a.query("set time zone 'Africa/Dar_es_Salaam'");
await a.query("set search_path to public, pg_catalog");
await a.query("create table if not exists notes(id serial primary key, body text)");
const first = await a.query({ name: "ins", text: "insert into notes(body) values ($1) returning id", values: ["before the quiet"] });
console.log("inserted", first.rows[0].id, `- now quiet for ${quiet}s`);
await new Promise((r) => setTimeout(r, quiet * 1000));

const t0 = Date.now();
// node-pg sends only Bind/Execute for a name it has already prepared.
const r1 = await a.query({ name: "ins", text: "insert into notes(body) values ($1) returning id", values: ["after the quiet"] });
const r2 = await a.query({ name: "s0", text: "select $1::int + 1 as v", values: [41] });
const tz = await a.query("show timezone");
const sp = await a.query("show search_path");
console.log("after resume:", {
  ins: r1.rows[0].id,
  s0: r2.rows[0].v,
  timezone: tz.rows[0].TimeZone,
  search_path: sp.rows[0].search_path,
  first_query_ms: Date.now() - t0,
});
const rb2 = await b.query({ name: "s0", text: "select $1::int * 10 as v", values: [3] });
console.log("B after the quiet, s0:", rb2.rows[0].v, "(expect 30)");
await a.end();
await b.end();
