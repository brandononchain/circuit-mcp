import type { Step, Workflow } from "./graph.js";
import { BY_TYPE, humanTool, portsOf, summarise, toolOf } from "./registry.js";
import { calledFlows, requiredTools, stepWrites } from "./tools.js";

/**
 * A workflow, rendered as a page you can keep.
 *
 * Circuit's boards live inside a conversation, and conversations end. This
 * writes a workflow out as a standalone HTML document with no scripts and no
 * external anything: the board is laid out server-side into absolute divs and
 * an SVG, so it draws identically forever, and the definition rides along in a
 * script tag. Read it as a reference, share it with someone, or hand the page
 * back to Circuit in a new conversation and get the working board again.
 *
 * Fixed chip heights are the trick that makes a server-side layout possible —
 * geometry has to be knowable without a browser to measure it in.
 */

const COL_W = 220, LANE_H = 150, PAD = 24, W = 178;
const H_PLAIN = 104, H_PORTS = 128;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

type Placed = Step & { x: number; y: number; h: number };

function place(wf: Workflow): Placed[] {
  return wf.steps.map((s) => {
    const pos = s.position ?? { col: 0, lane: 0 };
    const h = portsOf(s).length > 1 ? H_PORTS : H_PLAIN;
    return { ...s, x: PAD + pos.col * COL_W, y: PAD + pos.lane * LANE_H, h };
  });
}

/* Copper routing, same rules as the live board: 45 degree mitres, and a bus
   below the board for anything spanning more than two columns. */
function route(a: Placed, b: Placed, offset: number, busY: number): string {
  const x1 = a.x + W, y1 = a.y + a.h / 2 + offset;
  const x2 = b.x, y2 = b.y + b.h / 2;
  if (Math.abs(y2 - y1) < 1) return `M${x1} ${y1} L${x2} ${y2}`;
  const ch = (dy: number, dx: number) => Math.min(11, Math.abs(dy) / 2, Math.abs(dx));

  if (Math.abs(x2 - x1) > COL_W * 1.6) {
    const lead = 22, xv = x1 + lead;
    const c1 = ch(busY - y1, lead), s1 = busY > y1 ? 1 : -1;
    const xe = x2 - lead;
    const c2 = ch(y2 - busY, xe - xv), s2 = y2 > busY ? 1 : -1;
    return `M${x1} ${y1} L${xv - c1} ${y1} L${xv} ${y1 + s1 * c1} L${xv} ${busY - s1 * c1}` +
      ` L${xv + c1} ${busY} L${xe - c2} ${busY} L${xe} ${busY + s2 * c2} L${xe} ${y2 - s2 * c2}` +
      ` L${xe + c2} ${y2} L${x2} ${y2}`;
  }
  const xv = x1 + (x2 - x1) * 0.42;
  const c = ch(y2 - y1, Math.min(xv - x1, x2 - xv)), s = y2 > y1 ? 1 : -1;
  return `M${x1} ${y1} L${xv - c} ${y1} L${xv} ${y1 + s * c} L${xv} ${y2 - s * c} L${xv + c} ${y2} L${x2} ${y2}`;
}

function chip(s: Placed): string {
  const def = BY_TYPE.get(s.type);
  const ports = portsOf(s);
  const tool = toolOf(s);
  const [head, ...tail] = summarise(s).split(" · ");
  const summary = tail.length ? `<b>${esc(head)}</b> ${esc(tail.join(" · "))}` : esc(summarise(s));
  const dot = def?.actor === "user" ? "you" : def?.actor === "circuit" ? "circuit" : "claude";
  return `<div class="chip${ports.length > 1 ? " tall" : ""}${tool && stepWrites(s) ? " writes" : ""}"
   style="left:${s.x}px;top:${s.y}px">
  <div class="ch"><span class="p1 ${dot}"></span><span class="lab">${esc(def?.label ?? s.type)}</span></div>
  <div class="cb"><p class="ct">${esc(s.title)}</p><p class="cs">${summary}</p>
  ${ports.length > 1 ? `<div class="cp">${ports.map((p) => `<span>${esc(p)}</span>`).join("")}</div>` : ""}</div>
</div>`;
}

