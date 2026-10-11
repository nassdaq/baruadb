// Lower the declared minimum of PGlite's imported memory. The build bakes in
// 2048 pages (128 MB) - the whole isolate budget - while its static data ends
// below 3 MB. The limit is a two-byte LEB128 in the import section; rewriting
// it in place changes nothing else. Growth stays enabled, so Postgres takes
// more only when a query needs it.   usage: node patch-wasm-min.mjs <file> <pages>
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
const [file, pagesArg] = process.argv.slice(2); const pages = Number(pagesArg);
if (!(pages >= 64)) throw new Error("pages must be >= 64");
if (!existsSync(file + ".orig")) copyFileSync(file, file + ".orig");
const b = Buffer.from(readFileSync(file + ".orig")); let i = 8;
const leb = () => { let r = 0, s = 0, c; do { c = b[i++]; r |= (c & 0x7f) << s; s += 7; } while (c & 0x80); return r >>> 0; };
const skipStr = () => { const n = leb(); i += n; };
let done = false;
while (i < b.length && !done) {
  const id = b[i++]; const size = leb(); const end = i + size;
  if (id === 2) { const n = leb(); for (let k = 0; k < n && !done; k++) { skipStr(); skipStr(); const kind = b[i++];
      if (kind === 0) leb(); else if (kind === 1) { i++; const f = leb(); leb(); if (f & 1) leb(); }
      else if (kind === 2) { leb(); const at = i; const old = leb(); const width = i - at;
        // Re-encode in exactly the width the linker used (it pads to 5 bytes).
        let v = pages; for (let w = 0; w < width; w++) { let byte = v & 0x7f; v >>>= 7; if (w < width - 1) byte |= 0x80; b[at + w] = byte; }
        if (v !== 0) throw new Error("value does not fit the field");
        console.log(`  ${file}: memory min ${old} -> ${pages} pages (${pages * 64 / 1024} MB), ${width}-byte field`); done = true; }
      else if (kind === 3) { i += 2; } } }
  i = end;
}
if (!done) throw new Error("no memory import found");
writeFileSync(file, b);
