import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

/**
 * Circuit over stdio, for a local Claude Desktop or CLI config. Same server,
 * same tools; the workspace comes from the environment rather than a token,
 * because there is nobody else on the other end of a pipe.
 */
const workspace = process.env.CIRCUIT_WORKSPACE?.trim() || "local";
const server = buildServer(workspace);
await server.connect(new StdioServerTransport());
