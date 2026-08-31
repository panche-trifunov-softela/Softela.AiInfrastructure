---
name: pr-splitting-a-branch
description: How to cut an oversized branch into sequential PRs without regressions — strict-prefix stacks, rebase --update-refs, and what makes a rename atomic
metadata:
  type: project
  source: softela-ai
---

Reviewers on this project reject large PRs (one real branch was refused at 57 files). The rule: **≤30 files per PR, and after each merge the system must stay stable — no new bugs.** When that happens, split the branch this way.

**Why:** the two naive splits both fail here. Cutting "mechanical rename" from "behaviour fixes" means authoring the same big files twice, and the mechanical half silently keeps the bugs. Cutting by feature area fails because the consumers of a renamed API cannot be migrated in separate commits.

**How to apply:**

1. **Build a strict-prefix stack, never independent branches.** Each PR is one commit; PR N's tree is PR N+1's tree minus its own changes. Keep the original branch name pointing at the TOP of the stack, so it is still "the branch with everything" and children are just markers inside it.
2. **Rebase with `git rebase --update-refs origin/dev-ng` from the top branch** — it moves every child ref in the stack at once. Rebasing children separately splits the stack. ⚠️ `--update-refs` rewrites **every** ref under `refs/heads/` that points into the rebased range — including a `backup/<name>` branch, which is exactly what it must not do. Park rollback points outside that namespace: `git update-ref refs/backup/<name> <sha>` (visible via `git for-each-ref refs/backup`), since tags get wiped in this repo.
3. **The safety invariant is tree identity**: `git diff <top-of-stack> <pre-split commit>` must be empty. If it is, nothing was lost or invented; only the intermediate states carry risk, and `tsc -p` + `vitest` on EVERY commit bounds that. Verify each commit separately after the final rebase, not just the top.
4. **A barrel re-export makes a rename atomic.** `src/utils/index.ts` does `export *` from several modules; if the old and the new function share a name, TypeScript drops the ambiguous name from the barrel and every importer breaks. So the old symbol must die in the same commit the new one is exported — which drags in all its consumers. Check this before promising a smaller PR.
5. **What CAN be lifted out first:** brand-new pure modules (they are dead code until consumed), an import-cycle fix, type widenings, and any component that touches none of the renamed API. Split a NEW file across PRs freely (add part of it first, extend it later) — that is addition, not re-authoring.
6. **What can be deferred to the LAST PR:** new test files, and extracting a hook out of duplicated inline code. When deferring an extraction, write the inline version in the earlier PR with the FINAL semantics, so the later extraction changes no behaviour.
7. **Do not defer a file whose prop or export another PR's file already references** — it gets dragged back in anyway (e.g. `ScreenBuilder` had to stay because `ComponentMapper` passes it `renderInstanceId`).

`prettier` runs via lint-staged on commit, so a committed slice can differ from the pre-split commit by pure formatting. Fix the pre-split reference, not the slice.

See the companion notes on `softela-git-flow` and `frontend-typecheck-gotcha`.
