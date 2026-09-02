/**
 * Drives the whole engine over the wire, the way Claude drives it.
 *
 * Every check here is an assertion. This file used to print what it found and
 * leave the judging to a human; it went green for months while a shipped
 * example silently dropped every item it was given.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ok, eq, deepEq, includes, between, section, note, done } from "./expect.mjs";

const url = new URL(process.env.URL ?? "http://localhost:8787/mcp");
const client = new Client({ name: "smoke", version: "1" }, {
  capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
});
await client.connect(new StreamableHTTPClientTransport(url));

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (r) => r.content?.[0]?.text ?? "";
const stepOf = (r, id) => r.structuredContent.workflow.steps.find((s) => s.id === id);
const traceOf = (r, id) => r.structuredContent.run.trace.find((t) => t.stepId === id);

/* ------------------------------------------------------------------ surface */
section("the tool surface");
const tools = await client.listTools();
between("tool count", tools.tools.length, 20, 40);
for (const required of ["circuit_design", "circuit_run", "circuit_step", "circuit_patch", "circuit_export", "circuit_import"]) {
  includes("tools", tools.tools.map((t) => t.name), required);
}
const board = tools.tools.find((t) => t.name === "circuit_design");
deepEq("circuit_design carries the board app", board._meta?.ui?.resourceUri, "ui://circuit/board.html");

const read = await client.readResource({ uri: "ui://circuit/board.html" });
eq("board mime type", read.contents[0].mimeType, "text/html;profile=mcp-app");
between("board size in kB", +(read.contents[0].text.length / 1024).toFixed(1), 5, 400);

const cat = JSON.parse(text(await call("circuit_catalog")));
eq("catalog step types", cat.length, 14);
ok("every catalog entry says who does the work",
  cat.every((c) => ["circuit", "claude", "user"].includes(c.doneBy)),
  `saw: ${[...new Set(cat.map((c) => c.doneBy))].join(", ")}`);

/* ------------------------------------------------------- a real-shaped board */
const steps = [
  { id: "watch", type: "trigger.watch", title: "Look for new mail",
    config: { tool: "Gmail:search_threads", arguments: { q: "in:inbox is:unread -from:me", max_results: 5 } },
    next: [{ port: "out", to: "each" }] },
  { id: "each", type: "logic.each", title: "For each thread",
    config: { list: "trigger.threads", limit: 3 },
    next: [{ port: "out", to: "intent" }, { port: "done", to: "recap" }] },
  { id: "intent", type: "model.classify", title: "Read what they want",
    config: { labels: ["sales", "scheduling", "other"], input: "item", instructions: "Pricing questions are sales." },
    next: [{ port: "sales", to: "draft" }, { port: "scheduling", to: "slots" }, { port: "other", to: "label" }] },
  { id: "draft", type: "model.write", title: "Draft a sales reply",
    config: { instructions: "Answer the pricing question and offer a call.", voice: "brandononchain", context: ["item"], maxWords: 140 },
    next: [{ port: "out", to: "gate" }] },
  { id: "gate", type: "gate.approve", title: "Hold for my approval",
    config: { preview: "steps.draft.text", question: "Send this reply?" },
    next: [{ port: "out", to: "send" }] },
  { id: "send", type: "tool.call", title: "Send the reply",
    config: { tool: "Gmail:reply", arguments: { thread_id: "{{item.id}}", body: "{{steps.draft.text}}" } },
    next: [] },
  { id: "slots", type: "tool.call", title: "Find open slots",
    config: { tool: "Google_Calendar:list_events", arguments: { time_min: "now", days: 5 } }, next: [] },
  { id: "label", type: "tool.call", title: "Label it for a human",
    config: { tool: "Gmail:label_thread", arguments: { thread_id: "{{item.id}}", label: "needs-human" } }, next: [] },
  { id: "recap", type: "note.say", title: "Tell me what happened",
    config: { template: "Went through the unread inbox." }, next: [] },
];

section("connector binding");
const bind = await call("circuit_bind", { tools: [
  { name: "Gmail:search_threads", hint: "find threads by query" },
  { name: "Gmail:reply", hint: "reply in a thread" },
  { name: "Gmail:label_thread", hint: "add a label" },
  { name: "Google_Calendar:list_events", hint: "read the calendar" },
  { name: "Slack:send_message" },
] });
ok("binding five connector tools succeeds", !bind.isError, text(bind));

