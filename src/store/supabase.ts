import type { Run, Workflow } from "../graph.js";
import type { Credential, Store } from "./index.js";
import type { ToolBinding } from "../tools.js";

/**
 * PostgREST over fetch. The supabase-js client would pull in auth, realtime and
 * storage for four tables we never leave, so this talks to the REST endpoint
 * directly with the service role key.
 */
export class SupabaseStore implements Store {
  constructor(private url: string, private key: string) {
    this.url = url.replace(/\/$/, "");
  }

  private async rest(path: string, init: RequestInit = {}) {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  private upsert(table: string, row: unknown) {
    return this.rest(table, {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
  }

  async listWorkflows(ws: string) {
    const r = await this.rest(`circuit_workflows?workspace=eq.${enc(ws)}&select=doc&order=updated_at.desc`);
    return (r ?? []).map((x: any) => x.doc as Workflow);
  }
  async getWorkflow(ws: string, id: string) {
    const r = await this.rest(`circuit_workflows?workspace=eq.${enc(ws)}&id=eq.${enc(id)}&select=doc&limit=1`);
    return (r?.[0]?.doc as Workflow) ?? null;
  }
  async putWorkflow(wf: Workflow) {
    await this.upsert("circuit_workflows", {
      id: wf.id, workspace: wf.workspace, status: wf.status, updated_at: wf.updatedAt, doc: wf,
    });
    return wf;
  }
  async deleteWorkflow(ws: string, id: string) {
    await this.rest(`circuit_workflows?workspace=eq.${enc(ws)}&id=eq.${enc(id)}`, { method: "DELETE" });
  }
  async armedWorkflows() {
    const r = await this.rest(`circuit_workflows?status=eq.armed&select=doc`);
    return (r ?? []).map((x: any) => x.doc as Workflow);
  }

  async putRun(run: Run) {
    await this.upsert("circuit_runs", {
      id: run.id, workspace: run.workspace, workflow_id: run.workflowId,
      status: run.status, started_at: run.startedAt, doc: run,
    });
    return run;
  }
  async getRun(ws: string, id: string) {
    const r = await this.rest(`circuit_runs?workspace=eq.${enc(ws)}&id=eq.${enc(id)}&select=doc&limit=1`);
    return (r?.[0]?.doc as Run) ?? null;
  }
  async listRuns(ws: string, workflowId?: string, limit = 20) {
    const wf = workflowId ? `&workflow_id=eq.${enc(workflowId)}` : "";
    const r = await this.rest(`circuit_runs?workspace=eq.${enc(ws)}${wf}&select=doc&order=started_at.desc&limit=${limit}`);
    return (r ?? []).map((x: any) => x.doc as Run);
  }

  async putTools(binding: ToolBinding) {
    await this.upsert("circuit_tools", {
      workspace: binding.workspace, bound_at: binding.boundAt, doc: binding,
    });
  }
  async getTools(ws: string) {
    const r = await this.rest(`circuit_tools?workspace=eq.${enc(ws)}&select=doc&limit=1`);
    return (r?.[0]?.doc as ToolBinding) ?? null;
  }

  async putCredential(ws: string, provider: string, cred: Credential) {
    await this.upsert("circuit_credentials", { workspace: ws, provider, cred });
  }
  async getCredential(ws: string, provider: string) {
    const r = await this.rest(`circuit_credentials?workspace=eq.${enc(ws)}&provider=eq.${enc(provider)}&select=cred&limit=1`);
    return (r?.[0]?.cred as Credential) ?? null;
  }

  async seen(ws: string, key: string, windowHours: number) {
    const cutoff = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const r = await this.rest(`circuit_seen?workspace=eq.${enc(ws)}&key=eq.${enc(key)}&at=gte.${cutoff}&select=at&limit=1`);
    if (r?.length) return true;
    await this.upsert("circuit_seen", { workspace: ws, key, at: new Date().toISOString() });
    return false;
  }
}

const enc = (s: string) => encodeURIComponent(s);
