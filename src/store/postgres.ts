import pg from "pg";
import type { Run, Workflow } from "../graph.js";
import type { Credential, Store } from "./index.js";
import type { ToolBinding } from "../tools.js";
import { SCHEMA } from "./schema.js";

const { Pool } = pg;

/**
 * Postgres over a real connection pool.
 *
 * The Supabase store talks PostgREST over `fetch` because a serverless function
 * is too short-lived to hold a TCP connection open. On a host that runs Circuit
 * as one long process — Railway, Fly, a plain VM — that constraint is gone, and
 * a pool is both faster and lets `seen()` be a single atomic statement instead
 * of a read followed by a write.
 */
export class PostgresStore implements Store {
  private pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(connectionString: string, ssl?: pg.PoolConfig["ssl"]) {
    this.pool = new Pool({
      connectionString,
      ssl: ssl ?? sslFor(connectionString),
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    /* A pool error with no listener takes the process down. */
    this.pool.on("error", (e) => console.error("[circuit] idle client error:", e.message));
  }

  /** Applied once per process; every statement is `if not exists`. */
  private ensure() {
    this.ready ??= this.pool.query(SCHEMA).then(() => undefined);
    return this.ready;
  }

  private async q<T extends pg.QueryResultRow = any>(
    text: string, values: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    await this.ensure();
    return this.pool.query<T>(text, values);
  }

  async close() { await this.pool.end(); }

  /* ------------------------------------------------------------ workflows */
  async listWorkflows(ws: string) {
    const r = await this.q(
      `select doc from circuit_workflows where workspace = $1 order by updated_at desc`, [ws]);
    return r.rows.map((x) => x.doc as Workflow);
  }
  async getWorkflow(ws: string, id: string) {
    const r = await this.q(
      `select doc from circuit_workflows where workspace = $1 and id = $2 limit 1`, [ws, id]);
    return (r.rows[0]?.doc as Workflow) ?? null;
  }
  async putWorkflow(wf: Workflow) {
    await this.q(
      `insert into circuit_workflows (id, workspace, status, updated_at, doc)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update
         set workspace = excluded.workspace,
             status = excluded.status,
             updated_at = excluded.updated_at,
             doc = excluded.doc`,
      [wf.id, wf.workspace, wf.status, wf.updatedAt, JSON.stringify(wf)]);
    return wf;
  }
  async deleteWorkflow(ws: string, id: string) {
    await this.q(`delete from circuit_workflows where workspace = $1 and id = $2`, [ws, id]);
  }
  async armedWorkflows() {
    const r = await this.q(`select doc from circuit_workflows where status = 'armed'`);
    return r.rows.map((x) => x.doc as Workflow);
  }

  /* ----------------------------------------------------------------- runs */
  async putRun(run: Run) {
    await this.q(
      `insert into circuit_runs (id, workspace, workflow_id, status, started_at, doc)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update
         set status = excluded.status, doc = excluded.doc`,
      [run.id, run.workspace, run.workflowId, run.status, run.startedAt, JSON.stringify(run)]);
    return run;
  }
  async getRun(ws: string, id: string) {
    const r = await this.q(
      `select doc from circuit_runs where workspace = $1 and id = $2 limit 1`, [ws, id]);
    return (r.rows[0]?.doc as Run) ?? null;
  }
  async listRuns(ws: string, workflowId?: string, limit = 20) {
    const r = workflowId
      ? await this.q(
          `select doc from circuit_runs where workspace = $1 and workflow_id = $2
           order by started_at desc limit $3`, [ws, workflowId, limit])
      : await this.q(
          `select doc from circuit_runs where workspace = $1
           order by started_at desc limit $2`, [ws, limit]);
    return r.rows.map((x) => x.doc as Run);
  }

  /* ---------------------------------------------------------------- tools */
  async putTools(binding: ToolBinding) {
    await this.q(
      `insert into circuit_tools (workspace, bound_at, doc) values ($1, $2, $3)
       on conflict (workspace) do update set bound_at = excluded.bound_at, doc = excluded.doc`,
      [binding.workspace, binding.boundAt, JSON.stringify(binding)]);
  }
  async getTools(ws: string) {
    const r = await this.q(`select doc from circuit_tools where workspace = $1 limit 1`, [ws]);
    return (r.rows[0]?.doc as ToolBinding) ?? null;
  }

  /* ---------------------------------------------------------- credentials */
  async putCredential(ws: string, provider: string, cred: Credential) {
    await this.q(
      `insert into circuit_credentials (workspace, provider, cred) values ($1, $2, $3)
       on conflict (workspace, provider) do update set cred = excluded.cred`,
      [ws, provider, JSON.stringify(cred)]);
  }
  async getCredential(ws: string, provider: string) {
    const r = await this.q(
      `select cred from circuit_credentials where workspace = $1 and provider = $2 limit 1`,
      [ws, provider]);
    return (r.rows[0]?.cred as Credential) ?? null;
  }

  /* ----------------------------------------------------------------- seen */
  /**
   * One statement, so two requests racing on the same key cannot both be told
   * the key is fresh. This guards single-use OAuth codes, where a read followed
   * by a write leaves a window an attacker can drive a replay through.
   *
   * Absent, or present but expired  -> the row is written, a row comes back, not seen.
   * Present and still inside the window -> the WHERE suppresses the update, no row, seen.
   */
  async seen(ws: string, key: string, windowHours: number) {
    const r = await this.q(
      `insert into circuit_seen as s (workspace, key, at) values ($1, $2, now())
       on conflict (workspace, key) do update set at = now()
         where s.at < now() - ($3::float8 * interval '1 hour')
       returning 1`,
      [ws, key, windowHours]);
    return r.rowCount === 0;
  }
}

/**
 * Railway's private network (`*.railway.internal`) and a local database do not
 * want TLS; its public proxy does, behind a certificate chain Node will not
 * verify on its own. PGSSLMODE overrides either way.
 */
function sslFor(connectionString: string): pg.PoolConfig["ssl"] {
  const mode = process.env.PGSSLMODE;
  if (mode === "disable") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  if (mode) return true;

  let host = "";
  try { host = new URL(connectionString).hostname; } catch { /* fall through */ }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1"
    || host.endsWith(".railway.internal") || host.endsWith(".internal");
  return local ? false : { rejectUnauthorized: false };
}
