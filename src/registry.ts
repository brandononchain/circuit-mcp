import { z } from "zod";
import type { Step } from "./graph.js";

/**
 * Circuit owns no integrations. Every step is one of a small set of kinds that
 * either Circuit resolves itself (routing, filtering, looping) or hands to
 * Claude as a directive — a connector tool to call, a judgement to make, or a
 * question to put to the user.
 */
export type Kind = "trigger" | "tool" | "model" | "logic" | "gate" | "note";

export type StepDef = {
  type: string;
  kind: Kind;
  /** The verb printed on the chip. What this step DOES, not what class it is. */
  label: string;
  title: string;
  blurb: string;
  /** who does the work */
  actor: "circuit" | "claude" | "user";
  ports: string[] | "dynamic";
  config: z.ZodTypeAny;
  summary: (config: any, step?: Step) => string;
};

/* ------------------------------------------------------------- conditions */

const Cond = z.object({
  field: z.string().describe("Dot path into run data: 'trigger.subject', 'steps.classify.label', 'item.from'."),
  op: z.enum(["equals", "contains", "matches", "exists", "missing", "gt", "lt"]),
  value: z.string().optional(),
});
export type Cond = z.infer<typeof Cond>;

export const MatchSchema = z.object({
  all: z.array(Cond).default([]).describe("Every condition must hold."),
  any: z.array(Cond).default([]).describe("At least one must hold."),
});

export function pick(data: any, path: string): any {
  return path.split(".").reduce((a, k) => (a == null ? a : a[k]), data);
}

export function test(c: Cond, data: any): boolean {
  const v = pick(data, c.field);
  const s = v == null ? "" : String(v);
  switch (c.op) {
    case "exists": return v != null && s !== "";
    case "missing": return v == null || s === "";
    case "equals": return s.toLowerCase() === String(c.value ?? "").toLowerCase();
    case "contains": return s.toLowerCase().includes(String(c.value ?? "").toLowerCase());
    case "matches": try { return new RegExp(c.value ?? "", "i").test(s); } catch { return false; }
    case "gt": return Number(v) > Number(c.value);
    case "lt": return Number(v) < Number(c.value);
  }
}
export function matches(cfg: z.infer<typeof MatchSchema>, data: any) {
  const all = (cfg.all ?? []).every((c) => test(c, data));
  const any = (cfg.any ?? []).length === 0 || (cfg.any ?? []).some((c) => test(c, data));
  return all && any;
}
/* ------------------------------------------------------ plain English bits */

const VERB: Record<string, string> = {
  equals: "is", contains: "contains", matches: "looks like",
  exists: "is there", missing: "is empty", gt: "is over", lt: "is under",
};

/** "sender contains noreply and subject is there" */
function describeMatch(c: any): string {
  const one = (x: Cond) => {
    const field = (x.field ?? "").split(".").pop() || "it";
    const value = x.value ? ` \u201c${x.value}\u201d` : "";
    return `${field} ${VERB[x.op] ?? x.op}${value}`;
  };
  const all = (c?.all ?? []).map(one).join(" and ");
  const any = (c?.any ?? []).map(one).join(" or ");
  return [all, any].filter(Boolean).join(", and ") || "nothing set yet";
}

