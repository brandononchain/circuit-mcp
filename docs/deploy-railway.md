# Deploying Circuit to Railway

Circuit is a plain Node HTTP server (`src/local.ts`), not a bundle of serverless
functions. Railway runs it as one long-lived process, which is what lets storage
be an ordinary Postgres connection pool instead of an HTTP data API.

## The short version

```bash
railway init                       # or: railway link, for an existing project
railway add --database postgres    # sets DATABASE_URL on the service
railway variables --set "PUBLIC_BASE_URL=https://<your-domain>" \
                  --set "CIRCUIT_OWNER_KEY=$(openssl rand -hex 32)"
railway up
```

`railway.json` points at the `Dockerfile`, health-checks `/health`, and restarts
on failure. Nothing else is needed — the Postgres store applies its own schema on
first connect, so there is no migration step.

Confirm it came up the way you meant:

```bash
curl https://<your-domain>/health
```

```json
{ "ok": true, "storage": "postgres", "durable": true, "auth": "oauth" }
```

`"storage": "memory"` with `"durable": false` means `DATABASE_URL` did not reach
the service. Fix that before arming anything on a schedule — in-memory survives
between requests on a long-lived process, but a redeploy takes every workflow
and run with it, and an armed board that no longer exists fires nothing.

## Environment

| variable | what it does |
|---|---|
| `DATABASE_URL` | Postgres. Railway sets it when you attach the database. Its presence is what selects the Postgres store. |
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
https://<your-domain>/mcp
```

Claude will discover the OAuth metadata, register itself, and send you to the
consent screen, where you paste `CIRCUIT_OWNER_KEY`.

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
