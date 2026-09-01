import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * OAuth 2.1 for a server that stores nothing it does not have to.
 *
 * Every artefact in the flow — the client registration, the authorization code,
 * the tokens — is a signed blob rather than a database row. That is not a trick
 * for its own sake: Circuit is meant to run on serverless, where a cold start
 * would otherwise lose a registration mid-handshake, and where "the auth server
 * has state" quietly means "you now need a database before you can log in".
 *
 * The identity is the deployment's owner key. One key, one workspace. Multi-user
 * is a later thing, and this leaves room for it: the subject is already carried
 * through every token, so adding real accounts later means changing who issues a
 * subject, not how anything downstream reads one.
 */

export type OAuthConfig = {
  secret: string;
  ownerKey: string;
  issuer: string;
  workspace: string;
};

/** Off entirely unless an owner key is configured — dev stays frictionless. */
export function oauthConfig(baseUrl: string): OAuthConfig | null {
  const ownerKey = process.env.CIRCUIT_OWNER_KEY?.trim();
  if (!ownerKey) return null;
  const secret = process.env.CIRCUIT_SECRET?.trim() || `derived:${ownerKey}`;
  return {
    secret,
    ownerKey,
    issuer: baseUrl.replace(/\/$/, ""),
    workspace: process.env.CIRCUIT_WORKSPACE?.trim() || "owner",
  };
}

/* --------------------------------------------------------------- signing -- */

const b64 = (b: Buffer | string) =>
  Buffer.from(b).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

function sign(payload: object, secret: string): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify<T = any>(token: string, secret: string): T | null {
  const [body, mac] = String(token).split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(unb64(body).toString("utf8"));
    if (parsed.exp && Date.now() / 1000 > parsed.exp) return null;
    return parsed as T;
  } catch { return null; }
}

const now = () => Math.floor(Date.now() / 1000);

/* -------------------------------------------------------------- metadata -- */

export function protectedResourceMetadata(cfg: OAuthConfig) {
  return {
    resource: `${cfg.issuer}/mcp`,
    authorization_servers: [cfg.issuer],
    scopes_supported: ["circuit"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/brandononchain/circuit-mcp",
  };
}

export function authorizationServerMetadata(cfg: OAuthConfig) {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
    token_endpoint: `${cfg.issuer}/oauth/token`,
    registration_endpoint: `${cfg.issuer}/oauth/register`,
    revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
    scopes_supported: ["circuit"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://github.com/brandononchain/circuit-mcp",
  };
}

/* -------------------------------------------------- dynamic registration -- */

export type ClientMeta = { redirect_uris: string[]; name?: string; iat: number };

export function registerClient(body: any, cfg: OAuthConfig) {
  const uris: string[] = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length) return { error: "invalid_redirect_uri", error_description: "redirect_uris is required." };
  for (const u of uris) {
    let parsed: URL;
    try { parsed = new URL(u); } catch { return { error: "invalid_redirect_uri", error_description: `${u} is not a URL.` }; }
    const localhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !localhost) {
      return { error: "invalid_redirect_uri", error_description: `${u} must be https, or localhost.` };
    }
  }
  const meta: ClientMeta = { redirect_uris: uris, name: String(body?.client_name ?? "MCP client").slice(0, 80), iat: now() };
  return {
    client_id: `cid_${sign(meta, cfg.secret)}`,
    client_id_issued_at: meta.iat,
    redirect_uris: uris,
    client_name: meta.name,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export function readClient(clientId: string, cfg: OAuthConfig): ClientMeta | null {
  if (!clientId?.startsWith("cid_")) return null;
  return verify<ClientMeta>(clientId.slice(4), cfg.secret);
}

/* ----------------------------------------------------------------- codes -- */

type CodePayload = {
  typ: "ac"; jti: string; sub: string; cid: string; redirect_uri: string;
  challenge: string; resource?: string; scope: string; exp: number;
};

export function issueCode(p: Omit<CodePayload, "typ" | "exp" | "jti">, cfg: OAuthConfig) {
  return sign({ ...p, typ: "ac", jti: randomBytes(9).toString("base64url"), exp: now() + 60 }, cfg.secret);
}

export function redeemCode(code: string, verifier: string, redirectUri: string, clientId: string, cfg: OAuthConfig) {
  const p = verify<CodePayload>(code, cfg.secret);
  if (!p || p.typ !== "ac") return { error: "invalid_grant", error_description: "That code is not valid or has expired." };
  if (p.cid !== clientId) return { error: "invalid_grant", error_description: "That code was issued to a different client." };
  if (p.redirect_uri !== redirectUri) return { error: "invalid_grant", error_description: "redirect_uri does not match the one in the request." };
  const challenge = createHash("sha256").update(verifier ?? "").digest("base64url");
  if (challenge !== p.challenge) return { error: "invalid_grant", error_description: "PKCE verifier does not match." };
  // the caller records the jti so the same code cannot be exchanged twice
  return { ok: true as const, jti: p.jti, sub: p.sub, scope: p.scope, resource: p.resource };
}

/* ---------------------------------------------------------------- tokens -- */

type TokenPayload = { typ: "at" | "rt"; sub: string; aud?: string; scope: string; iss: string; exp: number };

const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 60 * 60 * 24 * 30;

export function issueTokens(sub: string, scope: string, resource: string | undefined, cfg: OAuthConfig) {
  const base = { sub, aud: resource, scope, iss: cfg.issuer };
  return {
    access_token: sign({ ...base, typ: "at", exp: now() + ACCESS_TTL }, cfg.secret),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: sign({ ...base, typ: "rt", exp: now() + REFRESH_TTL }, cfg.secret),
    scope,
  };
}

export function refresh(token: string, cfg: OAuthConfig) {
  const p = verify<TokenPayload>(token, cfg.secret);
  if (!p || p.typ !== "rt") return { error: "invalid_grant", error_description: "That refresh token is not valid or has expired." };
  return { ok: true as const, tokens: issueTokens(p.sub, p.scope, p.aud, cfg) };
}

/** The subject a bearer token is good for, or null. */
export function readAccess(token: string | undefined, cfg: OAuthConfig): string | null {
  if (!token) return null;
  const p = verify<TokenPayload>(token, cfg.secret);
  if (!p || p.typ !== "at") return null;
  // audience is bound at issue time when the client sent a resource indicator;
  // a token minted for another resource must not open this one
  if (p.aud && !p.aud.startsWith(cfg.issuer)) return null;
  return p.sub;
}

/** Constant-time check of the owner key someone typed into the consent page. */
export function ownerKeyMatches(given: string, cfg: OAuthConfig): boolean {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(cfg.ownerKey);
  if (a.length !== b.length) {
    // still burn the comparison so length is not a timing oracle
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(a, b);
}

export const newState = () => randomBytes(16).toString("base64url");
