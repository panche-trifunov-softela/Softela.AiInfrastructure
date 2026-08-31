"use strict";

/**
 * Denies a `git push` that would land on a base branch, and a force-push
 * that would land on a release branch, while leaving an ordinary
 * feature-branch push silent.
 *
 * Base branches are reached only through a pull request and a squash merge;
 * a direct push bypasses that review entirely. Release branches are not
 * always named in `baseBranches` but a rewritten history there is the same
 * failure by another door.
 *
 * An argument-less `git push` (or one naming only a remote) resolves its
 * real target through `ctx.git.upstreamBranch` when one is configured,
 * exactly as git itself resolves the same command through whatever the
 * branch tracks. This is deliberately blind to `push.default`: under the
 * `simple` default a name mismatch between the local branch and its
 * upstream makes git refuse the push outright, so treating the upstream as
 * the target only denies earlier what git would already have refused; under
 * `upstream`/`tracking` it is exactly what ships; only `current` can, in
 * principle, send an argument-less push somewhere other than the upstream —
 * an unusual, non-default setting this project does not otherwise assume,
 * and denying a same-upstream push too eagerly under it is judged the safer
 * failure mode than silently allowing the far more common `simple`/default
 * case to land directly on a base branch.
 */

const { gitVerb, splitStatements } = require("../lib/shell-parse");
const { compile } = require("../lib/safe-regexp");
const { deny, pass } = require("../lib/decision");

/** The push-verb-local flags that make a push a force-push. */
const FORCE_RE = /^(?:--force|--force-with-lease(?:=.*)?|-f)$/i;

/**
 * Locates the text following a `push` invocation within one statement.
 *
 * @param {string} stmt A statement already known to invoke `git push` via
 * {@link gitVerb}.
 * @returns {string} Everything after the `push` verb, or the empty string.
 */
function argsAfterPush(stmt) {
  const flag = "(?:(?:-c|-C)\\s+\\S+|-[^\\s]+(?:=\\S*)?)";
  const re = new RegExp(`git\\s+(?:${flag}\\s+)*push\\b`, "i");
  const m = stmt.match(re);
  return m ? stmt.slice(m.index + m[0].length) : "";
}

/**
 * Resolves the remote branch a push's positional arguments would land on,
 * following the same refspec rules `git push` itself follows.
 *
 * @param {string[]} positional The non-flag tokens after the `push` verb,
 * e.g. `["origin", "HEAD:dev-ng"]`.
 * @param {string} currentBranch The branch currently checked out, used as a
 * fallback whenever the push carries no explicit refspec and no upstream is
 * known either.
 * @param {string | null} upstreamBranch The current branch's configured
 * upstream, from `ctx.git.upstreamBranch`. Preferred over `currentBranch`
 * whenever the push carries no explicit refspec: that is exactly the form
 * whose real target is "whatever this branch tracks", which can differ from
 * the branch's own name — a plain `git push` on a branch checked out from a
 * base branch, tracking it, and never renamed to match is the case this
 * exists to catch. `null` when no upstream is configured, which this never
 * papers over by falling back silently to a guess only a human could verify.
 * @returns {string | null} The normalised remote branch name, or `null`
 * when nothing resolvable is present.
 */
function resolveTarget(positional, currentBranch, upstreamBranch) {
  const refspec = positional.length >= 2 ? positional[1] : undefined;
  let target;
  if (refspec === undefined) {
    target = upstreamBranch || currentBranch;
  } else {
    const stripped = refspec.replace(/^\+/, "");
    const colon = stripped.indexOf(":");
    if (colon === -1) target = stripped === "HEAD" ? currentBranch : stripped;
    else target = stripped.slice(colon + 1) || null;
  }
  return target ? target.replace(/^refs\/heads\//, "") : null;
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "no-push-to-base",

  /** one line, shown by `softela-ai doctor` */
  title: "Never push directly to a base branch",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Bash|PowerShell|shell|local_shell|exec_command|shell_command)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "git",

  /**
   * Deliberately empty, not `["baseBranches"]`: an absent or empty
   * `baseBranches` already produces the same silent "nothing to compare
   * against" result inside this rule's own logic, with no substitute value
   * invented — so gating candidacy on it would add nothing but a mismatch
   * against `PROJECT_MINIMAL`, which declares `baseBranches: []` on purpose.
   */
  requiresConfig: [],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix?: string}} The
   * decision.
   */
  evaluate(ctx) {
    const baseBranches = Array.isArray(ctx.project.baseBranches) ? ctx.project.baseBranches : [];
    const releasePattern = compile(ctx.project.releaseBranchPattern);
    const currentBranch = ctx.git.branch || "";
    const upstreamBranch = ctx.git.upstreamBranch || null;

    for (const stmt of splitStatements(ctx.command)) {
      if (!gitVerb(stmt, "push")) continue;

      const rest = argsAfterPush(stmt).trim();
      const tokens = rest.length ? rest.split(/\s+/) : [];
      const positional = tokens.filter((t) => !t.startsWith("-"));
      // `+<refspec>` is git's own shorthand for a per-ref force-push, distinct
      // from the `--force`/`-f` flags FORCE_RE already recognises.
      const forced = tokens.some((t) => FORCE_RE.test(t)) || positional.some((t) => t.startsWith("+"));

      const target = resolveTarget(positional, currentBranch, upstreamBranch);

      if (target && baseBranches.includes(target)) {
        return deny(
          "RULE: no direct push to a base branch. Base branches are reached only through a pull request and a squash merge.",
          "Open a pull request instead and let it land by squash merge.",
        );
      }

      if (forced && target && releasePattern && releasePattern.test(target)) {
        return deny(
          "RULE: no force-push to a release branch. Force-pushing there rewrites history other people already built on.",
          "Open a pull request instead and let it land by squash merge.",
        );
      }
    }

    return pass();
  },
};
