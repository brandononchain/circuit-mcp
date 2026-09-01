/* A single-file stdio build, for `npx circuit-mcp` and local configs. */
import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/stdio.ts"],
  bundle: true, platform: "node", target: ["node20"], format: "esm",
  outfile: "dist/stdio.js", minify: true, legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("dist/stdio.js", 0o755);
console.log("dist/stdio.js built");
