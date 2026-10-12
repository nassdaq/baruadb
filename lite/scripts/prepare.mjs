// After install: copy PGlite's artifacts beside the source, lower the wasm's
// declared memory minimum (128 MB -> 32 MB), build the addFunction wrapper
// modules, and lift plpgsql.so out of the file package so it can be shipped
// precompiled. The golden data directory is built separately
// (make-golden.mjs needs an unpatched PGlite) and is committed.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync("src/pglite", { recursive: true });
const dist = "node_modules/@electric-sql/pglite/dist";
for (const f of ["pglite.wasm", "initdb.wasm", "pglite.data"]) copyFileSync(`${dist}/${f}`, `src/pglite/${f}`);
copyFileSync("node_modules/@electric-sql/pglite-tools/dist/pg_dump.wasm", "src/pglite/pg_dump.wasm");
// plpgsql is a loadable library, which Postgres dlopens and Emscripten would
// compile at runtime - the one thing a Worker refuses. Its bytes sit inside
// pglite.data at the offsets the glue's file table gives; cut them out as a
// module of their own and the loader is handed it ready-made (see
// patch-pglite.mjs and the __wasmDylib hook in src/index.ts).
{
  const glue = readFileSync(`${dist}/index.js`, "utf8");
  const m = /\{\s*"?filename"?\s*:\s*"\/pglite\/lib\/postgresql\/plpgsql\.so"\s*,\s*"?start"?\s*:\s*(\d+)\s*,\s*"?end"?\s*:\s*(\d+)/.exec(glue);
  if (!m) throw new Error("plpgsql.so not found in PGlite's file table");
  const data = readFileSync(`${dist}/pglite.data`);
  const so = data.subarray(Number(m[1]), Number(m[2]));
  if (so.subarray(0, 4).toString("latin1") !== "\0asm") throw new Error("plpgsql.so is not a wasm module");
  writeFileSync("src/pglite/plpgsql.wasm", so);
  console.log(`plpgsql.so: ${so.length} bytes -> src/pglite/plpgsql.wasm`);
}
execFileSync("node", ["scripts/patch-pglite.mjs"], { stdio: "inherit" });
execFileSync("node", ["scripts/patch-wasm-min.mjs", "src/pglite/pglite.wasm", "512"], { stdio: "inherit" });
execFileSync("node", ["scripts/patch-wasm-min.mjs", "src/pglite/pg_dump.wasm", "256"], { stdio: "inherit" });
execFileSync("node", ["scripts/make-fn-wrappers.mjs"], { stdio: "inherit" });
