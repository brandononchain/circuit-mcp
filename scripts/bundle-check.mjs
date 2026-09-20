/**
 * A bundle that builds is not a bundle that runs.
 *
 * `npm run build` exited 0 for weeks while every artefact it produced died on
 * first load with `Dynamic require of "events" is not supported`: pg is
 * CommonJS and reaches for `require` at load time even on the pure-JS path it
 * takes, and an ESM bundle has none. Nothing ever loaded the output, so nothing
 * noticed.
 *
 * This imports the built Vercel function and serves real requests through it.
 *
 * It has to be a real module on disk. `node -e` runs its argument as CommonJS
 * and leaks a global `require`, which the bundle's own shim happily picks up —
 * a broken bundle passes that way. Under a .mjs there is no global `require`,
 * which is exactly the situation on Vercel and behind Railway's proxy.
 */
import { createServer } from "node:http";
import { existsSync, readdirSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ok, eq, between, section, note, done } from "./expect.mjs";

const FN = new URL("../.vercel/output/functions/index.func/index.mjs", import.meta.url);

section("the vercel function bundle");

ok("the function was built", existsSync(FN), `missing ${FN.pathname} — run \`npm run build\` first`);

/**
 * A stale artefact passes every check below while the build that was meant to
 * produce it lies broken on the floor — which is the same "nobody loaded the
 * output" failure this script exists to catch, one step earlier. So date the
 * bundle against the sources it is built from.
 */
/* board.html and board.generated.ts live under src/ but are written by
 * scripts/build-app.mjs, so any other build target refreshes them and they
 * would date the bundle stale the moment `npm run build:server` ran. */
const GENERATED = new Set(["board.html", "board.generated.ts"]);
const newestSource = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((max, e) => {
  if (GENERATED.has(e.name)) return max;
  const path = `${dir}/${e.name}`;
  return Math.max(max, e.isDirectory() ? newestSource(path) : statSync(path).mtimeMs);
}, 0);
const built = existsSync(FN) ? statSync(FN).mtimeMs : 0;
const sources = Math.max(newestSource("src"), statSync("scripts/build-output.mjs").mtimeMs);
ok("and it is newer than the sources it is built from", built >= sources,
  `the bundle is ${((sources - built) / 1000).toFixed(1)}s older than the newest source — \`npm run build\` did not finish`);

/**
 * Selected before the import, so the Postgres store is the one the module graph
 * resolves. /health reads the environment and never opens a socket, so this
 * needs no database — it only has to prove pg's CommonJS graph survived the
 * bundler. Cleared again below so the request checks run on the memory store.
 */
process.env.DATABASE_URL = "postgres://circuit:circuit@127.0.0.1:5432/circuit_bundle_check";

/**
 * Caught rather than left to crash the process: an uncaught load error makes
 * Node print the offending line, and the offending line of a minified bundle is
 * the entire bundle. The message is the part worth reading.
 */
let fn = null, loadError = null;
try {
  fn = (await import(FN)).default;
} catch (e) {
  loadError = e;
}
if (!ok("it loads under ESM, with pg in the graph", typeof fn === "function",
  loadError ? `${loadError.message}\n     the createRequire banner in scripts/build-output.mjs is missing`
            : `default export was ${typeof fn}`)) {
  done("bundle checks");
  process.exit(1);
}

const server = createServer((req, res) => fn(req, res));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
note("serving the bundled function on", base);

/* ---- it answers, and it reports the backend it was pointed at ---- */
const health = await fetch(`${base}/health`);
eq("GET /health", health.status, 200);
const body = await health.json();
eq("it reports itself healthy", body.ok, true);
eq("DATABASE_URL selects the postgres store", body.storage, "postgres");
eq("and it calls that durable", body.durable, true);

delete process.env.DATABASE_URL;

/* ---- and it speaks MCP, not just HTTP ---- */
const client = new Client({ name: "bundle-audit", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
const tools = (await client.listTools()).tools;
between("tools over the bundled function", tools.length, 20, 40);

const board = await client.readResource({ uri: "ui://circuit/board.html" });
eq("the board ships inside the bundle", board.contents[0].mimeType, "text/html;profile=mcp-app");

await client.close();
server.close();
done("bundle checks");
