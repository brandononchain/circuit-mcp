import { randomUUID } from "node:crypto";
import type { HistoryEntry, Run, Step, StepTrace, Workflow } from "../graph.js";
import { clip } from "../clip.js";
import { BY_TYPE, matches, pick, resolve } from "../registry.js";
import { stepWrites } from "../tools.js";
import { getStore } from "../store/index.js";

const now = () => new Date().toISOString();

/**
 * Circuit does not execute anything with side effects. It walks the graph,
 * resolves everything it can on its own (routing, filtering, looping), and
 * hands Claude one directive at a time — a connector tool to call, a judgement
 * to make, or a question to put to the user. Claude reports the result and the
 * walk continues. The board is the same object in both phases.
 */
export type Directive =
  | { act: "call_tool"; stepId: string; title: string; tool: string; arguments: Record<string, unknown>; expect: string }
  | { act: "preview"; stepId: string; title: string; tool: string; arguments: Record<string, unknown>; expect: string }
  | { act: "think"; stepId: string; title: string; task: "classify" | "write" | "extract"; instruction: string; input: unknown; labels?: string[]; fields?: { name: string; description: string }[]; maxWords?: number; expect: string }
  | { act: "ask"; stepId: string; title: string; question: string; preview: string; expect: string }
  | { act: "say"; stepId: string; text: string; expect: string }
  | { act: "done"; summary: string }
  | { act: "blocked"; stepId: string; reason: string };

export function newRun(wf: Workflow, trigger: unknown, mode: "test" | "live"): Run {
  return {
    id: `run_${randomUUID().slice(0, 8)}`,
    workflowId: wf.id,
    workspace: wf.workspace,
    status: "running",
    mode,
    startedAt: now(),
    data: { trigger: trigger ?? {}, steps: {} },
    queue: [wf.entry],
    loops: [],
    awaiting: null,
    attempts: {},
    failedAt: null,
    history: [],
    trace: wf.steps.map((s) => ({ stepId: s.id, state: "idle" as const })),
  };
}

const HISTORY_CAP = 240;

/** Append to the timeline. Bounded, oldest dropped, with a marker left behind. */
function record(run: Run, e: Omit<HistoryEntry, "at">) {
  run.history ??= [];
  run.history.push({ ...e, at: now() });
  if (run.history.length > HISTORY_CAP) {
    const dropped = run.history.length - HISTORY_CAP;
    run.history = run.history.slice(dropped);
    run.history[0] = { ...run.history[0], summary: `(${dropped} earlier steps dropped) ${run.history[0].summary ?? ""}`.trim() };
  }
}

function mark(run: Run, stepId: string, patch: Partial<StepTrace>) {
  const i = run.trace.findIndex((t) => t.stepId === stepId);
  const next = { ...(run.trace[i] ?? { stepId, state: "idle" as const }), ...patch };
  if (i >= 0) run.trace[i] = next; else run.trace.push(next);
}

const wires = (step: Step, port: string) =>
  step.next.filter((e) => (e.port ?? "out") === port).map((e) => e.to);

/** Follow `port`; if nothing is wired there and there is exactly one plain wire, take it. */
function follow(step: Step, port: string): string[] {
  const hit = wires(step, port);
  if (hit.length) return hit;
  if (port !== "out" && step.next.length === 1 && (step.next[0].port ?? "out") === "out") {
    return [step.next[0].to];
  }
  return [];
}