function board(wf: Workflow): string {
  const placed = place(wf);
  const byId = new Map(placed.map((s) => [s.id, s]));
  const maxCol = Math.max(0, ...wf.steps.map((s) => s.position?.col ?? 0));
  const maxLane = Math.max(0, ...wf.steps.map((s) => s.position?.lane ?? 0));
  const width = PAD * 2 + maxCol * COL_W + W;
  const busY = PAD + maxLane * LANE_H + H_PORTS + 34;
  const height = busY + 30;

  const wires: string[] = [];
  for (const s of placed) {
    const multi = s.next.length > 1;
    s.next.forEach((w, i) => {
      const b = byId.get(w.to);
      if (!b) return;
      const off = multi ? (i - (s.next.length - 1) / 2) * 16 : 0;
      const d = route(s, b, off, busY);
      wires.push(`<path class="trace" d="${d}"/>`);
      wires.push(`<circle class="pad" cx="${s.x + W}" cy="${s.y + s.h / 2 + off}" r="3"/>`);
      wires.push(`<circle class="pad" cx="${b.x}" cy="${b.y + b.h / 2}" r="3"/>`);
    });
  }

  return `<div class="boardwrap"><div class="board" style="width:${width}px;height:${height}px">
  <svg width="${width}" height="${height}" aria-hidden="true">${wires.join("")}</svg>
  ${placed.map(chip).join("\n  ")}
  <span class="silk">${esc(wf.id)} · rev ${wf.version}</span>
</div></div>`;
}

function prose(wf: Workflow): string {
  const order: Step[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const s = wf.steps.find((x) => x.id === id);
    if (!s) return;
    order.push(s);
    for (const e of s.next) walk(e.to);
  };
  walk(wf.entry);
  for (const s of wf.steps) walk(s.id);

  return order.map((s) => {
    const def = BY_TYPE.get(s.type);
    const wires = s.next.map((e) => (e.port === "out" ? e.to : `${e.port} → ${e.to}`)).join(", ");
    return `<li><b>${esc(s.title)}</b>
      <span class="verb">${esc(def?.label ?? s.type)}</span>
      <span class="det">${esc(summarise(s))}</span>
      ${wires ? `<span class="then">then ${esc(wires)}</span>` : `<span class="then">ends here</span>`}</li>`;
  }).join("\n");
}