const design = await call("circuit_design", {
  name: "Inbox triage & reply", description: "Sorts unread mail and drafts the easy replies.", steps,
});
ok("the board is drawn", !design.isError, text(design));
const wfId = design.structuredContent.workflow.id;
eq("every step landed", design.structuredContent.workflow.steps.length, steps.length);
ok("layout placed every step on the board",
  design.structuredContent.workflow.steps.every((s) => Number.isInteger(s.position?.col) && Number.isInteger(s.position?.lane)),
  JSON.stringify(design.structuredContent.workflow.steps.map((s) => [s.id, s.position])));
ok("the loop's done port is pushed past the loop body",
  stepOf(design, "recap").position.col > stepOf(design, "send").position.col,
  `recap col ${stepOf(design, "recap").position?.col} vs send col ${stepOf(design, "send").position?.col}`);
ok("no two steps share a cell",
  new Set(design.structuredContent.workflow.steps.map((s) => `${s.position.col},${s.position.lane}`)).size === steps.length,
  JSON.stringify(design.structuredContent.workflow.steps.map((s) => [s.id, s.position])));

/* ------------------------------------------------------------ driving a run */
section("driving a run");
let res = await call("circuit_run", { workflowId: wfId, mode: "live" });
const runId = res.structuredContent.run.id;
let d = res.structuredContent.directive;
const fakeThreads = [
  { id: "t1", from: "dana@northbeam.co", subject: "pricing", snippet: "what does it cost?" },
  { id: "t2", from: "sam@acme.io", subject: "meeting next week?", snippet: "can we talk thursday" },
];
const walked = [];
let guard = 0;
while (d && d.act !== "done" && d.act !== "blocked" && guard++ < 30) {
  walked.push(`${d.stepId}:${d.act}`);
  let result;
  if (d.act === "call_tool" && d.stepId === "watch") result = { threads: fakeThreads };
  else if (d.act === "call_tool") result = { ok: true };
  else if (d.act === "think" && d.task === "classify") result = { label: d.labels[0], why: "asks about price" };
  else if (d.act === "think" && d.task === "write") result = { text: "Hi — pricing depends on volume. Free Thursday?" };
  else if (d.act === "ask") result = { decision: "approve", edit: "Hi Dana — pricing scales with volume. Thursday 2pm?" };
  else result = {};
  res = await call("circuit_step", { runId, stepId: d.stepId, result });
  d = res.structuredContent.directive;
}
eq("the run finishes", d.act, "done");
eq("run status", res.structuredContent.run.status, "succeeded");
ok("both threads went through the loop",
  walked.filter((w) => w.startsWith("intent:")).length === 2,
  `walk was ${walked.join(" → ")}`);
includes("the walk", walked, "gate:ask");
includes("the walk", walked, "send:call_tool");
includes("the walk", walked, "recap:say");
ok("the gate's edit replaced the drafted text",
  JSON.stringify(res.structuredContent.run.history).includes("Thursday 2pm"),
  "the approved edit should be what the send step was handed");
ok("nothing was left idle after a completed run",
  !res.structuredContent.run.trace.some((t) => t.state === "idle" && ["watch", "intent", "gate", "send"].includes(t.stepId)),
  JSON.stringify(res.structuredContent.run.trace.map((t) => `${t.stepId}:${t.state}`)));

/* ------------------------------------------------------------------- guards */
section("design-time guards");
const bad = await call("circuit_design", { name: "x", steps: [{ id: "a", type: "slack.post", title: "nope", next: [] }] });
ok("an unknown step type is refused", bad.isError === true, text(bad));
includes("the refusal names the type", text(bad), "slack.post");

const typo = await call("circuit_design", { name: "Typo check", steps: [
  { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "send" }] },
  { id: "send", type: "tool.call", title: "Send it", config: { tool: "Gmail:send_reply", arguments: {} }, next: [] },
] });
eq("a mistyped connector tool is flagged on the chip", stepOf(typo, "send").toolKnown, false);
includes("and a correction is suggested", text(typo), "Gmail:reply");

