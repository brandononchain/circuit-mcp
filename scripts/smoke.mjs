import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.URL ?? "http://localhost:8787/mcp");
const client = new Client({ name: "smoke", version: "1" }, {
  capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
});
await client.connect(new StreamableHTTPClientTransport(url));

const tools = await client.listTools();
console.log("TOOLS", tools.tools.length);
for (const t of tools.tools) {
  const ui = t._meta?.ui;
  console.log(" -", t.name.padEnd(20), ui ? JSON.stringify(ui.visibility ?? ["model", "app"]) : "");
}
const read = await client.readResource({ uri: "ui://circuit/board.html" });
console.log("APP", read.contents[0].mimeType, (read.contents[0].text.length / 1024).toFixed(1) + " kB");

const cat = JSON.parse((await client.callTool({ name: "circuit_catalog", arguments: {} })).content[0].text);
console.log("CATALOG", cat.map(c => `${c.type}(${c.doneBy})`).join(" "));

/* A real-shaped workflow over connectors the user would already have. */
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

/* ---- tool binding: the guard that makes a mistyped connector a design error ---- */
const bind = await client.callTool({ name: "circuit_bind", arguments: { tools: [
  { name: "Gmail:search_threads", hint: "find threads by query" },
  { name: "Gmail:reply", hint: "reply in a thread" },
  { name: "Gmail:label_thread", hint: "add a label" },
  { name: "Google_Calendar:list_events", hint: "read the calendar" },
  { name: "Slack:send_message" },
] } });
console.log("\n--- circuit_bind ---\n" + bind.content[0].text);

const design = await client.callTool({
  name: "circuit_design",
  arguments: { name: "Inbox triage & reply", description: "Sorts unread mail and drafts the easy replies.", steps },
});
console.log("\n--- design ---\n" + design.content[0].text);
const wfId = design.structuredContent.workflow.id;

/* Now play Claude: take one directive at a time. */
let res = await client.callTool({ name: "circuit_run", arguments: { workflowId: wfId, mode: "live" } });
let runId = res.structuredContent.run.id;
let d = res.structuredContent.directive;
let guard = 0;
const fakeThreads = [
  { id: "t1", from: "dana@northbeam.co", subject: "pricing", snippet: "what does it cost?" },
  { id: "t2", from: "sam@acme.io", subject: "meeting next week?", snippet: "can we talk thursday" },
];
console.log("\n--- driving the run ---");
while (d && d.act !== "done" && d.act !== "blocked" && guard++ < 30) {
  console.log(`  ${String(guard).padStart(2)}. ${d.act.padEnd(10)} ${d.stepId ?? ""}  ${d.tool ?? d.title ?? ""}`);
  let result;
  if (d.act === "call_tool" && d.stepId === "watch") result = { threads: fakeThreads };
  else if (d.act === "call_tool") { console.log(`      args ${JSON.stringify(d.arguments)}`); result = { ok: true }; }
  else if (d.act === "think" && d.task === "classify") result = { label: d.labels[0], why: "asks about price" };
  else if (d.act === "think" && d.task === "write") result = { text: "Hi — pricing depends on volume. Free Thursday?" };
  else if (d.act === "ask") { console.log(`      preview: ${JSON.stringify(d.preview)}`); result = { decision: "approve", edit: "Hi Dana — pricing scales with volume. Thursday 2pm?" }; }
  else result = {};
  res = await client.callTool({ name: "circuit_step", arguments: { runId, stepId: d.stepId, result } });
  d = res.structuredContent.directive;
}
console.log("  ->", JSON.stringify(d));
console.log("\n--- final board ---\n" + res.content[0].text.split("\n--- do this next ---")[0]);

const bad = await client.callTool({ name: "circuit_design", arguments: { name: "x", steps: [{ id: "a", type: "slack.post", title: "nope", next: [] }] } });
console.log("\nunknown type guard:", bad.isError, "|", bad.content[0].text);

/* a plausible-but-wrong tool name should be caught while drawing, with a suggestion */
const typo = await client.callTool({ name: "circuit_design", arguments: {
  name: "Typo check",
  steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "send" }] },
    { id: "send", type: "tool.call", title: "Send it",
      config: { tool: "Gmail:send_reply", arguments: {} }, next: [] },
  ],
} });
console.log("\n--- mistyped tool ---\n" + typo.content[0].text.split("\n").slice(-5).join("\n"));
console.log("chip flagged:", JSON.stringify(typo.structuredContent.workflow.steps.find(s => s.id === "send").toolKnown));

