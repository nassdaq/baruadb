// The TCP door for Postgres as a function.
//
// Postgres clients speak TCP; Workers cannot accept it. This process can:
// it listens like a Postgres server, answers the one question clients ask
// before the protocol starts (SSL? no), reads the database name out of the
// startup packet, opens a WebSocket to that database's Durable Object, and
// from then on moves complete protocol messages back and forth untouched.
// PGlite speaks the wire protocol itself, so there is nothing to translate.
//
//   LITE_URL=wss://barua-lite.kelvineffect.workers.dev PORT=15432 node bridge/bridge.mjs
//   psql "postgresql://x:y@127.0.0.1:15432/demo?sslmode=disable"
import net from "node:net";

const LITE_URL = process.env.LITE_URL ?? "wss://barua-lite.kelvineffect.workers.dev";
const PORT = Number(process.env.PORT ?? 15432);
const SSL_REQUEST = 80877103, GSSENC_REQUEST = 80877104, CANCEL_REQUEST = 80877102;

/** Database name from a StartupMessage: int32 len, int32 version, then NUL-separated key/value pairs. */
function databaseOf(msg) {
  const pairs = msg.subarray(8).toString("utf8").split("\0");
  for (let i = 0; i + 1 < pairs.length; i += 2) if (pairs[i] === "database") return pairs[i + 1];
  for (let i = 0; i + 1 < pairs.length; i += 2) if (pairs[i] === "user") return pairs[i + 1];
  return null;
}

net.createServer((sock) => {
  let buf = Buffer.alloc(0), ws = null, started = false, pending = [];
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  const send = (frame) => (ws && ws.readyState === 1 ? ws.send(frame) : pending.push(frame));

  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!started) {
        if (buf.length < 8) return;
        const len = buf.readUInt32BE(0), code = buf.readUInt32BE(4);
        if (buf.length < len) return;
        const msg = buf.subarray(0, len); buf = buf.subarray(len);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) { sock.write("N"); continue; }
        if (code === CANCEL_REQUEST) { sock.end(); return; }
        // StartupMessage: find the database, open its door, forward as-is.
        const db = databaseOf(msg);
        if (!db || !/^[a-z][a-z0-9-]{0,40}$/.test(db)) { sock.end(); return; }
        started = true;
        ws = new WebSocket(`${LITE_URL}/wire/${db}`);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => { for (const f of pending) ws.send(f); pending = []; };
        ws.onmessage = (ev) => { if (sock.writable) sock.write(Buffer.from(ev.data)); };
        ws.onclose = (ev) => { if (ev.code !== 1000) console.error(`${peer} ${db}: door closed ${ev.code} ${ev.reason}`); sock.end(); };
        ws.onerror = (e) => { console.error(`${peer} ${db}: ${e.message ?? e}`); sock.end(); };
        console.log(`${peer} -> ${db}`);
        send(msg);
        continue;
      }
      // Regular message: type byte + int32 length (length includes itself).
      if (buf.length < 5) return;
      const len = buf.readUInt32BE(1) + 1;
      if (buf.length < len) return;
      const msg = buf.subarray(0, len); buf = buf.subarray(len);
      send(msg);
      if (msg[0] === 0x58) { /* Terminate */ ws?.close(1000, "client terminated"); sock.end(); return; }
    }
  });
  sock.on("close", () => ws?.close(1000, "client closed"));
  sock.on("error", (e) => { console.error(`${peer}: ${e.message}`); ws?.close(1011, "client error"); });
}).listen(PORT, "127.0.0.1", () => console.log(`bridge: 127.0.0.1:${PORT} -> ${LITE_URL}/wire/<database>`));
