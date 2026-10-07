// The dashboard. One self-contained document served at "/", in the same spirit
// as the rest of the control plane: no framework, no build step, no second
// deploy. Everything it shows comes from the same /v1 API a customer can use.
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BaruaDB</title>
<style>
  :root {
    --bg:#0a0a0b; --panel:#0e0e10; --line:#1f1f23; --line-soft:#161619;
    --fg:#e8e8ea; --muted:#8b8b94; --dim:#5f5f68;
    --ok:#4ade80; --warn:#fbbf24; --cold:#60a5fa; --bad:#f87171;
    --radius:10px;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  a { color:inherit; text-decoration:none; }
  button { font:inherit; color:inherit; cursor:pointer; }

  /* ---- chrome ---- */
  nav {
    display:flex; align-items:center; gap:28px; height:52px; padding:0 20px;
    border-bottom:1px solid var(--line); background:var(--panel);
  }
  .brand { font-weight:600; letter-spacing:-.01em; }
  .brand span { color:var(--muted); font-weight:400; }
  nav .tab { color:var(--muted); font-size:13px; padding:4px 0; border-bottom:2px solid transparent; }
  nav .tab.on { color:var(--fg); border-bottom-color:var(--fg); }
  nav .right { margin-left:auto; display:flex; align-items:center; gap:12px; font-size:12px; color:var(--dim); }

  .crumbs {
    display:flex; align-items:center; gap:10px; padding:14px 20px;
    border-bottom:1px solid var(--line-soft); font-size:13px; color:var(--muted);
  }
  .crumbs .sep { color:var(--dim); }
  .crumbs .actions { margin-left:auto; display:flex; gap:8px; }

  main { max-width:1000px; margin:0 auto; padding:28px 20px 80px; }

  /* ---- cards ---- */
  .card { border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); margin-bottom:14px; }
  .card.sel { border-color:#2f6b45; }
  .card-head { display:flex; align-items:center; gap:10px; padding:16px 18px; }
  .card-head .name { font-weight:500; }
  .card-head .id { color:var(--dim); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .card-head .tools { margin-left:auto; display:flex; gap:8px; align-items:center; }

  .dot { width:7px; height:7px; border-radius:50%; flex:none; }
  .dot.awake { background:var(--ok); box-shadow:0 0 8px #4ade8099; }
  .dot.asleep { background:var(--dim); }
  .dot.cold { background:var(--cold); }
  .dot.failed { background:var(--bad); }
  .state { font-size:12px; color:var(--muted); }

  .btn {
    background:transparent; border:1px solid #2a2a2f; border-radius:6px;
    padding:6px 12px; font-size:13px; display:inline-flex; align-items:center; gap:7px;
  }
  .btn:hover { background:#17171a; border-color:#3a3a41; }
  .btn.danger:hover { border-color:#7f2d2d; color:#fca5a5; }
  .btn.primary { border-color:#2f6b45; }
  .btn.primary:hover { background:#102318; }
  .btn:disabled { opacity:.45; cursor:default; }

  .row { display:flex; gap:40px; padding:0 18px 18px; flex-wrap:wrap; }
  .metric .k { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); }
  .metric .v { color:var(--ok); font-size:13px; margin-top:3px; }
  .metric .v.plain { color:var(--fg); }

  .fold { border-top:1px solid var(--line-soft); }
  .fold > summary {
    list-style:none; cursor:pointer; padding:13px 18px; font-size:13px;
    color:var(--muted); display:flex; align-items:center; gap:8px;
  }
  .fold > summary::-webkit-details-marker { display:none; }
  .fold > summary::before { content:"›"; display:inline-block; transition:transform .15s; color:var(--dim); }
  .fold[open] > summary::before { transform:rotate(90deg); }
  .fold .body { padding:0 18px 16px; }

  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .uri {
    display:flex; align-items:center; gap:10px; background:#0a0a0c;
    border:1px solid var(--line); border-radius:6px; padding:9px 12px; color:var(--muted);
    overflow:auto; white-space:nowrap;
  }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td, th { text-align:left; padding:7px 0; border-bottom:1px solid var(--line-soft); color:var(--muted); font-weight:400; }
  th { color:var(--dim); font-size:11px; letter-spacing:.06em; text-transform:uppercase; }

  .empty { color:var(--dim); font-size:13px; padding:28px 0; text-align:center; }
  .err { color:#fca5a5; font-size:13px; margin:10px 0; }
  .toast {
    position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
    background:#17171a; border:1px solid var(--line); border-radius:8px;
    padding:10px 16px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none;
  }
  .toast.on { opacity:1; }

  /* ---- sign in ---- */
  .signin { max-width:360px; margin:12vh auto; }
  .signin h1 { font-size:19px; font-weight:600; margin:0 0 6px; }
  .signin p { color:var(--muted); font-size:13px; margin:0 0 20px; }
  input {
    width:100%; background:#0a0a0c; border:1px solid var(--line); border-radius:6px;
    padding:10px 12px; color:var(--fg); font:13px ui-monospace,Menlo,monospace; margin-bottom:10px;
  }
  input:focus { outline:none; border-color:#3a3a41; }
</style>
</head>
<body>
<div id="app"></div>
<div class="toast" id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
const app = $("#app");
let KEY = localStorage.getItem("barua_key") || "";
let ADMIN = localStorage.getItem("barua_admin") === "1";
let TAB = "databases";
let OPEN = null; // expanded database id

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

async function api(path, opts = {}) {
  const r = await fetch("/v1" + path, {
    ...opts,
    headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const t = await r.text();
  const d = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(d.error || r.status + " " + r.statusText);
  return d;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.classList.add("on");
  setTimeout(() => el.classList.remove("on"), 1800);
}

const ago = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};

// ------------------------------------------------------------------ sign in
function signIn(err) {
  app.innerHTML = \`
    <div class="signin">
      <h1>BaruaDB</h1>
      <p>Paste a customer key (<code>bk_…</code>) to see your databases, or the admin token (64 hex characters) to see boxes too.</p>
      \${err ? '<div class="err">' + esc(err) + "</div>" : ""}
      <input id="k" placeholder="bk_… or the admin token" autofocus>
      <button class="btn primary" id="go" style="width:100%;justify-content:center">Continue</button>
    </div>\`;
  const go = async () => {
    // Be forgiving about what gets pasted: quotes from a .env line, a
    // copied "Bearer " prefix, stray whitespace.
    KEY = $("#k").value.trim().replace(/^Bearer\\s+/i, "").replace(/^["']|["']$/g, "").trim();
    if (!KEY) return;
    if (/^cfat_/.test(KEY) || /^ghp_/.test(KEY)) {
      return signIn("That is a Cloudflare/GitHub token, not a BaruaDB key. Use ADMIN_TOKEN (64 hex characters) or a customer key starting with bk_.");
    }
    try {
      await api("/databases");
      try { await api("/boxes"); ADMIN = true; } catch { ADMIN = false; }
      localStorage.setItem("barua_key", KEY);
      localStorage.setItem("barua_admin", ADMIN ? "1" : "0");
      render();
    } catch (e) { signIn(e.message); }
  };
  $("#go").onclick = go;
  $("#k").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

// ------------------------------------------------------------------ chrome
function chrome(inner, crumbs = "") {
  app.innerHTML = \`
    <nav>
      <div class="brand">Barua<span>DB</span></div>
      <a class="tab \${TAB === "databases" ? "on" : ""}" data-tab="databases">Databases</a>
      \${ADMIN ? '<a class="tab ' + (TAB === "boxes" ? "on" : "") + '" data-tab="boxes">Boxes</a>' : ""}
      <div class="right">
        <span>\${ADMIN ? "admin" : "customer"}</span>
        <button class="btn" id="out">Sign out</button>
      </div>
    </nav>
    \${crumbs}
    <main>\${inner}</main>\`;
  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.onclick = () => { TAB = el.dataset.tab; render(); };
  });
  $("#out").onclick = () => { localStorage.clear(); KEY = ""; ADMIN = false; signIn(); };
}

// ------------------------------------------------------------------ databases
function dbCard(d) {
  const open = OPEN === d.id;
  const st = d.status === "failed" ? "failed" : d.state;
  return \`
  <div class="card \${open ? "sel" : ""}">
    <div class="card-head">
      <span class="dot \${st}"></span>
      <span class="name">\${esc(d.name)}</span>
      <span class="state">\${esc(st)}</span>
      <span class="id">\${esc(d.id)}</span>
      <div class="tools">
        <button class="btn" data-copy="\${esc(d.connection_uri)}">Copy URL</button>
        <button class="btn" data-branch="\${esc(d.id)}">Branch</button>
        <button class="btn" data-open="\${esc(d.id)}">\${open ? "Hide" : "Details"}</button>
      </div>
    </div>
    <div class="row">
      <div class="metric"><div class="k">State</div><div class="v">\${esc(st)}</div></div>
      <div class="metric"><div class="k">Connections</div><div class="v">\${d.connections ?? 0}</div></div>
      <div class="metric"><div class="k">Where</div><div class="v">\${d.state === "cold" ? "R2 only" : "box disk"}</div></div>
      <div class="metric"><div class="k">Created</div><div class="v plain">\${ago(d.created_at)}</div></div>
      \${d.parent_id ? '<div class="metric"><div class="k">Branched from</div><div class="v plain">' + esc(d.parent_id) + "</div></div>" : ""}
    </div>
    \${open ? detail(d) : ""}
  </div>\`;
}

function detail(d) {
  return \`
  <details class="fold" open>
    <summary>Connection</summary>
    <div class="body">
      <div class="uri mono">\${esc(d.connection_uri)}</div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn" data-copy="\${esc(d.connection_uri)}">Copy</button>
        <button class="btn" data-reset="\${esc(d.id)}">Reset password</button>
        <button class="btn danger" data-del="\${esc(d.id)}">Delete</button>
      </div>
      <p style="color:var(--dim);font-size:12px;margin:12px 0 0">
        The password is shown only when the database or a new password is created.
      </p>
    </div>
  </details>
  <details class="fold">
    <summary>Restore points</summary>
    <div class="body" id="rp-\${esc(d.id)}">loading…</div>
  </details>\`;
}

async function databases() {
  chrome('<div class="empty">loading…</div>', \`
    <div class="crumbs">
      <span>databases</span>
      <div class="actions">
        <button class="btn primary" id="new">New database</button>
      </div>
    </div>\`);
  $("#new").onclick = async () => {
    const name = prompt("Database name");
    if (!name) return;
    try {
      const r = await api("/databases", { method: "POST", body: JSON.stringify({ name }) });
      await navigator.clipboard.writeText(r.connection_uri).catch(() => {});
      alert("Created.\\n\\nSave this now, the password is not shown again:\\n\\n" + r.connection_uri);
      render();
    } catch (e) { alert(e.message); }
  };

  let list;
  try { list = await api("/databases"); } catch (e) { $("main").innerHTML = '<div class="err">' + esc(e.message) + "</div>"; return; }
  $("main").innerHTML = list.length
    ? list.map(dbCard).join("")
    : '<div class="empty">No databases yet.</div>';

  document.querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
    await navigator.clipboard.writeText(b.dataset.copy); toast("Connection URL copied");
  });
  document.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => {
    OPEN = OPEN === b.dataset.open ? null : b.dataset.open; render();
  });
  document.querySelectorAll("[data-branch]").forEach((b) => b.onclick = async () => {
    const name = prompt("Branch name");
    if (!name) return;
    try { await api("/databases/" + b.dataset.branch + "/branches", { method: "POST", body: JSON.stringify({ name }) });
      toast("Branching…"); setTimeout(render, 1200);
    } catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-reset]").forEach((b) => b.onclick = async () => {
    try { const r = await api("/databases/" + b.dataset.reset + "/reset-password", { method: "POST" });
      alert("New connection string:\\n\\n" + (r.connection_uri || r.password));
    } catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete " + b.dataset.del + " and its history in R2?")) return;
    try { await api("/databases/" + b.dataset.del, { method: "DELETE" }); OPEN = null; render(); }
    catch (e) { alert(e.message); }
  });

  if (OPEN) {
    try {
      const rp = await api("/databases/" + OPEN + "/restore-points");
      const el = $("#rp-" + OPEN);
      if (el) el.innerHTML = rp.snapshots?.length
        ? '<table><tr><th>Taken</th><th>Kind</th></tr>' +
          rp.snapshots.map((s) => "<tr><td>" + esc(s.taken_at) + "</td><td>" + esc(s.kind) + "</td></tr>").join("") +
          "</table><p style='color:var(--dim);font-size:12px;margin-top:10px'>Earliest point you can branch from: " +
          esc(rp.earliest || "—") + "</p>"
        : '<div class="empty">No snapshots yet.</div>';
    } catch { /* detail stays as "loading…" if the box is unreachable */ }
  }
}

// ------------------------------------------------------------------ boxes
async function boxes() {
  chrome('<div class="empty">loading…</div>', '<div class="crumbs"><span>boxes</span></div>');
  let list;
  try { list = await api("/boxes"); } catch (e) { $("main").innerHTML = '<div class="err">' + esc(e.message) + "</div>"; return; }
  $("main").innerHTML = list.map((b) => {
    const usedMem = b.mem_total_mb - b.mem_available_mb;
    const pct = b.mem_total_mb ? Math.round((usedMem / b.mem_total_mb) * 100) : 0;
    return \`
    <div class="card">
      <div class="card-head">
        <span class="dot \${b.online ? "awake" : "failed"}"></span>
        <span class="name">\${esc(b.name)}</span>
        <span class="state">\${b.online ? "online" : "offline"}</span>
        <span class="id">\${esc(b.id)} · \${esc(b.public_ip)}</span>
        <div class="tools"><span class="state">seen \${ago(b.last_seen)}</span></div>
      </div>
      <div class="row">
        <div class="metric"><div class="k">CPU</div><div class="v">\${b.cpus} core\${b.cpus === 1 ? "" : "s"}</div></div>
        <div class="metric"><div class="k">RAM</div><div class="v">\${usedMem}/\${b.mem_total_mb} MB (\${pct}%)</div></div>
        <div class="metric"><div class="k">Disk free</div><div class="v">\${(b.disk_free_mb / 1024).toFixed(1)} GiB</div></div>
        <div class="metric"><div class="k">Databases awake</div><div class="v">\${b.databases_awake}</div></div>
      </div>
    </div>\`;
  }).join("") || '<div class="empty">No boxes have joined.</div>';
}

function render() {
  if (!KEY) return signIn();
  (TAB === "boxes" && ADMIN ? boxes : databases)();
}
render();
</script>
</body>
</html>`;
