---
name: frontend-dependency-install
description: Installing node dependencies in Softela.ReactSCExpert — always npm i --force
metadata:
  type: project
  source: softela-ai
---

In `Softela.ReactSCExpert` install dependencies with **`npm i --force`** (project convention). Plain `npm install` / `npm ci` can fail or resolve differently because the project carries peer-dependency conflicts.

**Why it matters beyond convenience:** the test suite runs through `node_modules/.bin` (`npx vitest`). If `.bin` is missing, every `npx`-driven check fails in a way that looks like a broken repo rather than broken tooling — check `ls node_modules/.bin` before believing such a failure.

**Windows/worktree caution:** do NOT try to share `node_modules` into a git worktree with `ln -s` from Git Bash — Windows falls back to a full recursive COPY, and aborting it midway can destroy `node_modules/.bin` in the MAIN checkout. Use a real directory junction (`New-Item -ItemType Junction`), and when cleaning such a worktree up delete the junction itself first (`[System.IO.Directory]::Delete(path, $false)`) before removing the folder — a plain `rm -rf` follows the junction and would delete the real `node_modules`.