const typoId = typo.structuredContent.workflow.id;
const blocked = await client.callTool({ name: "circuit_run", arguments: { workflowId: typoId } });
console.log("run refused:", blocked.isError, "|", blocked.content[0].text.split("\n")[0]);

const fixed = await client.callTool({ name: "circuit_patch", arguments: { workflowId: typoId,
  ops: [{ op: "update_step", stepId: "send", config: { tool: "Gmail:reply" } }] } });
console.log("after patch, flagged:", JSON.stringify(fixed.structuredContent.workflow.steps.find(s => s.id === "send").toolKnown));
const nowRuns = await client.callTool({ name: "circuit_run", arguments: { workflowId: typoId } });
console.log("run accepted:", !nowRuns.isError, "|", JSON.stringify(nowRuns.structuredContent.directive?.act));
const wrongStep = await client.callTool({ name: "circuit_step", arguments: { runId, stepId: "send", result: {} } });
console.log("out-of-order guard:", JSON.stringify(wrongStep.structuredContent.directive));

/* ---- failure handling: retry, route, stop + resume ---- */
console.log("\n--- failure policies ---");
const fw = await client.callTool({ name: "circuit_design", arguments: {
  name: "Failure drill", description: "Exercises every error policy.",
  steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "flaky" }] },
    { id: "flaky", type: "tool.call", title: "Flaky call",
      config: { tool: "Gmail:search_threads", arguments: {} },
      onError: { do: "retry", attempts: 3 }, next: [{ port: "out", to: "risky" }] },
    { id: "risky", type: "tool.call", title: "Risky call",
      config: { tool: "Gmail:label_thread", arguments: {} },
      onError: { do: "route", port: "error" },
      next: [{ port: "out", to: "done" }, { port: "error", to: "fallback" }] },
    { id: "fallback", type: "tool.call", title: "Fall back to a label",
      config: { tool: "Gmail:label_thread", arguments: { label: "needs-human" } }, next: [{ port: "out", to: "done" }] },
    { id: "done", type: "tool.call", title: "Final call",
      config: { tool: "Gmail:reply", arguments: {} }, next: [] },
  ],
} });
const fwId = fw.structuredContent.workflow.id;
console.log("error port exposed:", JSON.stringify(fw.structuredContent.workflow.steps.find(s => s.id === "risky").ports));

let r = await client.callTool({ name: "circuit_run", arguments: { workflowId: fwId } });
let rid = r.structuredContent.run.id, dd = r.structuredContent.directive;
const step = (args) => client.callTool({ name: "circuit_step", arguments: { runId: rid, ...args } });

// retry: fail twice, succeed on the third
dd = (await step({ stepId: "flaky", error: "429 rate limited" })).structuredContent.directive;
console.log("after 1st failure ->", dd.act, dd.stepId, "| attempt", r.structuredContent.run.trace.find(t=>t.stepId==="flaky")?.attempts);
let after = await step({ stepId: "flaky", error: "429 again" });
dd = after.structuredContent.directive;
console.log("after 2nd failure ->", dd.act, dd.stepId);
after = await step({ stepId: "flaky", result: { threads: [] } });
dd = after.structuredContent.directive;
console.log("then succeeds     ->", dd.act, dd.stepId);

// route: failure leaves by the error port
after = await step({ stepId: "risky", error: "label not found" });
dd = after.structuredContent.directive;
console.log("route on failure  ->", dd.act, dd.stepId, "(expected fallback)");

// stop: default policy halts the run, and resume picks it up
after = await step({ stepId: "fallback", result: { ok: true } });
dd = after.structuredContent.directive;
after = await step({ stepId: "done", error: "recipient rejected" });
dd = after.structuredContent.directive;
console.log("stop on failure   ->", dd.act, "| failedAt:", after.structuredContent.run.failedAt);
console.log("  reason:", dd.reason);

const again = await client.callTool({ name: "circuit_resume", arguments: { runId: rid } });
console.log("resume            ->", again.structuredContent.directive.act, again.structuredContent.directive.stepId);
const skipped = await client.callTool({ name: "circuit_step", arguments: { runId: rid, stepId: "done", error: "still rejected" } });
const over = await client.callTool({ name: "circuit_resume", arguments: { runId: rid, skip: true } });
console.log("resume with skip  ->", JSON.stringify(over.structuredContent.directive));
console.log("final status      ->", over.structuredContent.run.status);

