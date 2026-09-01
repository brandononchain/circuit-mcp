import type { Run, Workflow } from "../graph.js";
import type { Credential, Store } from "./index.js";

const g = globalThis as any;
g.__circuit ??= { wf: new Map(), runs: new Map(), creds: new Map(), seen: new Map() };
const db = g.__circuit as {
  wf: Map<string, Workflow>; runs: Map<string, Run>;
  creds: Map<string, Credential>; seen: Map<string, number>;
};

const k = (a: string, b: string) => `${a}::${b}`;

export class MemoryStore implements Store {
  async listWorkflows(ws: string) {
    return [...db.wf.values()].filter((w) => w.workspace === ws)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getWorkflow(ws: string, id: string) { return db.wf.get(k(ws, id)) ?? null; }
  async putWorkflow(wf: Workflow) { db.wf.set(k(wf.workspace, wf.id), wf); return wf; }
  async deleteWorkflow(ws: string, id: string) { db.wf.delete(k(ws, id)); }
  async armedWorkflows() { return [...db.wf.values()].filter((w) => w.status === "armed"); }

  async putRun(run: Run) { db.runs.set(k(run.workspace, run.id), run); return run; }
  async getRun(ws: string, id: string) { return db.runs.get(k(ws, id)) ?? null; }
  async listRuns(ws: string, workflowId?: string, limit = 20) {
    return [...db.runs.values()]
      .filter((r) => r.workspace === ws && (!workflowId || r.workflowId === workflowId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async putCredential(ws: string, p: string, c: Credential) { db.creds.set(k(ws, p), c); }
  async getCredential(ws: string, p: string) { return db.creds.get(k(ws, p)) ?? null; }

  async seen(ws: string, key: string, windowHours: number) {
    const id = k(ws, key);
    const at = db.seen.get(id);
    const now = Date.now();
    if (at && now - at < windowHours * 3600_000) return true;
    db.seen.set(id, now);
    return false;
  }
}