/** Walk until Claude is needed, or the run ends. */
export function advance(wf: Workflow, run: Run): Directive {
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  let guard = 0;

  while (guard++ < 2000) {
    if (run.queue.length === 0) {
      const frame = run.loops[run.loops.length - 1];
      if (frame) {
        frame.index += 1;
        const total = Math.min(frame.items.length, frame.limit);
        if (frame.index < total) {
          if (frame.kind === "each") {
            run.data.item = frame.items[frame.index];
            run.queue = [...frame.body];
            const at = `item ${frame.index + 1} of ${total}`;
            mark(run, frame.stepId, { state: "running", summary: at });
            record(run, { stepId: frame.stepId, state: "running", summary: at, output: clip(run.data.item), item: clip(run.data.item) });
          } else {
            run.queue = [String(frame.items[frame.index])];
            mark(run, frame.stepId, { state: "running", summary: `branch ${frame.index + 1} of ${total}` });
          }
          continue;
        }
        run.loops.pop();
        if (frame.kind === "each") delete run.data.item;
        const done = frame.kind === "each" ? `${total} handled` : `${total} branches done`;
        mark(run, frame.stepId, { state: "done", summary: done });
        record(run, { stepId: frame.stepId, state: "done", summary: done });
        run.queue = [...frame.after];
        continue;
      }
      run.status = "succeeded";
      run.endedAt = now();
      return { act: "done", summary: summarise(run) };
    }

    const id = run.queue.shift()!;
    const step = byId.get(id);
    if (!step) continue;

    if (step.enabled === false) {
      mark(run, id, { state: "skipped", summary: "muted" });
      run.queue.unshift(...follow(step, "out"));
      continue;
    }

    const def = BY_TYPE.get(step.type);
    if (!def) {
      mark(run, id, { state: "failed", error: `unknown step type '${step.type}'` });
      run.status = "failed";
      run.endedAt = now();
      return { act: "blocked", stepId: id, reason: `Step '${id}' uses an unknown type '${step.type}'.` };
    }

    const cfg = resolve(coerce(def.config, step.config), run.data);

    /* ---- triggers ---- */
    if (def.kind === "trigger") {
      if (step.type === "trigger.watch") {
        if (!cfg.tool) return blocked(run, id, `The trigger has no connector tool bound yet.`);
        mark(run, id, { state: "running" });
        run.awaiting = { stepId: id, act: "call_tool" };
        return {
          act: "call_tool", stepId: id, title: step.title,
          tool: cfg.tool, arguments: cfg.arguments ?? {},
          expect: "Call that tool, then send the whole result back with circuit_step.",
        };
      }
      run.data.steps[id] = run.data.trigger;
      mark(run, id, { state: "done", summary: "fired" });
      record(run, { stepId: id, state: "done", summary: "fired", output: clip(run.data.trigger) });
      run.queue.unshift(...follow(step, "out"));
      continue;
    }

    /* ---- things Circuit settles on its own ---- */
    if (def.actor === "circuit") {
      if (step.type === "logic.filter") {
        const passed = matches(cfg, run.data);
        const summary = passed ? "passed" : "stopped here";
        mark(run, id, passed ? { state: "done", port: "out", summary } : { state: "skipped", summary });
        record(run, {
          stepId: id, state: passed ? "done" : "skipped", summary,
          input: clip(cfg), output: passed, item: clip(run.data.item),
        });
        if (passed) run.queue.unshift(...follow(step, "out"));
        continue;
      }
      if (step.type === "logic.branch") {
        const v = String(pick(run.data, cfg.field) ?? "");
        const hit = (cfg.cases ?? []).find((c: any) => String(c.equals).toLowerCase() === v.toLowerCase());
        const port = hit?.port ?? cfg.fallback ?? "else";
        mark(run, id, { state: "done", port, summary: port });
        record(run, {
          stepId: id, state: "done", port, summary: `${cfg.field} = ${v || "(empty)"} → ${port}`,
          input: clip(v), output: port, item: clip(run.data.item),
        });
        run.queue.unshift(...follow(step, port));
        continue;
      }
      if (step.type === "logic.branches") {
        const branches = follow(step, "out");
        if (!branches.length) {
          mark(run, id, { state: "done", port: "join", summary: "nothing to do" });
          run.queue.unshift(...follow(step, "join"));
          continue;
        }
        run.loops.push({
          kind: "branches",
          stepId: id, items: branches, index: 0, limit: branches.length,
          body: [], after: [...follow(step, "join"), ...run.queue],
        });
        run.queue = [branches[0]];
        mark(run, id, { state: "running", summary: `branch 1 of ${branches.length}` });
        continue;
      }
      if (step.type === "logic.each") {
        const raw = pick(run.data, cfg.list);
        const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
        const limit = Math.max(1, Number(cfg.limit ?? 10));
        if (!items.length) {
          mark(run, id, { state: "done", port: "done", summary: "nothing to do" });
          run.queue.unshift(...follow(step, "done"));
          continue;
        }
        run.loops.push({
          kind: "each",
          stepId: id, items, index: 0, limit,
          body: follow(step, "out"),
          after: [...follow(step, "done"), ...run.queue],
        });
        run.queue = [...follow(step, "out")];
        run.data.item = items[0];
        mark(run, id, { state: "running", summary: `item 1 of ${Math.min(items.length, limit)}` });
        record(run, {
          stepId: id, state: "running", summary: `item 1 of ${Math.min(items.length, limit)}`,
          input: clip(items.length), output: clip(items[0]), item: clip(items[0]),
        });
        continue;
      }
    }

    /* ---- things Claude or the user has to do ---- */
    run.attempts ??= {};
    run.attempts[id] = run.attempts[id] ?? 1;
    mark(run, id, { state: "running", attempts: run.attempts[id] });

    if (step.type === "tool.call") {
      if (!cfg.tool) return blocked(run, id, `Step '${id}' has no connector tool bound yet.`);

      // A rehearsal that really sends the email is not a rehearsal.
      if (run.mode === "test" && stepWrites(step)) {
        run.awaiting = { stepId: id, act: "preview" };
        mark(run, id, { state: "running", summary: "rehearsing" });
        return {
          act: "preview", stepId: id, title: step.title,
          tool: cfg.tool, arguments: cfg.arguments ?? {},
          expect:
            "DO NOT call this tool. This is a test run and the step writes. Show the user the tool " +
            "name and these exact arguments so they can see what would go out, then report {} with " +
            "circuit_step to move on.",
        };
      }

      run.awaiting = { stepId: id, act: "call_tool" };
      const again = (run.attempts?.[id] ?? 1) > 1 ? ` This is attempt ${run.attempts![id]}.` : "";
      return {
        act: "call_tool", stepId: id, title: step.title,
        tool: cfg.tool, arguments: cfg.arguments ?? {},
        expect: "Call that tool exactly as given, then report the result with circuit_step. " +
          "If the call fails, report the error with circuit_step's `error` instead of inventing a result." + again,
      };
    }

    if (step.type === "model.classify") {
      run.awaiting = { stepId: id, act: "think" };
      return {
        act: "think", stepId: id, title: step.title, task: "classify",
        instruction: cfg.instructions || "Pick the single best label.",
        input: pick(run.data, cfg.input) ?? run.data.trigger,
        labels: cfg.labels,
        expect: `Report {"label": one of ${JSON.stringify(cfg.labels)}, "why": "one short sentence"}.`,
      };
    }
    if (step.type === "model.write") {
      run.awaiting = { stepId: id, act: "think" };
      return {
        act: "think", stepId: id, title: step.title, task: "write",
        instruction: [cfg.instructions, cfg.voice && `Voice: ${cfg.voice}.`].filter(Boolean).join(" "),
        input: Object.fromEntries((cfg.context ?? ["trigger"]).map((p: string) => [p, pick(run.data, p)])),
        maxWords: cfg.maxWords,
        expect: `Report {"text": "…"} — under ${cfg.maxWords ?? 160} words, no preamble.`,
      };
    }
    if (step.type === "model.extract") {
      run.awaiting = { stepId: id, act: "think" };
      return {
        act: "think", stepId: id, title: step.title, task: "extract",
        instruction: "Extract these fields. Use null where the source does not say.",
        input: pick(run.data, cfg.input) ?? run.data.trigger,
        fields: cfg.fields,
        expect: `Report an object with exactly these keys: ${JSON.stringify((cfg.fields ?? []).map((f: any) => f.name))}.`,
      };
    }

    if (step.type === "gate.approve") {
      const preview = cfg.preview ? String(pick(run.data, cfg.preview) ?? "") : "";
      run.status = "awaiting_approval";
      run.awaiting = { stepId: id, act: "ask" };
      mark(run, id, { state: "held", summary: "waiting on you" });
      return {
        act: "ask", stepId: id, title: step.title,
        question: cfg.question || "Go ahead?",
        preview,
        expect:
          "Show the user the board and wait. They answer on it, or you report " +
          `{"decision":"approve"|"reject","edit":"…"} with circuit_step.`,
      };
    }

    if (step.type === "note.say") {
      run.awaiting = { stepId: id, act: "say" };
      return {
        act: "say", stepId: id, text: String(cfg.template ?? ""),
        expect: "Say that to the user, then report {} with circuit_step.",
      };
    }

    return blocked(run, id, `Step '${id}' (${step.type}) has no handler.`);
  }

  return blocked(run, "?", "The workflow looped more than 2000 times and was stopped.");
}

