/**
 * The single definition of Circuit's tables.
 *
 * It lives in TypeScript rather than a .sql file because the Postgres store
 * applies it itself on first connect — every statement is `if not exists`, so
 * a deploy that already has the tables pays one cheap round trip and moves on.
 * That is what makes `railway up` against a fresh database a one-step affair.
 *
 * Plain Postgres. Nothing here is specific to a provider.
 */
export const SCHEMA = `
create table if not exists circuit_workflows (
  id text primary key,
  workspace text not null,
  status text not null default 'draft',
  updated_at timestamptz not null default now(),
  doc jsonb not null
);
create index if not exists circuit_workflows_ws on circuit_workflows (workspace, updated_at desc);
create index if not exists circuit_workflows_armed on circuit_workflows (status) where status = 'armed';

create table if not exists circuit_runs (
  id text primary key,
  workspace text not null,
  workflow_id text not null,
  status text not null,
  started_at timestamptz not null default now(),
  doc jsonb not null
);
create index if not exists circuit_runs_ws on circuit_runs (workspace, started_at desc);
create index if not exists circuit_runs_wf on circuit_runs (workspace, workflow_id, started_at desc);

create table if not exists circuit_credentials (
  workspace text not null,
  provider text not null,
  cred jsonb not null,
  primary key (workspace, provider)
);

create table if not exists circuit_tools (
  workspace text primary key,
  bound_at timestamptz not null default now(),
  doc jsonb not null
);

create table if not exists circuit_seen (
  workspace text not null,
  key text not null,
  at timestamptz not null default now(),
  primary key (workspace, key)
);
create index if not exists circuit_seen_at on circuit_seen (at);
`;

/**
 * Supabase only.
 *
 * On Supabase every table is reachable from the internet through PostgREST, so
 * RLS with no policies is what keeps anything but the service role out. On a
 * database that is not published — Railway's, say — this is the wrong tool:
 * it appears to work only because a table's owner bypasses RLS, which makes
 * the protection an accident of who ran the migration. There, keep the
 * database off the public network instead.
 */
export const SUPABASE_LOCKDOWN = `
alter table circuit_workflows enable row level security;
alter table circuit_runs enable row level security;
alter table circuit_credentials enable row level security;
alter table circuit_tools enable row level security;
alter table circuit_seen enable row level security;
-- no policies: only the service role key reaches these tables
`;
