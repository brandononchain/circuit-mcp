import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BOARD_HTML } from "./app/board.generated.js";
import { StepSchema, findEntry, layout, type Run, type Workflow } from "./graph.js";
import { BY_TYPE, catalog } from "./registry.js";
import { describe, toBoard } from "./board.js";
import { getStore } from "./store/index.js";
import { advance, fail, newRun, report, resume, type Directive } from "./engine/run.js";
import { checkTools, describeMissing, requiredTools, stepWrites, unguardedWrites, type ToolBinding } from "./tools.js";

export const APP_URI = "ui://circuit/board.html";
export const APP_MIME = "text/html;profile=mcp-app";

const now = () => new Date().toISOString();
const say = (text: string) => ({ content: [{ type: "text" as const, text }] });
const oops = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const ok = (text: string, props: unknown) => ({
  content: [{ type: "text" as const, text }],
  structuredContent: props as Record<string, unknown>,
  _meta: { "ui/props": props, ui: { props } },
});

const INSTRUCTIONS = `Circuit is a visual workflow builder that runs on top of the connectors the user
already has. It owns no integrations and holds no credentials: it stores the workflow, draws it on a
board inside this conversation, and then drives you one step at a time.

How to use it:
 1. circuit_catalog once, to see the step types and their config keys.
 1b. circuit_bind once per conversation, reporting the connector tools you can actually see. Circuit
    checks every step against that list, so a mistyped tool name becomes an error while you are still
    drawing instead of a dead end halfway through a run.
 2. circuit_design with the WHOLE workflow in one call. The board draws each chip as your arguments
    stream in, so one well-ordered call looks far better than several small ones. For a tool.call step,
    put the exact name of a tool from YOUR OWN tool list in config.tool — Gmail, Slack, Airtable,
    whatever the user has connected. Never invent a tool name; if the user has nothing suitable
    connected, say so instead of guessing.
 3. circuit_run to start it. It returns ONE directive. Do that one thing, then circuit_step with the
    result. Repeat until the directive is {"act":"done"}. Do not batch, skip, or reorder steps, and do
    not run a tool the directive did not name.
 4. On {"act":"ask"}, stop and let the user answer on the board.
 5. If a directive does not work — the tool errors, the connector refuses, the data is not there —
    report it with circuit_step's 'error' field. Do not substitute a plausible result: the step's own
    error policy decides what happens next, and it can only do that if you say what really happened.

Templates like {{trigger.subject}}, {{steps.draft.text}} and {{item.from}} are resolved by Circuit
before a directive reaches you — never fill them in yourself.`;