/* ---- test mode withholds writes ---- */
console.log("\n--- test mode ---");
const tw = await client.callTool({ name: "circuit_design", arguments: {
  name: "Write guard", description: "One read, one write.",
  steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "look" }] },
    { id: "look", type: "tool.call", title: "Look it up",
      config: { tool: "Gmail:search_threads", arguments: {} }, next: [{ port: "out", to: "reply" }] },
    { id: "reply", type: "tool.call", title: "Send the reply",
      config: { tool: "Gmail:reply", arguments: { body: "hello" } }, next: [] },
  ],
} });
const twId = tw.structuredContent.workflow.id;
const flags = tw.structuredContent.workflow.steps.map(s => `${s.id}:${s.writes}`).join(" ");
console.log("write detection:", flags, "(guessed from the verb, nothing declared)");

let t = await client.callTool({ name: "circuit_run", arguments: { workflowId: twId, mode: "test" } });
const tid = t.structuredContent.run.id;
let td = t.structuredContent.directive;
console.log("read step   ->", td.act, td.tool);
t = await client.callTool({ name: "circuit_step", arguments: { runId: tid, stepId: "look", result: { threads: [] } } });
td = t.structuredContent.directive;
console.log("write step  ->", td.act, td.tool, "|", td.expect.split(".")[0]);
t = await client.callTool({ name: "circuit_step", arguments: { runId: tid, stepId: "reply", result: {} } });
console.log("finished    ->", JSON.stringify(t.structuredContent.directive));
console.log("trace says  ->", t.structuredContent.run.trace.find(x => x.stepId === "reply").summary);

const armed = await client.callTool({ name: "circuit_arm", arguments: { workflowId: twId } });
console.log("arm refused:", armed.isError, "|", armed.content[0].text.split("\n")[0]);
const forced = await client.callTool({ name: "circuit_arm", arguments: { workflowId: twId, force: true } });
console.log("arm forced :", !forced.isError);

/* ---- wire editing ---- */
console.log("\n--- wiring ---");
const w1 = await client.callTool({ name: "circuit_wire", arguments: { workflowId: twId, from: "go", to: "reply" } });
console.log("after wire :", JSON.stringify(w1.structuredContent.workflow.steps.find(s => s.id === "go").next));
const w2 = await client.callTool({ name: "circuit_unwire", arguments: { workflowId: twId, from: "go", to: "reply" } });
console.log("after cut  :", JSON.stringify(w2.structuredContent.workflow.steps.find(s => s.id === "go").next));
const self = await client.callTool({ name: "circuit_wire", arguments: { workflowId: twId, from: "go", to: "go" } });
console.log("self wire  :", self.isError, "|", self.content[0].text);

/* ---- run history, the thing replay scrubs ---- */
console.log("\n--- run history ---");
const hist = res.structuredContent.run.history ?? [];
console.log(`${hist.length} moments recorded`);
for (const m of hist.slice(0, 6)) {
  const shape = (v) => v === undefined ? "-" : (JSON.stringify(v) ?? "").slice(0, 46);
  console.log(`  ${String(m.stepId).padEnd(8)} ${String(m.state).padEnd(8)} in ${shape(m.input).padEnd(48)} out ${shape(m.output)}`);
}
// a deliberately huge result should come back trimmed, not stored whole
const bigId = (await client.callTool({ name: "circuit_design", arguments: {
  name: "Big payload", steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "fetch" }] },
    { id: "fetch", type: "tool.call", title: "Fetch a lot",
      config: { tool: "Gmail:search_threads", arguments: {} }, next: [] },
  ],
} })).structuredContent.workflow.id;
const bigRun = await client.callTool({ name: "circuit_run", arguments: { workflowId: bigId } });
const bigDone = await client.callTool({ name: "circuit_step", arguments: {
  runId: bigRun.structuredContent.run.id, stepId: "fetch",
  result: { body: "x".repeat(9000), rows: Array.from({ length: 40 }, (_, i) => ({ i, note: "y".repeat(600) })) },
} });
const rec = bigDone.structuredContent.run.history.find(m => m.stepId === "fetch");
const stored = JSON.stringify(rec.output).length;
console.log(`9 kB string + 40 rows stored as ${stored} bytes; clipped:`,
  JSON.stringify(rec.output).includes("more characters") && JSON.stringify(rec.output).includes("more of 40"));

