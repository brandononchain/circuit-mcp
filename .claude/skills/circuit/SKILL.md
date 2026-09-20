---
name: circuit
description: >-
  Build, run, debug and maintain automations with the Circuit MCP server — a visual
  workflow builder that renders a board inside the conversation and drives the agent
  one step at a time over the user's own connectors. Load this whenever Circuit tools
  (circuit_*) are available and the user wants to automate a recurring process, or says
  "build me a workflow / automation", "triage my inbox", "every morning do X", "when a
  new Y arrives", "run that workflow", "why did my automation stop", or asks to edit,
  test, arm, schedule, export or resume anything built with Circuit.
---

# Circuit

## What it is

Circuit is a **workflow engine that owns no integrations and holds no credentials.**
It stores the graph, draws it on a board in the conversation, resolves the routing,
and then tells *you* what to do next. Every call to the outside world is made by you,
with the connectors the user has already granted.

That inversion is the whole design, and it drives every rule below:

| | |
|---|---|
| **Circuit does** | store the workflow, render the board, resolve templates, evaluate filters/branches/loops, sequence steps, apply error policy, keep run history |
| **You do** | call connector tools, make judgements (classify/write/extract), talk to the user, report results truthfully |
| **The user does** | answer approval gates, drag chips, approve on the board |

Circuit never calls a connector. If a directive names `Gmail:send_message`, *you* call it.

## The loop — the one thing to get right

```
circuit_run  ──►  directive ──►  you do exactly that one thing
                      ▲                      │
                      └──── circuit_step ◄───┘
                        (result or error)

… until {"act":"done"}
```

**One directive at a time.** Do not batch, skip, reorder, or run a tool the directive
did not name. Every directive carries an `expect` field stating the exact reply shape —
follow it literally.

## Session protocol

1. **`circuit_catalog`** — once. The real step types and config keys, so every `type` you write exists.
2. **`circuit_bind`** — once per conversation, *before designing*. Send the **exact names of every connector tool you can see**, not just the ones you think you'll need. Circuit validates every step against this list, so a typo becomes an error while you're still drawing instead of a dead end mid-run. Skip it and `circuit_run` warns it could not check anything.
3. **`circuit_design`** — the **whole workflow in one call**, trigger first, in reading order. The board draws each chip as your arguments stream in, so one well-ordered call renders as a build animation; several small calls look broken.
4. **`circuit_run`** → drive the loop above.

Use `circuit_patch` — never a second `circuit_design` — once a workflow exists. Patch preserves the user's own layout.

## Directives — the complete contract

| `act` | What you do | Reply via `circuit_step` |
|---|---|---|
| `call_tool` | Call `tool` with `arguments` **exactly as given** | `result:` the tool's output **verbatim, unsummarised** |
| `call_many` | Call every entry in `calls` | `results:` object keyed by `stepId` (+ `errors:` keyed by `stepId`) |
| `preview` | **Call nothing.** Test mode. Show the user what *would* go out | `result: {}` |
| `think` | `task` is `classify` \| `write` \| `extract` | classify → `{"label": <one of labels>, "why": "…"}` · write → `{"text": "…"}` · extract → object with exactly the named `fields` |
| `ask` | Stop. Show `preview`, put `question` to the user, wait | `{"decision": "approve"\|"reject", "edit": …}` — or let the board call `circuit_answer` |
| `say` | Say `text` to the user in the conversation | `result: {}` |
| `done` | Run complete. Report `summary` | — stop |
| `blocked` | Circuit cannot continue; `reason` says why | — stop, tell the user, fix the board |

### Three rules that are always wrong to break

1. **Never invent a tool name.** `config.tool` must be a tool you can actually see. If the user has nothing suitable connected, say so — do not guess a plausible name.
2. **Never fill in a template yourself.** `{{trigger.subject}}`, `{{steps.draft.text}}`, `{{item.from}}` are resolved by Circuit *before* the directive reaches you. Arguments arrive live.
3. **Never fabricate a result.** If the tool errored, the connector refused, or the data wasn't there, report `error:` with what actually happened. The step's own error policy decides what comes next and can only do that on the truth. A made-up success silently corrupts the run.

