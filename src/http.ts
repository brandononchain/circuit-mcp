import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { storeKind } from "./store/index.js";

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

  /* ---- health ---- */
  if (path === "/health") {
    return send(res, 200, JSON.stringify({
      ok: true,
      storage: storeKind(),
      auth: tokenMap().size ? "token" : "open",
      integrations: "none — Circuit runs on the caller's own connectors",
    }));
  }

  /* ---- mcp ---- */
  if (path === "/mcp") {
    const workspace = resolveWorkspace(req, url);
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

function page(title: string, body: string) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{background:#0A0D0E;color:#E8EEEB;font:15px/1.6 ui-sans-serif,system-ui;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:32rem;padding:2rem}h1{font-size:1.3rem;margin:0 0 .5rem}p{color:#9CAAA6;margin:0}code{color:#C8973F}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;
}
