import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "./http.js";

export default async function (req: IncomingMessage, res: ServerResponse) {
  try {
    await handle(req, res);
  } catch (e: any) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
}
