---
name: test-entity-naming
description: Naming rule for throwaway/test entities created during browser QA — never mention claude/ai/agent; use neutral names (test/temp/domain word/numbers)
metadata:
  type: project
  source: softela-ai
---

When a browser flow test (run directly or by a subagent) creates throwaway entities (ACs, docks, screens, DTs, rows, and similar) in a shared Softela SCExpert environment, their names/codes must NOT contain `claude`, `ai`, `agent` or similar AI references — a name like `TEST_TMP_CLAUDE` is wrong.

**Why:** the development and demo environments are shared across the team; AI-branded artifacts must not surface there even transiently.

**How to apply:** use neutral names — `test`, `temp`, a word tied to the entity type, optionally numbers, e.g. `TEST_TMP_AC_1`, `TMP_DOCK_42`. Bake this rule into subagent prompts that drive browser QA. Delete the throwaway entity when the flow is done.