export function exportHtml(wf: Workflow): string {
  const tools = [...new Set(requiredTools(wf.steps).map((t) => t.tool))];
  const services = [...new Set(tools.map((t) => t.split(/[:.]/)[0]))];
  const subs = calledFlows(wf);
  const json = JSON.stringify(
    {
      circuit: 1, name: wf.name, description: wf.description, entry: wf.entry,
      inputs: wf.inputs ?? [], schedule: wf.schedule ?? undefined, steps: wf.steps,
    },
    null, 1,
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(wf.name)}</title>
<style>
:root{--board:#EDEFEE;--grid:#D8DEDC;--chip:#FFF;--chip-2:#F4F7F6;--head:#EBEFEE;--edge:#C7D0CE;
 --trace:#AAB5B3;--accent:#8F6717;--ink:#0F1618;--ink-2:#485557;--ink-3:#768385;
 --panel:#FFF;--rule:#E2E7E6;--page:#F7F8F8}
@media(prefers-color-scheme:dark){:root{--board:#080B0C;--grid:#12191A;--chip:#141A1B;--chip-2:#1A2122;
 --head:#1A2122;--edge:#28312F;--trace:#41534E;--accent:#D2A24E;--ink:#E8EEEB;--ink-2:#9CAAA6;
 --ink-3:#6B7A77;--panel:#111718;--rule:#1E2626;--page:#0C1011}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);
 font:15px/1.6 "Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
code,pre,.mono{font-family:"Spline Sans Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:1040px;margin:0 auto;padding:0 22px}
/* the board is the widest thing here, so it gets the whole window */
.wide{max-width:1500px;margin:0 auto;padding:0 22px}
header{border-bottom:1px solid var(--rule);background:var(--panel);padding:30px 0 26px}
h1{margin:0 0 6px;font-size:25px;font-weight:700;letter-spacing:-.015em}
.desc{margin:0;color:var(--ink-2);font-size:15px;max-width:62ch}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.tag{font-size:11.5px;letter-spacing:.02em;color:var(--ink-2);background:var(--chip-2);
 border:1px solid var(--edge);border-radius:3px;padding:3px 9px}
.tag b{font-weight:600;color:var(--ink)}
h2{font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-3);
 font-weight:600;margin:0 0 14px}
section{padding:34px 0 0}
.boardwrap{overflow-x:auto;border:1px solid var(--edge);border-radius:6px;background:var(--board);
 background-image:radial-gradient(var(--grid) 1px,transparent 1px);background-size:22px 22px;
 background-position:8px 8px}
.board{position:relative}
.board svg{position:absolute;inset:0;overflow:visible}
.trace{fill:none;stroke:var(--trace);stroke-width:1.7;stroke-linejoin:miter}
.pad{fill:var(--board);stroke:var(--trace);stroke-width:1.6}
.silk{position:absolute;left:26px;bottom:10px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;
 color:var(--ink-3);opacity:.5;font-family:"Spline Sans Mono",monospace}
.chip{position:absolute;width:${W}px;height:${H_PLAIN}px;background:var(--chip);border:1px solid var(--edge);
 border-radius:3px;clip-path:polygon(9px 0,100% 0,100% 100%,0 100%,0 9px);overflow:hidden}
.chip.tall{height:${H_PORTS}px}
.ch{display:flex;align-items:center;gap:7px;padding:6px 9px 5px 12px;background:var(--head);
 border-bottom:1px solid var(--edge);min-height:24px}
.p1{width:5px;height:5px;border-radius:50%;background:var(--ink-3);flex:none}
.p1.you{background:var(--accent)}
.p1.claude{background:transparent;border:1.2px solid var(--ink-3)}
.p1.circuit{border-radius:1px;background:var(--ink-3);width:4.5px;height:4.5px}
.lab{font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;font-weight:600;color:var(--ink-3)}
.cb{padding:9px 12px}
.ct{margin:0 0 4px;font-size:14px;line-height:1.24;font-weight:600;letter-spacing:-.008em;
 display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cs{margin:0;font-size:12px;line-height:1.4;color:var(--ink-3);
 display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cs b{font-weight:500;color:var(--ink-2)}
.cp{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
.cp span{font-size:10px;padding:1px 6px;border-radius:2px;border:1px solid var(--edge);
 color:var(--ink-3);background:var(--chip-2);font-family:"Spline Sans Mono",monospace}
.chip.writes .ct:after{content:"";display:inline-block;width:5px;height:5px;margin-left:6px;
 border-radius:50%;background:var(--accent);vertical-align:middle;opacity:.75}
ol{margin:0;padding:0;list-style:none;counter-reset:s}
ol li{counter-increment:s;padding:11px 0 11px 42px;border-bottom:1px solid var(--rule);position:relative}
ol li:before{content:counter(s,decimal-leading-zero);position:absolute;left:0;top:12px;
 font-family:"Spline Sans Mono",monospace;font-size:11px;color:var(--accent)}
ol li b{font-weight:600}
.verb{font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;font-weight:600;color:var(--ink-3);
 margin-left:8px}
.det{display:block;color:var(--ink-2);font-size:13.5px;margin-top:2px}
.then{display:block;color:var(--ink-3);font-size:12px;margin-top:2px;
 font-family:"Spline Sans Mono",monospace}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-3);
 font-weight:600;padding:0 12px 7px 0;border-bottom:1px solid var(--rule)}
td{padding:9px 12px 9px 0;border-bottom:1px solid var(--rule);vertical-align:top;color:var(--ink-2)}
td:first-child{color:var(--ink);white-space:nowrap}
td code{font-size:12.5px}
pre.def{background:var(--panel);border:1px solid var(--edge);border-radius:5px;padding:14px 16px;
 overflow:auto;max-height:340px;font-size:11.5px;line-height:1.55;color:var(--ink-2);margin:0}
.restore{background:var(--panel);border:1px solid var(--edge);border-radius:5px;padding:16px 18px;
 margin-bottom:14px;font-size:14px;color:var(--ink-2)}
.restore b{color:var(--ink)}
footer{margin-top:44px;border-top:1px solid var(--rule);background:var(--panel);
 padding:18px 0 28px;font-size:12px;color:var(--ink-3)}
</style></head><body>

<header><div class="wrap">
  <h1>${esc(wf.name)}</h1>
  ${wf.description ? `<p class="desc">${esc(wf.description)}</p>` : ""}
  <div class="meta">
    <span class="tag"><b>${wf.steps.length}</b> steps</span>
    ${services.length ? `<span class="tag">needs <b>${esc(services.join(", "))}</b></span>` : ""}
    ${(wf.inputs ?? []).length ? `<span class="tag">asks for <b>${esc((wf.inputs ?? []).map((i) => i.name).join(", "))}</b></span>` : ""}
    ${wf.schedule?.cron ? `<span class="tag">runs <b>${esc(wf.schedule.note || wf.schedule.cron)}</b></span>` : ""}
    ${subs.length ? `<span class="tag">calls <b>${subs.length}</b> other workflow${subs.length === 1 ? "" : "s"}</span>` : ""}
    <span class="tag">saved from Circuit</span>
  </div>
</div></header>

<div class="wide"><section><h2>The board</h2>${board(wf)}</section></div>

<main class="wrap">

  <section><h2>What it does</h2><ol>${prose(wf)}</ol></section>

  ${tools.length ? `<section><h2>Connectors it needs</h2><table>
    <tr><th>Tool</th><th>Used by</th></tr>
    ${tools.map((t) => `<tr><td><code>${esc(t)}</code></td><td>${
      esc(requiredTools(wf.steps).filter((r) => r.tool === t).map((r) => r.stepId).join(", "))
    } — ${esc(humanTool(t))}</td></tr>`).join("")}
  </table></section>` : ""}

  ${(wf.inputs ?? []).length ? `<section><h2>What it asks for</h2><table>
    <tr><th>Input</th><th>What to put there</th></tr>
    ${(wf.inputs ?? []).map((i) => `<tr><td><code>${esc(i.name)}</code></td><td>${
      esc(i.description || "—")}${i.required === false ? " <em>(optional)</em>" : ""}</td></tr>`).join("")}
  </table></section>` : ""}

  <section><h2>Put it back to work</h2>
    ${subs.length ? `<div class="restore" style="border-color:var(--accent)"><b>This one calls other workflows.</b>
    It names ${esc(subs.join(", "))}, which are separate boards — save and restore those too, and rewire
    the <code>flow.call</code> steps to whatever ids they come back as.</div>` : ""}
    <div class="restore">Open any Claude conversation with the <b>Circuit</b> connector on, paste this
    page's link, and say <b>restore this workflow</b>. Claude reads the definition below and rebuilds
    the board. Nothing here is a secret — it is the shape of the automation, not an account or a key.</div>
    <pre class="def mono" id="circuit-workflow">${esc(json)}</pre>
  </section>
</main>

<footer><div class="wrap">Circuit · a workflow saved as a page. The definition above is the whole thing.</div></footer>

</body></html>`;
}

/** Pull a definition back out of an exported page, or accept the JSON directly. */
export function parseExport(source: string): unknown {
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  // the definition is shown to the reader and read back by the machine from the
  // same block, so there is only ever one copy of it in the page
  const tag = source.match(/id="circuit-workflow"[^>]*>([\s\S]*?)<\/(?:pre|script)>/);
  if (tag) {
    const raw = tag[1]
      .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  const loose = source.match(/\{[\s\S]*"steps"[\s\S]*\}/);
  if (loose) {
    try { return JSON.parse(loose[0]); } catch { /* fall through */ }
  }
  return null;
}
