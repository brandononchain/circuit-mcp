/* A single-file stdio build, for `npx circuit-mcp` and local configs. */
import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/stdio.ts"],
  bundle: true, platform: "node", target: ["node20"], format: "esm",
  outfile: "dist/stdio.js", minify: true, legalComments: "none",
  /* Optional native accelerator for pg; see scripts/build-server.mjs. */
  external: ["pg-native"],
  /**
   * The shebang has to stay the first line, so the createRequire shim rides
   * directly behind it. Without the shim pg's CommonJS `require` finds nothing
   * in an ESM bundle and the binary dies on launch with
   * `Dynamic require of "events" is not supported`.
   */
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});
chmodSync("dist/stdio.js", 0o755);
console.log("dist/stdio.js built");
