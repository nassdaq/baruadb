// A minimal OAuth 2.1 authorization server, just enough for claude.ai (and
// any MCP client) to connect to /mcp as a custom connector. Single user: the
// consent page is gated by a password (OAUTH_PASSWORD, or the LITE_TOKEN),
// so only the owner can authorize. Stateless: authorization codes and access
// tokens are HMAC-signed blobs that validate themselves — no storage.
//
// Flow (RFC 8414 / 9728 / 7591 / PKCE):
//   client GET  /mcp (no token)                 -> 401 + WWW-Authenticate
//   client GET  /.well-known/oauth-protected-resource
//   client GET  /.well-known/oauth-authorization-server
//   client POST /register                        -> client_id
//   browser GET/POST /authorize (consent)        -> redirect ?code=
//   client POST /token (code + PKCE verifier)     -> access_token
//   client POST /mcp (Bearer access_token)        -> tools

export interface OAuthEnv {
  LITE_TOKEN?: string;
  OAUTH_PASSWORD?: string;
}

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
const unb64urlJson = (s: string) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return JSON.parse(atob(pad));
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function signingSecret(env: OAuthEnv): string {
  // Dedicated secret if set, else derive from the master token. Either way the
  // key never leaves the Worker; tokens are opaque to the client.
  return (env.OAUTH_PASSWORD ? env.OAUTH_PASSWORD + "/" : "") + (env.LITE_TOKEN ?? "barua-lite");
}
async function sign(env: OAuthEnv, payload: Record<string, unknown>): Promise<string> {
  const body = b64urlJson(payload);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(signingSecret(env)), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}
async function verify(env: OAuthEnv, token: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify(
    "HMAC", await hmacKey(signingSecret(env)), Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((sig.length + 3) % 4)), (c) => c.charCodeAt(0)), enc.encode(body),
  ).catch(() => false);
  if (!ok) return null;
  let p: Record<string, unknown>;
  try { p = unb64urlJson(body); } catch { return null; }
  if (typeof p.exp === "number" && p.exp < Math.floor(Date.now() / 1000)) return null;
  return p;
}

/** Validate a Bearer token presented at /mcp: either a minted access token or
 *  the master LITE_TOKEN (for Claude Code remote with a static header). */
export async function verifyAccessToken(env: OAuthEnv, bearer: string | null): Promise<boolean> {
  if (!bearer) return false;
  if (env.LITE_TOKEN && bearer.length === env.LITE_TOKEN.length) {
    let diff = 0;
    for (let i = 0; i < bearer.length; i++) diff |= bearer.charCodeAt(i) ^ env.LITE_TOKEN.charCodeAt(i);
    if (diff === 0) return true;
  }
  const p = await verify(env, bearer);
  return !!p && p.t === "access";
}

const JSON_HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*" };
const jj = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: JSON_HEADERS });

