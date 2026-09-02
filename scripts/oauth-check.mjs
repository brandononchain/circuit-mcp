/* Walks the whole OAuth 2.1 flow the way an MCP client would. */
import { createHash, randomBytes } from "node:crypto";
import { ok, section, done } from "./expect.mjs";
const base = process.env.URL ?? "http://localhost:8788";
const j = async (r) => ({ status: r.status, body: await r.text() });

section("the unauthenticated challenge");
let r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const challenge = r.headers.get("www-authenticate") ?? "";
ok("401 with resource_metadata", r.status === 401 && challenge.includes("resource_metadata"), challenge.slice(0, 90));

section("metadata documents");
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
ok("protected-resource metadata", prm.authorization_servers?.length === 1, prm.resource);
const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
ok("authorization-server metadata", asm.code_challenge_methods_supported?.includes("S256"), asm.token_endpoint);

section("dynamic client registration");
const reg = await (await fetch(asm.registration_endpoint, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }),
})).json();
ok("dynamic registration", !!reg.client_id, `${String(reg.client_id).length} chars, stateless`);

const badReg = await fetch(asm.registration_endpoint, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
});
ok("refuses non-https redirect", badReg.status === 400);

section("authorize");
const verifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
const params = new URLSearchParams({
  response_type: "code", client_id: reg.client_id,
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  code_challenge: codeChallenge, code_challenge_method: "S256",
  state: "xyz", scope: "circuit", resource: `${base}/mcp`,
});
const consent = await j(await fetch(`${base}/oauth/authorize?${params}`));
ok("consent page renders", consent.status === 200 && consent.body.includes("Owner key"));

const wrong = await fetch(`${base}/oauth/authorize`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...Object.fromEntries(params), owner_key: "nope" }), redirect: "manual",
});
ok("wrong key refused", wrong.status === 200 && (await wrong.text()).includes("does not match"));

const good = await fetch(`${base}/oauth/authorize`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...Object.fromEntries(params), owner_key: process.env.CIRCUIT_OWNER_KEY }),
  redirect: "manual",
});
const location = new URL(good.headers.get("location"));
const code = location.searchParams.get("code");
ok("code issued", good.status === 302 && !!code, `state preserved: ${location.searchParams.get("state") === "xyz"}`);

section("token exchange");
const wrongPkce = await (await fetch(asm.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "wrong",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: reg.client_id }),
})).json();
ok("PKCE enforced", wrongPkce.error === "invalid_grant", wrongPkce.error_description);

const tok = await (await fetch(asm.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: reg.client_id }),
})).json();
ok("tokens issued", !!tok.access_token && !!tok.refresh_token, `expires_in ${tok.expires_in}`);

const replay = await (await fetch(asm.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: reg.client_id }),
})).json();
ok("code is single use", replay.error === "invalid_grant", replay.error_description);

section("using the token");
const call = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
    authorization: `Bearer ${tok.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "audit", version: "1" } } }),
});
const text = await call.text();
ok("bearer token opens /mcp", call.status === 200 && text.includes("circuit"));

const junk = await fetch(`${base}/mcp`, {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer forged.token" }, body: "{}" });
ok("forged token refused", junk.status === 401);

section("refresh");
const ref = await (await fetch(asm.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }),
})).json();
ok("refresh works", !!ref.access_token);
const notARefresh = await (await fetch(asm.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.access_token }),
})).json();
ok("access token rejected as refresh", notARefresh.error === "invalid_grant");

done("oauth checks");
