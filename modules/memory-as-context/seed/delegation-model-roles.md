---
name: delegation-model-roles
description: How to split work by model tier — the strong model is the "brain" that chooses each subagent's tier by task difficulty, never a fixed cheapest-always rule
metadata:
  type: reference
  source: softela-ai
---

**This is the default operating mode — always on, no need to be asked. Only deviate when the developer explicitly asks for something different on a given task.** The goal: efficient work, high-quality results, and no burning tokens on anything that does not need the strong model.

When running as the strong, frontier-tier model, act as the **"brain"**, not the coder:

- Design structure/architecture, make decisions, work out complex flows and logic.
- Find root causes of bugs/regressions, spot what can be improved.
- Verify results and **validate subagents' work**.
- **Do NOT write code yourself unless the developer explicitly asks you to.** Delegate the actual code-writing.

The framing: the strong model is **the brain AND the orchestrator** (analyze, plan, think through the solution/architecture/structure, hand out tasks, validate results); subagents are **its hands** — they write the code, except when the developer separately asks the strong model to write it.

## Choosing a tier is a judgement call, never a fixed rule

Delegating to the cheapest tier every time is not the rule — the rule is that **the strong model doing the analysis chooses each subagent's tier by how hard that particular task is.** A task that is simple and mechanical goes to the cheap tier; a task that still needs judgement, ambiguity resolution, or careful correctness goes to the tier one step down from frontier, never to the cheapest tier just to save tokens.

The concrete tiers depend on the host:

- **Claude Code:** harder/judgement-requiring work goes to **Sonnet**; simple/low-risk/mechanical work goes to **Haiku**.
- **Codex:** the equivalent split is **Terra** (harder, judgement-requiring) and **Luna** (simple, mechanical).

**Every subagent spawn names its model explicitly.** Omitting the model silently inherits the session's own model — the strong, frontier-tier one — which is exactly the silent escalation this rule exists to prevent. There is no default that does the right thing on its own; it only happens if a model is actually typed into the spawn.

- **Mechanically enforced by a shared delegation guard, not just self-discipline.** This used to be a rule the strong model had to catch in itself; it no longer is — a `PreToolUse` hook inspects the spawn call before it runs.
  - **Denied outright:** a subagent spawn with no model or with an unrecognized value, and a multi-agent workflow script whose individual agent spawns don't all carry an explicit, valid model (a shared constant spread into each call is allowed to carry the model along). Also denied: reasoning effort set below `medium` anywhere in such a script.
  - **Escalated to the developer for explicit approval:** requesting the frontier tier for a subagent (Opus/Fable-class on Claude Code, the frontier tier on Codex), and any spawn mode that ignores an explicit model and inherits the session's own model instead — that combination always needs explicit sign-off, precisely because it bypasses the tier choice silently.
  - **What the guard can't decide, and what still needs judgement every time:** which tier actually fits the task, and baking the right context into the prompt (below) — a guard can check that a model string is present and valid, not that it is the *right* one, or that the subagent isn't starting cold on work the strong model already did.
- Reasoning effort is **never below `medium`** on any subagent spawn that sets it explicitly. When a host or spawn mode does not expose an effort/thinking-mode parameter at all, match the subagent to the strong model's own effort and thinking mode instead of leaving it unset.
- **Share context with subagents to save tokens.** A fresh subagent spawn starts cold and re-derives everything unless told otherwise, so put what is already known INTO the prompt: exact file paths and line ranges, relevant code/findings already read, the root cause, the concrete plan, the acceptance criteria, and which memory files to read (the global index plus the specific linked notes). Goal: the subagent should almost never have to re-read a file the strong model already read. When context is large, prefer continuing an existing subagent (where the host supports it) over a fresh spawn that would need everything re-explained.

## Writing the knowledge base is also delegated — never to the cheapest tier

Writing durable memory content is delegated to the harder-judgement tier specifically (Sonnet on Claude Code, Terra on Codex) — never the cheap tier. The cheap tier is deliberately excluded here: it can muddle or transpose facts, and a wrong memory file is worse than a missing one. The frontier tier is wasteful for what is ultimately typing prose. There is a checkable threshold rather than a matter of taste:

- **Inline only when BOTH hold:** at most **3 files** (new or existing) **and roughly 90 changed lines total**. Below that, a subagent's fixed cost — cold start, re-reading the file, returning a summary — runs to several thousand tokens against a small fraction of that for a surgical direct edit, so delegating is meaningfully more expensive, not less.
- **Above it, delegation is mandatory:** new memory files, multi-file reconciliation, restructuring, any git-driven sweep across the base.
- **`## INTENT` sections are never delegated and never derived from code** — only the developer overturns intent. Say so explicitly in the subagent's prompt: it may write `## AS-OBSERVED` and `## CONFLICT` sections, and must leave `## INTENT` alone, or a shared memory guard will interrupt it mid-run.
- **The analysis is not delegated with the typing.** Deciding what is true, what moved in git, and what must be recorded stays orchestration; the subagent receives those findings already made.

## Browser/Chrome flow verification is also delegated

Don't drive a browser automation tool directly from the strong model for routine repro/QA — spell out the exact steps/selectors/expected state in the subagent's prompt, and have the subagent drive the browser and report back on the flow. Driving the browser from the strong model burns tokens on snapshots and DOM dumps that a cheaper model can equally read and act on. Exception: only when the developer explicitly asks the strong model to check something in the browser itself.

**Why:** token economy — reserve the expensive strong model for reasoning, architecture and validation; push mechanical code-writing and browser-driving to cheaper tiers chosen by task difficulty; and avoid paying twice for file reads by feeding known context down to the subagent doing the work.

**How to apply:** on any coding task, plan and decide first, then spawn subagent(s) to implement **with the shared context baked into their prompt and an explicit, judgement-based model choice**, then review their output before reporting done. Only pick up the keyboard directly if explicitly told to.
