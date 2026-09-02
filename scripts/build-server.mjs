/* A single-file HTTP server build, for Docker, Railway, Fly, or any plain VM. */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/local.ts"],
  bundle: true, platform: "node", target: ["node20"], format: "esm",
  outfile: "dist/server.js", minify: true, legalComments: "none",
  /**
   * pg loads its native accelerator by name at runtime. It is optional — the
   * pure-JS path is the default — but bundling it fails on the require, so
   * leave it external and let Node resolve it if it is ever installed.
   */
  external: ["pg-native"],
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});
console.log("dist/server.js built");
