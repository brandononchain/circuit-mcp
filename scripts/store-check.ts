/**
 * Holds every storage backend to the same contract.
 *
 * The engine only ever talks to the `Store` interface, so a backend that
 * differs anywhere — an upsert that inserts twice, a list that comes back in
 * the wrong order, a `seen()` that says "fresh" to two racing callers — is a
 * bug that only shows up in production, on whichever host happens to use it.
 * Both backends run the identical suite here.
 *
 *   npx tsx scripts/store-check.ts                              memory only
 *   DATABASE_URL=postgres://... npx tsx scripts/store-check.ts  memory + postgres
 */
import pg from "pg";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import type { Store } from "../src/store/index.js";
import type { Run, Workflow } from "../src/graph.js";
import { ok, eq, deepEq, section, note, done } from "./expect.mjs";

const wf = (id: string, ws = "w1", over: Partial<Workflow> = {}): Workflow => ({
  id, name: `Board ${id}`, description: "", steps: [], entry: "a", inputs: [],
  workspace: ws, status: "draft", createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z", ...over,
} as Workflow);

const run = (id: string, workflowId: string, ws = "w1", over: Partial<Run> = {}): Run => ({
  id, workflowId, workspace: ws, status: "running", mode: "live",
  startedAt: "2026-09-01T00:00:00.000Z",
  data: { trigger: {}, steps: {}, input: {} },
  queue: [], loops: [], awaiting: null, attempts: {}, failedAt: null,
  history: [], flowId: workflowId, calls: [], trace: [], ...over,
} as Run);

async function suite(label: string, store: Store) {
  section(label);

  /* ---------------------------------------------------------- workflows */
  await store.putWorkflow(wf("wf_a", "w1", { updatedAt: "2026-09-01T00:00:01.000Z" }));
  await store.putWorkflow(wf("wf_b", "w1", { updatedAt: "2026-09-01T00:00:03.000Z" }));
  await store.putWorkflow(wf("wf_c", "w2"));

  deepEq("workflows come back newest first, scoped to the workspace",
    (await store.listWorkflows("w1")).map((w) => w.id), ["wf_b", "wf_a"]);
  eq("another workspace sees only its own", (await store.listWorkflows("w2")).length, 1);
  eq("a workflow reads back", (await store.getWorkflow("w1", "wf_a"))?.id, "wf_a");
  eq("and is invisible from the wrong workspace", await store.getWorkflow("w2", "wf_a"), null);
  eq("a missing id is null, not an error", await store.getWorkflow("w1", "wf_nope"), null);

  await store.putWorkflow(wf("wf_a", "w1", { name: "Renamed", updatedAt: "2026-09-01T00:00:09.000Z" }));
  eq("putting the same id updates rather than duplicating",
    (await store.listWorkflows("w1")).length, 2);
  eq("and the update took", (await store.getWorkflow("w1", "wf_a"))?.name, "Renamed");
  deepEq("a newer updatedAt reorders the list",
    (await store.listWorkflows("w1")).map((w) => w.id), ["wf_a", "wf_b"]);

  await store.putWorkflow(wf("wf_armed", "w1", { status: "armed" }));
  await store.putWorkflow(wf("wf_armed2", "w2", { status: "armed" }));
  deepEq("armed boards are found across every workspace",
    (await store.armedWorkflows()).map((w) => w.id).sort(), ["wf_armed", "wf_armed2"]);

  await store.deleteWorkflow("w1", "wf_b");
  eq("delete removes it", await store.getWorkflow("w1", "wf_b"), null);
  await store.deleteWorkflow("w1", "wf_b");
  ok("deleting twice is not an error", true);

  /* --------------------------------------------------------------- runs */
  await store.putRun(run("run_1", "wf_a", "w1", { startedAt: "2026-09-01T00:00:01.000Z" }));
  await store.putRun(run("run_2", "wf_a", "w1", { startedAt: "2026-09-01T00:00:02.000Z" }));
  await store.putRun(run("run_3", "wf_z", "w1", { startedAt: "2026-09-01T00:00:03.000Z" }));
  await store.putRun(run("run_4", "wf_a", "w2"));

  deepEq("runs come back newest first",
    (await store.listRuns("w1")).map((r) => r.id), ["run_3", "run_2", "run_1"]);
  deepEq("and can be filtered to one board",
    (await store.listRuns("w1", "wf_a")).map((r) => r.id), ["run_2", "run_1"]);
  eq("the limit is honoured", (await store.listRuns("w1", undefined, 2)).length, 2);
  eq("a run reads back", (await store.getRun("w1", "run_1"))?.id, "run_1");
  eq("scoped to its workspace", await store.getRun("w2", "run_1"), null);

  await store.putRun(run("run_1", "wf_a", "w1", { status: "succeeded", startedAt: "2026-09-01T00:00:01.000Z" }));
  eq("a run updates in place", (await store.getRun("w1", "run_1"))?.status, "succeeded");
  eq("without duplicating", (await store.listRuns("w1", "wf_a")).length, 2);

  /* ------------------------------------------------------- nested state */
  const heavy = run("run_deep", "wf_a", "w1", {
    data: { trigger: { threads: [{ id: "t1", snippet: "x".repeat(200) }] }, steps: { a: { ok: true } }, input: { voice: "b" } },
    history: [{ stepId: "a", state: "done", summary: "ran", at: "2026-09-01T00:00:00.000Z" } as any],
  });
  await store.putRun(heavy);
  const readBack = await store.getRun("w1", "run_deep");
  deepEq("nested run state survives a round trip", readBack, heavy);
  eq("a long string is stored whole, not truncated by the backend",
    (readBack as any)?.data.trigger.threads[0].snippet.length, 200);
  eq("history survives with it", readBack?.history.length, 1);

  /* -------------------------------------------------------------- tools */
  eq("no binding yet", await store.getTools("w1"), null);
  await store.putTools({ workspace: "w1", boundAt: "2026-09-01T00:00:00.000Z", tools: [{ name: "Gmail:reply" }] } as any);
  deepEq("a binding reads back",
    ((await store.getTools("w1")) as any)?.tools.map((t: any) => t.name), ["Gmail:reply"]);
  await store.putTools({ workspace: "w1", boundAt: "2026-09-01T00:00:05.000Z", tools: [{ name: "Slack:send_message" }] } as any);
  deepEq("rebinding replaces rather than appends",
    ((await store.getTools("w1")) as any)?.tools.map((t: any) => t.name), ["Slack:send_message"]);

  /* -------------------------------------------------------- credentials */
  eq("no credential yet", await store.getCredential("w1", "gmail"), null);
  await store.putCredential("w1", "gmail", { refreshToken: "r1" });
  eq("a credential reads back", (await store.getCredential("w1", "gmail"))?.refreshToken, "r1");
  await store.putCredential("w1", "gmail", { refreshToken: "r2", accessToken: "a2", expiresAt: 123 });
  eq("and is replaced on write", (await store.getCredential("w1", "gmail"))?.refreshToken, "r2");
  eq("optional fields survive", (await store.getCredential("w1", "gmail"))?.expiresAt, 123);
  eq("another provider is separate", await store.getCredential("w1", "slack"), null);

  /* --------------------------------------------------- seen / single use */
  eq("a key is not seen the first time", await store.seen("w1", "k1", 1), false);
  eq("and is seen the second", await store.seen("w1", "k1", 1), true);
  eq("and stays seen", await store.seen("w1", "k1", 1), true);
  eq("a different key is independent", await store.seen("w1", "k2", 1), false);
  eq("so is the same key in another workspace", await store.seen("w2", "k1", 1), false);
  eq("a zero-length window means it has already expired", await store.seen("w1", "k1", 0), false);

  /**
   * The one that matters. seen() is what makes an OAuth code single-use, so if
   * several redemptions arrive together exactly one of them may be told it is
   * fresh. A read followed by a write passes this only by luck.
   *
   * The warm-up is load-bearing. On a cold pool the clients connect at
   * staggered times, which serialises the callers by accident and lets a racy
   * implementation through; with the connections already open they genuinely
   * overlap. Several rounds, because one round can still get lucky.
   */
  const ROUNDS = 12, RACERS = 8;
  await Promise.all(Array.from({ length: RACERS }, () => store.getWorkflow("warm", "warm")));

  const winners: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const racers = await Promise.all(
      Array.from({ length: RACERS }, () => store.seen("w1", `race_${i}`, 1)));
    winners.push(racers.filter((s) => s === false).length);
  }
  deepEq(`exactly one of ${RACERS} racing callers gets the key, every round`,
    winners, Array.from({ length: ROUNDS }, () => 1));
}

