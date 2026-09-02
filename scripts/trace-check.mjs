/**
 * Golden traces for the shipped examples.
 *
 * Each example is imported over the wire and driven to completion once per
 * scenario, exactly as Claude would drive it. The resulting directive sequence
 * is compared against a checked-in trace, and the union of steps visited across
 * an example's scenarios must cover every step in it.
 *
 * The second half is the point. An example whose filter drops every item still
 * runs, still ends "done", and still looks fine in the transcript — it just
 * never reaches seven of its ten steps. Only coverage catches that.
 *
 *   node scripts/trace-check.mjs                 check against examples/traces/
 *   UPDATE_TRACES=1 node scripts/trace-check.mjs rewrite them after a real change
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { SCENARIOS } from "./scenarios.mjs";
import { ok, eq, deepEq, section, note, done } from "./expect.mjs";

const UPDATE = process.env.UPDATE_TRACES === "1";
const TRACE_DIR = "examples/traces";
const MAX_DIRECTIVES = 60;

const url = new URL(process.env.URL ?? "http://localhost:8787/mcp");
const client = new Client({ name: "trace-check", version: "1" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(url));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text ?? "(no message)"}`);
  return r.structuredContent;
};

/** One line per directive: what Claude was asked to do, and where. */
const line = (d) => {
  if (d.act === "call_many") return `call_many ${d.stepId} [${d.calls.map((c) => c.stepId).join(" ")}]`;
  if (d.act === "done") return `done`;
  if (d.act === "blocked") return `blocked ${d.stepId} — ${d.reason}`;
  const detail = d.tool ?? d.task ?? "";
  return `${d.act} ${d.stepId}${detail ? ` ${detail}` : ""}`;
};

async function drive(file, scenario) {
  const source = readFileSync(`examples/${file}`, "utf8");
  const imported = await call("circuit_import", { source });
  const wf = imported.workflow;

  let out = await call("circuit_run", { workflowId: wf.id, mode: "live", input: scenario.input ?? {} });
  const runId = out.run.id;
  let d = out.directive;
  const trace = [];

  let guard = 0;
  while (d && d.act !== "done" && d.act !== "blocked") {
    if (++guard > MAX_DIRECTIVES) throw new Error(`ran past ${MAX_DIRECTIVES} directives — probably looping`);
    trace.push(line(d));
    const reply = scenario.respond(d) ?? { result: { ok: true } };
    out = await call("circuit_step", { runId, stepId: d.stepId, ...reply });
    d = out.directive;
  }
  trace.push(line(d));

  /**
   * Coverage comes from the run's own trace, not from the directive stream.
   * Loops, filters and branches are resolved by Circuit itself and never
   * surface as a directive, so counting directives would report the engine's
   * own steps as unreachable while missing the thing worth catching: a step
   * left idle because nothing ever routed to it.
   */
  const visited = new Set((out.run.trace ?? []).filter((t) => t.state !== "idle").map((t) => t.stepId));
  return { trace, visited, wf, run: out.run, last: d };
}

for (const [file, scenarios] of Object.entries(SCENARIOS)) {
  section(`examples/${file}`);
  const covered = new Set();
  let allSteps = [];
  const recorded = [];

  for (const scenario of scenarios) {
    let r;
    try {
      r = await drive(file, scenario);
    } catch (e) {
      ok(scenario.name, false, e.message);
      continue;
    }
    allSteps = r.wf.steps.map((s) => s.id);
    for (const v of r.visited) covered.add(v);
    recorded.push(`# ${scenario.name}\n${r.trace.join("\n")}`);

    const finished = r.last.act === "done";
    ok(`${scenario.name} — reaches the end`, finished,
      finished ? "" : `ended ${r.last.act}: ${r.last.reason ?? ""}`);
    if (scenario.expectStatus) eq(`${scenario.name} — run status`, r.run.status, scenario.expectStatus);
  }

  /* Every step in a shipped example has to be reachable by some scenario. */
  const unreached = allSteps.filter((s) => !covered.has(s));
  ok(`every step is reachable (${covered.size}/${allSteps.length})`, unreached.length === 0,
    `never visited: ${unreached.join(", ")}\n` +
    `a step no scenario can reach is either dead wiring or a bug upstream of it`);

  /* And the walk itself must not drift silently. */
  const path = `${TRACE_DIR}/${file.replace(/\.json$/, ".trace")}`;
  const body = recorded.join("\n\n") + "\n";
  if (UPDATE || !existsSync(path)) {
    mkdirSync(TRACE_DIR, { recursive: true });
    writeFileSync(path, body);
    note(existsSync(path) && !UPDATE ? `wrote ${path} (new)` : `rewrote ${path}`);
  } else {
    const expected = readFileSync(path, "utf8");
    if (body === expected) {
      eq(`trace matches ${path}`, true, true);
    } else {
      const a = body.split("\n"), b = expected.split("\n");
      const at = a.findIndex((l, i) => l !== b[i]);
      deepEq(`trace matches ${path} (first difference at line ${at + 1})`,
        { line: at + 1, got: a[at] ?? "(end of trace)" },
        { line: at + 1, got: b[at] ?? "(end of trace)" });
      note("if this change is intended: UPDATE_TRACES=1 node scripts/trace-check.mjs");
    }
  }
}

done("trace checks");
