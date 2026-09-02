/* Runs the packaged stdio build the way a local Claude config would. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ok, eq, between, section, done } from "./expect.mjs";

section("the packaged stdio build");
const c = new Client({ name: "stdio-audit", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/stdio.js"] }));

const tools = (await c.listTools()).tools;
between("tools over stdio", tools.length, 20, 40);
ok("the same tool surface as over HTTP",
  tools.some((t) => t.name === "circuit_design") && tools.some((t) => t.name === "circuit_step"),
  tools.map((t) => t.name).join(", "));

const r = await c.readResource({ uri: "ui://circuit/board.html" });
eq("the board app ships inside the bundle", r.contents[0].mimeType, "text/html;profile=mcp-app");
between("board size in kB", +(r.contents[0].text.length / 1024).toFixed(1), 5, 400);

const cat = JSON.parse((await c.callTool({ name: "circuit_catalog", arguments: {} })).content[0].text);
eq("catalog step types", cat.length, 14);

/* A workflow designed over stdio has to come back from the same process. */
const made = await c.callTool({ name: "circuit_design", arguments: {
  name: "Stdio probe", steps: [{ id: "a", type: "trigger.ask", title: "when", config: {}, next: [] }] } });
ok("a board can be drawn over stdio", !made.isError, made.content?.[0]?.text);
const listed = await c.callTool({ name: "circuit_list", arguments: {} });
ok("and it is there when listed back", listed.content[0].text.includes("Stdio probe"), listed.content[0].text);

await c.close();
done("stdio checks");
