---
name: infra-test-run-resource-cap
description: Run Softela.AiInfrastructure's own test suite with `npm run test:capped` (node tests/run.js --workers 6) instead of the uncapped default — recommended command and why it matters
metadata:
  type: project
  source: softela-ai
---

## Recommended default — run this repository's own suite capped

Run the `Softela.AiInfrastructure` suite as:

```
npm run test:capped
```

which is `node tests/run.js --workers 6`. Use it instead of plain `npm test`,
`node tests/run.js` or `npm run test:strict-skips` when the suite runs from
inside an agent session. The project config
(`projects/Softela.AiInfrastructure.json`, `commands.forbidden`) denies those
uncapped forms and points back here. A `--workers <n>` of your own,
`SOFTELA_AI_TEST_WORKERS`, or a filtered run (a path filter such as
`guards/commit-message`) all satisfy it too; `--workers 6` is only the
recommended value.

**Why a cap helps:** `tests/run.js`'s worker pool is clamped to
`min(workers, files)`, so an uncapped run pools up to one worker per CPU core
on the machine it happens to run on — but several suites are integration
tests that shell out to the real CLI, so each worker can spawn further child
processes of its own. That turns "one worker per core" into several times
that many live node processes, on a machine an agent is meant to keep using
for other work at the same time.

**How to apply:**
- `--workers 6` is the only lever needed here — no heap cap (`NODE_OPTIONS
  --max-old-space-size`) is layered on top. `tests/run.js` forks workers that
  inherit the parent's V8 flags, so a heap cap would reach every worker, and a
  heap cap set too low is fatal (`FATAL ERROR: Ineffective mark-compacts near
  heap limit`) rather than merely slow, unlike a lower worker count — not
  worth the risk unless a capped worker count alone turns out insufficient.
- Do not add a worker cap to the `test` or `test:strict-skips` scripts in
  `package.json` — both are kept at full parallelism on purpose, for a human
  or a future CI pipeline. `test:capped` is the separate, agent-facing script.
- Kill leftover node workers from a previous run before judging how heavy the
  next run feels — a stopped run's dying workers can inflate what the next
  run looks like it costs.
- This repository's own suite is small enough that the slowdown against the
  uncapped default is minor; the cap is still worth keeping on by default so
  a full run never quietly pushes the machine into needing many node
  processes at once while an agent is meant to still be usable for other
  work.