const failFast = process.env.STORE_CHECK_REQUIRE_PG === "1";
await suite("in-memory store", new MemoryStore());

const url = process.env.DATABASE_URL;
if (!url) {
  if (failFast) {
    ok("DATABASE_URL is set", false, "STORE_CHECK_REQUIRE_PG=1 but no DATABASE_URL was given");
  } else {
    note("DATABASE_URL not set — skipping the postgres suite");
    note("start one and re-run to cover it:  DATABASE_URL=postgres://… npm run store-check");
  }
} else {
  /* Start from an empty database, so the ordering assertions mean something. */
  const reset = new pg.Pool({ connectionString: url, ssl: false });
  await reset.query(
    `drop table if exists circuit_workflows, circuit_runs,
     circuit_credentials, circuit_tools, circuit_seen`);
  const tablesBefore = await reset.query(
    `select count(*)::int as n from information_schema.tables
     where table_schema = 'public' and table_name like 'circuit_%'`);
  eq("the database starts with no circuit tables", tablesBefore.rows[0].n, 0);

  /* The store applies its own schema on first use — that is what makes a
     fresh Railway Postgres a one-step deploy rather than a migration step. */
  const pgStore = new PostgresStore(url, false);
  await pgStore.listWorkflows("bootstrap");
  const tablesAfter = await reset.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name like 'circuit_%' order by table_name`);
  deepEq("the store creates them itself on first connect",
    tablesAfter.rows.map((r: any) => r.table_name),
    ["circuit_credentials", "circuit_runs", "circuit_seen", "circuit_tools", "circuit_workflows"]);
  ok("and applying the schema twice is harmless",
    await pgStore.listWorkflows("bootstrap").then(() => true, (e) => String(e)));

  await suite("postgres store", pgStore);
  await pgStore.close();
  await reset.end();
}

done("store checks");
