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

await client.close();
console.log("\nSMOKE OK");
