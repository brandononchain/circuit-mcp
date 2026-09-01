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

---

## Now

### A test mode that actually withholds writes

`mode: "test"` currently labels the run and nothing else — Claude will happily
really send the email. That is the most dangerous gap in the project: the word
"test" promises something the code does not deliver.

Circuit cannot know which connector tools write, so the workflow declares it. A
`tool.call` step gets `writes: true`, defaulted by a heuristic on the verb
(`send`, `post`, `create`, `delete`, `update`, `archive` → writes; `search`,
`list`, `get`, `read` → does not) and overridable at design time. In a test run
those steps come back as `{"act": "preview"}` — *show the user exactly what you
would call, with the resolved arguments, and do not call it* — and the board
renders the payload instead of a result.

The same flag pays off twice: an armed workflow can require that the first write
in any run passes an approval gate, which is a much better default than trusting
that whoever designed it remembered one.

### Wire editing on the canvas

Today the board is a viewer you can drag chips around. Dragging *from a port to
another chip* — and cutting a wire — is what turns it into an editor, and it is
the single largest jump in perceived quality still available.

Two app-only tools (`circuit_wire`, `circuit_unwire`), a port hit-target on each
chip, and a live trace that follows the cursor while you drag. Invisible to the
model, like `circuit_move`, so rewiring never costs a turn.

---

## Next

### Run replay

A finished run currently keeps what each step returned. Keep what each step
*received* as well and the board becomes a scrubber: step through a past run,
watch the payload move along the traces, click any chip to see exactly what went
in and what came out. It is simultaneously the best debugging tool Circuit could
have and the best thing to put in front of someone who has never seen it.

### `logic.parallel`

Fan-out where order does not matter — three lookups that can happen at once.
This is a real change to the state machine: the engine currently holds exactly
one `awaiting` step, and parallel means holding several and accepting results in
any order. It comes after replay because replay makes the resulting traces
legible.

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
| **0.3** | Connector binding, failure policies, resume. *(current)* |
| **0.4** | Honest test mode, wire editing. |
| **0.5** | Run replay, `logic.parallel`. |
| **0.6** | Workflow inputs, export/import, starter examples. |
| **1.0** | Multi-user hosting, observability, a deployment someone else can run. |