function blocked(run: Run, stepId: string, reason: string): Directive {
  run.status = "failed";
  run.endedAt = now();
  mark(run, stepId, { state: "failed", error: reason });
  return { act: "blocked", stepId, reason };
}

/**
 * A step that went wrong. What happens next is the step's own business: stop the
 * run, end just this path, hand Claude the same directive again, or leave by the
 * error port so the board can show a fallback.
 */
export function fail(wf: Workflow, run: Run, stepId: string, error: string): Directive {
  const step = wf.steps.find((s) => s.id === stepId);
  if (!step) return { act: "blocked", stepId, reason: `No step '${stepId}' in this workflow.` };
  if (run.awaiting?.stepId !== stepId) {
    return { act: "blocked", stepId, reason: `This run is waiting on '${run.awaiting?.stepId ?? "nothing"}', not '${stepId}'.` };
  }
  run.awaiting = null;
  run.attempts ??= {};
  const tries = (run.attempts[stepId] ?? 1);
  const policy = step.onError ?? { do: "stop" as const, attempts: 2, port: "error" };
  const msg = String(error).slice(0, 400);

  if (policy.do === "retry" && tries < (policy.attempts ?? 2)) {
    run.attempts[stepId] = tries + 1;
    run.status = "running";
    mark(run, stepId, { state: "retrying", error: msg, attempts: tries + 1,
      summary: `try ${tries + 1} of ${policy.attempts ?? 2}` });
    record(run, { stepId, state: "retrying", error: msg, summary: `try ${tries} failed`, item: clip(run.data.item) });
    run.queue.unshift(stepId);       // hand out the very same directive again
    return advance(wf, run);
  }

  if (policy.do === "route") {
    const port = policy.port || "error";
    const wired = follow(step, port);
    if (wired.length) {
      run.status = "running";
      mark(run, stepId, { state: "failed", error: msg, port, attempts: tries, summary: `failed \u2192 ${port}` });
      run.data.steps[stepId] = { error: msg };
      run.queue.unshift(...wired);
      return advance(wf, run);
    }
    // nothing wired to the error port — falling through to stop is safer than
    // pretending the failure was handled
  }

  if (policy.do === "skip") {
    run.status = "running";
    mark(run, stepId, { state: "failed", error: msg, attempts: tries, summary: "failed, path dropped" });
    record(run, { stepId, state: "failed", error: msg, summary: "failed, path dropped", item: clip(run.data.item) });
    run.data.steps[stepId] = { error: msg };
    return advance(wf, run);         // the loop, if any, moves to the next item
  }

  mark(run, stepId, { state: "failed", error: msg, attempts: tries });
  record(run, { stepId, state: "failed", error: msg, summary: "stopped the run", item: clip(run.data.item) });
  run.status = "failed";
  run.failedAt = stepId;
  run.endedAt = now();
  return {
    act: "blocked", stepId,
    reason: `${stepId} failed: ${msg}. Nothing after it ran. Fix the cause and call circuit_resume, ` +
      `or circuit_resume with skip to carry on without it.`,
  };
}

