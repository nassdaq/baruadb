// Read what the module declares: its imported memory's limits, and how high
// its static data reaches (the floor any smaller memory must stay above).
import { readFileSync } from "node:fs";
const b = readFileSync(process.argv[2]); let i = 8;
const leb = () => { let r = 0, s = 0, c; do { c = b[i++]; r |= (c & 0x7f) << s; s += 7; } while (c & 0x80); return r >>> 0; };
const str = () => { const n = leb(); const v = b.subarray(i, i + n).toString(); i += n; return v; };
let memory = null, dataEnd = 0, segs = 0, heapBase = null, exports = [];
while (i < b.length) {
  const id = b[i++]; const size = leb(); const end = i + size;
  if (id === 2) { const n = leb(); for (let k = 0; k < n; k++) { const mod = str(), name = str(), kind = b[i++];
      if (kind === 0) leb(); else if (kind === 1) { i++; const f = leb(); leb(); if (f & 1) leb(); }
      else if (kind === 2) { const f = leb(); const min = leb(); const max = (f & 1) ? leb() : null; memory = { mod, name, minPages: min, maxPages: max, shared: !!(f & 2) }; }
      else if (kind === 3) { i++; i++; } } }
  else if (id === 7) { const n = leb(); for (let k = 0; k < n; k++) { const name = str(); const kind = b[i++]; const idx = leb(); if (name === "__heap_base" || name === "__data_end" || name === "memory") exports.push(`${name}(${["func","table","memory","global"][kind]} #${idx})`); } }
  else if (id === 11) { const n = leb(); segs = n; for (let k = 0; k < n; k++) { const flags = leb(); if (flags === 2) leb(); if (flags !== 1) { // active: const expr
        const op = b[i++]; let off = 0; if (op === 0x41) { let r = 0, s = 0, c; do { c = b[i++]; r |= (c & 0x7f) << s; s += 7; } while (c & 0x80); off = r >>> 0; } else if (op === 0x23) { leb(); } i++; /* end */
        const len = leb(); dataEnd = Math.max(dataEnd, off + len); i += len; } else { const len = leb(); i += len; } } }
  i = end;
}
const mb = (p) => (p * 65536 / 1048576).toFixed(0) + " MB";
console.log("  imported memory:", memory ? `${memory.mod}.${memory.name} min ${memory.minPages} pages (${mb(memory.minPages)}), max ${memory.maxPages ?? "none"}${memory.maxPages ? " (" + mb(memory.maxPages) + ")" : ""}` : "(none: memory is internal)");
console.log("  static data:", segs, "segments, highest address", (dataEnd / 1048576).toFixed(1), "MB");
console.log("  relevant exports:", exports.join(", ") || "(none)");
