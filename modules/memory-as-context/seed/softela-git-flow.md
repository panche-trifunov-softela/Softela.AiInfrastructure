---
name: softela-git-flow
description: The single correct git flow for the whole Softela SCExpert project (both repos) — branch naming, rebase, Azure DevOps squash merge, no co-author
metadata:
  type: project
  source: softela-ai
---

One git flow applies across the WHOLE project (both `Softela.ReactSCExpert` and `Softela.SCExpert`) — though not everyone on the team follows it yet, so the agent should.

## The agreed flow (authoritative; the repos' own history does not overrule it)

- **Branch names:** `{feature|bugfix}/task_{task_number}_{branch_name_in_lower_case}` (e.g. `feature/task_12345_all_editors_integration`).
- **Keep branch current via REBASE, not merge:** rebase the branch onto the base branch (`dev` / `dev-ng`) instead of merging base into the branch — keeps a clean linear commit history. Never `git merge dev` into the feature branch.
- **Merging your own PR** into `dev` / `dev-ng`: do it through **Azure DevOps** as a **squash merge** with **delete source branch** enabled. (Don't merge locally.)
- **No `Co-Authored-By: Claude` / AI-attribution trailer** in commits or PR bodies — on EITHER repo. (This overrides a default AI-tool commit trailer for this project.)
- **Commit message format = SHORT.** Subject line only is the preferred default. NO `#<workitem>` / task-number prefix, no ticket id, no co-author trailer, and **NO conventional-commits prefix** (`feat:` / `fix:` / `chore:` …) — even though the team's own `dev-ng` history is full of `feat:`.
- **EXCEPTION — the final squashed handover commit.** When a whole branch has been squashed into the one commit the developer will push, that commit DOES want a body: a short, scannable summary of what was done, grouped (e.g. `Refactor` / `Fixes` / `Improvements`), as terse bullets. Still no prose, no root-cause narratives. This exception applies ONLY to that final commit — intermediate ones stay subject-only. **Practical note:** the shared shell guard denies any `git commit` with more than one `-m`, an `-m` value that is a heredoc/here-string, or a newline inside the subject — there is no carve-out for this exception, so a multi-line body cannot go through the normal `-m` path at all. Produce it via `git commit -F <tempfile>` (not matched by the guard), or leave writing that one commit to the developer.
- **Commit BODY (intermediate commits): prefer none at all.** If a body is genuinely warranted, it must be very short and to the point — a terse bullet LIST of what was done/touched, never prose. **No root-cause narratives, no "why it broke" explanations, no multi-paragraph reasoning.** Analysis belongs in the chat and in the memory base, NOT in git history. (Many small commits get squashed by the developer into one final commit with a message the developer writes, so intermediate messages only need to be scannable.) The team's historical merged-PR commits used `#<workitem> - <summary>`, but that convention is explicitly NOT to be followed for an agent's own commits.
- PR target is `dev` (or `dev-ng`), never master.
- **One ticket number can cover many branches.** The team's flow allows several sub-tasks under a single ticket, so multiple branches legitimately carry the same `task_{number}`. A branch whose number matches an already-shipped task is therefore NOT evidence of a naming mistake.
- **PR SIZE IS A HARD CONSTRAINT.** Many small branches and PRs beat one big weekly PR nobody can review. **Target ≤30 changed files per PR; anything over 50 is refused outright and sent back to be split.** Plan the cut-points up front rather than after the fact — see the companion note on splitting an oversized branch for the recovery procedure, not the plan.
- **But do NOT branch for every sneeze.** The developer explicitly does not want branches carrying 1-5 changed files — branch/PR administration then costs more than the review it buys. Group related work into a sensibly-sized branch.
- **Git operations an agent may perform unasked:** create and delete branches (only when genuinely needed), commit, delete commits (carefully), pull, and rebase onto the current base (`dev` / `dev-ng`, whichever the repo uses). **NEVER push — no exceptions.**
- **Rebase onto the CURRENT base as the last step before handing a branch over**, not once early — `dev-ng` moves fast (five or more commits landed during a single working session has been observed, repeatedly touching the same files). Rebase early too if the incoming commits touch the files being worked on, then again at the end.
- **Conflict resolution: absorb intent, never resolve mechanically.** Take the incoming commit's *purpose* into the current design rather than picking a side. **But when the two sides genuinely disagree on logic, or the incoming change makes existing logic contradictory, STOP and report it to the developer instead of deciding alone**. Report what each side intended and why they conflict.

**Why:** team standard for clean linear history and a tidy `dev` history (squash). The developer stated this flow explicitly, and git history corroborates it — it is authoritative because the developer said so, not because a repo `.md` file says so.

**How to apply:** create branches with this exact naming; update via rebase; never add co-author trailers. An agent MAY auto-commit its own changes without asking — but NEVER push, and never delete/rewrite the pre-existing (baseline) commits. Many small local commits are fine; the developer pushes and does the final squash-merge in Azure DevOps (an agent does not merge to dev itself).

## Team-wide rules the shared guards may enforce

Scope note: the section above is what the developer personally wants an agent to do — it is deliberately stricter than team norms. This section is what shared guards may impose on **the whole team**, where the convention is genuinely looser and is not always followed. Do not raise team-wide guards to the personal standard above.

Settled after comparing the team wiki's git-workflow page against the real repos. That wiki page reads as a generic git tutorial: it knows only a single `dev` base, never mentions `dev-ng`, and prescribes local merges with `--force-with-lease`. The ruling below takes the middle ground.

- **Branch names — ASK, never DENY.** Deliberately permissive: `_` or `-` as the separator, and the ticket may appear as `task_{number}`, `ticket_{number}` or just the bare number. A branch outside the pattern makes a guard ask and show the preferred form; the developer may proceed deliberately. Rationale: real branches on origin have included things like `feature/dt_editor_fundamentals` and `cleanForm` — a hard denial would block work the team creates on purpose. The guard exists to catch an agent being sloppy, not to stop a human.
- **Rebase is preferred but merge is NOT hard-forbidden** for keeping a branch current. This is downgraded from a denial to a prompt for team-wide guards.
- **Merging locally into `dev`/`main` — and force-pushing there — stays FORBIDDEN.** Everything reaches the base branch through a PR with a **squash merge**. This is the hard line.
- **Base branch names are per-repo configuration, never a constant.** `dev-ng` for `Softela.ReactSCExpert`, `dev` for `Softela.SCExpert`; other repos may differ. The wiki's single-`dev` assumption is exactly the mistake to avoid, so a shared guard must read the base from project configuration.
- **Release branches follow the repo, not the wiki.** Real release branches seen on origin are plural, e.g. `releases/25.3`, `releases/25.3.4`, `releases/26.1`, `releases/26.2`. The wiki's singular `release/25.3` is wrong.
- **Patches and tags follow the repo too.** The wiki prescribes per-patch tags like `v25.3.1`; the frontend repo has exactly **one** tag in total (`v26.2.0`), so that practice is effectively not in use. Do not encode it as a rule.

## Where the team wiki disagrees with reality

The team's internal wiki page for git workflow (still generic) contradicts the repos on branch naming, base branches, merge mechanics and release-branch naming, and refers to a CI system the org does not actually use for this project (it runs Azure DevOps). Resolved by the developer in favour of real practice — see the section above. **The wiki page itself has not been corrected**; raising it with the team is a separate, pending step, and only the developer or the team edits the wiki.

## What is enforced mechanically

- **Mechanically enforced, not just remembered.** `git push`; `git merge dev|dev-ng|main|master` into the branch; `git pull` without `--rebase`; a Co-Authored-By trailer; a conventional-commit prefix (`feat:`/`fix:`/…); and a `#<3+ digits>` ticket id in the subject are all hard PreToolUse denials in the shared shell guard. These are no longer things an agent needs to catch itself; the tool call is blocked before it runs, and the denial message carries the corrected command to use instead.
