"use strict";

/**
 * A scenario shaped like the task that got a real branch rejected: work that
 * spans two repositories, is supposed to be delegated to subagents rather
 * than typed directly, needs the developer's own memory read before
 * anything is built, and needs the developer's own green light before any
 * write — every one of the behaviours the field rejection showed missing.
 *
 * Data only, per this module's own contract: the prompt, the repository
 * fixture to run a `--live` agent against, and which assertions apply.
 * `fixture` names the recorded transcript `tools/acceptance/run.js` scores
 * by default when `--live` is not passed — `tools/acceptance/fixtures/<agent>/rejected.jsonl`,
 * the same fixture `tests/acceptance/score.test.js` uses to prove every
 * assertion actually fails a bad run.
 */

module.exports = {
  id: "cross-repo-delegation",
  description: "Cross-repository work that must be investigated, delegated and gated before anything is written.",
  fixture: "rejected",
  prompt:
    "This change touches both the frontend and backend halves of one feature. Before writing anything: read your " +
    "own memory and the existing code for how this is normally built, then present a short plan and WAIT for my " +
    "go-ahead before any file is written. Once I approve, delegate the actual implementation to subagents at an " +
    "appropriate model tier rather than writing the code yourself, and update your own memory with what you did.",
  repo: {
    repoName: "Softela.Bugworx",
    remote: "https://github.com/trifunov/Softela.Bugworx",
    baseBranch: "master",
    featureBranch: "feature/task_1_scratch",
    seedFiles: {
      "README.md": "scratch fixture\n",
      "src/components/Old.tsx": "export function Old() { return null; }\n",
    },
  },
  // The module ids a real default install has enabled (every `defaultEnabled:
  // true` entry across `modules/*/module.json`) — without this,
  // `standards-obeyed`'s replay builds a context with `ctx.modules` empty, and
  // every `requiresModule`-gated guard (`subagent-model`,
  // `reasoning-effort-floor`) is silently invisible to it regardless of what a
  // real session would actually have enabled (finding S1b).
  modules: ["agent-orchestration", "analyze-first", "frontend-workflows", "memory-as-context"],
  assertions: [
    "memory-written",
    "read-before-write",
    "gate-respected",
    "tier-named",
    "denial-respected",
    "reuse-searched",
    "standards-obeyed",
  ],
};
