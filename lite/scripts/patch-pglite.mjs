// Two things PGlite's bundle does that a Worker cannot:
//  1. new URL("./pglite.data", import.meta.url) even when the artifacts are
//     supplied - import.meta.url is not a URL in a Worker. Nothing is ever
//     fetched from those URLs here, so they get a harmless absolute base.
//  2. addFunction compiles a tiny wrapper module per signature at runtime;
//     Workers refuse runtime compilation. The same modules are prebuilt
//     (scripts/make-fn-wrappers.mjs) and a hook hands them over, keyed by
//     the wrapper's own bytes so minified variable names do not matter.
// Runs on every install.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
const root = "node_modules/@electric-sql/pglite/dist";
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : []; });
let urls = 0, hooks = 0;
for (const f of walk(root)) {
  const src = readFileSync(f, "utf8");
  let out = src.replaceAll("import.meta.url", '"https://pglite.invalid/dist/index.js"');
  urls += (src.match(/import\.meta\.url/g) ?? []).length;
  out = out.replace(/new WebAssembly\.Module\(new Uint8Array\((\w+)\)\)/g, (m, v) => {
    hooks++;
    return `((globalThis.__wasmFnModule&&globalThis.__wasmFnModule(${v}))||${m})`;
  });
  if (out !== src) writeFileSync(f, out);
}
console.log(`patched: ${urls} url sites, ${hooks} addFunction hooks`);