/** Pick a failed run back up, either retrying the step or stepping over it. */
export function resume(wf: Workflow, run: Run, skip = false): Directive {
  const stepId = run.failedAt;
  if (!stepId) return { act: "blocked", stepId: "?", reason: `Run ${run.id} is ${run.status} and has nothing to pick up.` };
  const step = wf.steps.find((s) => s.id === stepId);
  if (!step) return { act: "blocked", stepId, reason: `Step '${stepId}' is no longer in this workflow.` };

  run.status = "running";
  run.failedAt = null;
  run.endedAt = undefined;
  if (run.attempts) delete run.attempts[stepId];

  if (skip) {
    mark(run, stepId, { state: "skipped", summary: "you stepped over it" });
    run.queue.unshift(...follow(step, "out"));
  } else {
    mark(run, stepId, { state: "idle", error: undefined, summary: undefined });
    run.queue.unshift(stepId);
  }
  return advance(wf, run);
}

/** Claude reports what happened; the walk continues. */
export function report(wf: Workflow, run: Run, stepId: string, result: any): Directive {
  const step = wf.steps.find((s) => s.id === stepId);
  if (!step) return { act: "blocked", stepId, reason: `No step '${stepId}' in this workflow.` };
  if (run.awaiting?.stepId !== stepId) {
    return { act: "blocked", stepId, reason: `This run is waiting on '${run.awaiting?.stepId ?? "nothing"}', not '${stepId}'.` };
  }
  const was = run.awaiting.act;
  run.awaiting = null;
  run.status = "running";

  let port = "out";
  let summary = "";

  const given = resolve(step.config ?? {}, run.data) as any;

  if (was === "preview") {
    run.data.steps[stepId] = { previewed: true, tool: given.tool, arguments: given.arguments ?? {} };
    mark(run, stepId, { state: "done", port: "out", summary: `would call ${given.tool}` });
    record(run, {
      stepId, state: "done", port: "out", summary: `would call ${given.tool}`,
      input: clip(given.arguments ?? {}), output: "(not called — rehearsal)", item: clip(run.data.item),
    });
    run.queue.unshift(...follow(step, "out"));
    return advance(wf, run);
  }

  if (step.type === "model.classify") {
    const label = String(result?.label ?? "");
    const labels: string[] = (step.config?.labels as string[]) ?? [];
    port = labels.includes(label) ? label : labels[labels.length - 1] ?? "out";
    summary = result?.why ? `${port} — ${result.why}` : port;
    run.data.steps[stepId] = { label: port, why: result?.why ?? null };
  } else if (step.type === "gate.approve") {
    const decision = String(result?.decision ?? "approve");
    if (decision === "reject") {
      mark(run, stepId, { state: "skipped", summary: "you said no" });
      run.status = "cancelled";
      run.endedAt = now();
      return { act: "done", summary: "Stopped — you rejected it." };
    }
    if (result?.edit != null && step.config?.preview) {
      write(run.data, String(step.config.preview), result.edit);
      summary = "approved with edits";
    } else summary = "approved";
    run.data.steps[stepId] = { decision: "approve", edit: result?.edit ?? null };
  } else if (step.type === "trigger.watch") {
    run.data.trigger = result;
    run.data.steps[stepId] = result;
    summary = describeResult(result);
  } else {
    run.data.steps[stepId] = result ?? {};
    summary = describeResult(result);
  }

  mark(run, stepId, { state: "done", port, summary: summary.slice(0, 120) });
  record(run, {
    stepId, state: "done", port, summary: summary.slice(0, 120),
    input: clip(inputFor(step, given, run)), output: clip(result),
    item: clip(run.data.item),
  });
  run.queue.unshift(...follow(step, port));
  return advance(wf, run);
}

