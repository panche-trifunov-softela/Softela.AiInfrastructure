---
name: browser-debugging
description: How to connect to the developer's Chrome via chrome-devtools MCP, find/open SCExpert tabs, and debug the frontend locally
metadata:
  type: project
  source: softela-ai
---

⚠️ **Only use any of this when the developer explicitly asks, or ask first if the need arises mid-task (even for a throwaway/scratch repro).**

⚠️ **Routine browser repro/QA is delegated to subagents** — see the delegation model roles note: the strong model writes the exact steps/selectors/expected outcomes into the subagent prompt; the subagent drives Chrome with these tools and reports back.

The developer has chrome-devtools MCP wired up, allowing an agent to attach to their running Chrome to debug/verify the SCExpert frontend.

**Setup each session:** the `mcp__chrome-devtools__*` tools are DEFERRED — load schemas first with a tool search, e.g. `select:mcp__chrome-devtools__list_pages,mcp__chrome-devtools__select_page,mcp__chrome-devtools__new_page,mcp__chrome-devtools__navigate_page,mcp__chrome-devtools__take_snapshot,mcp__chrome-devtools__take_screenshot` (also available: `click, fill, fill_form, hover, evaluate_script, list_console_messages, get_console_message, list_network_requests, get_network_request, wait_for, press_key, take_heapsnapshot, performance_*`).

**Find/attach to a tab:**

1. `list_pages` → lists open tabs with numeric ids + URL/title.
2. `select_page({ pageId, bringToFront: true })` → make a tab the active context for subsequent calls.
3. `take_screenshot` (visual check) or `take_snapshot` (an accessibility tree with element `uid`s — PREFER for interacting: click/fill use the uid).
- If the tab isn't open: `new_page({ url })`. `navigate_page({ type: "url"|"reload"|"back"|"forward", url })` to move an existing tab.

**Workflow when asked to debug a page / check a scenario:** call `list_pages`, match the requested URL/screen, `select_page` it (open a `new_page` only if absent or if asked for a new tab), then snapshot/screenshot/console/network as needed and do what's asked.

**Environments:**

- **Local frontend debugging lives at `http://localhost:4200/SCExpert/`** (e.g. `…/screen/<screenId>` opens the Screen Editor for a specific screen). This is the dev server for `Softela.ReactSCExpert`.
- Deployed environments (all FINE, don't be alarmed — the project and its Identity service run there): a handful of internal RD test environments, each following the same URL pattern. Paths there: `/SCExpert/...`, `/Softela.Infra/...`, `/SCExpert.MobileBFF/...`, `/SCExpert.Warehouse/...` (swagger), `/SCExpertLegacy/...` (legacy screen generator).
- Confirmed working: a Screen Editor tab under `http://localhost:4200/SCExpert/screen/<screenId>` shows the Screen Editor plus Screen Builder (good for testing Screen Builder / editor sync).

See the companion note on `frontend-architecture`.
