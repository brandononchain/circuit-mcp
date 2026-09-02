import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { getStore, storeKind, storageIsDurable } from "./store/index.js";
import {
  authorizationServerMetadata, oauthConfig, ownerKeyMatches, protectedResourceMetadata,
  readAccess, readClient, redeemCode, refresh, registerClient, issueCode, issueTokens,
} from "./oauth.js";

/** CIRCUIT_TOKENS = "brandon=abc123,team=def456". Empty means open, workspace "local". */
function tokenMap(): Map<string, string> {
  const raw = (process.env.CIRCUIT_TOKENS ?? "").trim();
  const m = new Map<string, string>();
  if (!raw) return m;
  for (const pair of raw.split(",")) {
    const [ws, token] = pair.split("=").map((s) => s.trim());
    if (ws && token) m.set(token, ws);
  }
  return m;
}

function baseUrl(req: IncomingMessage, url: URL): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]
    || (process.env.PUBLIC_BASE_URL?.startsWith("https") ? "https" : url.protocol.replace(":", ""));
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? url.host);
  return process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || `${proto}://${host}`;
}

function resolveWorkspace(req: IncomingMessage, url: URL): string | null {
  const map = tokenMap();
  if (map.size === 0) return "local";
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const inPath = url.pathname.match(/^\/w\/([^/]+)\//)?.[1];
  const q = url.searchParams.get("token");
  for (const t of [bearer, inPath, q]) if (t && map.has(t)) return map.get(t)!;
  return null;
}

function send(res: ServerResponse, status: number, body: string, type = "application/json") {
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/^\/w\/[^/]+/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,mcp-session-id,mcp-protocol-version",
      "access-control-expose-headers": "mcp-session-id",
    });
    return res.end();
  }

  /* ---- oauth ---- */
  const cfg = oauthConfig(baseUrl(req, url));

  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    if (!cfg) return send(res, 404, JSON.stringify({ error: "authentication is not configured on this deployment" }));
    return send(res, 200, JSON.stringify(protectedResourceMetadata(cfg)));
  }
  if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
    if (!cfg) return send(res, 404, JSON.stringify({ error: "authentication is not configured on this deployment" }));
    return send(res, 200, JSON.stringify(authorizationServerMetadata(cfg)));
  }

  if (path === "/oauth/register" && req.method === "POST") {
    if (!cfg) return send(res, 404, JSON.stringify({ error: "invalid_request" }));
    const out = registerClient(await readBody(req), cfg);
    return send(res, "error" in out ? 400 : 201, JSON.stringify(out));
  }

  if (path === "/oauth/authorize") {
    if (!cfg) return send(res, 404, "Authentication is not configured on this deployment.", "text/plain");
    const q = req.method === "POST" ? new URLSearchParams(String(await readBody(req) ?? "")) : url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = readClient(clientId, cfg);
    if (!client) return send(res, 400, page("That client is not registered", "Register with Circuit first, then try again."), "text/html");
    if (!client.redirect_uris.includes(redirectUri)) {
      return send(res, 400, page("That redirect does not match", "The redirect_uri is not one this client registered."), "text/html");
    }
    const state = q.get("state") ?? "";
    const challenge = q.get("code_challenge") ?? "";
    const method = q.get("code_challenge_method") ?? "";
    const scope = q.get("scope") || "circuit";
    const resource = q.get("resource") ?? undefined;
    if (!challenge || method !== "S256") {
      return redirectError(res, redirectUri, state, "invalid_request", "PKCE with S256 is required.");
    }

    if (req.method !== "POST") {
      return send(res, 200, consentPage({ client: client.name ?? "an MCP client", clientId, redirectUri, state, challenge, method, scope, resource }), "text/html");
    }
    if (!ownerKeyMatches(q.get("owner_key") ?? "", cfg)) {
      return send(res, 200, consentPage({
        client: client.name ?? "an MCP client", clientId, redirectUri, state, challenge, method, scope, resource,
        error: "That key does not match. Check CIRCUIT_OWNER_KEY on the deployment.",
      }), "text/html");
    }
    const code = issueCode({ sub: cfg.workspace, cid: clientId, redirect_uri: redirectUri, challenge, resource, scope }, cfg);
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    if (state) back.searchParams.set("state", state);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  if (path === "/oauth/token" && req.method === "POST") {
    if (!cfg) return send(res, 404, JSON.stringify({ error: "invalid_request" }));
    const raw = await readBody(req);
    const form = new URLSearchParams(typeof raw === "string" ? raw : new URLSearchParams(raw ?? {}).toString());
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const out = redeemCode(
        form.get("code") ?? "", form.get("code_verifier") ?? "",
        form.get("redirect_uri") ?? "", form.get("client_id") ?? "", cfg,
      );
      if ("error" in out) return send(res, 400, JSON.stringify(out));
      // OAuth 2.1 wants codes used once. They are signed rather than stored, so
      // single-use comes from recording the id the first time it is redeemed.
      if (await getStore().seen(out.sub, `oauthcode:${out.jti}`, 1)) {
        return send(res, 400, JSON.stringify({
          error: "invalid_grant",
          error_description: "That code has already been exchanged.",
        }));
      }
      return send(res, 200, JSON.stringify(issueTokens(out.sub, out.scope, out.resource, cfg)));
    }
    if (grant === "refresh_token") {
      const out = refresh(form.get("refresh_token") ?? "", cfg);
      if ("error" in out) return send(res, 400, JSON.stringify(out));
      return send(res, 200, JSON.stringify(out.tokens));
    }
    return send(res, 400, JSON.stringify({ error: "unsupported_grant_type" }));
  }

  if (path === "/oauth/revoke" && req.method === "POST") {
    // tokens are signed rather than stored, so a single revocation is not
    // possible; say so rather than returning 200 and quietly doing nothing
    return send(res, 200, JSON.stringify({
      revoked: false,
      detail: "Circuit's tokens are signed, not stored. Rotate CIRCUIT_SECRET to invalidate every token at once.",
    }));
  }

  /* ---- health ---- */
  if (path === "/health") {
    return send(res, 200, JSON.stringify({
      ok: true,
      storage: storeKind(),
      /* Worth saying out loud: in-memory looks fine until the first redeploy. */
      durable: storageIsDurable(),
      ...(storageIsDurable() ? {} : {
        warning: "in-memory storage — every workflow and run is lost on restart. "
          + "Set DATABASE_URL to a Postgres connection string to persist.",
      }),
      auth: cfg ? "oauth" : tokenMap().size ? "token" : "open",
      integrations: "none — Circuit runs on the caller's own connectors",
    }));
  }

  /* ---- mcp ---- */
  if (path === "/mcp") {
    const cfg = oauthConfig(baseUrl(req, url));
    let workspace: string | null;
    if (cfg) {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      const sub = readAccess(bearer, cfg);
      if (!sub) {
        // point the client at the metadata that tells it where to go and log in
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate":
            `Bearer realm="circuit", resource_metadata="${cfg.issuer}/.well-known/oauth-protected-resource"`,
        });
        return res.end(JSON.stringify({ error: "unauthorized", error_description: "Authorize with Circuit first." }));
      }
      workspace = sub;
    } else {
      workspace = resolveWorkspace(req, url);
    }
    if (!workspace) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="circuit"`,
      });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    // stateless: one server + transport per request, so this runs anywhere
    const server = buildServer(workspace);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    const body = req.method === "POST" ? await readBody(req) : undefined;
    return transport.handleRequest(req, res, body);
  }

  if (path === "/") return send(res, 200, page("Circuit", "MCP endpoint: <code>/mcp</code>"), "text/html");
  return send(res, 404, `{"error":"not found"}`);
}

function redirectError(res: ServerResponse, redirectUri: string, state: string, error: string, desc: string) {
  try {
    const back = new URL(redirectUri);
    back.searchParams.set("error", error);
    back.searchParams.set("error_description", desc);
    if (state) back.searchParams.set("state", state);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  } catch {
    return send(res, 400, page("That request was not valid", desc), "text/html");
  }
}

function consentPage(o: {
  client: string; clientId: string; redirectUri: string; state: string;
  challenge: string; method: string; scope: string; resource?: string; error?: string;
}) {
  const hidden = (k: string, v: string) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
  return `<!doctype html><meta charset="utf-8"><title>Connect to Circuit</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#F7F8F8;--panel:#FFF;--edge:#C7D0CE;--ink:#0F1618;--ink-2:#485557;--ink-3:#768385;--accent:#8F6717;--fault:#AB362E}
