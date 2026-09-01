import { AppClient } from "./bridge.js";

/* ------------------------------------------------------------------ types */
type Wire = { port: string; to: string };
type Chip = {
  id: string; type: string; kind: string; label?: string; actor?: string;
  title: string; summary: string; config?: Record<string, unknown>;
  tool?: string | null; toolKnown?: boolean | null; writes?: boolean;
  onError?: { do: string; attempts?: number; port?: string };
  ports: string[]; next: Wire[]; enabled: boolean;
  position: { col: number; lane: number };
};
type Directive = {
  act: string; stepId?: string; title?: string; tool?: string; question?: string;
  preview?: string; text?: string; reason?: string; summary?: string;
};
type Trace = { stepId: string; state: string; port?: string; summary?: string; error?: string; attempts?: number };
type Moment = {
  stepId: string; at: string; state: string; port?: string;
  summary?: string; error?: string; input?: unknown; output?: unknown; item?: unknown;
};
type Board = {
  workflow: {
    id: string; name: string; description: string; status: string; entry: string;
    steps: Chip[]; inputs?: { name: string; description?: string; required?: boolean }[];
    schedule?: { cron: string; note?: string; taskId?: string } | null;
    lastRunAt?: string | null;
  };
  run: {
    id: string; status: string; mode: string; trace: Trace[];
    awaiting: { stepId: string; act: string } | null; failedAt?: string | null;
    history?: Moment[];
  } | null;
  storage?: string;
  phase?: string;
  tools?: { bound: boolean; missing: { stepId: string; tool: string; suggestion?: string }[]; present: string[] };
  directive?: Directive | null;
};

const COL_W = 220, LANE_H = 152, PAD_X = 24, PAD_Y = 22, NODE_W = 180;

const app = new AppClient(
  { name: "Circuit board", version: "0.1.0", title: "Circuit" },
  { autoResize: true },
);

let board: Board | null = null;
let building: Partial<Chip>[] = [];
let selected: string | null = null;
let fitted = true;
/** whether the board is wider than the panel it is sitting in */
let overflows = false;
/** the CSS scale the canvas is currently drawn at (1 unless fitted down) */
let scale = 1;
let wiring: { from: string; port: string; x: number; y: number } | null = null;
/** index into run.history while replaying, or null when showing the final state */
let replayAt: number | null = null;
let logLines: string[] = [];
let consoleState = { label: "circuit", sub: "idle", busy: false };

/* ------------------------------------------------------------------ theme */
function applyTheme() {
  const t = app.hostContext().theme;
  document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
}
app.h.onhostcontextchanged = () => { applyTheme(); };

/* ------------------------------------------------------- host -> this app */
app.h.ontoolinputpartial = (p: any) => {
  const args: any = p.arguments ?? {};
  const steps: any[] = Array.isArray(args.steps) ? args.steps : [];
  const usable = steps.filter((s) => s && s.id && s.type);
  if (usable.length !== building.length || args.name) {
    building = usable;
    consoleState = { label: "circuit_design", sub: `streaming · ${usable.length} step${usable.length === 1 ? "" : "s"}`, busy: true };
    logLines = usable.map((s: any) => {
      const detail = s.config?.tool ?? (Array.isArray(s.config?.labels) ? s.config.labels.join(" | ") : "");
      return `${pad(s.id, 12)}${pad(s.type, 18)}${detail ?? ""}`;
    });
    renderBuilding(String(args.name ?? "New workflow"));
  }
};

app.h.ontoolinput = () => { /* the result carries the real board */ };

