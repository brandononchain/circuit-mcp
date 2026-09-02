# Contributing to Circuit

Thanks for looking. Circuit is small on purpose — one server, one board, twelve
step types — and the aim is to keep it that way while it gets more capable.

## Getting set up

```bash
npm install
npm run dev            # server on :8787
npm run harness        # then open scripts/harness.html
```

You do not need a Claude subscription to work on this. `scripts/harness.html`
runs the official MCP Apps host implementation locally, so you can develop the
board against the real protocol with `?scene=build`, `?scene=run`,
`?scene=held`, and `&theme=light`.

## Before you open a PR

```bash
npm run typecheck
npm run dev & sleep 3 && npm run check
```

`npm run check` is four suites, ~150 assertions, and it exits non-zero when any
of them fails:

| | what it holds to account |
|---|---|
| `smoke.mjs` | the engine, driven over the wire the way Claude drives it — loops, classify fan-out, approval gates, all four failure policies, test mode, fan-out with join, sub-workflows, history clipping, scheduling |
| `protocol-check.mjs` | what the server claims over MCP: tools, prompts, resources, templates, completions, and the capabilities it deliberately does *not* claim |
| `export-check.mjs` | a board survives export to a page and back, field for field |
| `trace-check.mjs` | every shipped example walks the path it claims, and every step in it is reachable |

Every check is an assertion. **A check that only prints is not a check** — this
suite spent months green while `examples/inbox-triage.json` shipped with a
filter that dropped every thread it was given, so the run went from the trigger
straight to the recap and never reached seven of its ten steps. Use the helpers
in `scripts/expect.mjs` (`ok`, `eq`, `deepEq`, `includes`, `between`) and finish
with `done()`.

If you change an example on purpose, its trace will no longer match. Look at
the diff first, then `npm run trace:update` to accept it.

## What good changes look like

**New step types** belong in `src/registry.ts` as a single `StepDef`. Give the
`config` schema a `.describe()` on every field — those descriptions are what
Claude reads out of `circuit_catalog`, and a vague one produces a vague
workflow. If the step is performed by Claude rather than settled by Circuit,
add its directive shape in `src/engine/run.ts` and an assertion exercising it in
`scripts/smoke.mjs`.

**Board changes** should come with a harness screenshot in the PR, in both
themes. The visual system is documented in the README; the short version is
that chips are chips, traces are copper, and nothing is round.

**Words on the board are part of the design.** A chip says what it does in
language the person reading it already knows — "sorts into sales, scheduling or
other", not `labels: [...]`. Type names, dot paths and raw config belong in the
inspector, which is one click away. If you add a step type, write its `summary`
as a sentence fragment a non-engineer would understand, and give it a `label`
that is a verb.

**Integrations do not belong here.** Circuit's premise is that it holds no
credentials and reaches nothing on its own. If a workflow needs a new service,
that service is an MCP connector the user adds to Claude — not a module in this
repo. PRs that add an API client will be closed with this paragraph.

## Style

- Prose over abbreviation in anything a user reads: tool descriptions, chip
  titles, errors. "Gmail is not connected" beats "ERR_NO_AUTH".
- No dependency gets added without a sentence in the PR saying what it replaces.
- Comments explain why, not what.