export function buildServer(workspace: string): McpServer {
  const store = getStore();
  const server = new McpServer(
    { name: "circuit", version: "0.4.0", title: "Circuit" },
    { instructions: INSTRUCTIONS },
  );

  /* ------------------------------------------------------------- the app -- */

  server.registerResource(
    "Circuit board", APP_URI,
    {
      mimeType: APP_MIME,
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] },
          prefersBorder: false,
        },
      },
    },
    async () => ({ contents: [{ uri: APP_URI, mimeType: APP_MIME, text: BOARD_HTML }] }),
  );

  const ui = (visibility?: ("model" | "app")[]) => ({
    ui: { resourceUri: APP_URI, ...(visibility ? { visibility } : {}) },
    "ui/resourceUri": APP_URI,
  });

  const load = async (id: string) => store.getWorkflow(workspace, id);

  /* ---------------------------------------------------------------- read -- */

  server.registerTool("circuit_catalog", {
    title: "List the step kit",
    description:
      "Every step type Circuit can place and its config keys. Read this before your first design so " +
      "every `type` you write is real. Note which steps you perform and which Circuit settles itself.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => say(JSON.stringify(catalog(), null, 1)));

  server.registerTool("circuit_list", {
    title: "List workflows",
    description: "Every workflow saved here, with its id and status.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const all = await store.listWorkflows(workspace);
    if (!all.length) return say("No workflows yet. circuit_design creates the first one.");
    return say(all.map((w) => `${w.id}  ${w.status.padEnd(5)}  ${w.name}  (${w.steps.length} steps)`).join("\n"));
  });

  /* ---------------------------------------------------------- connectors -- */

  server.registerTool("circuit_bind", {
    title: "Report the connectors you have",
    description:
      "Tell Circuit which connector tools you can actually call, so it can check workflows against " +
      "reality. Send the EXACT names as they appear in your own tool list — every tool from every " +
      "connector the user has, not just the ones you think this workflow needs. Call this once per " +
      "conversation before designing, and again if the user connects something new. Circuit stores " +
      "only the names you send; it never calls them.",
    inputSchema: {
      tools: z.array(z.object({
        name: z.string().describe("Exact tool name, e.g. 'Gmail:send_message'."),
        hint: z.string().optional().describe("A few words on what it does, so Circuit can suggest it later."),
      })).min(1).describe("Every connector tool you can see."),
    },
  }, async ({ tools }) => {
    const seen = new Map<string, { name: string; hint?: string }>();
    for (const t of tools) if (t.name?.trim()) seen.set(t.name.trim(), { name: t.name.trim(), hint: t.hint });
    const binding: ToolBinding = { workspace, boundAt: now(), tools: [...seen.values()] };
    await store.putTools(binding);

    const services = [...new Set(binding.tools.map((t) => t.name.split(/[:.]/)[0]))];
    const drafts = await store.listWorkflows(workspace);
    const broken = drafts
      .map((wf) => ({ wf, check: checkTools(wf.steps, binding) }))
      .filter((x) => x.check.missing.length);
    return say(
      `Bound ${binding.tools.length} tools across ${services.length} connectors: ${services.join(", ")}.` +
      (broken.length
        ? `\n\nHeads up — ${broken.length} saved workflow${broken.length === 1 ? "" : "s"} now fail${broken.length === 1 ? "s" : ""} this check:\n` +
          broken.map((b) => `${b.wf.id} (${b.wf.name})\n${describeMissing(b.check)}`).join("\n")
        : ""),
    );
  });

  server.registerTool("circuit_tools", {
    title: "Show the connectors on file",
    description: "What Circuit believes you can call, and when you last told it.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const b = await store.getTools(workspace);
    if (!b) return say("No tool list on file. Call circuit_bind so Circuit can check workflows against what you actually have.");
    const by = new Map<string, string[]>();
    for (const t of b.tools) {
      const [svc, ...rest] = t.name.split(/[:.]/);
      by.set(svc, [...(by.get(svc) ?? []), rest.join(".") || t.name]);
    }
    const lines = [...by.entries()].map(([svc, actions]) => `${svc}  (${actions.length})  ${actions.join(", ")}`);
    return say(`${b.tools.length} tools, bound ${b.boundAt}.\n\n${lines.join("\n")}`);
  });

  /* -------------------------------------------------------------- design -- */

  server.registerTool("circuit_design", {
    title: "Design a workflow",
    description:
      "Draw a whole automation on the board. Send every step in one call, trigger first, in reading " +
      "order — the canvas places each chip as your arguments arrive, so the user watches it being " +
      "built. For tool.call and trigger.watch steps, config.tool must be the exact name of a tool you " +
      "can actually see in your own tool list. Pass workflowId to replace an existing workflow.",
    inputSchema: {
      workflowId: z.string().optional().describe("Omit to create a new one."),
      name: z.string().describe("Short name, e.g. 'Inbox triage & reply'."),
      description: z.string().default("").describe("One line: what it does and when it fires."),
      entry: z.string().optional().describe("id of the trigger step. Defaults to the first trigger."),
      steps: z.array(StepSchema).min(1).describe("Every step, trigger first, in reading order."),
    },
    _meta: ui(),
  }, async ({ workflowId, name, description, entry, steps }) => {
    const unknown = steps.filter((s) => !BY_TYPE.has(s.type));
    if (unknown.length) {
      return oops(`Unknown step type(s): ${unknown.map((s) => s.type).join(", ")}. Call circuit_catalog and use a type from it.`);
    }
    const e = findEntry(steps, entry);
    const existing = workflowId ? await load(workflowId) : null;
    const wf: Workflow = {
      id: existing?.id ?? workflowId ?? `wf_${randomUUID().slice(0, 8)}`,
      workspace, name, description: description ?? "",
      steps: layout(steps, e), entry: e,
      status: existing?.status ?? "draft",
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    await store.putWorkflow(wf);
    const binding = await store.getTools(workspace);
    const check = checkTools(wf.steps, binding);
    const needs = [...new Set(requiredTools(wf.steps).map((t) => t.tool))];

    // The board is saved either way — the wrong chips are easier to see than to
    // describe, and they are marked on the canvas. Running is what gets blocked.
    const note = check.missing.length
      ? `\n\n${describeMissing(check)}\nThe board is saved and those steps are flagged on it. ` +
        `Fix them with circuit_patch; circuit_run will refuse until you do.`
      : !check.bound && needs.length
        ? `\n\nConnector tools this needs: ${needs.join(", ")}. No tool list on file — call circuit_bind ` +
          `so Circuit can check these for you.`
        : `\n\nEvery connector it needs is one you have. Show the user the board, then circuit_run.`;
    return ok(describe(wf) + note, toBoard(wf, null, { phase: "design", tools: check }));
  });

  server.registerTool("circuit_open", {
    title: "Open a workflow",
    description: "Put an existing workflow back on the board, with its most recent run.",
    inputSchema: { workflowId: z.string() },
    _meta: ui(),
    annotations: { readOnlyHint: true },
  }, async ({ workflowId }) => {
    const wf = await load(workflowId);
    if (!wf) return oops(`No workflow ${workflowId}.`);
    const [last] = await store.listRuns(workspace, workflowId, 1);
    return ok(describe(wf, last), toBoard(wf, last, { phase: last ? "run" : "design" }));
  });

  const PatchOp = z.discriminatedUnion("op", [
    z.object({ op: z.literal("add_step"), step: StepSchema, after: z.string().optional(), port: z.string().default("out") }),
    z.object({ op: z.literal("remove_step"), stepId: z.string() }),
    z.object({ op: z.literal("update_step"), stepId: z.string(), title: z.string().optional(), config: z.record(z.any()).optional() }),
    z.object({ op: z.literal("connect"), from: z.string(), to: z.string(), port: z.string().default("out") }),
    z.object({ op: z.literal("disconnect"), from: z.string(), to: z.string() }),
  ]);

  server.registerTool("circuit_patch", {
    title: "Edit a workflow",
    description:
      "Change an existing board without redrawing it — add, remove or reconfigure steps and rewire " +
      "them. Prefer this over circuit_design once a workflow exists: it keeps the user's own layout.",
    inputSchema: { workflowId: z.string(), ops: z.array(PatchOp).min(1).describe("Applied in order.") },
    _meta: ui(),
  }, async ({ workflowId, ops }) => {
    const wf = await load(workflowId);
    if (!wf) return oops(`No workflow ${workflowId}.`);
    for (const o of ops) {
      if (o.op === "add_step") {
        if (!BY_TYPE.has(o.step.type)) return oops(`Unknown step type '${o.step.type}'.`);
        wf.steps.push(o.step);
        if (o.after) wf.steps.find((s) => s.id === o.after)?.next.push({ port: o.port, to: o.step.id });
      } else if (o.op === "remove_step") {
        wf.steps = wf.steps.filter((s) => s.id !== o.stepId);
        for (const s of wf.steps) s.next = s.next.filter((e) => e.to !== o.stepId);
      } else if (o.op === "update_step") {
        const s = wf.steps.find((x) => x.id === o.stepId);
        if (!s) return oops(`No step ${o.stepId}.`);
        if (o.title) s.title = o.title;
        if (o.config) s.config = { ...s.config, ...o.config };
      } else if (o.op === "connect") {
        const s = wf.steps.find((x) => x.id === o.from);
        if (!s) return oops(`No step ${o.from}.`);
        if (!s.next.some((e) => e.to === o.to && e.port === o.port)) s.next.push({ port: o.port, to: o.to });
      } else if (o.op === "disconnect") {
        const s = wf.steps.find((x) => x.id === o.from);
        if (s) s.next = s.next.filter((e) => e.to !== o.to);
      }
    }
    wf.entry = findEntry(wf.steps, wf.entry);
    wf.steps = layout(wf.steps, wf.entry);
    wf.version += 1; wf.updatedAt = now();
    await store.putWorkflow(wf);
    const check = checkTools(wf.steps, await store.getTools(workspace));
    return ok(
      describe(wf) + (check.missing.length ? `\n\n${describeMissing(check)}` : ""),
      toBoard(wf, null, { phase: "design", tools: check }),
    );
  });

  /* ----------------------------------------------------------------- run -- */

  const withDirective = (wf: Workflow, run: Run, d: Directive) =>
    ok(
      `${describe(wf, run)}\n\n--- do this next ---\n${JSON.stringify(d, null, 1)}`,
      toBoard(wf, run, { phase: "run", directive: d }),
    );

  server.registerTool("circuit_run", {
    title: "Start a run",
    description:
      "Begin a run and get the FIRST directive. Do exactly that one thing, then call circuit_step with " +
      "the result to get the next one. In mode 'test' any step that writes comes back as {\"act\":" +
      "\"preview\"} instead — show the user what would go out and call nothing. Use test before the " +
      "first live run of anything that sends.",
    inputSchema: {
      workflowId: z.string(),
      mode: z.enum(["test", "live"]).default("live"),
      trigger: z.record(z.any()).optional()
        .describe("Starting payload, reachable as {{trigger.…}}. Omit for a trigger.watch workflow."),
    },
    _meta: ui(),
  }, async ({ workflowId, mode, trigger }) => {
    const wf = await load(workflowId);
    if (!wf) return oops(`No workflow ${workflowId}.`);

    const binding = await store.getTools(workspace);
    const check = checkTools(wf.steps, binding);
    if (check.missing.length) {
      return oops(
        `This workflow will not run as written.\n\n${describeMissing(check)}\n\n` +
        `Nothing has started. Fix the tool names with circuit_patch and call circuit_run again.`,
      );
    }
    const run = newRun(wf, trigger ?? {}, mode);
    const d = advance(wf, run);
    await store.putRun(run);
    const unchecked = !check.bound && check.present.length
      ? `\n\nNo tool list on file, so Circuit could not check the ${check.present.length} connector ` +
        `tool${check.present.length === 1 ? "" : "s"} this needs. Call circuit_bind if a directive names ` +
        `something you cannot call.`
      : "";
    const res = withDirective(wf, run, d);
    return { ...res, content: [{ type: "text" as const, text: res.content[0].text + unchecked }] };
  });

  server.registerTool("circuit_step", {
    title: "Report a step and get the next one",
    description:
      "Report what came back from the directive Circuit gave you, and receive the next directive. " +
      "Send the tool's result verbatim for a call_tool step; {\"label\":…,\"why\":…} for a classify; " +
      "{\"text\":…} for a write; the extracted object for an extract; {\"decision\":\"approve\"|\"reject\"," +
      "\"edit\":…} for an ask; {} for a say. Keep calling until you get {\"act\":\"done\"}.",
    inputSchema: {
      runId: z.string(),
      stepId: z.string().describe("The stepId from the directive you just carried out."),
      result: z.any().optional().describe("What came back. Verbatim — do not summarise it."),
      error: z.string().optional().describe(
        "Set this instead of `result` when the step did not work — the tool errored, the connector " +
        "refused, the data was not there. Say what actually went wrong. Never paper over a failure " +
        "with a made-up result; what happens next is the step's own error policy, and Circuit needs " +
        "the truth to apply it."),
    },
    _meta: ui(),
  }, async ({ runId, stepId, result, error }) => {
    const run = await store.getRun(workspace, runId);
    if (!run) return oops(`No run ${runId}.`);
    const wf = await load(run.workflowId);
    if (!wf) return oops(`Workflow ${run.workflowId} is gone.`);
    const d = error ? fail(wf, run, stepId, error) : report(wf, run, stepId, result ?? {});
    await store.putRun(run);
    return withDirective(wf, run, d);
  });

  server.registerTool("circuit_resume", {
    title: "Pick up a failed run",
    description:
      "A run that stopped on a failure keeps everything it had. Call this once the cause is fixed and " +
      "Circuit hands you the same directive again, or pass skip to step over that one and carry on. " +
      "Use it rather than starting a fresh run — the earlier steps already happened, and running them " +
      "twice would repeat their side effects.",
    inputSchema: {
      runId: z.string(),
      skip: z.boolean().default(false).describe("Step over the failed step instead of trying it again."),
    },
    _meta: ui(["app", "model"]),
  }, async ({ runId, skip }) => {
    const run = await store.getRun(workspace, runId);
    if (!run) return oops(`No run ${runId}.`);
    if (!run.failedAt) return oops(`Run ${runId} is ${run.status} — there is nothing to pick up.`);
    const wf = await load(run.workflowId);
    if (!wf) return oops(`Workflow ${run.workflowId} is gone.`);
    const d = resume(wf, run, skip);
    await store.putRun(run);
    return withDirective(wf, run, d);
  });

  server.registerTool("circuit_runs", {
    title: "Show recent runs",
    description: "Run history, newest first, with anything still waiting on the user called out.",
    inputSchema: { workflowId: z.string().optional(), limit: z.number().default(10) },
    _meta: ui(),
    annotations: { readOnlyHint: true },
  }, async ({ workflowId, limit }) => {
    const runs = await store.listRuns(workspace, workflowId, limit);
    if (!runs.length) return say("No runs yet.");
    const wf = await load(runs[0].workflowId);
    const lines = runs.map((r) =>
      `${r.id}  ${r.status.padEnd(18)} ${r.mode.padEnd(4)} ${r.startedAt}${r.awaiting ? `  at ${r.awaiting.stepId}` : ""}`);
    return wf ? ok(lines.join("\n"), toBoard(wf, runs[0], { phase: "run" })) : say(lines.join("\n"));
  });

  server.registerTool("circuit_arm", {
    title: "Mark a workflow live",
    description:
      "Marks the workflow live. Circuit has no scheduler of its own — after arming, set up one of the " +
      "user's scheduled tasks to call circuit_run on this id. Refuses if a step would write with no " +
      "approval gate in front of it, because that is a thing to decide on purpose.",
    inputSchema: {
      workflowId: z.string(),
      force: z.boolean().default(false).describe(
        "Arm even though a step writes with no approval gate in front of it. Only after the user has " +
        "seen a test run and said they want it to fire unattended."),
    },
    _meta: ui(),
    annotations: { destructiveHint: true },
  }, async ({ workflowId, force }) => {
    const wf = await load(workflowId);
    if (!wf) return oops(`No workflow ${workflowId}.`);
    const trig = wf.steps.find((s) => s.id === wf.entry);
    const loose = unguardedWrites(wf);
    if (loose.length && !force) {
      return oops(
        `This would go live with ${loose.length === 1 ? "a step that writes" : `${loose.length} steps that write`} ` +
        `and no approval gate in front of ${loose.length === 1 ? "it" : "them"}:\n` +
        loose.map((w) => `  ${w.stepId}: ${w.tool}`).join("\n") +
        `\n\nAdd a gate.approve upstream with circuit_patch, or — if the user has seen a test run and ` +
        `explicitly wants it to fire unattended — call circuit_arm again with force.`,
      );
    }
    wf.status = "armed"; wf.updatedAt = now();
    await store.putWorkflow(wf);
    const cron = trig?.type === "trigger.schedule" ? String(trig.config?.cron ?? "") : "";
    return ok(
      `${wf.name} is armed.` + (cron
        ? ` Now create a scheduled task on '${cron}' whose prompt is: "Run Circuit workflow ${wf.id} with circuit_run, then follow its directives."`
        : ` Its trigger is "${trig?.type ?? "?"}", so it runs when you call circuit_run.`),
      toBoard(wf, null, { phase: "design" }),
    );
  });

  server.registerTool("circuit_disarm", {
    title: "Take a workflow off live",
    description: "Back to draft. The board and its history stay.",
    inputSchema: { workflowId: z.string() },
    _meta: ui(),
  }, async ({ workflowId }) => {
    const wf = await load(workflowId);
    if (!wf) return oops(`No workflow ${workflowId}.`);
    wf.status = "draft"; wf.updatedAt = now();
    await store.putWorkflow(wf);
    return ok(`${wf.name} is back to draft.`, toBoard(wf, null, { phase: "design" }));
  });

  /* ----------------------------------------------- edits made on the board -- */

  server.registerTool("circuit_move", {
    title: "Move a chip",
    description: "Persist a chip's board position after the user drags it.",
    inputSchema: { workflowId: z.string(), stepId: z.string(), col: z.number(), lane: z.number() },
    _meta: ui(["app"]),
  }, async ({ workflowId, stepId, col, lane }) => {
    const wf = await load(workflowId);
    const s = wf?.steps.find((x) => x.id === stepId);
    if (!wf || !s) return oops("gone");
    s.position = { col, lane };
    wf.updatedAt = now();
    await store.putWorkflow(wf);
    return ok("moved", toBoard(wf, null, { phase: "design" }));
  });

  server.registerTool("circuit_set_enabled", {
    title: "Mute or unmute a chip",
    description: "Turn a single step off without deleting it.",
    inputSchema: { workflowId: z.string(), stepId: z.string(), enabled: z.boolean() },
    _meta: ui(["app", "model"]),
  }, async ({ workflowId, stepId, enabled }) => {
    const wf = await load(workflowId);
    const s = wf?.steps.find((x) => x.id === stepId);
    if (!wf || !s) return oops("gone");
    s.enabled = enabled;
    wf.updatedAt = now();
    await store.putWorkflow(wf);
    return ok(`${stepId} is ${enabled ? "on" : "muted"}`, toBoard(wf, null, { phase: "design" }));
  });

  server.registerTool("circuit_wire", {
    title: "Connect two chips",
    description: "Draw a wire from one step's output port to another step. The board calls this when the user drags one.",
    inputSchema: {
      workflowId: z.string(), from: z.string(), to: z.string(),
      port: z.string().default("out").describe("Which output of `from` the wire leaves by."),
    },
    _meta: ui(["app", "model"]),
  }, async ({ workflowId, from, to, port }) => {
    const wf = await load(workflowId);
    if (!wf) return oops("gone");
    const a = wf.steps.find((x) => x.id === from), b = wf.steps.find((x) => x.id === to);
    if (!a || !b) return oops("no such step");
    if (from === to) return oops("a step cannot wire to itself");
    if (!a.next.some((e) => e.to === to && (e.port ?? "out") === port)) a.next.push({ port, to });
    wf.steps = layout(wf.steps, wf.entry);
    wf.version += 1; wf.updatedAt = now();
    await store.putWorkflow(wf);
    return ok(`${from} ${port === "out" ? "\u2192" : `(${port}) \u2192`} ${to}`, toBoard(wf, null, { phase: "design" }));
  });

  server.registerTool("circuit_unwire", {
    title: "Cut a wire",
    description: "Remove the connection between two steps. The board calls this when the user cuts one.",
    inputSchema: {
      workflowId: z.string(), from: z.string(), to: z.string(),
      port: z.string().optional().describe("Omit to cut every wire between them."),
    },
    _meta: ui(["app", "model"]),
  }, async ({ workflowId, from, to, port }) => {
    const wf = await load(workflowId);
    const a = wf?.steps.find((x) => x.id === from);
    if (!wf || !a) return oops("gone");
    a.next = a.next.filter((e) => !(e.to === to && (port === undefined || (e.port ?? "out") === port)));
    wf.version += 1; wf.updatedAt = now();
    await store.putWorkflow(wf);
    return ok(`cut ${from} \u2192 ${to}`, toBoard(wf, null, { phase: "design" }));
  });

  server.registerTool("circuit_rename", {
    title: "Rename a workflow",
    description: "Change the name shown on the board.",
    inputSchema: { workflowId: z.string(), name: z.string() },
    _meta: ui(["app", "model"]),
  }, async ({ workflowId, name }) => {
    const wf = await load(workflowId);
    if (!wf) return oops("gone");
    wf.name = name; wf.updatedAt = now();
    await store.putWorkflow(wf);
    return ok(`renamed to ${name}`, toBoard(wf, null, { phase: "design" }));
  });

  server.registerTool("circuit_answer", {
    title: "Answer a held gate from the board",
    description:
      "The board calls this when the user approves or rejects on the canvas. It is the same as " +
      "circuit_step for a gate.approve step — the directive that comes back is the next thing to do.",
    inputSchema: {
      runId: z.string(),
      decision: z.enum(["approve", "reject"]),
      edit: z.string().optional().describe("Replacement for whatever the gate was previewing."),
    },
    _meta: ui(["app", "model"]),
  }, async ({ runId, decision, edit }) => {
    const run = await store.getRun(workspace, runId);
    if (!run) return oops(`No run ${runId}.`);
    if (!run.awaiting) return oops(`Run ${runId} is ${run.status} — it is not waiting on anything.`);
    const wf = await load(run.workflowId);
    if (!wf) return oops(`Workflow ${run.workflowId} is gone.`);
    const d = report(wf, run, run.awaiting.stepId, { decision, edit });
    await store.putRun(run);
    return withDirective(wf, run, d);
  });

  return server;
}