app.h.ontoolresult = (p: any) => {
  const props =
    p?.result?.structuredContent ??
    p?.result?._meta?.["ui/props"] ??
    p?.structuredContent ??
    p?._meta?.["ui/props"];
  if (!props || !props.workflow) return;
  board = props as Board;
  building = [];
  replayAt = null;
  const wf = board.workflow;
  const run = board.run;
  if (run) {
    consoleState = {
      label: run.id,
      sub: `${run.mode} · ${run.status.replace(/_/g, " ")}`,
      busy: run.status === "running" || run.status === "awaiting_approval",
    };
    logLines = traceLog(run.trace);
    const d = board.directive;
    if (d && d.act !== "done" && d.act !== "blocked") {
      logLines.push(`${pad("→ next", 14)}${pad(d.act, 10)}${d.tool ?? d.title ?? ""}`);
    }
    // a blocked run already has the panel below; repeating the reason here just
    // runs off the edge of the console
    if (d?.act === "blocked" && !run.failedAt) {
      logLines.push(`${pad("✕", 14)}${first(d.reason ?? "blocked")}`);
    }
    if (d?.act === "done") logLines.push(`${pad("✓", 14)}${d.summary ?? "done"}`);
  } else {
    consoleState = { label: wf.name, sub: `${wf.steps.length} steps · ${wf.status}`, busy: false };
    const tools = board.tools;
    if (tools?.missing?.length) {
      consoleState = { label: "connectors", sub: `${tools.missing.length} not connected`, busy: false };
      logLines = tools.missing.map((m) =>
        `${pad(m.stepId, 14)}${m.tool}${m.suggestion ? `  \u2192 try ${m.suggestion}` : ""}`);
    } else if (tools && !tools.bound && tools.present.length) {
      consoleState = { label: wf.name, sub: "connectors unchecked", busy: false };
      logLines = ["needs these connector tools:", ...tools.present.map((t) => `  ${t}`)];
    } else if (wf.status === "armed" && wf.schedule && !wf.schedule.taskId) {
      // armed on a schedule with nothing actually calling it is the quiet failure
      consoleState = { label: "not scheduled yet", sub: "nothing will call this", busy: false };
      logLines = [
        `armed on    ${wf.schedule.cron}${wf.schedule.note ? `  (${wf.schedule.note})` : ""}`,
        `but         no scheduled task has been recorded`,
        `so          it will not fire until one is created`,
      ];
    } else {
      const needs = tools?.present ?? [];
      const asks = (wf.inputs ?? []).map((i) => i.name);
      logLines = [
        ...(wf.schedule?.taskId ? [`runs on     ${wf.schedule.cron}  via ${wf.schedule.taskId}`] : []),
        ...(needs.length ? [`connectors  ${needs.join(", ")}`] : []),
        ...(asks.length ? [`asks for    ${asks.join(", ")}`] : []),
        `steps       ${wf.steps.length}, starting at ${wf.entry}`,
        ...(wf.lastRunAt ? [`last ran    ${wf.lastRunAt.replace("T", " ").slice(0, 16)}`] : []),
      ];
      consoleState = {
        label: wf.name,
        sub: tools?.bound ? "every connector checks out" : `${wf.status === "armed" ? "armed" : "draft"}`,
        busy: false,
      };
    }
  }
  render();
};

/* ---------------------------------------------------------------- helpers */
/** first sentence, so a long reason does not run off the console */
const first = (s: string) => {
  const cut = s.split(/(?<=\.)\s/)[0];
  return cut.length > 96 ? cut.slice(0, 95) + "\u2026" : cut;
};
const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, Math.max(n, s.length + 1));
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const el = (id: string) => document.getElementById(id);

/** The interesting half of a trace: what actually ran, not what was bypassed. */
function traceLog(trace: Trace[]): string[] {
  const ran = trace.filter((t) => t.state !== "idle" && t.state !== "skipped");
  const lines = (ran.length ? ran : trace)
    .map((t) => `${pad(t.stepId, 14)}${pad(t.state, 10)}${t.summary ?? t.error ?? ""}`);
  const skipped = trace.filter((t) => t.state === "skipped").length;
  if (skipped) lines.push(`${pad("", 14)}${pad("", 10)}${skipped} step${skipped > 1 ? "s" : ""} not taken`);
  return lines;
}

const history = () => board?.run?.history ?? [];
const replaying = () => replayAt !== null && history().length > 0;

/**
 * While replaying, the board shows the run as it stood at that moment rather
 * than as it ended — anything that had not happened yet is simply idle.
 */
function stateOf(id: string): string {
  if (replaying()) {
    const upto = history().slice(0, replayAt! + 1).filter((h) => h.stepId === id);
    const last = upto[upto.length - 1];
    if (!last) return "idle";
    return history()[replayAt!].stepId === id ? "running" : last.state;
  }
  const t = board?.run?.trace.find((x) => x.stepId === id);
  return t?.state ?? "idle";
}

function portAt(id: string): string | undefined {
  if (!replaying()) return board?.run?.trace.find((t) => t.stepId === id)?.port;
  const upto = history().slice(0, replayAt! + 1).filter((h) => h.stepId === id && h.port);
  return upto[upto.length - 1]?.port;
}
const STATE_WORD: Record<string, string> = {
  running: "running", done: "ran", skipped: "not taken",
  held: "waiting on you", failed: "failed", retrying: "trying again", idle: "",
};

/** Nothing at all before a run — an "IDLE" badge on every chip is just noise. */
function labelOf(id: string): string {
  if (replaying()) {
    const upto = history().slice(0, replayAt! + 1).filter((h) => h.stepId === id);
    const last = upto[upto.length - 1];
    if (!last) return "";
    const s = last.summary || STATE_WORD[last.state] || last.state;
    return s.length > 20 ? s.slice(0, 19) + "\u2026" : s;
  }
  const t = board?.run?.trace.find((x) => x.stepId === id);
  if (!t || t.state === "idle") return "";
  const s = t.state === "failed" ? (t.summary || "failed")
    : t.summary || STATE_WORD[t.state] || t.state;
  return s.length > 20 ? s.slice(0, 19) + "\u2026" : s;
}

