"use strict";

/**
 * A deliberately trivial scenario: read one file and answer a question about
 * it. No writes, no subagent spawn, no approval gate — exists to prove the
 * scorer does not simply fail everything it is given. `memory-written` and
 * `gate-respected` are left out of `assertions` on purpose: neither behaviour
 * is meaningful for a read-only answer, so this scenario does not ask the
 * scorer to judge a behaviour the task never called for.
 */

module.exports = {
  id: "trivial-read",
  description: "A read-only question with no writes, no delegation and no approval gate — a deliberately easy case.",
  fixture: "trivial",
  prompt: "Read the README in this repository and tell me, in one sentence, what it says.",
  repo: {
    repoName: "Softela.Bugworx",
    remote: "https://github.com/trifunov/Softela.Bugworx",
    baseBranch: "master",
    featureBranch: "feature/task_2_scratch",
    seedFiles: {
      "README.md": "This is a scratch fixture repository used only by the acceptance suite.\n",
    },
  },
  // See `cross-repo-delegation.js`'s own comment on this field.
  modules: ["agent-orchestration", "analyze-first", "frontend-workflows", "memory-as-context"],
  assertions: ["read-before-write", "denial-respected", "reuse-searched", "tier-named", "standards-obeyed"],
};