/** A person reads this on the chip, so count things rather than naming keys. */
/**
 * What the step was actually handed. Config holds dot paths, not values, and a
 * replay showing you the string "item" instead of the email is useless.
 */
function inputFor(step: Step, cfg: any, run: Run): unknown {
  switch (step.type) {
    case "tool.call":
    case "trigger.watch":
      return cfg.arguments ?? {};
    case "model.classify":
    case "model.extract":
      return pick(run.data, cfg.input ?? "trigger") ?? run.data.trigger;
    case "model.write":
      return Object.fromEntries((cfg.context ?? ["trigger"]).map((p: string) => [p, pick(run.data, p)]));
    case "gate.approve":
      return cfg.preview ? pick(run.data, cfg.preview) : cfg.question;
    case "note.say":
      return cfg.template;
    default:
      return cfg;
  }
}

function describeResult(r: any): string {
  if (r == null) return "ran";
  if (typeof r === "string") return `${count(r.split(/\s+/).length, "word")}`;
  if (Array.isArray(r)) return count(r.length, "item");
  if (typeof r === "object") {
    if (typeof r.text === "string") return count(r.text.split(/\s+/).length, "word");
    // {threads: [...]} reads far better as "2 threads" than as "threads"
    const listy = Object.entries(r).find(([, v]) => Array.isArray(v));
    if (listy) return count((listy[1] as unknown[]).length, singular(listy[0]));
    const keys = Object.keys(r).filter((k) => !/^(ok|success|status|id|ids|uuid|key)$/i.test(k));
    if (!keys.length) return "ran";
    return keys.length <= 2 ? keys.join(" and ") : `${keys.length} fields`;
  }
  return String(r);
}
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const singular = (s: string) => s.replace(/ies$/, "y").replace(/s$/, "");

function write(data: any, path: string, value: unknown) {
  const parts = path.split(".");
  let t = data;
  for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]] ??= {};
  t[parts[parts.length - 1]] = value;
}

function coerce(schema: any, value: unknown) {
  const r = schema.safeParse(value ?? {});
  return r.success ? r.data : (value ?? {});
}

function summarise(run: Run): string {
  const done = run.trace.filter((t) => t.state === "done").length;
  const skipped = run.trace.filter((t) => t.state === "skipped").length;
  return `${done} step${done === 1 ? "" : "s"} ran${skipped ? `, ${skipped} not taken` : ""}.`;
}

export async function save(run: Run) { return getStore().putRun(run); }
