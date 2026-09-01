/* Vercel Build Output API v3 — one bundled Node function serving every route. */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

const FN = ".vercel/output/functions/index.func";
mkdirSync(FN, { recursive: true });

await build({
  entryPoints: ["src/vercel.ts"],
  bundle: true, platform: "node", target: ["node20"], format: "esm",
  outfile: `${FN}/index.mjs`, minify: true, legalComments: "none",
});

writeFileSync(`${FN}/.vc-config.json`, JSON.stringify({
  runtime: "nodejs20.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 60,
}, null, 2));
writeFileSync(`${FN}/package.json`, JSON.stringify({ type: "module" }));

writeFileSync(".vercel/output/config.json", JSON.stringify({
  version: 3,
  routes: [{ src: "/(.*)", dest: "/index" }],
  crons: [{ path: "/api/cron", schedule: "* * * * *" }],
}, null, 2));

console.log("build output ready");
