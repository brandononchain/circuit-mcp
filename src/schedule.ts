import type { Workflow } from "./graph.js";

/**
 * Circuit has no scheduler. A workflow armed on a schedule depends on someone
 * creating a scheduled task that calls it, and the failure mode is silent: the
 * board says "armed" for three weeks while nothing has called it once.
 *
 * So Circuit tracks two things it can actually check — whether a task was ever
 * reported back, and when the workflow last ran — and says plainly when those
 * disagree with what the board claims.
 */

/** Does this cron expression match that minute? Five fields, UTC. */
export function cronMatches(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const vals = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  return f.every((part, i) => {
    const v = vals[i];
    return part.split(",").some((chunk) => {
      const [range, stepStr] = chunk.split("/");
      const step = stepStr ? parseInt(stepStr, 10) : 1;
      if (!Number.isFinite(step) || step < 1) return false;
      if (range === "*") return v % step === 0;
      const [a, b] = range.split("-").map((n) => parseInt(n, 10));
      if (!Number.isFinite(a)) return false;
      const hi = Number.isFinite(b) ? b : a;
      return v >= a && v <= hi && (v - a) % step === 0;
    });
  });
}

export function isValidCron(expr: string): boolean {
  if (expr.trim().split(/\s+/).length !== 5) return false;
  const from = new Date(Date.UTC(2026, 0, 1));
  return nextFire(expr, from) !== null;
}

/** The next minute this fires after `from`, or null if it never does within a year. */
export function nextFire(expr: string, from: Date): Date | null {
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (cronMatches(expr, t)) return new Date(t.getTime());
  }
  return null;
}

/**
 * The LONGEST gap between firings over the next few, not the shortest. A
 * weekdays-at-one schedule fires 24 hours apart four times and then 72 hours
 * over the weekend; judging it on the 24 would call every Sunday an outage.
 */
export function intervalMinutes(expr: string, from = new Date()): number | null {
  let t = nextFire(expr, from);
  if (!t) return null;
  let widest = 0;
  for (let i = 0; i < 6; i++) {
    const next = nextFire(expr, t);
    if (!next) break;
    widest = Math.max(widest, (next.getTime() - t.getTime()) / 60000);
    t = next;
  }
  return widest ? Math.round(widest) : null;
}

export type Health = {
  workflowId: string;
  name: string;
  state: "fine" | "never confirmed" | "overdue" | "never run" | "no schedule";
  detail: string;
};

/**
 * Two windows late is the threshold: one missed firing is a blip, two is a
 * pattern, and anything tighter would cry wolf on a workflow that runs hourly.
 */
export function health(wf: Workflow, now = new Date()): Health {
  const base = { workflowId: wf.id, name: wf.name };
  if (wf.status !== "armed") return { ...base, state: "fine", detail: "draft — nothing is meant to be calling it" };

  const cron = wf.schedule?.cron;
  if (!cron) {
    return { ...base, state: "no schedule", detail: "armed, but it has no schedule — it only runs when you ask" };
  }
  if (!wf.schedule?.taskId) {
    return {
      ...base, state: "never confirmed",
      detail: `armed on "${wf.schedule?.note || cron}" but no scheduled task was ever reported back. ` +
        `Create one and record it with circuit_scheduled, or nothing will ever call this.`,
    };
  }
  if (!wf.lastRunAt) {
    return { ...base, state: "never run", detail: `task ${wf.schedule.taskId} is on file, but this has never run` };
  }

  const every = intervalMinutes(cron, new Date(wf.lastRunAt));
  if (every == null) return { ...base, state: "fine", detail: `last ran ${wf.lastRunAt}` };
  const lateBy = (now.getTime() - new Date(wf.lastRunAt).getTime()) / 60000;
  if (lateBy > every * 2 + 5) {
    return {
      ...base, state: "overdue",
      detail: `runs about every ${describeMinutes(every)}, but has not run for ${describeMinutes(Math.round(lateBy))}. ` +
        `Check that scheduled task ${wf.schedule.taskId} still exists.`,
    };
  }
  return { ...base, state: "fine", detail: `every ${describeMinutes(every)}, last ran ${wf.lastRunAt}` };
}

export function describeMinutes(m: number): string {
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  if (m < 60 * 24) { const h = Math.round(m / 60); return `${h} hour${h === 1 ? "" : "s"}`; }
  const d = Math.round(m / (60 * 24));
  return `${d} day${d === 1 ? "" : "s"}`;
}
