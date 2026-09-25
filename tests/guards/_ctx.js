"use strict";

/**
 * Shared fixtures for guard test suites.
 *
 * Every guard suite builds its contexts through here rather than inventing its
 * own shape, so a change to the context contract breaks one file instead of
 * twenty-four. Nothing in this module touches the filesystem, git, or the
 * developer's real configuration — a guard test that needs any of those is
 * testing the wrong layer.
 *
 * `ctx.readFile` and `ctx.statFile` are both backed by the same `files`
 * fixture map, using the same key-resolution rules: an exact key match first,
 * then a match resolved against this context's own `cwd`. `readFile` returns
 * a mapped string's own content; `statFile` returns its byte length instead,
 * mirroring the real `ctx.statFile`'s "size, not content" contract. Neither
 * reads the real filesystem — a path absent from `files` reads and stats as
 * absent, never as whatever happens to be on disk.
 *
 * Assertions go through `decide()`, which runs the rule inside the engine
 * rather than calling `evaluate` directly. That is deliberate: the override
 * clamp, the `allow` short-circuit and the "a throwing rule is skipped" path
 * all live in the engine, and a suite that bypasses it proves less than it
 * appears to.
 */

const path = require("path");
const { evaluate } = require("../../core/engine");
const { compileAll } = require("../../core/lib/safe-regexp");

/**
 * A realistic frontend project configuration, close enough to a shipped one
 * that a rule which works here works in practice.
 */
const PROJECT = Object.freeze({
  /** Identifier used to scope project-level overrides. */
  id: "TestProject.Frontend",

  /** Which stack this fixture represents — see CONTRACTS.md §8a. */
  stack: "frontend",

  /** Branches that may only be reached through a pull request. */
  baseBranches: ["dev-ng"],

  /** Anchored pattern identifying a release branch. */
  releaseBranchPattern: "^releases/",

  /** Branch-name expectation; permissive by design, and it only asks. */
  branchNaming: {
    pattern: "^(feature|bugfix|fix|hotfix)/((task|ticket)[_-])?\\d+[_-].+$",
    action: "ask",
    preferred: "feature/task_00000_short_name",
  },

  /** Paths that must never be swept into a commit unnoticed. */
  protectedPaths: [
    { path: "src/pages/Home.tsx", action: "ask", reason: "may hold local debug logging" },
  ],

  /** Globs owned by another team; not ours to run or maintain. */
  notOurs: ["cypress/**"],

  /** Command-line traps specific to this repository. */
  commands: {
    typecheck: {
      deny: "\\btsc\\s+--noEmit(?!.*(-p\\b|--project\\b|-b\\b))",
      fix: "npx tsc -b",
      reason: "the root tsconfig is a solution file, so a bare --noEmit checks nothing",
    },
    install: {
      deny: "\\bnpm\\s+(install|i|add)\\b(?!.*(--force|--legacy-peer-deps))",
      fix: "npm i --force",
      reason: "peer conflicts break the install otherwise",
    },
    forbidden: [
      { pattern: "\\bcypress\\s+(run|open)\\b", action: "deny", reason: "owned by the QA team" },
    ],
  },

  /** Line-count thresholds for a single source file. */
  limits: { fileLines: { warn: 1000, ask: 1500 } },

  /** Structural expectations the code-standard rules read. */
  conventions: {
    componentFolders: "src/components/**",
    testFolder: "__tests__",
    apiLayer: "src/services/api/**",
    contractTypes: "src/types/**",
    sourceRoots: ["src"],
    language: "typescript",
  },

  /** Where accumulated memory is kept for this project. */
  memoryLocation: "infrastructure",
});

/**
 * A project that declares nothing beyond an identifier.
 *
 * Every config-driven rule must be silent against this, which is the property
 * that keeps the guard set safe to install in a repository nobody has
 * configured yet.
 */
const PROJECT_MINIMAL = Object.freeze({ id: "_default", baseBranches: [] });

/**
 * A realistic backend project configuration — the frontend fixture's mirror,
 * for suites that need to prove a rule behaves differently, or identically,
 * on the other stack.
 */
const PROJECT_BACKEND = Object.freeze({
  /** Identifier used to scope project-level overrides. */
  id: "TestProject.Backend",

  /** Which stack this fixture represents — see CONTRACTS.md §8a. */
  stack: "backend",

  /** Branches that may only be reached through a pull request. */
  baseBranches: ["dev"],

  /** Structural expectations the code-standard rules read. */
  conventions: {
    sourceRoots: ["src"],
    language: "csharp",
  },

  /** Configuration `patch-manifest` needs to be meaningful. */
  patchManifest: {
    filePattern: "patch\\.manifest\\.xml$",
    databasePattern: "<Database",
    requiredEntry: "UpgradeScript",
  },
});

/**
 * Builds an overrides object with the same surface the real resolver exposes.
 *
 * @param {object} spec Map of rule id to `{action, allow}`, where `allow` holds
 * raw pattern strings exactly as a developer would write them.
 * @returns {{forRule: function, invalid: string[], raw: object}} The resolved
 * overrides.
 */
function makeOverrides(spec) {
  const map = spec || {};
  return {
    forRule(id) {
      const entry = map[id];
      if (!entry) return { action: undefined, allow: [], reason: "" };
      const { regexps } = compileAll(entry.allow || []);
      return { action: entry.action, allow: regexps, reason: entry.reason || "" };
    },
    invalid: [],
    raw: map,
  };
}

/**
 * Lazy git state stub. Real `gitState` shells out; a guard test must not.
 *
 * @param {object} partial Fields to expose.
 * @returns {object} A git-state-shaped object.
 */
