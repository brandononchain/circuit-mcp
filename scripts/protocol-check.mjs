/* Everything Circuit claims over MCP, exercised. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "protocol-audit", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.URL ?? "http://localhost:8787/mcp")));

console.log("capabilities   ", JSON.stringify(c.getServerCapabilities()));
console.log("tools          ", (await c.listTools()).tools.length);

const prompts = await c.listPrompts();
console.log("prompts        ", prompts.prompts.map(p => p.name).join(", "));

const res = await c.listResources();
console.log("resources      ", res.resources.map(r => r.uri).join(", ") || "(none listed yet)");
const tpl = await c.listResourceTemplates();
console.log("templates      ", tpl.resourceTemplates.map(t => t.uriTemplate).join(", "));

/* seed one so the listings and completions have something to find */
await c.callTool({ name: "circuit_design", arguments: {
  name: "Protocol probe", steps: [{ id: "a", type: "trigger.ask", title: "when", config: {}, next: [] }] } });

const res2 = await c.listResources();
const wfUri = res2.resources.find(r => r.uri.startsWith("circuit://workflow/"))?.uri;
console.log("workflow listed", wfUri);
const read = await c.readResource({ uri: wfUri });
console.log("workflow read  ", read.contents[0].mimeType, JSON.parse(read.contents[0].text).steps.length, "steps");

const comp = await c.complete({
  ref: { type: "ref/resource", uri: "circuit://workflow/{id}" },
  argument: { name: "id", value: "wf_" },
});
console.log("completion     ", comp.completion.values.length, "workflow ids offered");

const pcomp = await c.complete({
  ref: { type: "ref/prompt", name: "circuit-open" },
  argument: { name: "workflowId", value: "wf_" },
});
console.log("prompt arg     ", pcomp.completion.values.length, "offered");

const got = await c.getPrompt({ name: "circuit-build", arguments: { what: "triage my inbox" } });
console.log("prompt renders ", got.messages[0].content.text.slice(0, 58) + "…");

await c.close();
console.log("\nPROTOCOL OK");
