import type { Step, Workflow } from "./graph.js";

/**
 * Circuit never calls a connector — Claude does. That leaves one sharp edge:
 * a step names a tool as a plain string, and if the string is wrong nothing
 * complains until the run is already underway and a directive points at a tool
 * Claude cannot see.
 *
 * Binding closes it. Claude reports the tools it actually has once, Circuit
 * remembers them, and from then on an unknown tool is a design-time error with
 * a suggestion attached — the same treatment an unknown step type already gets.
 */

export type BoundTool = { name: string; hint?: string };

export type ToolBinding = {
  workspace: string;
  boundAt: string;
  tools: BoundTool[];
};

/** Every connector tool a workflow depends on, with the step that wants it. */
export function requiredTools(steps: Step[]): { stepId: string; tool: string }[] {
  return steps
    .map((s) => ({ stepId: s.id, tool: String(s.config?.tool ?? "") }))
    .filter((x) => x.tool.length > 0);
}

export type ToolCheck = {
  bound: boolean;
  /** tools the workflow wants that the binding does not have */
  missing: { stepId: string; tool: string; suggestion?: string }[];
  /** tools the workflow wants that the binding does have */
  present: string[];
};

export function checkTools(steps: Step[], binding: ToolBinding | null): ToolCheck {
  const wanted = requiredTools(steps);
  if (!binding || !binding.tools.length) {
    return { bound: false, missing: [], present: [...new Set(wanted.map((w) => w.tool))] };
  }
  const known = binding.tools.map((t) => t.name);
  const index = new Map(known.map((n) => [norm(n), n]));
  const missing: ToolCheck["missing"] = [];
  const present: string[] = [];
  for (const w of wanted) {
    const hit = index.get(norm(w.tool));
    if (hit) present.push(hit);
    else missing.push({ stepId: w.stepId, tool: w.tool, suggestion: suggest(w.tool, known) });
  }
  return { bound: true, missing, present: [...new Set(present)] };
}

/** One line the model can act on, or "" when everything checks out. */
export function describeMissing(check: ToolCheck): string {
  if (!check.missing.length) return "";
  const lines = check.missing.map((m) =>
    `  ${m.stepId}: '${m.tool}' is not in your tool list` +
    (m.suggestion ? ` — did you mean '${m.suggestion}'?` : ""));
  const n = check.missing.length;
  return [
    n === 1
      ? "One step names a connector tool you do not have:"
      : `${n} steps name connector tools you do not have:`,
    ...lines,
    "Fix the tool names, or call circuit_bind again if the user has connected something since.",
  ].join("\n");
}

/* ------------------------------------------------------------- matching -- */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function split(name: string): { service: string; action: string } {
  const [service, ...rest] = name.split(/[:.]/);
  return { service: norm(service ?? ""), action: norm(rest.join("")) };
}

/** Dice coefficient over character bigrams — cheap, and good on tool names. */
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a), gb = grams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/**
 * A name from the same connector is almost always the intended one, so a match
 * on the service is worth more than a close spelling on the action alone.
 */
export function suggest(wanted: string, known: string[]): string | undefined {
  const w = split(wanted);
  let best: { name: string; score: number } | undefined;
  for (const name of known) {
    const k = split(name);
    const sameService = k.service === w.service;
    const score = sameService
      ? 0.5 + 0.5 * dice(w.action, k.action)
      : 0.6 * dice(norm(wanted), norm(name));
    if (!best || score > best.score) best = { name, score };
  }
  return best && best.score >= 0.55 ? best.name : undefined;
}

/* ---------------------------------------------------------------- writes -- */

/**
 * Circuit cannot know what a connector tool does, so a step can declare
 * `writes`. Where it hasn't, the verb is a good enough guess to keep a test run
 * from sending real email — and a wrong guess is always overridable.
 */
const WRITE_VERBS = /(^|[_\-. ])(send|post|create|add|insert|write|update|edit|patch|put|delete|remove|archive|trash|move|upload|publish|reply|forward|invite|schedule|book|assign|comment|label|star|mark|set|approve|merge|close|pay|charge|transfer)([_\-. ]|$)/i;
const READ_VERBS = /(^|[_\-. ])(get|list|search|read|find|fetch|query|show|describe|lookup|count|check|view)([_\-. ]|$)/i;

export function looksLikeWrite(tool?: string): boolean {
  if (!tool) return false;
  const action = tool.split(/[:.]/).slice(1).join(" ") || tool;
  if (READ_VERBS.test(action)) return false;
  return WRITE_VERBS.test(action);
}

/** true when this step would change something outside Circuit. */
export function stepWrites(step: Step): boolean {
  const declared = (step.config as any)?.writes;
  if (typeof declared === "boolean") return declared;
  return looksLikeWrite((step.config as any)?.tool);
}

/**
 * Write steps that no approval gate stands in front of. Every path from the
 * trigger has to pass a gate for a write to count as guarded — one unguarded
 * branch is enough to send something nobody looked at.
 */
export function unguardedWrites(wf: Workflow): { stepId: string; tool: string }[] {
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  const guarded = new Map<string, boolean>();   // id -> guarded on EVERY path so far
  const walk = (id: string, seenGate: boolean, path: Set<string>) => {
    if (path.has(id)) return;
    const prior = guarded.get(id);
    guarded.set(id, prior === undefined ? seenGate : prior && seenGate);
    const step = byId.get(id);
    if (!step) return;
    const next = seenGate || step.type === "gate.approve";
    const deeper = new Set(path).add(id);
    for (const e of step.next) walk(e.to, next, deeper);
  };
  walk(wf.entry, false, new Set());

  return wf.steps
    .filter((s) => stepWrites(s) && s.enabled !== false && guarded.get(s.id) === false)
    .map((s) => ({ stepId: s.id, tool: String((s.config as any)?.tool ?? s.type) }));
}

/**
 * `together` hands several calls out in one directive, which only makes sense
 * when each branch is exactly one connector call. Anything else — a branch with
 * a second step, a retry policy that would need its own round trip — has no
 * unambiguous meaning, so it is refused while the board is being drawn.
 */
export function checkTogether(wf: Workflow): string[] {
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  const problems: string[] = [];
  for (const s of wf.steps) {
    if (s.type !== "logic.branches" || !(s.config as any)?.together) continue;
    const heads = s.next.filter((e) => (e.port ?? "out") === "out").map((e) => e.to);
    if (heads.length < 2) problems.push(`${s.id}: 'together' needs at least two branches.`);
    for (const id of heads) {
      const h = byId.get(id);
      if (!h) continue;
      if (h.type !== "tool.call") {
        problems.push(`${s.id} → ${id}: only tool.call steps can go together, and ${id} is ${h.type}.`);
      }
      if (h.next.length) {
        problems.push(`${s.id} → ${id}: ${id} has steps after it, so it cannot go in a 'together' batch. ` +
          `Wire that work after the join instead.`);
      }
      const policy = h.onError?.do;
      if (policy === "retry" || policy === "route") {
        problems.push(`${s.id} → ${id}: onError '${policy}' needs its own round trip, so it cannot go together. ` +
          `Use stop or skip.`);
      }
    }
  }
  return problems;
}

/** Which connectors a board touches, for the header line on the app. */
export function servicesOf(wf: Workflow): string[] {
  return [...new Set(requiredTools(wf.steps).map((t) => t.tool.split(/[:.]/)[0]))];
}
