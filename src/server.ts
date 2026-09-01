import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";

import { BOARD_HTML } from "./app/board.generated.js";
import { InputSchema, StepSchema, findEntry, layout, type Run, type Workflow } from "./graph.js";
import { BY_TYPE, catalog } from "./registry.js";
import { describe, toBoard } from "./board.js";
import { getStore } from "./store/index.js";
import { advance, fail, newRun, report, reportMany, resume, type Directive, type Flows } from "./engine/run.js";
import { calledFlows, checkFlows, checkTogether, checkTools, describeMissing, requiredTools, stepWrites, unguardedWrites, type ToolBinding } from "./tools.js";
import { exportHtml, parseExport } from "./export.js";
import { describeMinutes, health, intervalMinutes, isValidCron } from "./schedule.js";

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
    { name: "circuit", version: "0.8.0", title: "Circuit" },
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

  /** Every workflow a run might step into, loaded up front so the engine can switch synchronously. */
  async function flowsFor(wf: Workflow): Promise<Flows> {
    const map: Flows = new Map([[wf.id, wf]]);
    const queue = calledFlows(wf);
    while (queue.length) {
      const id = queue.shift()!;
      if (map.has(id)) continue;
      const child = await load(id);
      if (!child) continue;
      map.set(id, child);
      queue.push(...calledFlows(child));
    }
    return map;
  }

  /* ------------------------------------------------------------ resources -- */

  // Workflows and runs are readable as resources, so a client can browse what is
  // here rather than having to call a tool to find out.
  server.registerResource(
    "Workflow",
    new ResourceTemplate("circuit://workflow/{id}", {
      list: async () => ({
        resources: (await store.listWorkflows(workspace)).map((w) => ({
          uri: `circuit://workflow/${w.id}`,
          name: w.name,
          description: w.description || `${w.steps.length} steps, ${w.status}`,
          mimeType: "application/json",
        })),
      }),
      complete: {
        id: async (value) => {
          const all = await store.listWorkflows(workspace);
          return all.map((w) => w.id).filter((id) => id.startsWith(value)).slice(0, 20);
        },
      },
    }),
    { title: "A saved workflow", description: "The definition, as circuit_export writes it.", mimeType: "application/json" },
    async (uri, { id }) => {
      const wf = await load(String(id));
      if (!wf) throw new Error(`No workflow ${id}.`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
        circuit: 1, name: wf.name, description: wf.description, entry: wf.entry,
        inputs: wf.inputs ?? [], schedule: wf.schedule, steps: wf.steps,
      }, null, 1) }] };
    },
  );

  server.registerResource(
    "Run",
    new ResourceTemplate("circuit://run/{id}", {
      list: async () => ({
        resources: (await store.listRuns(workspace, undefined, 20)).map((r) => ({
          uri: `circuit://run/${r.id}`,
          name: `${r.id} — ${r.status}`,
          description: `${r.mode} run of ${r.workflowId}, started ${r.startedAt}`,
          mimeType: "application/json",
        })),
      }),
      complete: {
        id: async (value) => {
          const runs = await store.listRuns(workspace, undefined, 40);
          return runs.map((r) => r.id).filter((id) => id.startsWith(value)).slice(0, 20);
        },
      },
    }),
    { title: "A run", description: "Status, the trace, and the timeline a replay scrubs.", mimeType: "application/json" },
    async (uri, { id }) => {
      const run = await store.getRun(workspace, String(id));
      if (!run) throw new Error(`No run ${id}.`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
        id: run.id, workflowId: run.workflowId, status: run.status, mode: run.mode,
        startedAt: run.startedAt, endedAt: run.endedAt, trace: run.trace, history: run.history ?? [],
      }, null, 1) }] };
    },
  );

  /* -------------------------------------------------------------- prompts -- */

  server.registerPrompt("circuit-build", {
    title: "Build an automation",
    description: "Design a workflow on the board from a plain description of what should happen.",
    argsSchema: {
      what: z.string().describe("What should happen, in your own words."),
    },
  }, ({ what }) => ({
    messages: [{
      role: "user", content: { type: "text", text:
        `Build this automation with Circuit: ${what}

` +
        `Call circuit_catalog and circuit_bind first, then design the whole thing in one circuit_design ` +
        `call so I can watch the board draw itself. Use tools from my own connectors only, declare an ` +
        `input for anything that would otherwise be hardcoded, and put an approval gate in front of ` +
        `anything that sends. Show me the board before running it.`,
      },
    }],
  }));

  server.registerPrompt("circuit-open", {
    title: "Open a workflow",
    description: "Put a saved workflow back on the board.",
    argsSchema: {
      workflowId: completable(z.string().describe("Which workflow."), async (value) => {
        const all = await store.listWorkflows(workspace);
        return all.map((w) => w.id).filter((id) => id.startsWith(value)).slice(0, 20);
      }),
    },
  }, ({ workflowId }) => ({
    messages: [{
      role: "user", content: { type: "text", text:
        `Open Circuit workflow ${workflowId} with circuit_open and show me the board. Tell me what it ` +
        `does, what it needs, and whether anything is wrong with it.`,
      },
    }],
  }));

  server.registerPrompt("circuit-save", {
    title: "Save a workflow",
    description: "Write a workflow out as a page to keep.",
    argsSchema: {
      workflowId: completable(z.string().describe("Which workflow."), async (value) => {
        const all = await store.listWorkflows(workspace);
        return all.map((w) => w.id).filter((id) => id.startsWith(value)).slice(0, 20);
      }),
    },
  }, ({ workflowId }) => ({
    messages: [{
      role: "user", content: { type: "text", text:
        `Call circuit_export for workflow ${workflowId}, write the html it gives you to a file exactly ` +
        `as returned, publish it as an artifact, and give me the link.`,
      },
    }],
  }));

  server.registerPrompt("circuit-check", {
    title: "Check on my automations",
    description: "Which armed workflows have quietly stopped firing.",
    argsSchema: {},
  }, () => ({
    messages: [{
      role: "user", content: { type: "text", text:
        `Run circuit_health and tell me plainly whether anything I have armed has stopped working. ` +
        `If something needs a scheduled task created, offer to walk me through it.`,
      },
    }],
  }));

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
      inputs: z.array(InputSchema).default([]).describe(
        "Values the workflow asks for each time it runs, reachable everywhere as {{input.<name>}}. " +
        "Use these instead of baking a name, an address or a search term into a step — it is what " +
        "makes one board serve many cases, and what makes it worth sharing."),
    },
    _meta: ui(),
  }, async ({ workflowId, name, description, entry, steps, inputs }) => {
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
      inputs: inputs?.length ? inputs : existing?.inputs,
      status: existing?.status ?? "draft",
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    const known = await flowsFor(wf);
    const nested = checkFlows(wf, (id) => known.get(id));
    if (nested.length) {
      return oops(`This will not run as a set of workflows:\n${nested.map((n) => `  ${n}`).join("\n")}`);
    }
    const together = checkTogether(wf);
    if (together.length) {
      return oops(`'together' is only for branches that are a single connector call:\n${together.map((t) => `  ${t}`).join("\n")}`);
    }
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

  /* ------------------------------------------------------- keep and reuse -- */

  server.registerTool("circuit_export", {
    title: "Save a workflow the user can keep",
    description:
      "Returns a complete standalone HTML page for this workflow — the board drawn out, what each step " +
      "does in plain English, the connectors it needs, and the definition itself. " +
      "WHAT TO DO WITH IT: write the html exactly as given to a file and publish it with your Artifact " +
      "tool. That gives the user a private page they keep across conversations and can share. " +
      "Do not summarise, reformat or regenerate the html — it is already finished, and the definition " +
      "inside it is what circuit_import reads back.",
    inputSchema: { workflowId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ workflowId }) => {
    const wf = await load(workflowId);
    if (!wf) return oops(`No workflow ${workflowId}.`);
    const html = exportHtml(wf);
    return {
      content: [
        { type: "text" as const,
          text:
            `Write this to "${wf.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.html" ` +
            `and publish it with your Artifact tool, titled "${wf.name}". ` +
            `Then give the user the link — that page is their copy of this workflow, and pasting it into ` +
            `a future conversation with circuit_import rebuilds the board.\n\n--- begin html ---\n${html}\n--- end html ---`,
        },
      ],
    };
  });

  server.registerTool("circuit_import", {
    title: "Rebuild a saved workflow",
    description:
      "Takes a workflow the user saved earlier and puts it back on the board. Pass the whole page you " +
      "read from their saved artifact — Circuit finds the definition inside it — or the JSON on its own. " +
      "Tool names come back exactly as they were saved, so check them against your own tool list: a " +
      "workflow built on someone else's connectors will name tools you do not have.",
    inputSchema: {
      source: z.string().describe("The saved page's HTML, or the workflow JSON."),
      name: z.string().optional().describe("Rename it on the way in."),
    },
    _meta: ui(),
  }, async ({ source, name }) => {
    const parsed: any = parseExport(source);
    if (!parsed || !Array.isArray(parsed.steps) || !parsed.steps.length) {
      return oops(
        "Could not find a workflow in that. Expected a page saved by circuit_export, or JSON with a " +
        "`steps` array. If you read it from an artifact, pass the page's whole HTML.",
      );
    }
    const steps = z.array(StepSchema).safeParse(parsed.steps);
    if (!steps.success) {
      return oops(`That definition did not validate: ${steps.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const unknown = steps.data.filter((s) => !BY_TYPE.has(s.type));
    if (unknown.length) return oops(`Saved with step types this Circuit does not know: ${unknown.map((s) => s.type).join(", ")}.`);

    const e = findEntry(steps.data, parsed.entry);
    const wf: Workflow = {
      id: `wf_${randomUUID().slice(0, 8)}`,
      workspace,
      name: name ?? String(parsed.name ?? "Restored workflow"),
      description: String(parsed.description ?? ""),
      steps: layout(steps.data, e),
      inputs: Array.isArray(parsed.inputs) && parsed.inputs.length ? parsed.inputs : undefined,
      entry: e,
      status: "draft",
      version: 1,
      createdAt: now(), updatedAt: now(),
    };
    await store.putWorkflow(wf);
    const check = checkTools(wf.steps, await store.getTools(workspace));
    return ok(
      describe(wf) + "\n\nRestored as a draft." +
      (check.missing.length ? `\n\n${describeMissing(check)}` : check.bound ? " Every connector it needs is one you have." : ""),
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
      input: z.record(z.any()).default({}).describe(
        "Values for the workflow's declared inputs. Ask the user for anything you do not already know " +
        "rather than guessing — these usually decide who gets contacted and what about."),
    },
    _meta: ui(),
  }, async ({ workflowId, mode, trigger, input }) => {
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
    const supplied: Record<string, any> = { ...input };
    for (const decl of wf.inputs ?? []) {
      if (supplied[decl.name] === undefined && decl.default !== undefined) supplied[decl.name] = decl.default;
    }
    const missing = (wf.inputs ?? []).filter((d) => d.required !== false && supplied[d.name] === undefined);
    if (missing.length) {
      return oops(
        `This workflow needs ${missing.length === 1 ? "a value" : "values"} before it can run:\n` +
        missing.map((d) => `  ${d.name} — ${d.description || "no description given"}`).join("\n") +
        `\n\nAsk the user, then call circuit_run again with input.`,
      );
    }

    const run = newRun(wf, trigger ?? {}, mode, supplied);
    const flows = await flowsFor(wf);
    const d = advance(wf, run, flows);
    wf.lastRunAt = now();
    await store.putWorkflow(wf);
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
      "For a call_many directive, send `results` (and `errors`) keyed by stepId instead of `result`. " +
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
      results: z.record(z.any()).optional().describe(
        "Answering a call_many directive: every result, keyed by the stepId it came from."),
      errors: z.record(z.string()).optional().describe(
        "Answering a call_many directive: anything that failed, keyed by stepId, with what went wrong."),
    },
    _meta: ui(),
  }, async ({ runId, stepId, result, error, results, errors }) => {
    const run = await store.getRun(workspace, runId);
    if (!run) return oops(`No run ${runId}.`);
    const wf = await load(run.workflowId);
    if (!wf) return oops(`Workflow ${run.workflowId} is gone.`);
    const flows = await flowsFor(wf);
    const batched = run.awaiting?.batch && (results || errors);
    const d = batched ? reportMany(wf, run, stepId, results ?? {}, errors ?? {}, flows)
      : error ? fail(wf, run, stepId, error, flows)
      : report(wf, run, stepId, result ?? {}, flows);
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
    const d = resume(wf, run, skip, await flowsFor(wf));
    await store.putRun(run);
    return withDirective(wf, run, d);
  });

  server.registerTool("circuit_runs", {
    title: "Show recent runs",
    description:
      "Run history, newest first, with anything still waiting on the user called out. The most recent " +
      "run comes back on the board, where it can be replayed step by step.",
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
    const cron = trig?.type === "trigger.schedule" ? String(trig.config?.cron ?? "") : "";
    if (cron && !isValidCron(cron)) {
      return oops(`'${cron}' is not a 5 field cron expression, so nothing could ever be scheduled from it.`);
    }
    wf.status = "armed";
    wf.updatedAt = now();
    if (cron) {
      wf.schedule = { cron, note: String(trig?.config?.note ?? ""), taskId: wf.schedule?.taskId, confirmedAt: wf.schedule?.confirmedAt };
    }
    await store.putWorkflow(wf);

    if (!cron) {
      return ok(
        `${wf.name} is armed. Its trigger is "${trig?.type ?? "?"}", so it runs when you call circuit_run.`,
        toBoard(wf, null, { phase: "design" }),
      );
    }
    const every = intervalMinutes(cron);
    const prompt =
      `Run Circuit workflow ${wf.id} ("${wf.name}"): call circuit_run with workflowId "${wf.id}"` +
      ((wf.inputs ?? []).length ? `, passing input for ${(wf.inputs ?? []).map((i) => i.name).join(" and ")}` : "") +
      `, then follow each directive it returns until you get {"act":"done"}.`;
    return ok(
      `${wf.name} is armed on \`${cron}\`${every ? ` (about every ${describeMinutes(every)})` : ""}.\n\n` +
      `Circuit has no scheduler of its own, so nothing will call this until you create a scheduled task. ` +
      `Create one on that cron with exactly this prompt:\n\n${prompt}\n\n` +
      `Then call circuit_scheduled with the task's id, so Circuit can tell later whether it is still ` +
      `firing. Until you do, circuit_health will report this workflow as armed but unconfirmed.`,
      toBoard(wf, null, { phase: "design", schedulePrompt: prompt }),
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

  server.registerTool("circuit_scheduled", {
    title: "Record the scheduled task",
    description:
      "After you create the scheduled task that calls an armed workflow, tell Circuit its id. That is " +
      "the only way Circuit can later distinguish 'armed and firing' from 'armed and quietly dead'.",
    inputSchema: {
      workflowId: z.string(),
      taskId: z.string().describe("Whatever identifies the scheduled task you just made."),
    },
    _meta: ui(),
  }, async ({ workflowId, taskId }) => {
    const wf = await load(workflowId);
    if (!wf) return oops(`No workflow ${workflowId}.`);
    if (!wf.schedule?.cron) {
      return oops(`${wf.name} has no schedule, so there is nothing for a task to be attached to. Arm it on a trigger.schedule first.`);
    }
    wf.schedule = { ...wf.schedule, taskId, confirmedAt: now() };
    wf.updatedAt = now();
    await store.putWorkflow(wf);
    return ok(
      `Noted — task ${taskId} calls ${wf.name} on \`${wf.schedule.cron}\`. circuit_health will tell you if it stops.`,
      toBoard(wf, null, { phase: "design" }),
    );
  });

  server.registerTool("circuit_health", {
    title: "Is anything quietly dead?",
    description:
      "Checks every armed workflow against what is actually happening: whether a scheduled task was " +
      "ever recorded, and whether it has run recently enough for its own schedule. Worth calling when " +
      "the user wonders why something stopped, and worth calling unprompted if they mention that an " +
      "automation has gone quiet.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const all = await store.listWorkflows(workspace);
    const armed = all.filter((w) => w.status === "armed");
    if (!armed.length) return say("Nothing is armed, so nothing is meant to be running on its own.");
    const rows = armed.map((w) => health(w));
    const bad = rows.filter((r) => r.state !== "fine");
    const lines = rows.map((r) => `${r.state === "fine" ? "  ok" : "  ✕ "} ${r.workflowId}  ${r.name}\n       ${r.detail}`);
    return say(
      (bad.length
        ? `${bad.length} of ${rows.length} armed workflow${rows.length === 1 ? "" : "s"} ${bad.length === 1 ? "needs" : "need"} attention.\n\n`
        : `All ${rows.length} armed workflow${rows.length === 1 ? " is" : "s are"} firing as expected.\n\n`) +
      lines.join("\n"),
    );
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
    const d = report(wf, run, run.awaiting.stepId, { decision, edit }, await flowsFor(wf));
    await store.putRun(run);
    return withDirective(wf, run, d);
  });

  // The SDK turns listChanged on for anything you register, but a stateless
  // Streamable HTTP session has no channel to push a notification down. Claiming
  // a capability that can never fire leaves a client waiting for something that
  // is never coming, so it is withdrawn rather than left as a polite lie.
  // (Restore it the day sessions become stateful, not before.)
  const declared: any = (server.server as any).getCapabilities?.() ?? {};
  (server.server as any)._capabilities = {
    ...declared,
    ...(declared.tools ? { tools: {} } : {}),
    ...(declared.resources ? { resources: {} } : {}),
    ...(declared.prompts ? { prompts: {} } : {}),
  };

  return server;
}
