/**
 * What "running correctly" means for each shipped example.
 *
 * Every scenario drives one example to completion with fixed answers, so the
 * sequence of directives is deterministic and can be diffed against a checked-in
 * trace. Across all of an example's scenarios, every step must be visited at
 * least once — that is the check that catches a filter which quietly drops
 * everything, a loop that never enters, or a branch nothing routes to.
 */

const threads = [
  { id: "t1", from: "dana@northbeam.co", subject: "pricing", snippet: "what does it cost for 20 seats?" },
  { id: "t2", from: "sam@acme.io", subject: "next week?", snippet: "can we talk thursday" },
];

/** Answers keyed by step. Anything unlisted gets a bland successful result. */
const answer = (map) => (d) => {
  const hit = map[d.stepId];
  const v = typeof hit === "function" ? hit(d) : hit;
  if (v !== undefined) return v;
  if (d.act === "call_many") {
    return { results: Object.fromEntries(d.calls.map((c) => [c.stepId, { ok: true }])) };
  }
  if (d.act === "think" && d.task === "classify") return { result: { label: d.labels[0] } };
  if (d.act === "think" && d.task === "write") return { result: { text: "Short and plain." } };
  if (d.act === "think" && d.task === "extract") {
    return { result: Object.fromEntries(d.fields.map((f) => [f.name, `some ${f.name}`])) };
  }
  if (d.act === "ask") return { result: { decision: "approve" } };
  return { result: { ok: true } };
};

export const SCENARIOS = {
  "inbox-triage.json": [
    {
      name: "a sales thread gets a drafted reply",
      input: { voice: "Brandon", limit: 2 },
      respond: answer({
        watch: { result: { threads: [threads[0]] } },
        intent: { result: { label: "sales", why: "asks about price" } },
        draft: { result: { text: "Pricing scales with seats — free Thursday?" } },
        gate: { result: { decision: "approve" } },
      }),
    },
    {
      name: "a scheduling thread checks the calendar",
      input: { voice: "Brandon", limit: 2 },
      respond: answer({
        watch: { result: { threads: [threads[1]] } },
        intent: { result: { label: "scheduling", why: "wants a time" } },
        slots: { result: { events: [{ start: "2026-09-04T14:00:00Z" }] } },
      }),
    },
    {
      name: "anything else is labelled for a human",
      input: { voice: "Brandon", limit: 2 },
      respond: answer({
        watch: { result: { threads: [{ id: "t3", from: "ops@vendor.com", subject: "invoice" }] } },
        intent: { result: { label: "other", why: "not sales or scheduling" } },
      }),
    },
    {
      name: "rejecting the gate stops before sending",
      input: { voice: "Brandon", limit: 2 },
      expectStatus: "cancelled",
      respond: answer({
        watch: { result: { threads: [threads[0]] } },
        intent: { result: { label: "sales", why: "asks about price" } },
        gate: { result: { decision: "reject" } },
      }),
    },
    {
      name: "an empty inbox still finishes",
      input: { voice: "Brandon", limit: 2 },
      respond: answer({ watch: { result: { threads: [] } } }),
    },
  ],

  "lead-intake.json": [
    {
      name: "a named company is recorded and answered",
      input: { base: "appDemo", voice: "Brandon" },
      respond: answer({
        read: { result: { name: "Dana Ruiz", email: "dana@northbeam.co", company: "Northbeam", asking: "pricing" } },
        record: { result: { id: "recAbc123" } },
      }),
    },
    {
      name: "no company still routes through the CRM",
      input: { base: "appDemo", voice: "Brandon" },
      respond: answer({
        read: { result: { name: "Sam Ellis", email: "sam@gmail.com", company: "", asking: "a demo" } },
        record: { result: { id: "recDef456" } },
      }),
    },
    {
      name: "a CRM failure takes the error port and flags it",
      input: { base: "appDemo", voice: "Brandon" },
      respond: answer({
        read: { result: { name: "Kit Moss", email: "kit@moss.dev", company: "Moss", asking: "pricing" } },
        record: { error: "Airtable returned 403: the table is read-only" },
      }),
    },
  ],

  "weekly-digest.json": [
    {
      name: "both sources are gathered, then the digest is posted",
      input: { channel: "#general" },
      respond: answer({
        gather: (d) => d.act === "call_many"
          ? { results: { mail: { threads: [{ id: "a" }, { id: "b" }] }, meetings: { events: [{ id: "m1" }] } } }
          : undefined,
        write: { result: { text: "Five bullets, plainly put." } },
        check: { result: { decision: "approve" } },
      }),
    },
    {
      name: "an edit at the gate replaces the text that gets posted",
      input: { channel: "#eng" },
      respond: answer({
        write: { result: { text: "First draft." } },
        check: { result: { decision: "approve", edit: "Edited before posting." } },
      }),
    },
  ],
};
