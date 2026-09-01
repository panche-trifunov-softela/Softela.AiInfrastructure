---
name: softela-git-flow
description: The git flow an agent follows in every Softela repository — branch naming, rebase not merge, squash merge through the PR host, no AI trailer, never push
metadata:
  type: reference
  source: softela-ai
---

One git flow applies across every repository here — though not everyone on the team follows it yet, so the agent should. **The base branch and the pull-request host are per-repository configuration, never constants**: read them from the project's own config (`baseBranches`) and its doc under `docs/projects/`, and never assume the last repository's answer carries over.

## The agreed flow (authoritative; a repository's own history does not overrule it)

- **Branch names:** `{feature|bugfix}/task_{task_number}_{branch_name_in_lower_case}`, e.g. `feature/task_12345_all_editors_integration`. Where a repository's own config relaxes the ticket number to optional, that config wins — it was written against that repository's real branches.
- **Keep a branch current by REBASE, not merge.** Rebase onto the base branch instead of merging the base into the branch; that is what keeps history linear. Never `git merge <base>` into a feature branch.
- **Merge your own PR through the host** — a **squash merge** with **delete source branch** enabled. Never merge locally into the base.
- **No `Co-Authored-By: Claude` / AI-attribution trailer** in a commit or a PR body, in any repository. This overrides the default AI-tool commit trailer.
- **Commit message format = SHORT.** Subject line only is the preferred default. No `#<workitem>` or ticket-id prefix, no co-author trailer, and **no conventional-commits prefix** (`feat:` / `fix:` / `chore:` …) — even where a repository's own history is full of them.
- **EXCEPTION — the final squashed handover commit.** When a whole branch has been squashed into the one commit the developer will push, that commit DOES want a body: a short, scannable summary grouped as terse bullets (e.g. `Refactor` / `Fixes` / `Improvements`). Still no prose, no root-cause narratives. Intermediate commits stay subject-only. **Practical note:** the shared shell guard denies any `git commit` with more than one `-m`, an `-m` value that is a heredoc/here-string, or a newline inside the subject, and there is no carve-out for this exception — so produce it with `git commit -F <tempfile>` (not matched by the guard), or leave that one commit to the developer.
- **Commit BODY on intermediate commits: prefer none at all.** If one is genuinely warranted it must be a terse bullet list of what was touched, never prose. **No root-cause narratives, no "why it broke" explanations, no multi-paragraph reasoning.** Analysis belongs in the chat and in the memory base, not in git history.
- **PR target is the repository's own base branch**, whatever its config says. Never a release branch, and never a branch you picked because another repository uses it.
- **One ticket number can cover many branches.** Several sub-tasks under a single ticket is normal, so a branch whose number matches an already-shipped task is NOT evidence of a naming mistake.
- **PR SIZE IS A HARD CONSTRAINT.** Many small branches and PRs beat one big weekly PR nobody can review. **Target ≤30 changed files per PR; anything over 50 is refused outright and sent back to be split.** Plan the cut-points up front — see [[pr-splitting-a-branch]] for the recovery procedure when that was not done.
- **But do NOT branch for every sneeze.** The developer explicitly does not want branches carrying 1–5 changed files; branch and PR administration then costs more than the review it buys. Group related work into a sensibly sized branch.
- **Git operations an agent may perform unasked:** create and delete branches (only when genuinely needed), commit, delete commits (carefully), pull, and rebase onto the current base. **NEVER push — no exceptions.**
- **Rebase onto the CURRENT base as the last step before handing a branch over**, not once early. A fast-moving base can land five or more commits during a single working session, repeatedly touching the same files. Rebase early too if incoming commits touch the files being worked on, then again at the end.
- **Conflict resolution: absorb intent, never resolve mechanically.** Take the incoming commit's *purpose* into the current design rather than picking a side. **But when the two sides genuinely disagree on logic, or the incoming change makes existing logic contradictory, STOP and report it** rather than deciding alone — say what each side intended and why they conflict.

**Why:** a clean linear history and a tidy base-branch history through squash merges. The developer stated this flow explicitly, and repository history corroborates it — it is authoritative because the developer said so, not because a file in a repo says so.

**How to apply:** create branches with this naming; update by rebase; never add a co-author trailer. An agent MAY auto-commit its own changes without asking — but NEVER push, and never delete or rewrite the pre-existing baseline commits. Many small local commits are fine; the developer pushes and does the final squash merge.

## Team-wide rules the shared guards may enforce

Scope note: the section above is what the developer personally wants an agent to do, and it is deliberately stricter than team norms. This section is what shared guards may impose on **the whole team**, where the convention is genuinely looser and is not always followed. Do not raise team-wide guards to the personal standard above.

- **Branch names — ASK, never DENY.** Deliberately permissive: `_` or `-` as the separator, and the ticket may appear as `task_{number}`, `ticket_{number}`, the bare number, or not at all where a repository's config says so. A branch outside the pattern makes a guard ask and show the preferred form; the developer may proceed deliberately. Real branches include shapes a hard denial would block, and the guard exists to catch an agent being sloppy, not to stop a human.
- **Rebase is preferred but merge is NOT hard-forbidden** for keeping a branch current. Downgraded from a denial to a prompt for team-wide guards.
- **Merging locally into a base branch — and force-pushing there — stays FORBIDDEN.** Everything reaches a base branch through a PR with a squash merge. This is the hard line.
- **Base branch names are per-repository configuration, never a constant.** A shared guard must read the base from project configuration; assuming a single organisation-wide base is exactly the mistake to avoid.
- **Release branches and tags follow the repository, not a wiki page.** Where a repository's real practice and a written convention disagree, real practice is the one to encode — and a convention nothing actually follows should not become a rule.

## What is enforced mechanically

`git push`; `git merge <base>` into a branch; `git pull` without `--rebase`; a `Co-Authored-By` trailer; a conventional-commit prefix (`feat:` / `fix:` / …); and a `#<3+ digits>` ticket id in the subject are all hard PreToolUse denials in the shared shell guard. These are no longer things an agent has to catch itself — the tool call is blocked before it runs, and the denial carries the corrected command.

The portable, written-up version of these rules is `docs/standards/git-flow.md`.
