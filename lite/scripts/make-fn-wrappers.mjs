// Emscripten's addFunction wraps a JS function in a one-import, one-export
// WebAssembly module whose bytes depend only on the signature, and compiles
// it at runtime. Workers refuse runtime compilation, so the same modules are
// built here, once, and bundled; a patched convertJsFunctionToWasm picks
// them up by signature. Byte layout mirrors Emscripten's generator.
import { readFileSync, writeFileSync } from "node:fs";
const TYPES = { i: 0x7f, p: 0x7f, j: 0x7e, f: 0x7d, d: 0x7c, e: 0x6f };
const uleb = (n, out) => { do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); };
function wrapper(sig) {
  const [ret, ...params] = sig;
  const type = [0x60]; uleb(params.length, type); for (const p of params) type.push(TYPES[p]);
  if (ret === "v") type.push(0); else { type.push(1, TYPES[ret]); }
  const typeSection = [1, ...type];
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0, 1]; uleb(typeSection.length, bytes); bytes.push(...typeSection);
  bytes.push(2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0); // import "e"."f" as func 0; export "f"
  return new Uint8Array(bytes);
}
const sigs = readFileSync("scripts/fn-sigs.txt", "utf8").split("\n").filter(Boolean);
const manifest = {};
for (const sig of sigs) {
  const bytes = wrapper(sig);
  const mod = new WebAssembly.Module(bytes); // proves it compiles
  const inst = new WebAssembly.Instance(mod, { e: { f: () => 0 } });
  if (typeof inst.exports.f !== "function") throw new Error("bad wrapper " + sig);
  writeFileSync(`src/pglite/fn-${sig}.wasm`, bytes);
  manifest[Array.from(bytes).join(",")] = sig;
  console.log("  wrapper", sig, bytes.length, "bytes");
}
writeFileSync("src/pglite/fn-wrappers.json", JSON.stringify(manifest));
