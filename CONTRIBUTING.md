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
npm run dev & sleep 3 && node scripts/smoke.mjs
```

`smoke.mjs` plays the part of Claude and drives a whole run — a loop, a
classify fan-out, an approval gate, template resolution, and both guard rails.
If it prints `SMOKE OK`, the server contract still holds.

## What good changes look like

**New step types** belong in `src/registry.ts` as a single `StepDef`. Give the
`config` schema a `.describe()` on every field — those descriptions are what
Claude reads out of `circuit_catalog`, and a vague one produces a vague
workflow. If the step is performed by Claude rather than settled by Circuit,
add its directive shape in `src/engine/run.ts` and a line exercising it in
`scripts/smoke.mjs`.

**Board changes** should come with a harness screenshot in the PR, in both
themes. The visual system is documented in the README; the short version is
that chips are chips, traces are copper, and nothing is round.

**Integrations do not belong here.** Circuit's premise is that it holds no
credentials and reaches nothing on its own. If a workflow needs a new service,
that service is an MCP connector the user adds to Claude — not a module in this
repo. PRs that add an API client will be closed with this paragraph.

## Style

- Prose over abbreviation in anything a user reads: tool descriptions, chip
  titles, errors. "Gmail is not connected" beats "ERR_NO_AUTH".
- No dependency gets added without a sentence in the PR saying what it replaces.
- Comments explain why, not what.
