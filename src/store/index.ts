import type { Run, Workflow } from "../graph.js";
import type { ToolBinding } from "../tools.js";
import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
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

  /** the connector tools Claude reported it can see, per workspace */
  putTools(binding: ToolBinding): Promise<void>;
  getTools(workspace: string): Promise<ToolBinding | null>;

  putCredential(workspace: string, provider: string, cred: Credential): Promise<void>;
  getCredential(workspace: string, provider: string): Promise<Credential | null>;

  /** returns true if the key was already seen inside the window */
  seen(workspace: string, key: string, windowHours: number): Promise<boolean>;
}

/**
 * Which backend the environment asks for.
 *
 * DATABASE_URL wins: it is what Railway, Fly and a plain Postgres all set, and
 * it is the one that keeps working when Circuit runs as a long-lived process.
 * Supabase stays for serverless hosts, where a TCP pool is not an option and
 * PostgREST over fetch is the only way to reach a database at all.
 *
 * In-memory is the fallback. On a long-lived process it is genuinely usable —
 * one heap, one set of Maps, alive between requests — but a redeploy or a crash
 * takes everything with it, so `storeKind()` says so and /health reports it.
 */
export type StoreKind = "postgres" | "supabase" | "memory";

export function storeKind(): StoreKind {
  if (process.env.DATABASE_URL) return "postgres";
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return "supabase";
  return "memory";
}

/** True when a restart loses every workflow and run. */
export function storageIsDurable() {
  return storeKind() !== "memory";
}

let store: Store | null = null;
export function getStore(): Store {
  if (store) return store;
  switch (storeKind()) {
    case "postgres": store = new PostgresStore(process.env.DATABASE_URL!); break;
    case "supabase": store = new SupabaseStore(
      process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!); break;
    default: store = new MemoryStore();
  }
  return store;
}

/** Tests only: point the module at a store of their choosing. */
export function setStore(s: Store | null) { store = s; }
