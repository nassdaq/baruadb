// Two things PGlite's bundle does that a Worker cannot:
//  1. new URL("./pglite.data", import.meta.url) even when the artifacts are
//     supplied - import.meta.url is not a URL in a Worker. Nothing is ever
//     fetched from those URLs here, so they get a harmless absolute base.
//  2. addFunction compiles a tiny wrapper module per signature at runtime;
//     Workers refuse runtime compilation. The same modules are prebuilt
//     (scripts/make-fn-wrappers.mjs) and a hook hands them over, keyed by
//     the wrapper's own bytes so minified variable names do not matter.
// Runs on every install; each change is skipped when it is already there.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
const roots = ["node_modules/@electric-sql/pglite/dist", "node_modules/@electric-sql/pglite-tools/dist"];
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : []; });
let urls = 0, hooks = 0, loaders = 0;
for (const f of roots.flatMap(walk)) {
  const src = readFileSync(f, "utf8");
  let out = src.replaceAll("import.meta.url", '"https://pglite.invalid/dist/index.js"');
  urls += (src.match(/import\.meta\.url/g) ?? []).length;
  if (!out.includes("__wasmFnModule")) {
    out = out.replace(/new WebAssembly\.Module\(new Uint8Array\((\w+)\)\)/g, (m, v) => {
      hooks++;
      return `((globalThis.__wasmFnModule&&globalThis.__wasmFnModule(${v}))||${m})`;
    });
  }
  // pg_dump's glue fetches its wasm by URL and pgDump() takes no module
  // option: when a precompiled module is on the global, instantiate that.
  if (!out.includes("__pgDumpWasm")) {
    out = out.replace(/async function instantiateAsync\((\w+),(\w+),(\w+)\)\{/g, (m, a, b, c) => {
      loaders++;
      return `${m}if(globalThis.__pgDumpWasm){var __i=await WebAssembly.instantiate(globalThis.__pgDumpWasm,${c});return{instance:__i,module:globalThis.__pgDumpWasm}}`;
    });
  }
  // dlopen: Postgres loads plpgsql (and any extension) as a side module,
  // which the loader compiles from the bytes it read out of the file
  // package. The same hook idea: a precompiled module for that library name
  // is used instead when one is on the global.
  if (!out.includes("__wasmDylib")) {
    out = out.replace(/new WebAssembly\.Module\(binary\)/g, (m) => {
      loaders++;
      return `((globalThis.__wasmDylib&&globalThis.__wasmDylib(libName,binary))||${m})`;
    });
  }
  // The Node branch imports "module" for createRequire; the bundler tries to
  // resolve it even though a Worker never takes that branch.
  out = out.replaceAll('await import("module")', '({createRequire:()=>()=>{throw new Error("no require in a Worker")}})');
  // pg_dump's glue starts its heap at 64 MB inside an isolate that has 128 MB
  // in total; 16 MB is plenty for a dump, and growth stays on.
  out = out.replace(/Module\.INITIAL_MEMORY\|\|67108864/g, "Module.INITIAL_MEMORY||16777216");
  if (out !== src) writeFileSync(f, out);
}
console.log(`patched: ${urls} url sites, ${hooks} addFunction hooks, ${loaders} wasm loaders`);