## Step catalog (14 types)

**Triggers**
| type | config | ports | notes |
|---|---|---|---|
| `trigger.ask` | — | `out` | the default — user starts it from chat |
| `trigger.schedule` | `cron` (5-field UTC), `note` | `out` | stores the schedule; does **not** fire it |
| `trigger.watch` | `tool`, `arguments`, `writes?` | `out` | polls for new items; pair with `logic.each` |

**Work you perform**
| type | config | ports | notes |
|---|---|---|---|
| `tool.call` | `tool`, `arguments`, `writes?` | `out` | the workhorse |
| `model.classify` | `labels[]` (≥2), `input`, `instructions` | **dynamic** | each label becomes an output port |
| `model.write` | `instructions`, `voice`, `context[]`, `maxWords` (160) | `out` | drafts only; a later `tool.call` sends |
| `model.extract` | `fields[{name,description}]`, `input` | `out` | returns structured data |
| `note.say` | `template` | `out` | good as a final step |

**Circuit resolves these itself**
| type | config | ports | notes |
|---|---|---|---|
| `logic.filter` | `all[]` / `any[]` of `{field, op, value}` | `out` | ends this path when it doesn't hold |
| `logic.branch` | `field`, `cases[{equals,port}]`, `fallback` | **dynamic** | one port per case, plus the fallback |
| `logic.each` | `list` (dot path), `limit` (10) | `out`, **`done`** | `{{item.…}}` inside; wire `done` for after the last item |
| `logic.branches` | `together` (false) | `out`, **`join`** | fans out, continues from `join` once all finish |
| `flow.call` | `workflowId`, `input`, `trigger`, `returns` | `out` | sub-workflow, own step namespace |

**User**
| type | config | ports | notes |
|---|---|---|---|
| `gate.approve` | `preview` (dot path), `question` | `out` | parks the run with an editable draft |

`logic.filter` ops: `equals`, `contains`, `matches` (regex), `exists`, `missing`, `gt`, `lt`.

## Template scopes

| Scope | Available |
|---|---|
| `{{trigger.…}}` | the starting payload |
| `{{steps.<id>.…}}` | any earlier step's output, by step id |
| `{{item.…}}` | the current item, **inside a `logic.each` body only** |
| `{{input.<name>}}` | a declared workflow input |

Declare `inputs` for anything the run needs supplied. `circuit_run` refuses to start
when a required input is missing — **ask the user rather than guessing**, since inputs
usually decide who gets contacted and about what.

## Error policy — `onError` per step

| `do` | Behaviour |
|---|---|
| `stop` *(default)* | the whole run fails here |
| `skip` | this path ends; the rest of the run (the next loop item, say) carries on |
| `retry` | Circuit hands you the same directive again, up to `attempts` (default 2, max 5) |
| `route` | the run leaves by the `error` port — wire a fallback |

Set these deliberately on anything that touches a flaky connector. A loop over 50 items
where one bad item kills the run is usually a missing `skip`.

## Test before you send

`circuit_run` with `mode: "test"` turns every writing step into a `preview` directive.
**Use it before the first live run of anything that sends, posts, creates or deletes.**
Circuit infers `writes` from the verb in the tool name and is usually right; set
`writes: true` explicitly when the guess would be wrong.

## Recovering a failed run

Use **`circuit_resume`**, not a fresh `circuit_run`. The earlier steps already happened
and their side effects are real — restarting would send the same email twice. Pass
`skip: true` to step over the failed step and carry on.

## Arming and scheduling

**Circuit has no scheduler.** Arming marks a workflow live; it does not make anything fire.

1. `circuit_arm` — refuses if a step writes with no approval gate in front of it, because that is a decision to make on purpose (`force` to override).
2. Create a real scheduled task with the user's own tooling that calls `circuit_run` on that workflow id.
3. **`circuit_scheduled`** — report the task id back. This is the only way Circuit can later tell "armed and firing" from "armed and quietly dead."

