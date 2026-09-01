/* Runs the packaged stdio build the way a local Claude config would. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "stdio-audit", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/stdio.js"] }));
const t = await c.listTools();
console.log("stdio tools:", t.tools.length);
const r = await c.readResource({ uri: "ui://circuit/board.html" });
console.log("stdio app resource:", r.contents[0].mimeType, (r.contents[0].text.length/1024).toFixed(1)+" kB");
const cat = await c.callTool({ name: "circuit_catalog", arguments: {} });
console.log("stdio catalog types:", JSON.parse(cat.content[0].text).length);
await c.close();