/* ----------------------------------------------------------------- render */
function shell(inner: string, extra = "") {
  const wf = board?.workflow;
  const live = wf?.status === "armed";
  const run = board?.run;
  const meta = run
    ? `${run.mode === "test" ? "rehearsal" : "live"} \u00b7 ${run.status.replace(/_/g, " ")}`
    : wf ? `${wf.status === "armed" ? "armed" : "draft"} \u00b7 ${wf.steps.length} steps` : "drawing";
  return `
  <div class="frame">
    <div class="bar">
      <span class="dot ${live ? "live" : ""}"></span>
      <span class="name" id="wfname" ${wf ? 'contenteditable="true" spellcheck="false"' : ""}>${esc(wf?.name ?? "Drawing\u2026")}</span>
      <span class="lab num" id="wfmeta">${esc(meta)}</span>
      <span class="sp"></span>
      ${history().length ? `<button id="btn-replay" class="ghost">${replaying() ? "Latest" : "Replay"}</button>` : ""}
      ${wf && overflows ? `<button id="btn-fit" class="ghost">${fitted ? "Actual size" : "Fit"}</button>` : ""}
      ${wf ? `<button id="btn-full" class="ghost">Full screen</button>` : ""}
      ${wf?.description ? `<span class="why">${esc(wf.description)}</span>` : ""}
    </div>
    <div class="scroll" id="scroll"><div class="canvas" id="canvas">
      <svg id="traces" aria-hidden="true"></svg>
      <span class="silk mono">${wf ? `${esc(wf.id)}` : "circuit"}</span>
      ${inner}
    </div></div>
    <div class="console">
      <div class="rail">
        <div style="display:flex;align-items:center;gap:7px">
          <span class="spark ${consoleState.busy ? "" : "idle"}"></span>
          <span class="${/^(run|wf)_/.test(consoleState.label) ? "railid mono" : "lab"}">${esc(consoleState.label)}</span>
        </div>
        <span class="sub">${esc(consoleState.sub)}</span>
      </div>
      ${replaying() ? replayHtml()
        : selected ? inspectorHtml()
        : `<pre class="log mono" id="log">${logLines.slice(-4).map(esc).join("\n")}${consoleState.busy ? '<span class="caret"></span>' : ""}</pre>`}
    </div>
    ${extra}
  </div>`;
}

/**
 * The scrubber. A finished run already knows what every step was handed and what
 * came back, so stepping through it is the closest thing to watching it happen.
 */
function replayHtml() {
  const h = history();
  const i = Math.max(0, Math.min(replayAt ?? 0, h.length - 1));
  const m = h[i];
  const step = board?.workflow.steps.find((s) => s.id === m.stepId);
  const time = m.at ? new Date(m.at).toLocaleTimeString(undefined, { hour12: false }) : "";
  const body = (v: unknown) =>
    v === undefined ? "<span style=\"opacity:.5\">nothing</span>"
      : esc(typeof v === "string" ? v : JSON.stringify(v, null, 1));

  const ticks = h.map((x, n) =>
    `<i class="${x.state === "failed" ? "fail" : n === i ? "at" : n < i ? "past" : ""}" data-n="${n}"></i>`).join("");

  return `<div class="replay">
    <div class="replay-head">
      <b>${esc(step?.title ?? m.stepId)}</b>
      <span class="when mono">${esc(m.summary ?? m.state)}${time ? ` \u00b7 ${time}` : ""}</span>
      <span class="sp"></span>
      <span class="when mono num">${i + 1} / ${h.length}</span>
      <button class="step-btn" id="rw" ${i === 0 ? "disabled" : ""}>\u2190</button>
      <button class="step-btn" id="ff" ${i === h.length - 1 ? "disabled" : ""}>\u2192</button>
    </div>
    <div class="scrub" id="scrub">${ticks}</div>
    <div class="io">
      <div><dt>given</dt><pre class="mono">${body(m.item !== undefined && m.input === undefined ? m.item : m.input)}</pre></div>
      <div><dt>${m.error ? "error" : "returned"}</dt><pre class="mono${m.error ? " err" : ""}">${
        m.error ? esc(m.error) : body(m.output)}</pre></div>
    </div>
  </div>`;
}

/** Clicking a chip swaps the log for what that step actually is. */
function inspectorHtml() {
  const c = board?.workflow.steps.find((s) => s.id === selected);
  if (!c) return `<pre class="log mono"></pre>`;
  const t = board?.run?.trace.find((x) => x.stepId === selected);
  const who = { circuit: "Circuit, on its own", claude: "Claude", user: "you" }[c.actor ?? "claude"] ?? "Claude";
  const cfg = JSON.stringify(c.config ?? {}, null, 1).replace(/\n\s*/g, " ");
  return `<div class="insp"><dl>
    <dt>step</dt><dd><code>${esc(c.id)}</code> \u00b7 <code>${esc(c.type)}</code></dd>
    <dt>done by</dt><dd>${esc(who)}</dd>
    ${c.ports.length > 1 ? `<dt>ports</dt><dd><code>${c.ports.map(esc).join(" \u00b7 ")}</code></dd>` : ""}
    ${c.tool ? `<dt>connector</dt><dd><code>${esc(c.tool)}</code>${
      c.toolKnown === false ? ' \u00b7 <span class="warn">not in your tool list</span>'
      : c.toolKnown === true ? ' \u00b7 checked' : ""}</dd>` : ""}
    ${c.tool ? `<dt>effect</dt><dd>${c.writes
      ? "writes \u2014 a test run shows it instead of calling it"
      : "reads only"}</dd>` : ""}
    ${c.onError ? `<dt>on failure</dt><dd>${esc(FAILURE[c.onError.do] ?? c.onError.do)}</dd>` : ""}
    ${t && t.state !== "idle" ? `<dt>last run</dt><dd>${esc(t.summary || t.state)}${
      t.error ? `<pre class="warn">${esc(t.error)}</pre>` : ""}</dd>` : ""}
    <dt>settings</dt><dd><pre>${esc(cfg === "{}" ? "nothing to configure" : cfg)}</pre></dd>
  </dl></div>`;
}

