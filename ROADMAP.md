# Roadmap

Circuit's premise fixes what belongs in it: it stores workflows, draws them, and
drives Claude one step at a time. It holds no credentials and reaches no service
itself. Everything below either sharpens that loop or gets out of its way.

Sequenced by what breaks first if you actually use it.

---

## Shipped

| | |
| --- | --- |
| **Streaming design** | The board places each chip as `tool-input-partial` arrives, so building is something you watch rather than wait for. |
| **The directive loop** | `circuit_run` → one directive → `circuit_step` → the next. Branching, filtering and looping stay server-side and deterministic. |
| **Twelve step types** | Triggers, `tool.call`, three model steps, filter / branch / each, an approval gate, and a report-back note. |
| **Connector binding** | Claude reports what it can reach; a mistyped tool is a design-time error with a suggestion, and `circuit_run` refuses to start on one. |
| **Failure policies** | Per-step `stop` / `skip` / `retry` / `route`, an `error` port, and `circuit_resume` to pick a stopped run back up without repeating what already ran. |
| **Honest test mode** | Steps that write come back as `preview` instead of running, detected from the verb and overridable per step. `circuit_arm` refuses a write with no approval gate on every path to it. |
| **Wire editing** | Drag from an output port to a chip to connect; hover a wire to cut it. App-only, so it never costs a turn. |

---

## Now

### Run replay

A finished run currently keeps what each step returned. Keep what each step
*received* as well and the board becomes a scrubber: step through a past run,
watch the payload move along the traces, click any chip to see exactly what went
in and what came out. It is simultaneously the best debugging tool Circuit could
have and the best thing to put in front of someone who has never seen it.

The storage change is small — one more field per trace entry — but it wants a
decision about size: a run over fifty emails should not keep fifty full payloads
forever. Likely a head/tail excerpt per step with the full value kept only for
the most recent run of each workflow.

### `logic.parallel`

Fan-out where order does not matter — three lookups that can happen at once.
This is a real change to the state machine: the engine holds exactly one
`awaiting` step today, and parallel means holding several and accepting results
in any order. It comes after replay because replay is what makes the resulting
traces legible.

## Next

### Workflow inputs

`{{input.customer}}` alongside `{{trigger.…}}`, declared on the workflow and
prompted for by `circuit_run`. One board then serves many cases instead of being
copied and edited, and a workflow becomes something you can hand to someone else.

### Export and import

A versioned JSON envelope, `circuit_export` / `circuit_import`, and an
`examples/` directory of starter boards. Workflows that can live in a gist or a
repo are workflows people can share, which is most of what makes an open-source
automation tool spread.

---

## Later

**Sub-workflows.** A `flow.call` step that runs another board and returns its
result. Composition is what stops large workflows becoming unreadable, but it
needs inputs (above) to be worth anything.

**Scheduling that closes the loop.** `circuit_arm` currently tells Claude to go
create a scheduled task and trusts that it happened. It should be able to check,
and to say when a workflow claims to be armed but nothing is actually calling it.

**Multi-user hosting.** OAuth on the server itself and per-user workspaces, so
one deployment can serve a team rather than a person. This is the only item here
that adds a credential to Circuit, and it is Circuit's own — never a connector's.

**Observability.** Run counts, durations and failure rates are already implied by
the stored runs. Surfacing "this step fails a third of the time" on the chip
itself is cheap and would change how people fix their workflows.

**Official Connector submission.** Worth doing once test mode is honest and
hosting exists — not before.

---

## Not doing

**Integrations.** Circuit will not grow a Gmail client, an OAuth flow, or a
credential store for third-party services. That is the whole premise: the
connectors are yours, they live in Claude, and Circuit orchestrates them without
ever holding a key. A PR that adds an API client gets closed with this paragraph.

**A standalone web app.** The conversation is the editor. A canvas you open in a
separate tab and drag nodes around in is a different product, and there are
several good ones already.

**Its own scheduler or queue.** Triggers fire because the host schedules them.
Circuit storing a cron and telling you what to do with it is the correct amount
of scheduling for something with no runtime of its own.

**A workflow DSL.** Steps stay plain JSON with described fields, because the
thing writing them is a language model reading a schema, not a person learning a
syntax.

---

## Versions

| | |
| --- | --- |
| **0.3** | Connector binding, failure policies, resume. |
| **0.4** | Honest test mode, wire editing. *(current)* |
| **0.5** | Run replay, `logic.parallel`. |
| **0.6** | Workflow inputs, export/import, starter examples. |
| **1.0** | Multi-user hosting, observability, a deployment someone else can run. |
