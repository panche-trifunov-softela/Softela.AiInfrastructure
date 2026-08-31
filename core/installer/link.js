"use strict";

/**
 * `softela-ai link [--repo <path>]` — writes the per-repository pointer
 * (INSTALLER.md §6) into a product repository: `AGENTS.md` from
 * `templates/repo-pointer/AGENTS.md`, and, where Claude Code needs
 * `CLAUDE.md`, a one-line import of `AGENTS.md` rather than a second copy.
 *
 * Automatic detection of a repository's own conventions conflicting with
 * the shipped standard (INSTALLER.md §6, "the installer does not pick a
 * winner") is not implemented here — nothing in this repository specifies
 * what "contradicts" means well enough to detect it without guessing, so
 * `link` always writes the managed block (safe: everything outside the
 * markers is preserved) and names the gap in its result for the CLI to
 * report, rather than silently pretending the check ran.
 */

const path = require("path");
const { readText, writeTextAtomic } = require("../lib/fs-safe");
const paths = require("../lib/paths");
const { resolveProject } = require("../lib/project-resolver");
const sj = require("./settings-json");
const mb = require("./managed-block");

/** Claude Code's own import syntax, so `CLAUDE.md` is never a second copy of `AGENTS.md`. */
const CLAUDE_MD_BODY = "@AGENTS.md";

/**
 * Computes what `link` would write, without touching the filesystem.
 *
 * @param {{repo?: string, now?: number}} [options] `repo` is the target
 * repository, defaulting to the current working directory; `now` overrides
 * the clock, mainly for tests.
 * @returns {{ok: true, project: object, actions: object[], note: string} | {ok: false, reason: string}}
 * `actions` are `{kind: "block", target, action: "write" | "none", content, state}`
 * entries for `AGENTS.md` and `CLAUDE.md`; `ok: false` only when the
 * shipped template itself cannot be read.
 */
function planLink(options = {}) {
  const repoPath = path.resolve(options.repo || process.cwd());
  const project = resolveProject(repoPath);

  const templatePath = path.join(paths.repoRoot(), "templates", "repo-pointer", "AGENTS.md");
  const template = readText(templatePath);
  if (template === null) return { ok: false, reason: `shipped template missing: ${templatePath}` };

  const baseBranches =
    Array.isArray(project.baseBranches) && project.baseBranches.length ? project.baseBranches.join(", ") : "none configured";
  const vars = {
    PROJECT_ID: project.id,
    BASE_BRANCHES: baseBranches,
    PROJECT_CONFIG: path.join(paths.repoRoot(), "projects", `${project.id}.json`),
    INSTALLED_AT: new Date(typeof options.now === "number" ? options.now : Date.now()).toISOString(),
    STANDARDS_PATH: path.join(paths.repoRoot(), "docs", "standards"),
  };
  const substituted = sj.substitute(template, vars);

  const agentsMdPath = path.join(repoPath, "AGENTS.md");
  const existingAgentsMd = readText(agentsMdPath);
  const agentsMdResult = mb.applyTemplate(existingAgentsMd, substituted);

  const claudeMdPath = path.join(repoPath, "CLAUDE.md");
  const existingClaudeMd = readText(claudeMdPath);
  const claudeMdResult = mb.upsertBlock(existingClaudeMd || "", CLAUDE_MD_BODY);

  return {
    ok: true,
    project,
    actions: [
      {
        kind: "block",
        target: agentsMdPath,
        state: existingAgentsMd === null ? "new" : agentsMdResult.changed ? "modified" : "current",
        action: agentsMdResult.changed ? "write" : "none",
        content: agentsMdResult.content,
      },
      {
        kind: "block",
        target: claudeMdPath,
        state: existingClaudeMd === null ? "new" : claudeMdResult.changed ? "modified" : "current",
        action: claudeMdResult.changed ? "write" : "none",
        content: claudeMdResult.content,
      },
    ],
    note:
      "This repository's own conventions were not automatically checked against the shipped standard — " +
      "review AGENTS.md and resolve any conflict by hand, then record the decision in the project config.",
  };
}

/**
 * Executes a plan built by {@link planLink}.
 *
 * @param {{actions: object[]}} planResult A successful {@link planLink}
 * result.
 * @returns {string[]} The absolute paths actually written.
 */
function applyLink(planResult) {
  const written = [];
  for (const a of planResult.actions) {
    if (a.action !== "write") continue;
    writeTextAtomic(a.target, a.content);
    written.push(a.target);
  }
  return written;
}

module.exports = { planLink, applyLink };
