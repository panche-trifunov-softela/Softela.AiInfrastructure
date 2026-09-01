---
name: browser-debugging
description: How to attach to the developer's Chrome via chrome-devtools MCP and debug a running frontend — only on explicit request, and normally delegated
metadata:
  type: reference
  source: softela-ai
---

⚠️ **Only use any of this when the developer explicitly asks, or ask first if the need arises mid-task (even for a throwaway/scratch repro).** Attaching to someone's real browser is not a routine investigative step.

⚠️ **Routine browser repro/QA is delegated to subagents** — see [[delegation-model-roles]]: the strong model writes the exact steps, selectors and expected outcomes into the subagent prompt; the subagent drives Chrome with these tools and reports back.

Where the developer has chrome-devtools MCP wired up, an agent can attach to their running Chrome to debug or verify a frontend.

**Setup each session:** the `mcp__chrome-devtools__*` tools are DEFERRED — load their schemas first with a tool search, e.g. `select:mcp__chrome-devtools__list_pages,mcp__chrome-devtools__select_page,mcp__chrome-devtools__new_page,mcp__chrome-devtools__navigate_page,mcp__chrome-devtools__take_snapshot,mcp__chrome-devtools__take_screenshot` (also available: `click, fill, fill_form, hover, evaluate_script, list_console_messages, get_console_message, list_network_requests, get_network_request, wait_for, press_key, take_heapsnapshot, performance_*`).

**Find and attach to a tab:**

1. `list_pages` → open tabs with numeric ids plus URL/title.
2. `select_page({ pageId, bringToFront: true })` → make one tab the active context for every later call.
3. `take_screenshot` for a visual check, or `take_snapshot` for an accessibility tree carrying element `uid`s — **prefer the snapshot for interacting**, since `click` and `fill` take a uid.

If the tab is not open: `new_page({ url })`. `navigate_page({ type: "url"|"reload"|"back"|"forward", url })` moves an existing one.

**Workflow when asked to debug a page or check a scenario:** `list_pages`, match the requested URL or screen, `select_page` it (open a `new_page` only if it is absent or the developer asked for a new tab), then snapshot, screenshot, console and network as needed.

**Two standing cautions:**

- **Do not assume a URL.** Ask the developer for the dev-server origin and path, or read it from the project's own docs — a guessed URL either 404s or, worse, hits a shared environment nobody meant you to touch.
- **A deployed environment is shared.** Anything created there is visible to the whole team; see [[test-entity-naming]] for how a throwaway entity must be named and that it has to be deleted afterwards.
