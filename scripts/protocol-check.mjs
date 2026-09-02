/* Everything Circuit claims over MCP, exercised and asserted. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ok, eq, includes, between, section, note, done } from "./expect.mjs";

const c = new Client({ name: "protocol-audit", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.URL ?? "http://localhost:8787/mcp")));

section("capabilities");
const caps = c.getServerCapabilities();
for (const k of ["tools", "resources", "prompts", "completions"]) ok(`declares ${k}`, !!caps[k], JSON.stringify(caps));
/**
 * Circuit is stateless, so it cannot push a listChanged notification to anyone.
 * Declaring the capability anyway would be a promise it silently breaks.
 */
eq("tools.listChanged is not claimed", caps.tools?.listChanged, undefined);
eq("resources.listChanged is not claimed", caps.resources?.listChanged, undefined);
eq("prompts.listChanged is not claimed", caps.prompts?.listChanged, undefined);

section("tools, prompts, resources");
between("tools", (await c.listTools()).tools.length, 20, 40);

const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
between("prompts", prompts.length, 3, 10);
for (const p of ["circuit-build", "circuit-open"]) includes("prompts", prompts, p);

const tpl = (await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
includes("resource templates", tpl, "circuit://workflow/{id}");

/* seed one so the listings and completions have something to find */
await c.callTool({ name: "circuit_design", arguments: {
  name: "Protocol probe", steps: [{ id: "a", type: "trigger.ask", title: "when", config: {}, next: [] }] } });

const listed = (await c.listResources()).resources;
includes("the board app is listed", listed.map((r) => r.uri), "ui://circuit/board.html");
const wfUri = listed.find((r) => r.uri.startsWith("circuit://workflow/"))?.uri;
ok("a saved workflow is listed as a resource", !!wfUri, JSON.stringify(listed.map((r) => r.uri)));

const read = await c.readResource({ uri: wfUri });
eq("it reads back as JSON", read.contents[0].mimeType, "application/json");
eq("with its steps intact", JSON.parse(read.contents[0].text).steps.length, 1);

section("completions");
const comp = await c.complete({
  ref: { type: "ref/resource", uri: "circuit://workflow/{id}" },
  argument: { name: "id", value: "wf_" },
});
ok("workflow ids are offered", comp.completion.values.length > 0, JSON.stringify(comp.completion));
ok("and they all match the prefix typed so far",
  comp.completion.values.every((v) => v.startsWith("wf_")), JSON.stringify(comp.completion.values.slice(0, 3)));

const pcomp = await c.complete({
  ref: { type: "ref/prompt", name: "circuit-open" },
  argument: { name: "workflowId", value: "wf_" },
});
ok("prompt arguments complete too", pcomp.completion.values.length > 0, JSON.stringify(pcomp.completion));

const nothing = await c.complete({
  ref: { type: "ref/resource", uri: "circuit://workflow/{id}" },
  argument: { name: "id", value: "zzz_no_such_prefix" },
});
eq("a prefix that matches nothing returns nothing", nothing.completion.values.length, 0);

section("prompts render");
const got = await c.getPrompt({ name: "circuit-build", arguments: { what: "triage my inbox" } });
ok("the build prompt renders", got.messages?.length > 0, JSON.stringify(got).slice(0, 120));
includes("and carries the user's words through", got.messages[0].content.text, "triage my inbox");

await c.close();
done("protocol checks");