async function sha256b64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function consentPage(params: Record<string, string>, error?: string): Response {
  const hidden = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"]
    .map((k) => `<input type="hidden" name="${k}" value="${(params[k] ?? "").replace(/"/g, "&quot;")}">`).join("");
  const html = `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Connect Claude to your threads</title>
<style>
 body{margin:0;background:#0b0b10;color:#ececf2;font:16px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif;
      display:grid;place-items:center;min-height:100vh}
 .card{width:min(92vw,420px);background:#14141b;border:1px solid #262633;border-radius:16px;padding:30px 28px}
 h1{font-size:21px;margin:0 0 6px;letter-spacing:-.01em}
 p{color:#9a9ab0;font-size:14px;margin:0 0 20px}
 label{display:block;font-size:13px;color:#9a9ab0;margin:0 0 7px}
 input[type=password]{width:100%;box-sizing:border-box;background:#0b0b10;border:1px solid #2d2d3d;border-radius:10px;
   padding:12px 13px;color:#ececf2;font-size:15px;outline:none}
 input[type=password]:focus{border-color:#6d4aff}
 button{margin-top:18px;width:100%;background:#6d4aff;color:#fff;border:0;border-radius:10px;padding:12px;font-size:15px;font-weight:600;cursor:pointer}
 .err{color:#ff8080;font-size:13px;margin:12px 0 0}
 .who{display:flex;align-items:center;gap:9px;margin-bottom:18px}
 .dot{width:26px;height:26px;border-radius:50%;border:2px solid #6d4aff}
</style>
<div class=card>
 <div class=who><span class=dot></span><b>Barua · threads</b></div>
 <h1>Connect Claude</h1>
 <p>Claude is asking to read your Claude Code thread history. Enter your access password to allow it.</p>
 <form method=post>
  ${hidden}
  <label for=pw>Access password</label>
  <input id=pw name=password type=password autofocus autocomplete=current-password placeholder="your LITE_TOKEN or OAUTH_PASSWORD">
  ${error ? `<div class=err>${error}</div>` : ""}
  <button type=submit>Allow access</button>
 </form>
</div>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Handle every OAuth / discovery route. Returns a Response when it owns the
 *  path, else null so the caller continues. */
export async function handleOAuth(request: Request, url: URL, env: OAuthEnv): Promise<Response | null> {
  const base = url.origin;
  const p = url.pathname;

  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
    return jj({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["threads:read"], bearer_methods_supported: ["header"] });
  }
  if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") {
    return jj({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: ["threads:read"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }

  // Dynamic client registration: public clients with PKCE, so we just mint an
  // id and echo the metadata back (nothing to store).
  if (p === "/register" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { redirect_uris?: string[]; client_name?: string; token_endpoint_auth_method?: string };
    return jj({
      client_id: "mcp-" + b64url(crypto.getRandomValues(new Uint8Array(12))),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris ?? [],
      client_name: body.client_name ?? "MCP client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }, 201);
  }

  if (p === "/authorize") {
    const q = Object.fromEntries(url.searchParams.entries());
    if (request.method === "GET") {
      if (q.response_type !== "code") return jj({ error: "unsupported_response_type" }, 400);
      if (!q.redirect_uri || !q.code_challenge) return jj({ error: "invalid_request", error_description: "redirect_uri and PKCE code_challenge are required" }, 400);
      return consentPage(q);
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const f = (k: string) => String(form.get(k) ?? "");
      const redirect_uri = f("redirect_uri");
      const given = f("password");
      const expected = env.OAUTH_PASSWORD || env.LITE_TOKEN || "";
      const okpw = !!expected && given.length === expected.length &&
        Array.from(given).reduce((d, c, i) => d | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0;
      if (!okpw) {
        const params = Object.fromEntries(["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"].map((k) => [k, f(k)]));
        return consentPage(params, "That password is not right.");
      }
      const code = await sign(env, { t: "code", redirect_uri, cc: f("code_challenge"), exp: Math.floor(Date.now() / 1000) + 300 });
      const to = new URL(redirect_uri);
      to.searchParams.set("code", code);
      if (f("state")) to.searchParams.set("state", f("state"));
      return new Response(null, { status: 302, headers: { location: to.toString() } });
    }
  }

  if (p === "/token" && request.method === "POST") {
    const form = await request.formData();
    const f = (k: string) => String(form.get(k) ?? "");
    const grant = f("grant_type");
    if (grant === "authorization_code") {
      const code = await verify(env, f("code"));
      if (!code || code.t !== "code") return jj({ error: "invalid_grant" }, 400);
      if (code.redirect_uri !== f("redirect_uri")) return jj({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
      // PKCE: SHA256(verifier) must equal the challenge the client committed to.
      if ((await sha256b64url(f("code_verifier"))) !== code.cc) return jj({ error: "invalid_grant", error_description: "PKCE check failed" }, 400);
      const now = Math.floor(Date.now() / 1000);
      return jj({
        access_token: await sign(env, { t: "access", scope: "threads:read", exp: now + 30 * 86400 }),
        token_type: "Bearer",
        expires_in: 30 * 86400,
        refresh_token: await sign(env, { t: "refresh", exp: now + 180 * 86400 }),
        scope: "threads:read",
      });
    }
    if (grant === "refresh_token") {
      const r = await verify(env, f("refresh_token"));
      if (!r || r.t !== "refresh") return jj({ error: "invalid_grant" }, 400);
      const now = Math.floor(Date.now() / 1000);
      return jj({ access_token: await sign(env, { t: "access", scope: "threads:read", exp: now + 30 * 86400 }), token_type: "Bearer", expires_in: 30 * 86400, scope: "threads:read" });
    }
    return jj({ error: "unsupported_grant_type" }, 400);
  }

  return null;
}