const typoId = typo.structuredContent.workflow.id;
const blocked = await call("circuit_run", { workflowId: typoId });
ok("a board with an unknown tool will not run", blocked.isError === true, text(blocked));

const fixed = await call("circuit_patch", { workflowId: typoId, ops: [
  { op: "update_step", stepId: "send", config: { tool: "Gmail:reply" } },
] });
eq("patching the name clears the flag", stepOf(fixed, "send").toolKnown, true);
const nowRuns = await call("circuit_run", { workflowId: typoId });
ok("and then it runs", !nowRuns.isError, text(nowRuns));

const wrongStep = await call("circuit_step", { runId, stepId: "send", result: {} });
eq("reporting a step the run is not waiting on is blocked",
  wrongStep.structuredContent.directive.act, "blocked");

/* -------------------------------------------------------- failure policies */
section("failure policies");
const fw = await call("circuit_design", {
  name: "Failure drill", description: "Exercises every error policy.",
  steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "flaky" }] },
    { id: "flaky", type: "tool.call", title: "Flaky call", config: { tool: "Gmail:search_threads", arguments: {} },
      onError: { do: "retry", attempts: 3 }, next: [{ port: "out", to: "risky" }] },
    { id: "risky", type: "tool.call", title: "Risky call", config: { tool: "Gmail:label_thread", arguments: {} },
      onError: { do: "route", port: "error" },
      next: [{ port: "out", to: "done" }, { port: "error", to: "fallback" }] },
    { id: "fallback", type: "tool.call", title: "Fall back to a label",
      config: { tool: "Gmail:label_thread", arguments: { label: "needs-human" } }, next: [{ port: "out", to: "done" }] },
    { id: "done", type: "tool.call", title: "Final call", config: { tool: "Gmail:reply", arguments: {} }, next: [] },
  ],
});
const fwId = fw.structuredContent.workflow.id;
includes("a routed step exposes its error port", stepOf(fw, "risky").ports, "error");

let r = await call("circuit_run", { workflowId: fwId });
const rid = r.structuredContent.run.id;
const step = (args) => call("circuit_step", { runId: rid, ...args });

let after = await step({ stepId: "flaky", error: "429 rate limited" });
eq("retry re-issues the same step", after.structuredContent.directive.stepId, "flaky");
eq("and the chip now says which attempt is pending", traceOf(after, "flaky")?.attempts, 2);
after = await step({ stepId: "flaky", error: "429 again" });
eq("retry again", after.structuredContent.directive.stepId, "flaky");
eq("third and final attempt pending", traceOf(after, "flaky")?.attempts, 3);
after = await step({ stepId: "flaky", result: { threads: [] } });
eq("a later success moves on", after.structuredContent.directive.stepId, "risky");

after = await step({ stepId: "risky", error: "label not found" });
eq("route sends the failure out the error port", after.structuredContent.directive.stepId, "fallback");

after = await step({ stepId: "fallback", result: { ok: true } });
eq("the fallback rejoins the main path", after.structuredContent.directive.stepId, "done");
after = await step({ stepId: "done", error: "recipient rejected" });
eq("the default policy stops the run", after.structuredContent.directive.act, "blocked");
eq("and records where it stopped", after.structuredContent.run.failedAt, "done");
includes("the reason survives", after.structuredContent.directive.reason, "recipient rejected");

const again = await call("circuit_resume", { runId: rid });
eq("resume retries the failed step", again.structuredContent.directive.stepId, "done");
await call("circuit_step", { runId: rid, stepId: "done", error: "still rejected" });
const over = await call("circuit_resume", { runId: rid, skip: true });
eq("resume with skip finishes the run", over.structuredContent.directive.act, "done");
eq("final status", over.structuredContent.run.status, "succeeded");

/* ------------------------------------------------------------- test mode */
section("test mode withholds writes");
const tw = await call("circuit_design", {
  name: "Write guard", description: "One read, one write.",
  steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "look" }] },
    { id: "look", type: "tool.call", title: "Look it up", config: { tool: "Gmail:search_threads", arguments: {} },
      next: [{ port: "out", to: "reply" }] },
    { id: "reply", type: "tool.call", title: "Send the reply", config: { tool: "Gmail:reply", arguments: { body: "hello" } }, next: [] },
  ],
});
const twId = tw.structuredContent.workflow.id;
eq("a search is not a write", stepOf(tw, "look").writes, false);
eq("a reply is a write", stepOf(tw, "reply").writes, true);

