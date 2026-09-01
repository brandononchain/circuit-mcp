-- Circuit storage. Service-role only; no anon access.
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

alter table circuit_workflows enable row level security;
alter table circuit_runs enable row level security;
alter table circuit_credentials enable row level security;
alter table circuit_tools enable row level security;
alter table circuit_seen enable row level security;
-- no policies: only the service role key reaches these tables
