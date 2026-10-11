// After install: copy PGlite's artifacts beside the source, lower the wasm's
// declared memory minimum (128 MB -> 32 MB), and build the addFunction
// wrapper modules. The golden data directory is built separately
// (make-golden.mjs needs an unpatched PGlite) and is committed.
import { copyFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync("src/pglite", { recursive: true });
for (const f of ["pglite.wasm", "initdb.wasm", "pglite.data"]) copyFileSync(`node_modules/@electric-sql/pglite/dist/${f}`, `src/pglite/${f}`);
execFileSync("node", ["scripts/patch-pglite.mjs"], { stdio: "inherit" });
execFileSync("node", ["scripts/patch-wasm-min.mjs", "src/pglite/pglite.wasm", "512"], { stdio: "inherit" });
execFileSync("node", ["scripts/make-fn-wrappers.mjs"], { stdio: "inherit" });
