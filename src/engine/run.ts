import { randomUUID } from "node:crypto";
import type { Run, Step, StepTrace, Workflow } from "../graph.js";
import { BY_TYPE, matches, pick, resolve } from "../registry.js";
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
    trace: wf.steps.map((s) => ({ stepId: s.id, state: "idle" as const })),
  };
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
        if (frame.index < frame.items.length && frame.index < frame.limit) {
          run.data.item = frame.items[frame.index];
          run.queue = [...frame.body];
          mark(run, frame.stepId, { state: "running", summary: `item ${frame.index + 1} of ${Math.min(frame.items.length, frame.limit)}` });
          continue;
        }
        run.loops.pop();
        delete run.data.item;
        mark(run, frame.stepId, { state: "done", summary: `${Math.min(frame.items.length, frame.limit)} handled` });
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
      run.queue.unshift(...follow(step, "out"));
      continue;
    }

    /* ---- things Circuit settles on its own ---- */
    if (def.actor === "circuit") {
      if (step.type === "logic.filter") {
        if (matches(cfg, run.data)) {
          mark(run, id, { state: "done", port: "out", summary: "passed" });
          run.queue.unshift(...follow(step, "out"));
        } else {
          mark(run, id, { state: "skipped", summary: "stopped here" });
        }
        continue;
      }
      if (step.type === "logic.branch") {
        const v = String(pick(run.data, cfg.field) ?? "");
        const hit = (cfg.cases ?? []).find((c: any) => String(c.equals).toLowerCase() === v.toLowerCase());
        const port = hit?.port ?? cfg.fallback ?? "else";
        mark(run, id, { state: "done", port, summary: port });
        run.queue.unshift(...follow(step, port));
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
          stepId: id, items, index: 0, limit,
          body: follow(step, "out"),
          after: [...follow(step, "done"), ...run.queue],
        });
        run.queue = [...follow(step, "out")];
        run.data.item = items[0];
        mark(run, id, { state: "running", summary: `item 1 of ${Math.min(items.length, limit)}` });
        continue;
      }
    }

    /* ---- things Claude or the user has to do ---- */
    mark(run, id, { state: "running" });

    if (step.type === "tool.call") {
      if (!cfg.tool) return blocked(run, id, `Step '${id}' has no connector tool bound yet.`);
      run.awaiting = { stepId: id, act: "call_tool" };
      return {
        act: "call_tool", stepId: id, title: step.title,
        tool: cfg.tool, arguments: cfg.arguments ?? {},
        expect: "Call that tool exactly as given, then report the result with circuit_step.",
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

/** Claude reports what happened; the walk continues. */
export function report(wf: Workflow, run: Run, stepId: string, result: any): Directive {
  const step = wf.steps.find((s) => s.id === stepId);
  if (!step) return { act: "blocked", stepId, reason: `No step '${stepId}' in this workflow.` };
  if (run.awaiting?.stepId !== stepId) {
    return { act: "blocked", stepId, reason: `This run is waiting on '${run.awaiting?.stepId ?? "nothing"}', not '${stepId}'.` };
  }
  run.awaiting = null;
  run.status = "running";

  let port = "out";
  let summary = "";

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
  run.queue.unshift(...follow(step, port));
  return advance(wf, run);
}

function describeResult(r: any): string {
  if (r == null) return "done";
  if (typeof r === "string") return `${r.split(/\s+/).length} words`;
  if (Array.isArray(r)) return `${r.length} items`;
  if (typeof r === "object") {
    if (typeof r.text === "string") return `${r.text.split(/\s+/).length} words`;
    const keys = Object.keys(r);
    return keys.length ? keys.slice(0, 3).join(", ") : "done";
  }
  return String(r);
}

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
