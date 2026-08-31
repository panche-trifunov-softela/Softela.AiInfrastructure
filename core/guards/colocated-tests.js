"use strict";

/**
 * Test files must sit beside the component they cover.
 *
 * A test named `<Subject>.test.tsx` (or `.spec.`) must live directly inside
 * a `__tests__` folder whose own parent folder is `<Subject>` — never in a
 * distant test tree, and never in an ancestor component's `__tests__` when
 * the subject is itself a nested child component.
 */

const { deny, pass } = require("../lib/decision");
const { globToRegex } = require("../lib/project-resolver");
const { relativeToRepo } = require("../lib/repo-path");

/** Tool names this rule inspects: file-write calls on both hosts. */
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/**
 * Matches a test file's name, capturing the subject it claims to cover.
 *
 * The subject is the leading, dot-free segment of the filename: any dotted
 * qualifier between it and `.test.`/`.spec.` (`.integration`, `.a11y`,
 * `.snapshot`, ...) is skipped rather than swallowed into the capture, so a
 * qualified test name still resolves to its real subject.
 */
const TEST_FILE = /^([^.]+)(?:\.[^.]+)*\.(test|spec)\.[jt]sx?$/i;

/**
 * Resolves a context's file path to a forward-slash path relative to the
 * repository root, falling back to the working directory when the root is
 * unknown.
 *
 * @param {object} ctx The evaluation context.
 * @returns {string} The project-relative path, or `""` when `ctx.filePath`
 * is empty.
 */
function relativePath(ctx) {
  const raw = (ctx && ctx.filePath) || "";
  if (!raw) return "";
  const root = (ctx.git && ctx.git.repoRoot) || ctx.cwd || "";
  return relativeToRepo(raw, root);
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "colocated-tests",

  /** one line, shown by `softela-ai doctor` */
  title: "Test files sit in a __tests__ folder beside their component",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: WRITE_TOOLS,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** frontend-only: the __tests__-beside-component layout is a frontend convention */
  stacks: ["frontend"],

  /** an existing test's location predates the __tests__ convention; relocating it is a refactor suggestion, not a gate on editing it */
  newCodeOnly: true,

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["conventions.testFolder"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: string, reason: string, fix?: string}} A deny
   * decision when a test file is not directly inside a matching `__tests__`
   * folder beside the component it names, `null` otherwise.
   */
  evaluate(ctx) {
    const conventions = ctx.project && ctx.project.conventions;
    const testFolder = conventions && conventions.testFolder;
    if (!testFolder) return pass();

    const rel = relativePath(ctx);
    if (!rel) return pass();

    const notOurs = Array.isArray(ctx.project.notOurs) ? ctx.project.notOurs : [];
    for (const glob of notOurs) {
      const re = globToRegex(glob);
      if (re && re.test(rel)) return pass();
    }

    const segments = rel.split("/");
    const fileName = segments[segments.length - 1] || "";
    const match = fileName.match(TEST_FILE);
    if (!match) return pass();

    const subject = match[1];
    const parent = segments.length >= 2 ? segments[segments.length - 2] : "";
    const grandparent = segments.length >= 3 ? segments[segments.length - 3] : "";

    if (parent === testFolder && grandparent === subject) return pass();

    const containingDir = segments.slice(0, -1).join("/") || ".";
    return deny(
      `A test file must sit in a "${testFolder}" folder directly inside the folder of the component it covers, not "${containingDir}".`,
      `Move it to a path ending in "${subject}/${testFolder}/${fileName}".`,
    );
  },
};