function chipHtml(c: Partial<Chip>, i: number, state = "idle", label = "") {
  const pos = c.position ?? { col: i, lane: 0 };
  const x = PAD_X + pos.col * COL_W, y = PAD_Y + pos.lane * LANE_H;

  const all = c.ports ?? [];
  const lit = portAt(c.id!);
  const shown = all.length > 3 ? [...all.slice(0, 2), ...(lit && !all.slice(0, 2).includes(lit) ? [lit] : [])] : all;
  const ports = all.length > 1
    ? `<div class="no">${shown.map((p) =>
        `<span class="op mono ${lit === p ? "lit" : ""}">${esc(portName(c.type ?? "", p))}</span>`).join("")}${
        all.length > shown.length ? `<span class="op mono">+${all.length - shown.length}</span>` : ""}</div>`
    : "";

  const actor = c.actor ?? "claude";
  const waiting = board?.run?.awaiting?.stepId === c.id;
  const unbound = c.toolKnown === false;
  const cls = ["node", state === "idle" ? "" : state, waiting ? "waiting" : "",
    unbound ? "unbound" : "", c.writes ? "writes" : "", c.enabled === false ? "muted" : "",
    selected === c.id ? "sel" : ""].join(" ");

  // "Gmail · search threads" reads better with the service carrying the weight
  const [head, ...tail] = String(c.summary ?? "").split(" · ");
  const summary = tail.length
    ? `<b>${esc(head)}</b> ${esc(tail.join(" · "))}`
    : esc(c.summary ?? "");

  return `<div class="${cls}" data-id="${esc(c.id!)}" style="left:${x}px;top:${y}px">
    <div class="nh"><span class="p1 by-${esc(actor)}" title="${esc(DOES[actor] ?? "")}"></span>
      <span class="lab nk">${esc(c.label ?? kindOf(c.type ?? ""))}</span>
      ${unbound ? `<span class="ns bad">not connected</span>`
        : label ? `<span class="ns">${esc(label)}</span>` : ""}</div>
    <div class="nb"><p class="nt">${esc(c.title ?? c.id)}</p>
      <p class="nc">${summary}</p>${ports}</div>
  </div>`;
}

/** "out"/"done" mean nothing to a reader; on a loop they mean these. */
const PORT_NAMES: Record<string, Record<string, string>> = {
  "logic.each": { out: "each", done: "then" },
};
const portName = (type: string, port: string) => PORT_NAMES[type]?.[port] ?? port;

const ACTORS: Record<string, string> = {
  "trigger.ask": "user", "trigger.schedule": "user", "gate.approve": "user",
  "logic.filter": "circuit", "logic.branch": "circuit", "logic.each": "circuit",
};

const FAILURE: Record<string, string> = {
  stop: "stops the whole run", skip: "ends this path, the rest carries on",
  retry: "hands Claude the same directive again", route: "leaves by the error port",
};

const DOES: Record<string, string> = {
  circuit: "Circuit settles this one on its own",
  claude: "Claude does this",
  user: "this one is yours",
};

/** Mirrors registry.ts so a chip streaming in already says what it does. */
const LABELS: Record<string, string> = {
  "trigger.ask": "when", "trigger.schedule": "every", "trigger.watch": "watch",
  "tool.call": "do",
  "model.classify": "decide", "model.write": "write", "model.extract": "read",
  "logic.filter": "only if", "logic.branch": "route", "logic.each": "for each",
  "gate.approve": "ask you", "note.say": "report",
};
function kindOf(type: string) {
  return LABELS[type] ?? (type ?? "").split(".")[0] ?? "step";
}

function renderBuilding(name: string) {
  const chips = building.map((s, i) => ({
    ...s,
    position: s.position ?? { col: i, lane: 0 },
    kind: kindOf(s.type ?? ""),
    tool: (s as any).config?.tool ?? null,
    actor: ACTORS[s.type ?? ""] ?? "claude",
    summary: (s as any).summary ?? "",
  }));
  const html = chips.map((c, i) => chipHtml(c, i)).join("");
  document.getElementById("root")!.innerHTML = shell(html);
  const meta = el("wfmeta"); if (meta) meta.textContent = `${chips.length} steps`;
  const n = el("wfname"); if (n) n.textContent = name;
  sizeCanvas(chips as Chip[]);
  requestAnimationFrame(() => document.querySelectorAll(".node").forEach((n) => n.classList.add("in")));
  wire();
}

