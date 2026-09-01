import { AppClient } from "./bridge.js";

/* ------------------------------------------------------------------ types */
type Wire = { port: string; to: string };
type Chip = {
  id: string; type: string; kind: string; label?: string; actor?: string;
  title: string; summary: string; config?: Record<string, unknown>;
  tool?: string | null; toolKnown?: boolean | null; ports: string[]; next: Wire[]; enabled: boolean;
  position: { col: number; lane: number };
};
type Directive = {
  act: string; stepId?: string; title?: string; tool?: string; question?: string;
  preview?: string; text?: string; reason?: string; summary?: string;
};
type Trace = { stepId: string; state: string; port?: string; summary?: string; error?: string };
type Board = {
  workflow: { id: string; name: string; description: string; status: string; entry: string; steps: Chip[] };
  run: { id: string; status: string; mode: string; trace: Trace[]; awaiting: { stepId: string; act: string } | null } | null;
  storage?: string;
  phase?: string;
  tools?: { bound: boolean; missing: { stepId: string; tool: string; suggestion?: string }[]; present: string[] };
  directive?: Directive | null;
};

const COL_W = 224, LANE_H = 164, PAD_X = 24, PAD_Y = 24, NODE_W = 180;

const app = new AppClient(
  { name: "Circuit board", version: "0.1.0", title: "Circuit" },
  { autoResize: true },
);

let board: Board | null = null;
let building: Partial<Chip>[] = [];
let selected: string | null = null;
let fitted = false;
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
    if (d?.act === "blocked") logLines.push(`${pad("✕", 14)}${d.reason ?? "blocked"}`);
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
    } else if (tools?.present?.length) {
      logLines = ["all connectors check out:", ...tools.present.map((t) => `  ${t}`)];
    } else {
      logLines = wf.steps.map((s) => `${pad(s.id, 14)}${s.title}`);
    }
  }
  render();
};

/* ---------------------------------------------------------------- helpers */
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

function stateOf(id: string): string {
  const t = board?.run?.trace.find((x) => x.stepId === id);
  return t?.state ?? "idle";
}
const STATE_WORD: Record<string, string> = {
  running: "running", done: "ran", skipped: "not taken",
  held: "waiting on you", failed: "failed", idle: "",
};

/** Nothing at all before a run — an "IDLE" badge on every chip is just noise. */
function labelOf(id: string): string {
  const t = board?.run?.trace.find((x) => x.stepId === id);
  if (!t || t.state === "idle") return "";
  const s = t.summary || STATE_WORD[t.state] || t.state;
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
      ${wf ? `<button id="btn-fit" class="ghost">${fitted ? "Actual size" : "Fit"}</button>` : ""}
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
      ${selected ? inspectorHtml() : `<pre class="log mono" id="log">${logLines.slice(-4).map(esc).join("\n")}${consoleState.busy ? '<span class="caret"></span>' : ""}</pre>`}
    </div>
    ${extra}
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
    ${t && t.state !== "idle" ? `<dt>last run</dt><dd>${esc(t.summary || t.error || t.state)}</dd>` : ""}
    <dt>settings</dt><dd><pre>${esc(cfg === "{}" ? "nothing to configure" : cfg)}</pre></dd>
  </dl></div>`;
}

function chipHtml(c: Partial<Chip>, i: number, state = "idle", label = "") {
  const pos = c.position ?? { col: i, lane: 0 };
  const x = PAD_X + pos.col * COL_W, y = PAD_Y + pos.lane * LANE_H;

  const all = c.ports ?? [];
  const lit = board?.run?.trace.find((t) => t.stepId === c.id)?.port;
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
    unbound ? "unbound" : "", c.enabled === false ? "muted" : "",
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
  const gate = d?.act === "ask" ? gateHtml(d) : "";
  document.getElementById("root")!.innerHTML = shell(chips, gate);
  sizeCanvas(wf.steps);
  drawTraces(wf.steps);
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

function sizeCanvas(steps: Chip[]) {
  const maxCol = Math.max(0, ...steps.map((s) => s.position?.col ?? 0));
  const maxLane = Math.max(0, ...steps.map((s) => s.position?.lane ?? 0));
  const c = el("canvas")!;
  const w = PAD_X * 2 + maxCol * COL_W + NODE_W;
  const h = PAD_Y * 2 + maxLane * LANE_H + 168;
  c.style.minWidth = `${w}px`;
  c.style.height = `${h}px`;
  applyFit(w, h);
}

/** "Fit" shrinks a wide board to the panel rather than making you scroll it. */
function applyFit(w: number, h: number) {
  const c = el("canvas") as HTMLElement | null;
  const wrap = el("scroll") as HTMLElement | null;
  if (!c || !wrap) return;
  if (!fitted) {
    c.style.transform = "";
    c.style.transformOrigin = "";
    wrap.style.height = "";
    return;
  }
  const scale = Math.min(1, (wrap.clientWidth - 2) / w);
  c.style.transformOrigin = "0 0";
  c.style.transform = `scale(${scale})`;
  wrap.style.height = `${Math.ceil(h * scale)}px`;
  wrap.style.overflowX = "hidden";
}

/*
 * Copper routing. Short hops take a straight run with 45 degree mitred corners.
 * Anything spanning more than two columns drops to a bus below the board and
 * runs there, the way a long trace avoids the components in its way, instead of
 * cutting straight through a chip.
 */
function path(a: DOMRect, b: DOMRect, host: DOMRect, offset: number, busY: number) {
  const x1 = a.right - host.left, y1 = a.top - host.top + a.height / 2 + offset;
  const x2 = b.left - host.left, y2 = b.top - host.top + b.height / 2;
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

/** true while a run is still in flight — pulses only run then */
function runInFlight() {
  const st = board?.run?.status;
  return st === "running" || st === "awaiting_approval";
}

function drawTraces(steps: Chip[]) {
  const svg = el("traces")!;
  const canvasEl = el("canvas")!;
  const host = canvasEl.getBoundingClientRect();
  const busY = Math.max(...steps.map((s) => (s.position?.lane ?? 0))) * LANE_H + PAD_Y + 148;
  const rect = (id: string) => document.querySelector(`.node[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const NS = "http://www.w3.org/2000/svg";
  svg.innerHTML = "";
  for (const s of steps) {
    const a = rect(s.id); if (!a) continue;
    const multi = s.next.length > 1;
    s.next.forEach((w, i) => {
      const b = rect(w.to); if (!b) return;
      const offset = multi ? (i - (s.next.length - 1) / 2) * 16 : 0;
      const r = path(a, b, host, offset, busY);
      const hot = stateOf(s.id) === "done" &&
        (board?.run?.trace.find((t) => t.stepId === s.id)?.port ?? "out") === (w.port ?? "out") &&
        stateOf(w.to) !== "idle" && stateOf(w.to) !== "skipped";
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", r.d);
      p.setAttribute("class", `trace${hot ? " hot" : ""}`);
      svg.appendChild(p);
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
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    const col = Math.max(0, Math.round(from.col + dx / COL_W));
    const lane = Math.max(0, Math.round(from.lane + dy / LANE_H));
    node.style.left = `${PAD_X + col * COL_W}px`;
    node.style.top = `${PAD_Y + lane * LANE_H}px`;
    step.position = { col, lane };
    drawTraces(wf.steps);
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
window.addEventListener("resize", () => { if (board) drawTraces(board.workflow.steps); });
