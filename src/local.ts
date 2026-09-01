import { createServer } from "node:http";
import { handle } from "./http.js";

const port = Number(process.env.PORT ?? 8787);
createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  });
}).listen(port, () => {
  console.log(`Circuit on http://localhost:${port}  ·  MCP at /mcp`);
});
