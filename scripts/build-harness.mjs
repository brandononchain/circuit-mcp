import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
const board = readFileSync("src/app/board.html", "utf8");
const fx = readFileSync("scripts/fixtures.json", "utf8");
const out = await build({
  entryPoints: ["scripts/harness.ts"], bundle: true, format: "iife", target: ["es2020"],
  write: false, legalComments: "none",
  define: { BOARD_HTML: JSON.stringify(board), FIXTURES: fx },
});
writeFileSync("scripts/harness.html", `<!doctype html><html><head><meta charset="utf-8"><title>Circuit harness</title>
<style>body{margin:0;background:#0C1011;color:#9CAAA6;font:13px ui-sans-serif,system-ui}
.hdr{padding:8px 14px;border-bottom:1px solid #1E2626;display:flex;gap:16px;align-items:center}
a{color:#D2A24E;text-decoration:none;margin-right:10px}
pre{margin:0;font:11px ui-monospace,monospace;color:#6B7A77;white-space:pre-wrap}
iframe{width:100%;border:0;height:820px;display:block;background:transparent}</style></head><body>
<div class="hdr"><b style="color:#E8EEEB">host harness</b>
<span><a href="?scene=build">build</a><a href="?scene=run">run</a><a href="?scene=held">held</a><a href="?scene=broken">unbound</a></span>
<span><a href="?scene=held&theme=light">light</a></span>
<pre id="hostlog"></pre></div>
<iframe id="view" sandbox="allow-scripts allow-same-origin"></iframe>
<script>${out.outputFiles[0].text}</script></body></html>`);
console.log("harness.html written");
