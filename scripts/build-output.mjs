/* Vercel Build Output API v3 — one bundled Node function serving every route. */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

const FN = ".vercel/output/functions/index.func";
mkdirSync(FN, { recursive: true });

await build({
  entryPoints: ["src/vercel.ts"],
  bundle: true, platform: "node", target: ["node20"], format: "esm",
  outfile: `${FN}/index.mjs`, minify: true, legalComments: "none",
  /**
   * pg loads its native accelerator by name at runtime. It is optional — the
   * pure-JS path is the default — but bundling it fails on the require, so
   * leave it external and let Node resolve it if it is ever installed.
   */
  external: ["pg-native"],
  /**
   * pg is CommonJS and reaches for `require` at load time even on the pure-JS
   * path it actually takes. An ESM bundle has none, so without this the
   * function compiles cleanly and dies on first load with
   * `Dynamic require of "events" is not supported`.
   */
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

writeFileSync(`${FN}/.vc-config.json`, JSON.stringify({
  runtime: "nodejs20.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 60,
}, null, 2));
writeFileSync(`${FN}/package.json`, JSON.stringify({ type: "module" }));

/**
 * No `crons` entry. Nothing has ever served /api/cron — Circuit does not fire
 * its own schedules, it asks you to create a real scheduled task and report the
 * id back with `circuit_scheduled`.
 */
writeFileSync(".vercel/output/config.json", JSON.stringify({
  version: 3,
  routes: [{ src: "/(.*)", dest: "/index" }],
}, null, 2));

console.log("build output ready");
