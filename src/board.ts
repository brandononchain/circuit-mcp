import type { Run, Workflow } from "./graph.js";
import { BY_TYPE, portsOf, summarise, toolOf } from "./registry.js";
import { storeKind } from "./store/index.js";

/** Everything the canvas needs to draw itself. Kept small on purpose. */
export function toBoard(wf: Workflow, run?: Run | null, extra: Record<string, unknown> = {}) {
  return {
    workflow: {
      id: wf.id,
      name: wf.name,
      description: wf.description,
      status: wf.status,
      entry: wf.entry,
      steps: wf.steps.map((s) => ({
        id: s.id,
        type: s.type,
        kind: BY_TYPE.get(s.type)?.kind ?? "tool",
        actor: BY_TYPE.get(s.type)?.actor ?? "claude",
        title: s.title,
        summary: summarise(s),
        tool: toolOf(s),
        ports: portsOf(s),
        next: s.next,
        enabled: s.enabled !== false,
        position: s.position ?? { col: 0, lane: 0 },
      })),
    },
    run: run
      ? {
          id: run.id, status: run.status, mode: run.mode,
          startedAt: run.startedAt, endedAt: run.endedAt,
          trace: run.trace, awaiting: run.awaiting ?? null,
        }
      : null,
    storage: storeKind(),
    ...extra,
  };
}

/** One line per step — what the model reads back. */
export function describe(wf: Workflow, run?: Run | null): string {
  const state = new Map((run?.trace ?? []).map((t) => [t.stepId, t]));
  const lines = wf.steps.map((s) => {
    const t = state.get(s.id);
    const mark = t ? ` [${t.state}${t.summary ? ": " + t.summary : ""}]` : "";
    const wires = s.next.map((e) => `${e.port === "out" ? "" : e.port + "→"}${e.to}`).join(", ");
    return `  ${s.id}  ${s.type}  "${s.title}"${wires ? `  → ${wires}` : ""}${mark}`;
  });
  const head = `${wf.name} (${wf.id}) — ${wf.status}, ${wf.steps.length} steps, entry: ${wf.entry}`;
  const tail = run
    ? `\nrun ${run.id}: ${run.status}${run.awaiting ? ` — at ${run.awaiting.stepId}` : ""}`
    : "";
  return [head, ...lines].join("\n") + tail;
}