function render() {
  if (!board) return;
  const wf = board.workflow;
  const chips = wf.steps.map((c, i) => chipHtml(c, i, stateOf(c.id), labelOf(c.id))).join("");
  const d = board.directive;
  const gate = d?.act === "ask" ? gateHtml(d)
    : board.run?.failedAt ? troubleHtml(board.run.failedAt) : "";
  document.getElementById("root")!.innerHTML = shell(chips, gate);
  sizeCanvas(wf.steps);
  drawTraces(wf.steps);
  drawHandles(wf.steps);
  requestAnimationFrame(() => document.querySelectorAll(".node").forEach((n) => n.classList.add("in")));
  wire();
}

function gateHtml(d: Directive) {
  const hasDraft = (d.preview ?? "").length > 0;
  return `<div class="gate">
    <h4>${esc(d.question || "Go ahead?")}</h4>
    <p class="q mono">${esc(d.title ?? "")} · ${esc(d.stepId ?? "")}</p>
    ${hasDraft ? `<textarea id="gate-text" spellcheck="true">${esc(d.preview!)}</textarea>` : ""}
    <div class="row">
      <button class="primary" id="gate-ok">${hasDraft ? "Approve &amp; continue" : "Approve"}</button>
      <button id="gate-no">Reject</button>
      <span class="sub mono">${hasDraft ? "Edits here are what actually goes out." : "The run continues from this step."}</span>
    </div>
  </div>`;
}

/** A failed run is a fork in the road, so give it the two roads. */
function troubleHtml(stepId: string) {
  const t = board?.run?.trace.find((x) => x.stepId === stepId);
  const step = board?.workflow.steps.find((x) => x.id === stepId);
  return `<div class="gate trouble">
    <h4>${esc(step?.title ?? stepId)} didn\u2019t work</h4>
    <p class="q">${esc(t?.error ?? "No detail was reported.")}</p>
    <div class="row">
      <button class="primary" id="fix-retry">Try it again</button>
      <button id="fix-skip">Skip this step</button>
      <span class="sub">Everything before this already ran \u2014 picking up is not the same as starting over.</span>
    </div>
  </div>`;
}

/** true when some wire has to take the bus below the board */
function needsBus(steps: Chip[]): boolean {
  const col = new Map(steps.map((s) => [s.id, s.position?.col ?? 0]));
  return steps.some((s) => s.next.some((w) => Math.abs((col.get(w.to) ?? 0) - (col.get(s.id) ?? 0)) > 1.6));
}

function sizeCanvas(steps: Chip[]) {
  const maxCol = Math.max(0, ...steps.map((s) => s.position?.col ?? 0));
  const maxLane = Math.max(0, ...steps.map((s) => s.position?.lane ?? 0));
  const c = el("canvas")!;
  const w = PAD_X * 2 + maxCol * COL_W + NODE_W;
  // only leave room under the board when something actually runs down there
  const h = PAD_Y * 2 + maxLane * LANE_H + (needsBus(steps) ? 172 : 126);
  c.style.minWidth = `${w}px`;
  c.style.height = `${h}px`;
  applyFit(w, h);
}

/** "Fit" shrinks a wide board to the panel rather than making you scroll it. */
function applyFit(w: number, h: number) {
  const c = el("canvas") as HTMLElement | null;
  const wrap = el("scroll") as HTMLElement | null;
  if (!c || !wrap) return;
  const was = overflows;
  overflows = w > wrap.clientWidth - 2;
  if (was !== overflows) requestAnimationFrame(() => { if (board) render(); });
  if (!fitted) {
    scale = 1;
    c.style.transform = "";
    c.style.transformOrigin = "";
    wrap.style.height = "";
    wrap.style.overflowX = "auto";
    return;
  }
  const s = Math.min(1, (wrap.clientWidth - 2) / w);
  if (s >= 1) {
    scale = 1;
    c.style.transform = ""; wrap.style.height = ""; wrap.style.overflowX = "auto";
    return;
  }
  scale = s;
  c.style.transformOrigin = "0 0";
  c.style.transform = `scale(${s})`;
  wrap.style.height = `${Math.ceil(h * s)}px`;
  wrap.style.overflowX = "hidden";
}

/*
 * Copper routing. Short hops take a straight run with 45 degree mitred corners.
 * Anything spanning more than two columns drops to a bus below the board and
 * runs there, the way a long trace avoids the components in its way, instead of
 * cutting straight through a chip.
 */
type Box = { x: number; y: number; w: number; h: number };

function path(a: Box, b: Box, offset: number, busY: number) {
  const x1 = a.x + a.w, y1 = a.y + a.h / 2 + offset;
  const x2 = b.x, y2 = b.y + b.h / 2;
  const p: [number, number, number, number] = [x1, y1, x2, y2];
  if (Math.abs(y2 - y1) < 1) return { d: `M${x1} ${y1} L${x2} ${y2}`, p };

  const long = Math.abs(x2 - x1) > COL_W * 1.6;
  if (long) {
    const lead = 22;
    return { d: elbow(x1, y1, x1 + lead, busY) + elbow2(x1 + lead, busY, x2 - lead, y2, x2), p };
  }
  const xv = x1 + (x2 - x1) * 0.42;
  return { d: elbowFull(x1, y1, xv, y2, x2), p };
}