@media(prefers-color-scheme:dark){:root{--bg:#0C1011;--panel:#111718;--edge:#28312F;--ink:#E8EEEB;--ink-2:#9CAAA6;--ink-3:#6B7A77;--accent:#D2A24E;--fault:#DA5A4F}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
 font:15px/1.6 "Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{width:100%;max-width:430px;padding:30px 32px 28px;background:var(--panel);border:1px solid var(--edge);border-radius:8px;margin:22px}
.mark{display:flex;align-items:center;gap:9px;margin-bottom:18px}
h1{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em}
p{margin:0 0 14px;color:var(--ink-2);font-size:14px}
ul{margin:0 0 18px;padding-left:18px;color:var(--ink-2);font-size:13.5px}
li{margin:3px 0}
label{display:block;font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;font-weight:600;color:var(--ink-3);margin-bottom:6px}
input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--edge);border-radius:4px;
 background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
input[type=password]:focus{outline:none;border-color:var(--accent)}
button{width:100%;margin-top:14px;padding:11px;border:1px solid var(--accent);background:var(--accent);
 color:var(--bg);font:inherit;font-size:12px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;
 border-radius:4px;cursor:pointer}
.err{color:var(--fault);font-size:13px;margin:0 0 12px}
.foot{margin-top:16px;font-size:12px;color:var(--ink-3)}
code{font-family:"Spline Sans Mono",ui-monospace,monospace;font-size:12px;color:var(--accent)}
</style>
<main>
<div class="mark">
 <svg width="22" height="22" viewBox="0 0 26 26" aria-hidden="true"><rect x="1.5" y="1.5" width="23" height="23" rx="2.5" fill="none" stroke="var(--accent)" stroke-width="1.4"/><path d="M6 13h4l3-5 3 10 2-5h2" fill="none" stroke="var(--accent)" stroke-width="1.6"/><circle cx="5" cy="5" r="1.3" fill="var(--accent)"/></svg>
 <h1>Connect to Circuit</h1>
</div>
<p><b>${escapeHtml(o.client)}</b> is asking to use this Circuit.</p>
<ul>
 <li>It can create, read and run workflows stored here.</li>
 <li>It cannot reach any of your connectors — Circuit holds no accounts and no keys.</li>
 <li>Access lasts an hour at a time and refreshes quietly.</li>
</ul>
${o.error ? `<p class="err">${escapeHtml(o.error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
 ${hidden("client_id", o.clientId)}${hidden("redirect_uri", o.redirectUri)}${hidden("state", o.state)}
 ${hidden("code_challenge", o.challenge)}${hidden("code_challenge_method", o.method)}
 ${hidden("scope", o.scope)}${o.resource ? hidden("resource", o.resource) : ""}
 <label for="k">Owner key</label>
 <input id="k" name="owner_key" type="password" autocomplete="off" autofocus placeholder="the key this deployment was set up with">
 <button type="submit">Allow</button>
</form>
<p class="foot">This is the <code>CIRCUIT_OWNER_KEY</code> set on the deployment. If you did not start this, close the tab.</p>
</main>`;
}

const escapeHtml = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function page(title: string, body: string) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{background:#0A0D0E;color:#E8EEEB;font:15px/1.6 ui-sans-serif,system-ui;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:32rem;padding:2rem}h1{font-size:1.3rem;margin:0 0 .5rem}p{color:#9CAAA6;margin:0}code{color:#C8973F}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;
}
