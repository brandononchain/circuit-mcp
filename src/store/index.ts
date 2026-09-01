import type { Run, Workflow } from "../graph.js";
import { MemoryStore } from "./memory.js";
import { SupabaseStore } from "./supabase.js";

export type Credential = {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
};

export interface Store {
  listWorkflows(workspace: string): Promise<Workflow[]>;
  getWorkflow(workspace: string, id: string): Promise<Workflow | null>;
  putWorkflow(wf: Workflow): Promise<Workflow>;
  deleteWorkflow(workspace: string, id: string): Promise<void>;
  armedWorkflows(): Promise<Workflow[]>;

  putRun(run: Run): Promise<Run>;
  getRun(workspace: string, id: string): Promise<Run | null>;
  listRuns(workspace: string, workflowId?: string, limit?: number): Promise<Run[]>;

  putCredential(workspace: string, provider: string, cred: Credential): Promise<void>;
  getCredential(workspace: string, provider: string): Promise<Credential | null>;

  /** returns true if the key was already seen inside the window */
  seen(workspace: string, key: string, windowHours: number): Promise<boolean>;
}

let store: Store | null = null;
export function getStore(): Store {
  if (store) return store;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  store = url && key ? new SupabaseStore(url, key) : new MemoryStore();
  return store;
}
export function storeKind() {
  return process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "memory";
}
