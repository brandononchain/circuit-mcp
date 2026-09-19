# Deploying Circuit to Railway

Circuit is a plain Node HTTP server (`src/local.ts`), not a bundle of serverless
functions. Railway runs it as one long-lived process, which is what lets storage
be an ordinary Postgres connection pool instead of an HTTP data API.

`railway.json` points at the `Dockerfile`, health-checks `/health`, and restarts
on failure. There is no migration step — the Postgres store applies its own
schema on first connect, every statement `if not exists`.

## The runbook

The order matters. Each step depends on the one above it.

### 1. Install the CLI

```bash
npm install -g @railway/cli
```

If npm is configured to block package install scripts, the binary never gets
fetched. Either allow it for this one package
(`npm install -g @railway/cli --allow-scripts=@railway/cli`) or take the
standalone build instead — on Windows:

```powershell
irm https://github.com/railwayapp/cli/releases/latest/download/railway-windows-x86_64.exe -OutFile $env:LOCALAPPDATA\railway.exe
```

### 2. Create the project and the database

```bash
railway login
railway init                      # name it circuit-mcp
railway add --database postgres
```

### 3. Wire the database to your service — Railway does not do this for you

This is the step worth slowing down for. `railway add --database postgres` sets
`DATABASE_URL` **on the Postgres service, not on yours**. Skip this and the
deployment comes up looking perfectly healthy and runs in memory, losing every
workflow on each redeploy.

```bash
railway variables --set 'DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}'
```

The `${{...}}` is a Railway variable reference and has to reach Railway
unexpanded, so quote it for your shell: single quotes in bash and in PowerShell,
`"DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}"` in cmd.

Prefer `DATABASE_PRIVATE_URL`. Fall back to `${{Postgres.DATABASE_URL}}` if the
service does not expose it. `sslFor()` in `src/store/postgres.ts` infers TLS from
the hostname either way.

### 4. Deploy, and give it a domain

```bash
railway up                        # builds the Dockerfile, health-checks /health
railway domain
```

`railway up` uploads the working directory, so it deploys what is on your disk,
not what is on GitHub.

### 5. Set the public URL and the owner key, then redeploy

Both of these need the domain from the step above, which is why they come last.

```bash
railway variables --set "PUBLIC_BASE_URL=https://<domain>"
railway variables --set "CIRCUIT_OWNER_KEY=$(openssl rand -hex 32)"
railway redeploy
```

On Windows, where `openssl` may not be present:

```powershell
$key = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
railway variables --set "CIRCUIT_OWNER_KEY=$key"
```

**Save that key.** It is what you type on the consent screen, and it cannot be
read back out of the deployment.

`PUBLIC_BASE_URL` has to be set before any client tries to authorize. Without it
Circuit advertises whatever origin the request arrived on, which behind Railway's
proxy is not where the browser needs to be sent.

## Confirming it came up the way you meant

```bash
curl https://<domain>/health
```

```json
{ "ok": true, "storage": "postgres", "durable": true, "auth": "oauth" }
```

All four matter:

| reading | what it means |
|---|---|
| `"storage": "memory"` | step 3 did not take. `railway variables` should show a real `postgres://` string, not the literal `${{...}}` |
| `"durable": false` | the same thing said differently. Arm nothing on a schedule until this is `true` |
| `"auth": "open"` | `CIRCUIT_OWNER_KEY` did not take, and anyone who finds the URL can drive your workflows. Fix before sharing |
| a 502 that never clears | the health check is failing. `railway logs` has the startup error; `Dynamic require of "events"` there means the createRequire banner did not make it into the image |

Then drive the real engine through the live server:

```bash
URL=https://<domain>/mcp node scripts/smoke.mjs
```

That runs a full workflow — loop, classify fan-out, approval gate, all four
failure policies, sub-workflows — against the deployment. If it passes, it is
real.

## Environment

| variable | what it does |
|---|---|
| `DATABASE_URL` | Postgres. **You set this yourself**, to a reference to the Postgres service (step 3). Its presence is what selects the Postgres store. |
| `PUBLIC_BASE_URL` | The origin Circuit advertises in its OAuth metadata. Must be the public HTTPS URL, or clients will be sent to the wrong place to authorize. |
| `CIRCUIT_OWNER_KEY` | The key you type on the consent screen. Without it the server is open to anyone who can reach it. |
| `PORT` | Set by Railway. The Dockerfile falls back to 8787. |
| `PGSSLMODE` | `disable`, `no-verify`, or unset. See below. |
| `PGPOOL_MAX` | Pool size, default 10. Raise it only alongside Railway's own connection limit. |

### Which database URL

Railway gives you two. Prefer the **private** one — `postgres.railway.internal` —
because it never leaves Railway's network and is not billed as egress. The store
detects `.railway.internal` and turns TLS off for it, since the private network
does not offer a certificate.

The **public** proxy URL is for connecting from your laptop. It needs TLS behind a
chain Node will not verify on its own, which the store handles by not verifying
it. If you would rather be explicit, set `PGSSLMODE=no-verify`.

## Connecting it to Claude

Once it is up, add it as a custom connector with the `/mcp` URL:

```
https://<domain>/mcp
```

Claude discovers the OAuth metadata, registers itself via RFC 7591, and sends you
to the consent screen, where you paste `CIRCUIT_OWNER_KEY`. Then ask it to build
you something — *"use Circuit to build me an inbox triage workflow"* — and the
board should render in the conversation.

## Why not Vercel and Supabase

That combination still works and is still supported — `src/vercel.ts` and the
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` pair are unchanged. It exists
because a serverless function cannot hold a TCP connection pool open between
invocations, so it has to reach a database over HTTP, and Supabase's PostgREST
is that. On a long-lived process the constraint disappears and a normal pool is
both simpler and faster.

One thing does not carry across. `src/store/schema.ts` exports `SUPABASE_LOCKDOWN`,
five `enable row level security` statements with no policies, and that idiom is
Supabase-specific: it works there because the service role bypasses RLS, and it
would appear to work on Railway only because a table's owner also bypasses RLS.
Relying on that would make your access control an accident of who ran the
migration. On Railway, keep the database on the private network and do not apply
those statements — the Postgres store does not.