function makeGit(partial) {
  const g = partial || {};
  return {
    repoRoot: g.repoRoot !== undefined ? g.repoRoot : "/repo",
    branch: g.branch !== undefined ? g.branch : "feature/task_1_thing",
    remote: g.remote !== undefined ? g.remote : "https://example.invalid/_git/TestProject.Frontend",
    base: g.base !== undefined ? g.base : "dev-ng",
    upstreamBranch: g.upstreamBranch !== undefined ? g.upstreamBranch : null,
    rebaseInProgress: Boolean(g.rebaseInProgress),
    staged: () => (Array.isArray(g.staged) ? g.staged : []),
  };
}

/**
 * Looks up a fixture file by an exact key match, then by resolving both the
 * requested path and each fixture key against a working directory and
 * comparing the results.
 *
 * @param {Object.<string, string>} files The fixture map.
 * @param {string} cwdForResolve The working directory relative paths resolve
 * against.
 * @param {string} p The path being looked up.
 * @returns {string|undefined} The matched fixture value, or `undefined` when
 * nothing matches.
 */
function lookupFixtureFile(files, cwdForResolve, p) {
  if (typeof p !== "string" || !p) return undefined;
  if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
  try {
    const target = path.isAbsolute(p) ? p : path.resolve(cwdForResolve, p);
    for (const key of Object.keys(files)) {
      const keyResolved = path.isAbsolute(key) ? key : path.resolve(cwdForResolve, key);
      if (keyResolved === target) return files[key];
    }
  } catch {
    // Fall through to undefined below.
  }
  return undefined;
}

/**
 * Builds a frozen context for a guard test.
 *
 * Top-level fields are replaced wholesale; `project`, `git` and `session` are
 * merged one level deep so a case can change a single field without restating
 * the fixture. `resultingContent` defaults to `null` (unreconstructed) rather
 * than mirroring `content` — a case exercising a decoded Edit/MultiEdit's own
 * split between the two must set it explicitly, the same as the real
 * `buildWriteContext` always does. `agentId`/`agentType` default to `null`,
 * the shape of a main-thread tool call; a case exercising a call from inside
 * a delegated agent sets `agentId` explicitly. `sessionId` defaults to `null`
 * too — the shape a host that sent no identifier produces, and the one a rule
 * reading the per-task tally must stay silent on rather than guess at.
 *
 * @param {object} [partial] Fields to override.
 * @returns {object} A frozen context.
 */
function makeCtx(partial = {}) {
  const project =
    partial.project === PROJECT_MINIMAL
      ? PROJECT_MINIMAL
      : Object.assign({}, PROJECT, partial.project || {});

  const files = partial.files || {};

  return Object.freeze({
    event: partial.event || "PreToolUse",
    agent: partial.agent || "claude",
    toolName: partial.toolName || "Bash",
    input: partial.input || {},
    command: partial.command || "",
    filePath: partial.filePath || "",
    content: partial.content || "",
    resultingContent: partial.resultingContent !== undefined ? partial.resultingContent : null,
    cwd: partial.cwd || "/repo",
    project,
    git: makeGit(partial.git),
    session: Object.assign({ model: "sonnet", effort: "high" }, partial.session || {}),
    agentId: partial.agentId !== undefined ? partial.agentId : null,
    agentType: partial.agentType !== undefined ? partial.agentType : null,
    sessionId: partial.sessionId !== undefined ? partial.sessionId : null,
    modules: new Set(partial.modules || []),
    overrides: partial.overrides || makeOverrides(partial.overrideSpec),
    raw: partial.raw || {},
    // Exact-key lookup first — every existing fixture keyed by its own
    // already-resolved or intentionally-absolute path is unaffected. The
    // fallback resolves `p` against this context's own `cwd`, the same
    // anchor `core/lib/context.js#makeReadFile` uses in production, so a
    // fixture keyed by a write's own raw, unresolved path (`files: {"a.ts": …}`)
    // still resolves when a rule reads `ctx.readFile(ctx.filePath)` AFTER
    // `adapters/shared/dispatch-core.js#buildWriteContext` has already
    // resolved `ctx.filePath` to an absolute path (`patch-manifest`'s own
    // ratchet, in the same spirit as `no-explicit-any`'s).
    readFile: (p) => {
      const cwdForResolve = partial.cwd || "/repo";
      const found = lookupFixtureFile(files, cwdForResolve, p);
      return typeof found === "string" ? found : null;
    },
    // Byte length of the same fixture entry `readFile` would return, never
    // its content — the real `ctx.statFile` answers "how big", not "what's
    // in it", and a rule that leaned on `statFile` returning content instead
    // of a size would pass here and fail against the real context.
    statFile: (p) => {
      const cwdForResolve = partial.cwd || "/repo";
      const found = lookupFixtureFile(files, cwdForResolve, p);
      return typeof found === "string" ? Buffer.byteLength(found, "utf8") : null;
    },
  });
}

/**
 * Runs one rule through the engine and reports the resulting action.
 *
 * @param {object} rule The rule module under test.
 * @param {object} [partial] Context fields for this case.
 * @returns {string} `"deny"`, `"ask"` or `"pass"`.
 */
function decide(rule, partial) {
  const result = evaluate(makeCtx(partial), { rules: [rule] });
  return result ? result.action : "pass";
}

/**
 * Runs one rule through the engine and returns the whole decision, for cases
 * that assert on the reason or the fix rather than only the action.
 *
 * @param {object} rule The rule module under test.
 * @param {object} [partial] Context fields for this case.
 * @returns {object|null} The decision, or `null` when the rule stayed silent.
 */
function decision(rule, partial) {
  return evaluate(makeCtx(partial), { rules: [rule] });
}

module.exports = { PROJECT, PROJECT_MINIMAL, PROJECT_BACKEND, makeCtx, makeOverrides, makeGit, decide, decision };
