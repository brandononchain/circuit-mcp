/* Exports a workflow, checks the page, and imports it straight back. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import { ok, eq, deepEq, includes, between, section, note, done } from "./expect.mjs";

const connect = async (name) => {
  const c = new Client({ name, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(process.env.URL ?? "http://localhost:8787/mcp")));
  return c;
};
const c = await connect("exp");

/* The connector surface a user with mail, calendar, chat and a base would have. */
const CONNECTOR_TOOLS = [
  "Gmail:search_threads", "Gmail:reply", "Gmail:label_thread", "Gmail:send_message",
  "Google_Calendar:list_events", "Slack:send_message",
  "Airtable:create_records_for_table", "Airtable:list_records_for_table",
];
await c.callTool({ name: "circuit_bind", arguments: { tools: CONNECTOR_TOOLS.map((name) => ({ name })) } });

const d = await c.callTool({ name: "circuit_design", arguments: {
  name: "Inbox triage & reply", description: "Sorts unread mail and drafts the easy replies.",
  inputs: [
    { name: "voice", description: "Whose voice the replies should sound like", required: true },
    { name: "max", description: "How many threads to work through in one pass", required: false, default: 5 },
  ],
  steps: [
    { id: "watch", type: "trigger.watch", title: "Look for new mail",
      config: { tool: "Gmail:search_threads", arguments: { q: "in:inbox is:unread -from:me" } }, next: [{ port: "out", to: "each" }] },
    { id: "each", type: "logic.each", title: "For each thread",
      config: { list: "trigger.threads", limit: 5 }, next: [{ port: "out", to: "intent" }, { port: "done", to: "recap" }] },
    { id: "intent", type: "model.classify", title: "Read what they want",
      config: { labels: ["sales", "scheduling", "other"], input: "item" },
      next: [{ port: "sales", to: "draft" }, { port: "scheduling", to: "slots" }, { port: "other", to: "label" }] },
    { id: "draft", type: "model.write", title: "Draft a sales reply",
      config: { instructions: "Answer the pricing question and offer a call.", voice: "{{input.voice}}", maxWords: 140 },
      next: [{ port: "out", to: "gate" }] },
    { id: "gate", type: "gate.approve", title: "Hold for my approval",
      config: { preview: "steps.draft.text", question: "Send this reply?" }, next: [{ port: "out", to: "send" }] },
    { id: "send", type: "tool.call", title: "Send the reply",
      config: { tool: "Gmail:reply", arguments: { thread_id: "{{item.id}}", body: "{{steps.draft.text}}" } }, next: [] },
    { id: "slots", type: "tool.call", title: "Find open slots",
      config: { tool: "Google_Calendar:list_events", arguments: { days: 5 } }, next: [] },
    { id: "label", type: "tool.call", title: "Label it for a human",
      config: { tool: "Gmail:label_thread", arguments: { thread_id: "{{item.id}}", label: "needs-human" } }, next: [] },
    { id: "recap", type: "note.say", title: "Tell me what happened",
      config: { template: "Went through the unread inbox." }, next: [] },
  ],
} });
const id = d.structuredContent.workflow.id;
const original = d.structuredContent.workflow;

section("the exported page");
const ex = await c.callTool({ name: "circuit_export", arguments: { workflowId: id } });
const html = ex.content[0].text.split("--- begin html ---\n")[1].split("\n--- end html ---")[0];
writeFileSync("exported.html", html);
note(`${html.length} bytes, roughly ${Math.round(html.length / 3.6)} tokens`);
between("page size in bytes", html.length, 4000, 60000);
ok("it is a standalone document", html.trimStart().startsWith("<!"), html.slice(0, 40));
ok("with no script tag", !/<script/i.test(html), "an exported board must render without JS");
includes("the definition travels in the page", html, 'id="circuit-workflow"');
includes("a person can read the name off it", html, "Inbox triage &amp; reply");

section("round trip");
const back = await c.callTool({ name: "circuit_import", arguments: { source: html } });
ok("the page imports back", !back.isError, back.content?.[0]?.text);
const wf = back.structuredContent.workflow;
eq("every step survived", wf.steps.length, original.steps.length);
deepEq("declared inputs survived", wf.inputs?.map((i) => i.name), ["voice", "max"]);
deepEq("the wiring survived",
  wf.steps.map((s) => [s.id, s.next.map((n) => `${n.port}->${n.to}`).join(",")]),
  original.steps.map((s) => [s.id, s.next.map((n) => `${n.port}->${n.to}`).join(",")]));
deepEq("the connector bound to each step survived",
  wf.steps.map((s) => s.tool ?? null),
  original.steps.map((s) => s.tool ?? null));
/* The returned board is a view with no config on it, so compare the stored JSON. */
const full = async (wid) => JSON.parse((await c.readResource({ uri: `circuit://workflow/${wid}` })).contents[0].text);
const [before, after] = [await full(id), await full(wf.id)];
deepEq("and so did every step config, field for field",
  after.steps.map((s) => [s.id, JSON.stringify(s.config)]),
  before.steps.map((s) => [s.id, JSON.stringify(s.config)]));
ok("configs are not empty, so that comparison means something",
  before.steps.filter((s) => Object.keys(s.config ?? {}).length).length >= 7,
  JSON.stringify(before.steps.map((s) => Object.keys(s.config ?? {}).length)));

section("input guards");
const missing = await c.callTool({ name: "circuit_run", arguments: { workflowId: id } });
ok("a run without a required input is refused", missing.isError === true, missing.content?.[0]?.text);
includes("and it names the input", missing.content[0].text, "voice");
const okRun = await c.callTool({ name: "circuit_run", arguments: { workflowId: id, input: { voice: "brandononchain" } } });
ok("supplying it lets the run start", !okRun.isError, okRun.content?.[0]?.text);
eq("with a real first directive", okRun.structuredContent.directive.act, "call_tool");

const junk = await c.callTool({ name: "circuit_import", arguments: { source: "<html>nothing here</html>" } });
ok("a page with no definition in it is rejected", junk.isError === true, junk.content?.[0]?.text);

await c.close();

section("every starter board imports cleanly");
const c2 = await connect("ex");
await c2.callTool({ name: "circuit_bind", arguments: { tools: CONNECTOR_TOOLS.map((name) => ({ name })) } });
for (const f of readdirSync("examples").filter((f) => f.endsWith(".json"))) {
  const r = await c2.callTool({ name: "circuit_import", arguments: { source: readFileSync(`examples/${f}`, "utf8") } });
  if (!ok(`examples/${f}`, !r.isError, r.content?.[0]?.text)) continue;
  const w = r.structuredContent.workflow;
  ok(`examples/${f} — every wire points at a real step`,
    w.steps.every((s) => s.next.every((n) => w.steps.some((t) => t.id === n.to))),
    JSON.stringify(w.steps.flatMap((s) => s.next.map((n) => `${s.id}->${n.to}`))));
  ok(`examples/${f} — every connector tool is one a real connector offers`,
    w.steps.every((s) => s.toolKnown !== false),
    `unknown: ${JSON.stringify(w.steps.filter((s) => s.toolKnown === false).map((s) => s.tool))}\n` +
    `bound for this check: ${CONNECTOR_TOOLS.join(", ")}`);
}
await c2.close();
done("export checks");
