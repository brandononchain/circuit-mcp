/* Exports a workflow, checks the page, and imports it straight back. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";
const c = new Client({ name: "exp", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.URL ?? "http://localhost:8787/mcp")));
await c.callTool({ name: "circuit_bind", arguments: { tools: [
  { name: "Gmail:search_threads" }, { name: "Gmail:reply" }, { name: "Gmail:label_thread" },
  { name: "Google_Calendar:list_events" } ] } });
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
const ex = await c.callTool({ name: "circuit_export", arguments: { workflowId: id } });
const html = ex.content[0].text.split("--- begin html ---\n")[1].split("\n--- end html ---")[0];
writeFileSync("exported.html", html);
console.log("page bytes:", html.length, "| roughly", Math.round(html.length / 3.6), "tokens");
const back = await c.callTool({ name: "circuit_import", arguments: { source: html } });
console.log("\n--- import ---\n" + back.content[0].text.split("\n").slice(0, 4).join("\n"));
console.log("inputs survived:", JSON.stringify(back.structuredContent.workflow.inputs?.map(i => i.name)));
const missing = await c.callTool({ name: "circuit_run", arguments: { workflowId: id } });
console.log("\nrequired input guard:", missing.isError, "|", missing.content[0].text.split("\n")[0]);
const okRun = await c.callTool({ name: "circuit_run", arguments: { workflowId: id, input: { voice: "brandononchain" } } });
console.log("with input:", !okRun.isError, "|", okRun.structuredContent.directive.act);
const junk = await c.callTool({ name: "circuit_import", arguments: { source: "<html>nothing here</html>" } });
console.log("junk guard:", junk.isError);
await c.close();

/* every starter board must import cleanly */
import { readdirSync, readFileSync } from "node:fs";
const c2 = new Client({ name: "ex", version: "1" });
await c2.connect(new StreamableHTTPClientTransport(new URL(process.env.URL ?? "http://localhost:8787/mcp")));
for (const f of readdirSync("examples").filter((f) => f.endsWith(".json"))) {
  const r = await c2.callTool({ name: "circuit_import", arguments: { source: readFileSync(`examples/${f}`, "utf8") } });
  const wf = r.structuredContent?.workflow;
  console.log(`${f.padEnd(22)} ${r.isError ? "REJECTED: " + r.content[0].text.split("\n")[0] : `ok — ${wf.steps.length} steps, asks for ${(wf.inputs ?? []).map(i => i.name).join(", ") || "nothing"}`}`);
}
await c2.close();