let t = await call("circuit_run", { workflowId: twId, mode: "test" });
const tid = t.structuredContent.run.id;
eq("the read step is a real call even in test mode", t.structuredContent.directive.act, "call_tool");
t = await call("circuit_step", { runId: tid, stepId: "look", result: { threads: [] } });
eq("the write step is a rehearsal instead", t.structuredContent.directive.act, "preview");
t = await call("circuit_step", { runId: tid, stepId: "reply", result: {} });
eq("the run still completes", t.structuredContent.directive.act, "done");
includes("and the trace says it was not really sent", traceOf(t, "reply").summary, "would call");

const armed = await call("circuit_arm", { workflowId: twId });
ok("arming a board that has never really run is refused", armed.isError === true, text(armed));
const forced = await call("circuit_arm", { workflowId: twId, force: true });
ok("but it can be forced", !forced.isError, text(forced));

/* --------------------------------------------------------------- wiring */
section("wire editing");
const w1 = await call("circuit_wire", { workflowId: twId, from: "go", to: "reply" });
includes("a new wire appears on the source step", stepOf(w1, "go").next.map((n) => n.to), "reply");
const w2 = await call("circuit_unwire", { workflowId: twId, from: "go", to: "reply" });
ok("cutting it removes it", !stepOf(w2, "go").next.some((n) => n.to === "reply"),
  JSON.stringify(stepOf(w2, "go").next));
const self = await call("circuit_wire", { workflowId: twId, from: "go", to: "go" });
ok("a step cannot be wired to itself", self.isError === true, text(self));

/* -------------------------------------------------------------- history */
section("run history");
const hist = res.structuredContent.run.history ?? [];
between("moments recorded for the inbox run", hist.length, 8, 240);
ok("every moment names its step and state",
  hist.every((m) => m.stepId && m.state), JSON.stringify(hist[0]));

const bigId = (await call("circuit_design", { name: "Big payload", steps: [
  { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "fetch" }] },
  { id: "fetch", type: "tool.call", title: "Fetch a lot", config: { tool: "Gmail:search_threads", arguments: {} }, next: [] },
] })).structuredContent.workflow.id;
const bigRun = await call("circuit_run", { workflowId: bigId });
const bigDone = await call("circuit_step", {
  runId: bigRun.structuredContent.run.id, stepId: "fetch",
  result: { body: "x".repeat(9000), rows: Array.from({ length: 40 }, (_, i) => ({ i, note: "y".repeat(600) })) },
});
const rec = bigDone.structuredContent.run.history.find((m) => m.stepId === "fetch");
const stored = JSON.stringify(rec.output).length;
const raw = 9000 + 40 * 600;
between("a 33 kB payload is stored clipped", stored, 500, 5000);
ok(`clipped to ${stored} bytes from ~${raw}`, stored < raw / 5, `stored ${stored}, raw ~${raw}`);
includes("the long string says how much was cut", JSON.stringify(rec.output), "more characters");
includes("the long array says how many rows were cut", JSON.stringify(rec.output), "more of 40");

/* -------------------------------------------------------------- branches */
section("fan out, then join");
const br = await call("circuit_design", { name: "Three lookups then a summary", steps: [
  { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "all" }] },
  { id: "all", type: "logic.branches", title: "Gather everything", config: {},
    next: [{ port: "out", to: "a" }, { port: "out", to: "b" }, { port: "out", to: "c" }, { port: "join", to: "sum" }] },
  { id: "a", type: "tool.call", title: "Threads", config: { tool: "Gmail:search_threads", arguments: {} }, next: [] },
  { id: "b", type: "tool.call", title: "Calendar", config: { tool: "Google_Calendar:list_events", arguments: {} }, next: [] },
  { id: "c", type: "tool.call", title: "Labels", config: { tool: "Gmail:label_thread", arguments: {} }, writes: false, next: [] },
  { id: "sum", type: "note.say", title: "Summarise", config: { template: "Here is everything." }, next: [] },
] });
const brId = br.structuredContent.workflow.id;
let b2 = await call("circuit_run", { workflowId: brId });
const bid = b2.structuredContent.run.id;
let bd = b2.structuredContent.directive;
const order = [];
let g = 0;
while (bd && bd.act !== "done" && bd.act !== "blocked" && g++ < 12) {
  order.push(bd.stepId);
  b2 = await call("circuit_step", { runId: bid, stepId: bd.stepId, result: { ok: true } });
  bd = b2.structuredContent.directive;
}
eq("the fan-out finishes", bd.act, "done");
for (const branch of ["a", "b", "c"]) includes("branch order", order, branch);
eq("the join runs last", order[order.length - 1], "sum");

