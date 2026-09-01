/* Captures real tool results from a running Circuit server for the host harness. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";

const c = new Client({ name: "fx", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp")));

const steps = [
  { id: "watch", type: "trigger.watch", title: "Look for new mail",
    config: { tool: "Gmail:search_threads", arguments: { q: "in:inbox is:unread -from:me", max_results: 5 } },
    next: [{ port: "out", to: "each" }] },
  { id: "each", type: "logic.each", title: "For each thread",
    config: { list: "trigger.threads", limit: 5 },
    next: [{ port: "out", to: "intent" }, { port: "done", to: "recap" }] },
  { id: "intent", type: "model.classify", title: "Read what they want",
    config: { labels: ["sales", "scheduling", "other"], input: "item", instructions: "Pricing questions are sales." },
    next: [{ port: "sales", to: "draft" }, { port: "scheduling", to: "slots" }, { port: "other", to: "label" }] },
  { id: "draft", type: "model.write", title: "Draft a sales reply",
    config: { instructions: "Answer the pricing question and offer a call.", voice: "brandononchain", context: ["item"], maxWords: 140 },
    next: [{ port: "out", to: "gate" }] },
  { id: "gate", type: "gate.approve", title: "Hold for my approval",
    config: { preview: "steps.draft.text", question: "Send this reply to Dana?" },
    next: [{ port: "out", to: "send" }] },
  { id: "send", type: "tool.call", title: "Send the reply",
    config: { tool: "Gmail:reply", arguments: { thread_id: "{{item.id}}", body: "{{steps.draft.text}}" } }, next: [] },
  { id: "slots", type: "tool.call", title: "Find open slots",
    config: { tool: "Google_Calendar:list_events", arguments: { days: 5 } }, next: [] },
  { id: "label", type: "tool.call", title: "Label it for a human",
    config: { tool: "Gmail:label_thread", arguments: { thread_id: "{{item.id}}", label: "needs-human" } }, next: [] },
  { id: "recap", type: "note.say", title: "Tell me what happened",
    config: { template: "Went through the unread inbox." }, next: [] },
];

await c.callTool({ name: "circuit_bind", arguments: { tools: [
  { name: "Gmail:search_threads" }, { name: "Gmail:reply" }, { name: "Gmail:label_thread" },
  { name: "Google_Calendar:list_events" },
] } });

const design = await c.callTool({ name: "circuit_design", arguments: {
  name: "Inbox triage & reply", description: "Sorts unread mail and drafts the easy replies.", steps } });
const wfId = design.structuredContent.workflow.id;

const threads = [
  { id: "t1", from: "dana@northbeam.co", subject: "pricing for a team of 40", snippet: "what would this cost us?" },
  { id: "t2", from: "sam@acme.io", subject: "quick call?", snippet: "any time thursday" },
];
const draft = "Hi Dana — thanks for reaching out.\n\nPricing scales with volume, so the honest answer is a range: teams around your size usually land between $2k and $4k a month. Happy to walk you through where you'd sit — are you free Thursday afternoon?\n\nBrandon";

let res = await c.callTool({ name: "circuit_run", arguments: { workflowId: wfId, mode: "live" } });
const runId = res.structuredContent.run.id;
let d = res.structuredContent.directive;
let held = null, guard = 0;
while (d && d.act !== "done" && d.act !== "blocked" && guard++ < 30) {
  let result;
  if (d.stepId === "watch") result = { threads };
  else if (d.act === "think" && d.task === "classify") result = { label: "sales", why: "asking about price" };
  else if (d.act === "think" && d.task === "write") result = { text: draft };
  else if (d.act === "ask") { if (!held) held = res; result = { decision: "approve" }; }
  else result = { ok: true, id: "m_" + guard };
  res = await c.callTool({ name: "circuit_step", arguments: { runId, stepId: d.stepId, result } });
  d = res.structuredContent.directive;
}

/* a board with one connector that isn't there, for the "unbound" scene */
const broken = await c.callTool({ name: "circuit_design", arguments: {
  name: "Weekly digest", description: "Rounds up the week and posts it.",
  steps: [
    { id: "friday", type: "trigger.schedule", title: "Every Friday at five",
      config: { cron: "0 22 * * 5", note: "Fridays at 5pm" }, next: [{ port: "out", to: "gather" }] },
    { id: "gather", type: "tool.call", title: "Pull the week's threads",
      config: { tool: "Gmail:search_threads", arguments: { q: "newer_than:7d" } }, next: [{ port: "out", to: "digest" }] },
    { id: "digest", type: "model.write", title: "Write the digest",
      config: { instructions: "Summarise the week in five bullets.", maxWords: 180 }, next: [{ port: "out", to: "post" }] },
    { id: "post", type: "tool.call", title: "Post it to the team",
      config: { tool: "Slack:post_msg", arguments: { channel: "#general", text: "{{steps.digest.text}}" } }, next: [] },
  ],
} });

writeFileSync("scripts/fixtures.json", JSON.stringify({
  design, held: held ?? res, run: res, afterMove: design, broken,
}, null, 1));
console.log("fixtures written · workflow", wfId, "· final", JSON.stringify(d));
await c.close();