/** ["a","b","c"] -> "a, b or c" */
export function list(items: string[], conj = "or"): string {
  const xs = (items ?? []).filter(Boolean);
  if (!xs.length) return "";
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(", ")} ${conj} ${xs[xs.length - 1]}`;
}

/** "Gmail:search_threads" -> "Gmail | search threads" */
export function humanTool(t?: string): string {
  if (!t) return "no connector picked yet";
  const [service, ...rest] = t.split(/[:.]/);
  const action = rest.join(" ").replace(/[_-]+/g, " ").trim();
  const svc = service.replace(/[_-]+/g, " ");
  return action ? `${svc} \u00b7 ${action}` : svc;
}

/* ------------------------------------------------------------------ steps */

const ToolCall = z.object({
  tool: z.string().describe(
    "Exact name of a tool from one of the user's own connectors, as it appears in your tool list " +
    "(e.g. 'Gmail:search_threads'). Circuit never calls it — you do."),
  arguments: z.record(z.any()).default({}).describe(
    "Arguments for that tool. Use {{trigger.x}}, {{steps.<id>.y}} or {{item.z}} anywhere in a string " +
    "and Circuit substitutes the live value before handing the call back to you."),
  writes: z.boolean().optional().describe(
    "Does this change something outside Circuit — send, post, create, delete? Circuit guesses from " +
    "the verb in the tool name and gets it right most of the time; set this when the guess would be " +
    "wrong. A test run never actually calls a step that writes."),
});

export const STEPS: StepDef[] = [
  {
    type: "trigger.ask", kind: "trigger", label: "when", actor: "user",
    title: "When I ask",
    blurb: "The workflow runs when the user asks for it in the conversation. The default.",
    ports: ["out"], config: z.object({}),
    summary: () => "you start it from the chat",
  },
  {
    type: "trigger.schedule", kind: "trigger", label: "every", actor: "user",
    title: "On a schedule",
    blurb:
      "Runs on a schedule. Circuit stores the schedule; you set it up with the user's scheduled tasks " +
      "so a future session calls circuit_run.",
    ports: ["out"],
    config: z.object({
      cron: z.string().describe("5 field cron, UTC."),
      note: z.string().default("").describe("Plain English version, for the chip."),
    }),
    summary: (c) => c.note || c.cron || "no schedule set yet",
  },
  {
    type: "trigger.watch", kind: "trigger", label: "watch", actor: "claude",
    title: "When something new shows up",
    blurb:
      "Runs a connector tool to look for new items, and starts one pass per item found. " +
      "Pair it with logic.each when the tool returns a list.",
    ports: ["out"],
    config: ToolCall,
    summary: (c) => humanTool(c.tool),
  },

  {
    type: "tool.call", kind: "tool", label: "do", actor: "claude",
    title: "Use a connector",
    blurb:
      "The workhorse. Names a tool from the user's own connectors and the arguments to call it with. " +
      "Circuit resolves the templates and hands you the call; you make it and report the result back.",
    ports: ["out"],
    config: ToolCall,
    summary: (c) => humanTool(c.tool),
  },

  {
    type: "model.classify", kind: "model", label: "decide", actor: "claude",
    title: "Decide which kind it is",
    blurb: "You read the input and pick one label. The label becomes the output port, so wires fan out from it.",
    ports: "dynamic",
    config: z.object({
      labels: z.array(z.string()).min(2).describe("The buckets. Each becomes an output port."),
      input: z.string().default("trigger").describe("Dot path to what should be read."),
      instructions: z.string().default("").describe("How to decide. Say what tips a borderline case."),
    }),
    summary: (c) => c.labels?.length ? `sorts into ${list(c.labels)}` : "no buckets set yet",
  },
  {
    type: "model.write", kind: "model", label: "write", actor: "claude",
    title: "Write something",
    blurb: "You draft the text. Nothing is sent here — a later tool.call step does that.",
    ports: ["out"],
    config: z.object({
      instructions: z.string().describe("What to write, and what it must or must not say."),
      voice: z.string().default("").describe("How it should sound. Quote the user's own words if they gave you any."),
      context: z.array(z.string()).default(["trigger"]).describe("Dot paths to read before writing."),
      maxWords: z.number().default(160),
    }),
    summary: (c) => [c.voice ? `in ${c.voice}’s voice` : "", `under ${c.maxWords ?? 160} words`]
      .filter(Boolean).join(", "),
  },
  {
    type: "model.extract", kind: "model", label: "read", actor: "claude",
    title: "Pull out the details",
    blurb: "You read the input and return the named fields as structured data.",
    ports: ["out"],
    config: z.object({
      fields: z.array(z.object({ name: z.string(), description: z.string() })).min(1),
      input: z.string().default("trigger"),
    }),
    summary: (c) => c.fields?.length ? `pulls out ${list(c.fields.map((f: any) => f.name), "and")}` : "no fields set yet",
  },

  {
    type: "logic.filter", kind: "logic", label: "only if", actor: "circuit",
    title: "Continue only if",
    blurb: "Circuit checks the conditions itself and stops this path when they do not hold.",
    ports: ["out"],
    config: MatchSchema,
    summary: (c) => describeMatch(c),
  },
  {
    type: "logic.branch", kind: "logic", label: "route", actor: "circuit",
    title: "Branch on a value",
    blurb: "Circuit sends the run down a named wire based on a value it already has.",
    ports: "dynamic",
    config: z.object({
      field: z.string(),
      cases: z.array(z.object({ equals: z.string(), port: z.string() })).min(1),
      fallback: z.string().default("else"),
    }),
    summary: (c) => `on ${(c.field ?? "?").split(".").pop()}: ${list((c.cases ?? []).map((x: any) => x.port))}`,
  },
  {
    type: "logic.each", kind: "logic", label: "for each", actor: "circuit",
    title: "For each",
    blurb:
      "Runs everything downstream once per item in a list. Inside the loop, {{item.…}} is the current item. " +
      "Wire the 'done' port to whatever should happen after the last one.",
    ports: ["out", "done"],
    config: z.object({
      list: z.string().describe("Dot path to the array, e.g. 'steps.search.threads'."),
      limit: z.number().default(10).describe("Stop after this many, so a big inbox cannot run away."),
    }),
    summary: (c) => `one at a time, up to ${c.limit ?? 10}`,
  },

  {
    type: "logic.branches", kind: "logic", label: "all of", actor: "circuit",
    title: "Do several things",
    blurb:
      "Fans out to every wire on its `out` port, runs each branch to the end, then continues from the " +
      "`join` port once they have all finished. Use it when several things must happen before one last " +
      "step — three lookups before a summary, say. Circuit walks the branches one after another, since " +
      "you do one thing at a time anyway; what this buys is the join, not speed.",
    ports: ["out", "join"],
    config: z.object({
      together: z.boolean().default(false).describe(
        "Hand Claude every branch at once instead of one at a time, so three lookups cost one turn " +
        "rather than three. Only allowed when every branch is a single tool.call with nothing after " +
        "it — that is the shape where doing them together is unambiguous."),
    }),
    summary: (c, step) => {
      const n = (step?.next ?? []).filter((e) => (e.port ?? "out") === "out").length;
      if (!n) return "nothing wired yet";
      return c?.together ? `${n} at once, then carries on` : `${n} in turn, then carries on`;
    },
  },
  {
    type: "gate.approve", kind: "gate", label: "ask you", actor: "user",
    title: "Hold for my approval",
    blurb:
      "Parks the run and shows the user what is about to happen, on the board, with an editable draft. " +
      "Nothing downstream runs until they answer.",
    ports: ["out"],
    config: z.object({
      preview: z.string().default("").describe("Dot path to what the user should look at, e.g. 'steps.draft.text'."),
      question: z.string().default("Send this?"),
    }),
    summary: (c) => c.question || "nothing moves until you say so",
  },
  {
    type: "note.say", kind: "note", label: "report", actor: "claude",
    title: "Tell me what happened",
    blurb: "You report back in the conversation. Good as the last step of a run.",
    ports: ["out"],
    config: z.object({
      template: z.string().describe("What to say. Templates resolve, e.g. 'Replied to {{item.from}}.'"),
    }),
    summary: (c) => c.template ? `\u201c${String(c.template).slice(0, 46)}\u201d` : "nothing to say yet",
  },
];

export const BY_TYPE = new Map(STEPS.map((s) => [s.type, s]));

export function summarise(step: Step): string {
  const def = BY_TYPE.get(step.type);
  if (!def) return step.type;
  const parsed = def.config.safeParse(step.config ?? {});
  try { return def.summary(parsed.success ? parsed.data : step.config ?? {}, step); }
  catch { return step.type; }
}

export function portsOf(step: Step): string[] {
  const base = basePorts(step);
  const err = step.onError?.do === "route" ? (step.onError.port || "error") : null;
  return err && !base.includes(err) ? [...base, err] : base;
}

function basePorts(step: Step): string[] {
  const def = BY_TYPE.get(step.type);
  if (!def) return ["out"];
  if (def.ports !== "dynamic") return def.ports;
  if (step.type === "model.classify") return (step.config?.labels as string[]) ?? ["out"];
  if (step.type === "logic.branch") {
    const cs = (step.config?.cases as any[]) ?? [];
    return [...cs.map((c) => c.port), step.config?.fallback ?? "else"];
  }
  return ["out"];
}

/** The tool referenced by a step, if any — used to show the connector on the chip. */
export function toolOf(step: Step): string | null {
  const t = step.config?.tool;
  return typeof t === "string" && t ? t : null;
}

export function catalog() {
  return STEPS.map((s) => ({
    type: s.type, kind: s.kind, label: s.label, title: s.title, blurb: s.blurb,
    doneBy: s.actor,
    ports: s.ports === "dynamic" ? "dynamic — see blurb" : s.ports,
    config: sketch(s.config),
  }));
}

/** A compact shape of a zod object — cheaper to read than full JSON Schema. */
function sketch(schema: z.ZodTypeAny): Record<string, string> {
  const out: Record<string, string> = {};
  const def: any = (schema as any)._def;
  const shape = def?.shape?.() ?? def?.innerType?._def?.shape?.();
  if (!shape) return {};
  for (const [k, v] of Object.entries<any>(shape)) {
    const d = v._def?.description ?? v._def?.innerType?._def?.description ?? "";
    const t = v._def?.typeName?.replace("Zod", "").toLowerCase() ?? "any";
    const dv = v._def?.defaultValue ? JSON.stringify(v._def.defaultValue()) : undefined;
    out[k] = [t, dv !== undefined ? `= ${dv}` : "", d].filter(Boolean).join(" ").trim();
  }
  return out;
}

/* ---------------------------------------------------------------- templates */

/** Replace {{path}} anywhere inside a value, using the run's data. */
export function resolve<T>(value: T, data: any): T {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole) return pick(data, whole[1]) as T;          // keep the real type
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => {
      const v = pick(data, p.trim());
      return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, data)) as T;
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value as any)) out[k] = resolve(v, data);
    return out;
  }
  return value;
}
