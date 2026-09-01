import { z } from "zod";

/** A single chip on the board. */
export const StepSchema = z.object({
  id: z.string().describe("Short stable id, e.g. 'classify'. Used by connections."),
  type: z.string().describe("Node type from the catalog, e.g. 'gmail.reply'."),
  title: z.string().describe("Human label shown on the chip. Write it the way the user would say it."),
  config: z.record(z.any()).default({}).describe("Type specific settings. See circuit_catalog."),
  next: z.array(z.object({
    port: z.string().default("out").describe("Which output of this step the wire leaves from."),
    to: z.string().describe("id of the step it goes to."),
  })).default([]).describe("Outgoing wires."),
  enabled: z.boolean().default(true),
  position: z.object({ col: z.number().int(), lane: z.number().int() }).optional()
    .describe("Board placement. Omit and Circuit lays it out."),
});
export type Step = z.infer<typeof StepSchema>;

export const WorkflowSpecSchema = z.object({
  name: z.string().describe("Short name, e.g. 'Inbox triage & reply'."),
  description: z.string().default("").describe("One line on what it does and when it fires."),
  steps: z.array(StepSchema).min(1).describe("Every step, including the trigger, in the order you want them read."),
  entry: z.string().optional().describe("id of the trigger step. Defaults to the first trigger found."),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

export type Workflow = {
  id: string;
  workspace: string;
  name: string;
  description: string;
  steps: Step[];
  entry: string;
  status: "draft" | "armed";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type StepRunState =
  | "idle" | "running" | "done" | "skipped" | "held" | "failed";

export type StepTrace = {
  stepId: string;
  state: StepRunState;
  port?: string;
  summary?: string;
  output?: unknown;
  error?: string;
  ms?: number;
};

export type LoopFrame = {
  stepId: string; items: any[]; index: number; limit: number;
  body: string[]; after: string[];
};

export type Run = {
  id: string;
  workflowId: string;
  workspace: string;
  status: "running" | "awaiting_approval" | "succeeded" | "failed" | "cancelled";
  mode: "test" | "live";
  startedAt: string;
  endedAt?: string;
  /** everything a template can reach: {{trigger.x}}, {{steps.id.y}}, {{item.z}} */
  data: { trigger: any; steps: Record<string, any>; item?: any };
  /** depth-first list of steps still to visit */
  queue: string[];
  loops: LoopFrame[];
  /** the step Claude is currently working on, if any */
  awaiting: { stepId: string; act: string } | null;
  trace: StepTrace[];
};

/* ---------------------------------------------------------------- layout -- */

/**
 * Deterministic board layout.
 *
 * Columns come from a longest-path relaxation, so a chip always sits to the
 * right of everything that can reach it. A `logic.each` loop is the one special
 * case: whatever hangs off its `done` port belongs after the whole loop body,
 * not one column after the loop itself.
 *
 * Lanes read like the spec — the first wire out of a step carries on in the
 * same lane, later wires fan downward in the order they were written.
 */
export function layout(steps: Step[], entry: string): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const col = new Map<string, number>(steps.map((s) => [s.id, 0]));
  col.set(entry, 0);

  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const e of byId.get(id)?.next ?? []) visit(e.to);
  };
  visit(entry);
  for (const s of steps) visit(s.id);

  const relax = () => {
    for (let pass = 0; pass < steps.length + 2; pass++) {
      let moved = false;
      for (const s of steps) {
        for (const e of s.next) {
          const want = (col.get(s.id) ?? 0) + 1;
          if ((col.get(e.to) ?? 0) < want) { col.set(e.to, want); moved = true; }
        }
      }
      if (!moved) break;
    }
  };
  relax();

  // push each loop's exit past the deepest chip inside the loop
  for (const s of steps) {
    if (s.type !== "logic.each") continue;
    const body = new Set<string>();
    const walkBody = (id: string) => {
      if (body.has(id) || id === s.id) return;
      body.add(id);
      for (const e of byId.get(id)?.next ?? []) walkBody(e.to);
    };
    for (const e of s.next) if ((e.port ?? "out") === "out") walkBody(e.to);
    if (!body.size) continue;
    const deepest = Math.max(...[...body].map((id) => col.get(id) ?? 0));
    for (const e of s.next) {
      if ((e.port ?? "out") !== "done") continue;
      if (!body.has(e.to)) col.set(e.to, Math.max(col.get(e.to) ?? 0, deepest + 1));
    }
  }
  relax();

  const lane = new Map<string, number>();
  const taken = new Map<number, Set<number>>();
  const claim = (c: number, preferred: number) => {
    const used = taken.get(c) ?? new Set<number>();
    let l = Math.max(0, preferred);
    while (used.has(l)) l++;
    used.add(l);
    taken.set(c, used);
    return l;
  };
  lane.set(entry, claim(col.get(entry) ?? 0, 0));
  for (const id of order) {
    const s = byId.get(id);
    if (!s) continue;
    const base = lane.get(id) ?? 0;
    s.next.forEach((e, i) => {
      if (lane.has(e.to)) return;
      lane.set(e.to, claim(col.get(e.to) ?? 0, base + i));
    });
  }
  for (const s of steps) if (!lane.has(s.id)) lane.set(s.id, claim(col.get(s.id) ?? 0, 0));

  return steps.map((s) => ({
    ...s,
    position: s.position ?? { col: col.get(s.id) ?? 0, lane: lane.get(s.id) ?? 0 },
  }));
}

export function findEntry(steps: Step[], declared?: string): string {
  if (declared && steps.some((s) => s.id === declared)) return declared;
  const trig = steps.find((s) => s.type.startsWith("trigger."));
  return trig?.id ?? steps[0].id;
}