/* -------------------------------------------------------------- together */
section("several calls in one turn");
const tg = await call("circuit_design", { name: "Gather at once", steps: [
  { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "all" }] },
  { id: "all", type: "logic.branches", title: "Gather everything", config: { together: true },
    next: [{ port: "out", to: "a" }, { port: "out", to: "b" }, { port: "out", to: "c" }, { port: "join", to: "sum" }] },
  { id: "a", type: "tool.call", title: "Threads", config: { tool: "Gmail:search_threads", arguments: {} }, next: [] },
  { id: "b", type: "tool.call", title: "Calendar", config: { tool: "Google_Calendar:list_events", arguments: {} }, next: [] },
  { id: "c", type: "tool.call", title: "Labels", config: { tool: "Gmail:label_thread", arguments: {} },
    onError: { do: "skip" }, next: [] },
  { id: "sum", type: "note.say", title: "Summarise", config: { template: "Done." }, next: [] },
] });
const tgId = tg.structuredContent.workflow.id;
let tr = await call("circuit_run", { workflowId: tgId });
const trid = tr.structuredContent.run.id;
eq("one directive covers all three calls", tr.structuredContent.directive.act, "call_many");
eq("with three calls in it", tr.structuredContent.directive.calls.length, 3);
tr = await call("circuit_step", { runId: trid, stepId: "all",
  results: { a: { threads: [1, 2] }, b: { events: [] } }, errors: { c: "label not found" } });
const states = Object.fromEntries(tr.structuredContent.run.trace
  .filter((x) => "abc".includes(x.stepId)).map((x) => [x.stepId, x.state]));
deepEq("two succeed, and the one with a skip policy is marked failed", states, { a: "done", b: "done", c: "failed" });
includes("its summary says only the path was dropped",
  tr.structuredContent.run.trace.find((x) => x.stepId === "c").summary, "dropped");
ok("a skip policy does not fail the whole run",
  tr.structuredContent.run.status !== "failed", tr.structuredContent.run.status);
eq("the join still fires", tr.structuredContent.directive.stepId, "sum");

const badTogether = await call("circuit_design", { name: "Bad together", steps: [
  { id: "go", type: "trigger.ask", title: "x", config: {}, next: [{ port: "out", to: "all" }] },
  { id: "all", type: "logic.branches", title: "y", config: { together: true },
    next: [{ port: "out", to: "a" }, { port: "out", to: "b" }] },
  { id: "a", type: "tool.call", title: "z", config: { tool: "Gmail:reply", arguments: {} }, next: [{ port: "out", to: "b" }] },
  { id: "b", type: "model.write", title: "w", config: { instructions: "hi" }, next: [] },
] });
ok("branches that depend on each other cannot run together", badTogether.isError === true, text(badTogether));

/* --------------------------------------------------------- sub-workflows */
section("sub-workflows");
const child = await call("circuit_design", {
  name: "Draft and approve", description: "Writes a reply and holds it.",
  inputs: [{ name: "who", description: "who it is going to", required: true }],
  steps: [
    { id: "start", type: "trigger.ask", title: "When called", config: {}, next: [{ port: "out", to: "write" }] },
    { id: "write", type: "model.write", title: "Write it", config: { instructions: "Reply to {{input.who}}.", maxWords: 80 },
      next: [{ port: "out", to: "check" }] },
    { id: "check", type: "gate.approve", title: "Approve it", config: { preview: "steps.write.text", question: "Send this?" }, next: [] },
  ],
});
const childId = child.structuredContent.workflow.id;