const ch = (dy: number, dx: number) => Math.min(11, Math.abs(dy) / 2, Math.abs(dx));

/** x1,y1 → run right to xv → mitre → drop to y2 */
function elbow(x1: number, y1: number, xv: number, y2: number) {
  const c = ch(y2 - y1, xv - x1), s = y2 > y1 ? 1 : -1;
  return `M${x1} ${y1} L${xv - c} ${y1} L${xv} ${y1 + s * c} L${xv} ${y2 - s * c}`;
}
/** …continue along the bus at y1 to xv, mitre up to y2, run into x2 */
function elbow2(x1: number, y1: number, xv: number, y2: number, x2: number) {
  const c = ch(y2 - y1, xv - x1), s = y2 > y1 ? 1 : -1;
  return ` L${x1 + c} ${y1} L${xv - c} ${y1} L${xv} ${y1 + s * c} L${xv} ${y2 - s * c} L${xv + c} ${y2} L${x2} ${y2}`;
}
/** the short form: out, mitre, vertical, mitre, in */
function elbowFull(x1: number, y1: number, xv: number, y2: number, x2: number) {
  const c = ch(y2 - y1, Math.min(xv - x1, x2 - xv)), s = y2 > y1 ? 1 : -1;
  return `M${x1} ${y1} L${xv - c} ${y1} L${xv} ${y1 + s * c} L${xv} ${y2 - s * c} L${xv + c} ${y2} L${x2} ${y2}`;
}

let cutTimer = 0;
/** Hovering a wire offers to cut it, right where you are looking. */
function showCut(p: SVGPathElement, hit: SVGPathElement, from: string, to: string, port: string) {
  const svg = el("traces")!;
  clearTimeout(cutTimer);
  svg.querySelectorAll(".cut").forEach((c) => c.remove());
  svg.querySelectorAll(".trace.hover").forEach((t) => t.classList.remove("hover"));
  p.classList.add("hover");

  const len = p.getTotalLength();
  const mid = p.getPointAtLength(len / 2);
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "cut");
  g.setAttribute("transform", `translate(${mid.x} ${mid.y})`);
  g.innerHTML =
    `<circle r="8"></circle>` +
    `<line x1="-3.2" y1="-3.2" x2="3.2" y2="3.2"></line>` +
    `<line x1="3.2" y1="-3.2" x2="-3.2" y2="3.2"></line>`;
  g.addEventListener("click", (e) => {
    e.stopPropagation();
    const wf = board?.workflow;
    if (wf) call("circuit_unwire", { workflowId: wf.id, from, to, port });
  });
  const leave = () => {
    cutTimer = window.setTimeout(() => {
      p.classList.remove("hover");
      g.remove();
    }, 220);
  };
  g.addEventListener("pointerenter", () => clearTimeout(cutTimer));
  g.addEventListener("pointerleave", leave);
  hit.addEventListener("pointerleave", leave, { once: true });
  svg.appendChild(g);
}

/** true while a run is still in flight — pulses only run then */
function runInFlight() {
  const st = board?.run?.status;
  return st === "running" || st === "awaiting_approval";
}

/**
 * One grab-handle per output port, sitting exactly where that port's trace
 * leaves the chip — so pulling a wire starts from the thing the wire comes out
 * of, rather than from some abstract edge of the card.
 */