/* ---- logic.branches: fan out, then join ---- */
console.log("\n--- branches ---");
const br = await client.callTool({ name: "circuit_design", arguments: {
  name: "Three lookups then a summary",
  steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "all" }] },
    { id: "all", type: "logic.branches", title: "Gather everything", config: {},
      next: [{ port: "out", to: "a" }, { port: "out", to: "b" }, { port: "out", to: "c" },
             { port: "join", to: "sum" }] },
    { id: "a", type: "tool.call", title: "Threads", config: { tool: "Gmail:search_threads", arguments: {} }, next: [] },
    { id: "b", type: "tool.call", title: "Calendar", config: { tool: "Google_Calendar:list_events", arguments: {} }, next: [] },
    { id: "c", type: "tool.call", title: "Labels", config: { tool: "Gmail:label_thread", arguments: {} },
      writes: false, next: [] },
    { id: "sum", type: "note.say", title: "Summarise", config: { template: "Here is everything." }, next: [] },
  ],
} });
const brId = br.structuredContent.workflow.id;
console.log("chip says:", br.structuredContent.workflow.steps.find(s => s.id === "all").summary);
let b2 = await client.callTool({ name: "circuit_run", arguments: { workflowId: brId } });
const bid = b2.structuredContent.run.id;
let bd = b2.structuredContent.directive, order = [];
let g = 0;
while (bd && bd.act !== "done" && bd.act !== "blocked" && g++ < 12) {
  order.push(bd.stepId);
  b2 = await client.callTool({ name: "circuit_step", arguments: { runId: bid, stepId: bd.stepId, result: { ok: true } } });
  bd = b2.structuredContent.directive;
}
console.log("order:", order.join(" → "), "|", JSON.stringify(bd));
console.log("join fired after all three:", order.indexOf("sum") === order.length - 1 && order.includes("a") && order.includes("b") && order.includes("c"));

/* ---- together: several calls in one turn ---- */
console.log("\n--- together ---");
const tg = await client.callTool({ name: "circuit_design", arguments: {
  name: "Gather at once",
  steps: [
    { id: "go", type: "trigger.ask", title: "When I ask", config: {}, next: [{ port: "out", to: "all" }] },
    { id: "all", type: "logic.branches", title: "Gather everything", config: { together: true },
      next: [{ port: "out", to: "a" }, { port: "out", to: "b" }, { port: "out", to: "c" }, { port: "join", to: "sum" }] },
    { id: "a", type: "tool.call", title: "Threads", config: { tool: "Gmail:search_threads", arguments: {} }, next: [] },
    { id: "b", type: "tool.call", title: "Calendar", config: { tool: "Google_Calendar:list_events", arguments: {} }, next: [] },
    { id: "c", type: "tool.call", title: "Labels", config: { tool: "Gmail:label_thread", arguments: {} },
      onError: { do: "skip" }, next: [] },
    { id: "sum", type: "note.say", title: "Summarise", config: { template: "Done." }, next: [] },
  ],
} });
const tgId = tg.structuredContent.workflow.id;
console.log("chip says:", tg.structuredContent.workflow.steps.find(s => s.id === "all").summary);
let tr = await client.callTool({ name: "circuit_run", arguments: { workflowId: tgId } });
const trid = tr.structuredContent.run.id;
let tdd = tr.structuredContent.directive;
console.log("directive:", tdd.act, "with", tdd.calls?.length, "calls:", tdd.calls?.map(c => c.tool).join(", "));
tr = await client.callTool({ name: "circuit_step", arguments: { runId: trid, stepId: "all",
  results: { a: { threads: [1, 2] }, b: { events: [] } }, errors: { c: "label not found" } } });
console.log("after one turn:", JSON.stringify(tr.structuredContent.directive));
console.log("states:", tr.structuredContent.run.trace.filter(t => "abc".includes(t.stepId))
  .map(t => `${t.stepId}:${t.state}`).join(" "));

const badTogether = await client.callTool({ name: "circuit_design", arguments: {
  name: "Bad together",
  steps: [
    { id: "go", type: "trigger.ask", title: "x", config: {}, next: [{ port: "out", to: "all" }] },
    { id: "all", type: "logic.branches", title: "y", config: { together: true },
      next: [{ port: "out", to: "a" }, { port: "out", to: "b" }] },
    { id: "a", type: "tool.call", title: "z", config: { tool: "Gmail:reply", arguments: {} }, next: [{ port: "out", to: "b" }] },
    { id: "b", type: "model.write", title: "w", config: { instructions: "hi" }, next: [] },
  ],
} });
console.log("together guard:", badTogether.isError, "|", badTogether.content[0].text.split("\n")[1]?.trim());

await client.close();
console.log("\nSMOKE OK");