const parent = await call("circuit_design", {
  name: "Chase then send", description: "Finds a thread, uses the drafting workflow, sends it.",
  steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "find" }] },
    { id: "find", type: "tool.call", title: "Find the thread", config: { tool: "Gmail:search_threads", arguments: {} },
      next: [{ port: "out", to: "sub" }] },
    { id: "sub", type: "flow.call", title: "Draft and approve",
      config: { workflowId: childId, input: { who: "{{steps.find.threads.0.from}}" }, returns: "steps.write.text" },
      next: [{ port: "out", to: "send" }] },
    { id: "send", type: "tool.call", title: "Send it", config: { tool: "Gmail:reply", arguments: { body: "{{steps.sub}}" } }, next: [] },
  ],
});
const parentId = parent.structuredContent.workflow.id;

let pr = await call("circuit_run", { workflowId: parentId });
const prid = pr.structuredContent.run.id;
let pd = pr.structuredContent.directive;
const seen = [];
let pg = 0;
while (pd && pd.act !== "done" && pd.act !== "blocked" && pg++ < 14) {
  seen.push(`${pd.stepId}:${pd.act}`);
  const result = pd.act === "think" ? { text: "Hi — here is the update." }
    : pd.act === "ask" ? { decision: "approve" }
    : { threads: [{ id: "t1", from: "dana@northbeam.co" }] };
  pr = await call("circuit_step", { runId: prid, stepId: pd.stepId, result });
  pd = pr.structuredContent.directive;
}
eq("the parent run finishes", pd.act, "done");
includes("the child's steps are driven from the parent run", seen, "write:think");
includes("including the child's gate", seen, "check:ask");
const sendStep = pr.structuredContent.run.history.find((m) => m.stepId === "send");
ok("what the sub-workflow returned reached the parent's send step",
  JSON.stringify(sendStep?.input ?? {}).includes("here is the update"),
  JSON.stringify(sendStep?.input));

const loop = await call("circuit_design", {
  workflowId: childId, name: "Draft and approve",
  inputs: [{ name: "who", description: "who", required: true }],
  steps: [
    { id: "start", type: "trigger.ask", title: "When called", config: {}, next: [{ port: "out", to: "back" }] },
    { id: "back", type: "flow.call", title: "Call the parent", config: { workflowId: parentId }, next: [] },
  ],
});
ok("a workflow cycle is refused", loop.isError === true, text(loop));

/* ------------------------------------------------------------ scheduling */
section("scheduling");
const sched = await call("circuit_design", { name: "Friday digest", steps: [
  { id: "fri", type: "trigger.schedule", title: "Every Friday", config: { cron: "0 22 * * 5", note: "Fridays at 5pm" },
    next: [{ port: "out", to: "tell" }] },
  { id: "tell", type: "note.say", title: "Say the digest", config: { template: "Here it is." }, next: [] },
] });
const schedId = sched.structuredContent.workflow.id;
const armedNow = await call("circuit_arm", { workflowId: schedId });
ok("a scheduled board arms", !armedNow.isError, text(armedNow));

let h = await call("circuit_health");
includes("health flags a board armed with no task behind it", text(h), "no scheduled task was ever reported back");
await call("circuit_scheduled", { workflowId: schedId, taskId: "trig_abc123" });
h = await call("circuit_health");
ok("recording the task clears that warning",
  !text(h).split("\n").filter((l) => l.includes("Friday digest")).join(" ").includes("no scheduled task"),
  text(h).split("\n").filter((l) => l.includes("Friday digest")).join("\n"));

const sr = await call("circuit_run", { workflowId: schedId });
await call("circuit_step", { runId: sr.structuredContent.run.id, stepId: "tell", result: {} });
h = await call("circuit_health");
ok("health reports a healthy schedule once it has actually run",
  !text(h).includes("never run"), text(h));

const badCron = await call("circuit_design", { name: "Bad cron", steps: [
  { id: "f", type: "trigger.schedule", title: "when", config: { cron: "not a cron" }, next: [] },
] });
const badArm = await call("circuit_arm", { workflowId: badCron.structuredContent.workflow.id });
ok("an unparseable cron cannot be armed", badArm.isError === true, text(badArm));

await client.close();
done("engine checks");