/** Layout coordinates, unaffected by any CSS scale the fit applies. */
function boxOf(id: string) {
  const n = document.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`);
  return n ? { x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight } : null;
}

function drawHandles(steps: Chip[]) {
  const canvasEl = el("canvas")!;
  canvasEl.querySelectorAll(".handle").forEach((h) => h.remove());
  if (board?.run) return;               // wiring is a design-time act
  for (const s of steps) {
    const r = boxOf(s.id);
    if (!r) continue;
    const ports = s.ports?.length ? s.ports : ["out"];
    ports.forEach((port, i) => {
      const off = ports.length > 1 ? (i - (ports.length - 1) / 2) * 16 : 0;
      const h = document.createElement("div");
      h.className = "handle";
      h.dataset.from = s.id;
      h.dataset.port = port;
      h.style.left = `${r.x + r.w}px`;
      h.style.top = `${r.y + r.h / 2 + off}px`;
      h.innerHTML = ports.length > 1 ? `<span class="tip">${esc(portName(s.type, port))}</span>` : "";
      canvasEl.appendChild(h);
    });
  }
}

function drawTraces(steps: Chip[]) {
  const svg = el("traces")!;
  const busY = Math.max(...steps.map((s) => (s.position?.lane ?? 0))) * LANE_H + PAD_Y + 140;
  const rect = boxOf;
  const NS = "http://www.w3.org/2000/svg";
  svg.innerHTML = "";
  for (const s of steps) {
    const a = rect(s.id); if (!a) continue;
    const multi = s.next.length > 1;
    s.next.forEach((w, i) => {
      const b = rect(w.to); if (!b) return;
      const offset = multi ? (i - (s.next.length - 1) / 2) * 16 : 0;
      const r = path(a, b, offset, busY);
      const hot = ["done", "running"].includes(stateOf(s.id)) &&
        (portAt(s.id) ?? "out") === (w.port ?? "out") &&
        stateOf(w.to) !== "idle" && stateOf(w.to) !== "skipped";
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", r.d);
      p.setAttribute("class", `trace${hot ? " hot" : ""}`);
      svg.appendChild(p);

      // a fat invisible copy makes a 1.7px line clickable, and carries the cut
      if (!board?.run) {
        const hit = document.createElementNS(NS, "path");
        hit.setAttribute("d", r.d);
        hit.setAttribute("class", "hit");
        hit.addEventListener("pointerenter", () => showCut(p, hit, s.id, w.to, w.port ?? "out"));
        svg.appendChild(hit);
      }
      if (hot && runInFlight()) {
        const pulse = document.createElementNS(NS, "path");
        pulse.setAttribute("d", r.d);
        pulse.setAttribute("class", "pulse");
        pulse.setAttribute("pathLength", "1");
        pulse.setAttribute("stroke-dasharray", ".08 .92");
        svg.appendChild(pulse);
      }
      for (const [cx, cy] of [[r.p[0], r.p[1]], [r.p[2], r.p[3]]]) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", String(cx)); c.setAttribute("cy", String(cy));
        c.setAttribute("r", "3"); c.setAttribute("class", `pad${hot ? " hot" : ""}`);
        svg.appendChild(c);
      }
    });
  }
}

/* ------------------------------------------------------------ interaction */
function wire() {
  const wf = board?.workflow;

  el("btn-replay")?.addEventListener("click", () => {
    replayAt = replaying() ? null : 0;
    selected = null;
    render();
  });
  el("rw")?.addEventListener("click", () => scrubTo((replayAt ?? 0) - 1));
  el("ff")?.addEventListener("click", () => scrubTo((replayAt ?? 0) + 1));
  el("scrub")?.addEventListener("click", (e) => {
    const n = (e.target as HTMLElement).dataset?.n;
    if (n !== undefined) scrubTo(Number(n));
  });

  el("btn-full")?.addEventListener("click", () => app.requestDisplayMode("fullscreen").catch(() => {}));
  el("btn-fit")?.addEventListener("click", () => { fitted = !fitted; render(); });

  // clicking the board itself clears the selection
  el("canvas")?.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".node")) return;
    if (selected) { selected = null; render(); }
  });

  const nameEl = el("wfname");
  nameEl?.addEventListener("blur", () => {
    const v = nameEl.textContent?.trim();
    if (wf && v && v !== wf.name) call("circuit_rename", { workflowId: wf.id, name: v });
  });
  nameEl?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); }
  });

  el("gate-ok")?.addEventListener("click", () => {
    const text = (el("gate-text") as HTMLTextAreaElement | null)?.value;
    if (!board?.run) return;
    consoleState = { label: board.run.id, sub: "continuing", busy: true };
    render();
    call("circuit_answer", { runId: board.run.id, decision: "approve", ...(text != null ? { edit: text } : {}) });
  });
  el("gate-no")?.addEventListener("click", () => {
    if (!board?.run) return;
    call("circuit_answer", { runId: board.run.id, decision: "reject" });
  });

  el("fix-retry")?.addEventListener("click", () => {
    if (!board?.run) return;
    consoleState = { label: board.run.id, sub: "trying again", busy: true }; render();
    call("circuit_resume", { runId: board.run.id, skip: false });
  });
  el("fix-skip")?.addEventListener("click", () => {
    if (!board?.run) return;
    call("circuit_resume", { runId: board.run.id, skip: true });
  });

  document.querySelectorAll<HTMLElement>(".handle").forEach((h) => {
    h.addEventListener("pointerdown", (ev) => startWire(ev, h));
  });

  document.querySelectorAll<HTMLElement>(".node").forEach((n) => {
    n.addEventListener("dblclick", () => {
      const id = n.dataset.id!;
      const step = wf?.steps.find((s) => s.id === id);
      if (!wf || !step) return;
      call("circuit_set_enabled", { workflowId: wf.id, stepId: id, enabled: !(step.enabled !== false) });
    });
    n.addEventListener("pointerdown", (ev) => startDrag(ev, n));
  });
}

function scrubTo(n: number) {
  const h = history();
  if (!h.length) return;
  replayAt = Math.max(0, Math.min(n, h.length - 1));
  render();
}

function dropTarget(x: number, y: number): string | undefined {
  const stack = document.elementsFromPoint(x, y) as Element[];
  for (const node of stack) {
    const chip = (node as HTMLElement).closest?.<HTMLElement>(".node");
    if (chip?.dataset.id) return chip.dataset.id;
  }
  return undefined;
}

/** Pull a wire out of a port and drop it on the chip it should reach. */
function startWire(ev: PointerEvent, handle: HTMLElement) {
  const wf = board?.workflow;
  if (!wf) return;
  ev.preventDefault();
  ev.stopPropagation();
  const canvasEl = el("canvas")!;
  const svg = el("traces")!;
  const host = canvasEl.getBoundingClientRect();
  const from = handle.dataset.from!, port = handle.dataset.port ?? "out";
  const x0 = parseFloat(handle.style.left), y0 = parseFloat(handle.style.top);

  handle.classList.add("armed");
  canvasEl.classList.add("wiring");
  const draft = document.createElementNS("http://www.w3.org/2000/svg", "path");
  draft.setAttribute("class", "draft");
  svg.appendChild(draft);
  handle.setPointerCapture(ev.pointerId);

  const move = (e: PointerEvent) => {
    const x = (e.clientX - host.left) / scale, y = (e.clientY - host.top) / scale;
    const bend = Math.max(14, Math.abs(x - x0) * 0.4);
    draft.setAttribute("d", `M${x0} ${y0} L${x0 + bend} ${y0} L${x - 10} ${y} L${x} ${y}`);
  };
  const up = (e: PointerEvent) => {
    handle.releasePointerCapture(ev.pointerId);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.classList.remove("armed");
    canvasEl.classList.remove("wiring");
    draft.remove();
    // The chip under the cursor decides. elementFromPoint alone is not enough:
    // trace hit-paths, other chips' handles and the SVG overlay all sit on top,
    // so walk the whole stack and take the first chip in it.
    const to = dropTarget(e.clientX, e.clientY);
    if (!to || to === from) return;
    consoleState = { label: "wiring", sub: `${from} \u2192 ${to}`, busy: true };
    call("circuit_wire", { workflowId: wf.id, from, to, port });
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

function startDrag(ev: PointerEvent, node: HTMLElement) {
  if ((ev.target as HTMLElement).isContentEditable) return;
  const wf = board?.workflow; if (!wf) return;
  const id = node.dataset.id!;
  selected = id;
  document.querySelectorAll(".node.sel").forEach((n) => n.classList.remove("sel"));
  node.classList.add("sel");

  const first = selected !== id;
  const startX = ev.clientX, startY = ev.clientY;
  const step = wf.steps.find((s) => s.id === id)!;
  const from = { ...step.position };
  let moved = false;
  node.setPointerCapture(ev.pointerId);
  node.classList.add("dragging");

  const move = (e: PointerEvent) => {
    const dx = (e.clientX - startX) / scale, dy = (e.clientY - startY) / scale;
    if (!moved && (Math.abs(dx) + Math.abs(dy)) * scale < 4) return;
    moved = true;
    const col = Math.max(0, Math.round(from.col + dx / COL_W));
    const lane = Math.max(0, Math.round(from.lane + dy / LANE_H));
    node.style.left = `${PAD_X + col * COL_W}px`;
    node.style.top = `${PAD_Y + lane * LANE_H}px`;
    step.position = { col, lane };
    drawTraces(wf.steps);
    drawHandles(wf.steps);
  };
  const up = () => {
    node.classList.remove("dragging");
    node.removeEventListener("pointermove", move);
    node.removeEventListener("pointerup", up);
    if (moved) {
      sizeCanvas(wf.steps);
      call("circuit_move", { workflowId: wf.id, stepId: id, col: step.position.col, lane: step.position.lane }, true);
    } else if (first) {
      render();   // show this step in the inspector
    }
  };
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
}

async function call(name: string, args: Record<string, unknown>, quiet = false) {
  try {
    const res: any = await app.callServerTool(name, args);
    const props = res?.structuredContent ?? res?._meta?.["ui/props"];
    if (props?.workflow) {
      board = props as Board;
      if (!quiet) {
        const run = board.run;
        consoleState = run
          ? { label: run.id, sub: `${run.mode} · ${run.status.replace("_", " ")}`, busy: false }
          : { label: board.workflow.name, sub: `${board.workflow.steps.length} steps · ${board.workflow.status}`, busy: false };
        if (run) {
          logLines = traceLog(run.trace);
          const d = board.directive;
          if (d && d.act !== "done" && d.act !== "blocked") {
            logLines.push(`${pad("→ next", 14)}${pad(d.act, 10)}${d.tool ?? d.title ?? ""}`);
          }
        }
      }
      render();
    }
  } catch (e: any) {
    consoleState = { label: name, sub: "failed", busy: false };
    logLines = [...logLines, String(e?.message ?? e)];
    render();
  }
}

/* -------------------------------------------------------------------- go */
applyTheme();
app.connect().then(applyTheme).catch((e) => console.warn("circuit: host handshake failed", e));
window.addEventListener("keydown", (e) => {
  if (!replaying()) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); scrubTo((replayAt ?? 0) - 1); }
  if (e.key === "ArrowRight") { e.preventDefault(); scrubTo((replayAt ?? 0) + 1); }
  if (e.key === "Escape") { replayAt = null; render(); }
});

window.addEventListener("resize", () => {
  if (!board) return;
  drawTraces(board.workflow.steps);
  drawHandles(board.workflow.steps);
});
