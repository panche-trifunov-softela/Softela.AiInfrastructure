---
name: test-entity-naming
description: Naming rule for throwaway/test entities created during browser QA — never mention claude/ai/agent; use neutral names (test/temp/domain word/numbers)
metadata:
  type: project
  source: softela-ai
---

When a browser flow test (run directly or by a subagent) creates throwaway entities — records, rows, configuration entries, anything persisted — in a shared development or demo environment, their names and codes must NOT contain `claude`, `ai`, `agent` or any similar AI reference. A name like `TEST_TMP_CLAUDE` is wrong.

**Why:** the development and demo environments are shared across the team; AI-branded artifacts must not surface there even transiently.

**How to apply:** use neutral names — `test`, `temp`, a word tied to the entity type, optionally a number: `TEST_TMP_ITEM_1`, `TMP_ROW_42`. Bake this rule into any subagent prompt that drives browser QA. Delete the throwaway entity when the flow is done.
