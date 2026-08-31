---
name: frontend-test-run-resource-cap
description: Run the frontend vitest suite with a capped worker pool instead of the default one-worker-per-core spawn — recommended flags and measured numbers
metadata:
  type: project
  source: softela-ai
---

## Recommended default — run the frontend suite capped

Run the `Softela.ReactSCExpert` suite as:

```
NODE_OPTIONS=--max-old-space-size=224 node node_modules/vitest/vitest.mjs run --maxWorkers=4
```

Prefer this over plain `npx vitest run`. An uncapped run spawns one worker per available core, which on a many-core development machine can turn into dozens of node processes and multiple gigabytes of resident memory while the agent is still supposed to be usable for other work — a developer has reported this directly as "node processes eating more than 2 GB" while an agent session was running.

**Why a cap helps:** an uncapped run on a 22-core machine, observed directly, produced ~21 workers, 23 node processes and **4635 MB** peak resident memory. That was not hooks — hooks are one-shot, live around 96 ms and hold effectively 0 MB — it was the test worker pool itself, which is why the memory footprint vanishes the moment the run stops.

**How to apply:**
- Three levers together give the effect, not any one alone: `--maxWorkers=4`, a `NODE_OPTIONS=--max-old-space-size=224` heap cap per worker, and invoking `vitest.mjs` through `node` directly instead of `npx` (the `npx` wrapper adds a whole extra ~74 MB process that does nothing useful).
- Expect a real slowdown against the uncapped default — roughly 300 s against roughly 123 s uncapped in measurements below. A responsive development machine while the suite runs is worth trading against a faster suite; do not quietly drop the cap to "fix" the slow run.
- Do NOT put this in `vitest.config.ts` — that file is shared with the team and with CI, where full parallelism is wanted. This is the invocation an agent uses locally, not a repo-wide setting.
- Kill leftover worker processes before measuring anything: a stopped run's dying workers can sit around for minutes and inflate the next sample by hundreds of MB.

## Measurements that justify the cap (vitest 4.1.8, 22-core machine)

Every row is a full run of the real suite (123 files / 1356 tests at the time of measurement), peak working set sampled every 3 s across all vitest node processes.

| configuration | procs | peak RAM | duration | result |
|---|---|---|---|---|
| default (~21 workers) | 23 | 4635 MB | 123 s | pass |
| `--maxWorkers=4` | 10 | ~2767 MB | - | pass |
| `--maxWorkers=4`, heap 224 MB, via npx | 10 | 1942 MB | 246 s | pass |
| **`--maxWorkers=4`, heap 224 MB, direct node** | **5** | **1328 MB** | **301 s** | **1356 passed** |
| `--maxWorkers=4`, heap 160 MB | - | - | - | **OOM, fatal** |
| `--pool=threads --maxWorkers=6` | 4 | 2451 MB | 222 s | **34 failed** |

Two dead ends, worth not retrying:
- **160 MB heap** dies with `FATAL ERROR: Ineffective mark-compacts near heap limit`. 224 MB is effectively the floor for this suite.
- **The threads pool** is worse on all three axes — more RAM, not faster, and it breaks 34 tests in 3 files. Each thread still carries its own V8 isolate, so only process overhead is shared. Forks (the vitest default pool) win here.

Measure under the load being complained about, never at rest: a first sample taken at idle showed node at 21 MB and looked like the complaint was unfounded. It was not — the spike only appears during an actual test run.