`circuit_health` checks every armed workflow for a missing task id or a run that never
happened. Call it when the user wonders why something stopped — and **unprompted** if
they mention an automation has gone quiet.

## Saving and restoring

- `circuit_export` returns a complete standalone HTML page. Write it **exactly as given** to a file and publish it with your Artifact tool — that gives the user something they own and can re-import.
- `circuit_import` takes that page back (or the bare JSON). Tool names return exactly as saved, so **re-check them against your current tool list** — a workflow built on someone else's connectors will name tools you don't have.

## Board callbacks

`circuit_move`, `circuit_wire`, `circuit_unwire`, `circuit_set_enabled`, `circuit_rename`
and `circuit_answer` are what the canvas calls when the user drags, cuts, mutes or
approves. `circuit_answer` is the board's version of `circuit_step` for a gate — the
directive it returns is the next thing to do, so pick the loop straight back up.

## Anti-patterns

| Don't | Do |
|---|---|
| Design before `circuit_bind` | Bind first — a mistyped tool becomes a design-time error |
| Several small `circuit_design` calls | One call, whole workflow, trigger first |
| `circuit_design` to edit | `circuit_patch` — keeps the user's layout |
| Summarise a tool result | Send it verbatim; later steps read fields off it |
| Fake a result to keep going | `error:` — let the step's policy decide |
| Resolve `{{…}}` yourself | Circuit already did |
| Fresh run after a failure | `circuit_resume` |
| Arm and assume it fires | Create the task, then `circuit_scheduled` |
| Batch several directives | One at a time; `call_many` only when Circuit asks |
| Live run of a sender, untested | `mode: "test"` first |

## Worked shape — inbox triage

```
trigger.ask
  └─► tool.call        Gmail:search_threads      {"query":"is:unread newer_than:1d"}
        └─► logic.each  list steps.search.threads, limit 10
              └─► model.classify  labels [sales, scheduling, other]   ← ports fan out
                    ├─sales──► model.write   draft a reply, voice "warm, brief"
                    │            └─► gate.approve  preview steps.draft.text
                    │                  └─► tool.call  Gmail:reply   onError: skip
                    ├─scheduling─► tool.call  Google_Calendar:list_events
                    └─other──────► tool.call  Gmail:label_thread
        └─(done port)─► note.say  "Handled {{steps.search.threads.length}} threads."
```

Note: the gate sits in front of the only step that sends; the reply is `skip` so one
bad thread doesn't kill the batch; `note.say` hangs off the loop's **`done`** port, not
its `out` port.

## Reference

| Purpose | Tool |
|---|---|
| Step kit, config keys | `circuit_catalog` |
| Report your connectors / see them | `circuit_bind` · `circuit_tools` |
| Create · edit · open · list | `circuit_design` · `circuit_patch` · `circuit_open` · `circuit_list` |
| Run the loop | `circuit_run` · `circuit_step` · `circuit_answer` · `circuit_resume` |
| History | `circuit_runs` |
| Go live | `circuit_arm` · `circuit_scheduled` · `circuit_disarm` · `circuit_health` |
| Keep / restore | `circuit_export` · `circuit_import` |
| Board edits | `circuit_move` · `circuit_wire` · `circuit_unwire` · `circuit_set_enabled` · `circuit_rename` |

Resources: `circuit://workflow/{id}`, `circuit://run/{id}`.
Prompts: `circuit-build`, `circuit-open`, `circuit-save`, `circuit-check`.

## Deployment note

Circuit is self-hosted. `/health` on the deployment tells you what it is really doing:

```json
{"ok":true,"storage":"postgres","durable":true,"auth":"oauth"}
```

`"storage":"memory"` or `"durable":false` means every workflow is lost on the next
redeploy — **do not arm anything on a schedule** until that reads `postgres`/`true`.
`"auth":"open"` means anyone who finds the URL can drive the user's workflows; say so.
