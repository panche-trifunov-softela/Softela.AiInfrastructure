"use strict";

/**
 * Nudges a backend test body toward a visible Arrange-Act-Assert shape.
 *
 * Backend-only: Arrange-Act-Assert is a convention of the backend suite. The
 * agreed frontend testing standard does not use it, so this rule stays out
 * of frontend test files entirely (`stacks`, below).
 *
 * Deliberately narrow in when it fires: only when every one of three signals
 * is missing at once — no blank-line grouping, no stage markers, and more
 * than one assertion sitting interleaved with setup code. Any single one of
 * those present is enough to stay silent, which is what keeps the case that
 * does fire a genuine, agreed structural violation rather than a guess.
 *
 * Test NAMING is intentionally not checked here. The organisation's own
 * wiki offers three competing conventions for it and never settled on one,
 * so enforcing any of them would be inventing a decision nobody made.
 */

const { deny, pass } = require("../lib/decision");

/** Tool names this rule inspects, shared with every other file-content rule. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** A test/spec file by its own naming convention, independent of any config. */
const TEST_FILE_SUFFIX = /\.(test|spec)\.[a-z0-9]+$/i;

/** An assertion call in any of the frameworks this rule expects to see. */
const ASSERTION_CALL = /\b(expect|assert|Assert\.\w+)\s*\(/;

/** A stage marker in the Arrange-Act-Assert style this rule recognises. */
const STAGE_MARKER = /\/\/\s*(arrange|act|assert)\b/i;

/**
 * Decides whether a write targets something this rule should look at.
 *
 * @param {object} ctx The evaluation context.
 * @returns {boolean} `true` when the path is a test file by its own
 * filename suffix, or sits inside the project's declared test folder.
 */
function isTestFile(ctx) {
  const filePath = ctx.filePath || "";
  if (!filePath) return false;
  const rel = filePath.replace(/\\/g, "/");
  const base = rel.split("/").pop() || "";
  if (TEST_FILE_SUFFIX.test(base)) return true;

  const testFolder = ctx.project.conventions && ctx.project.conventions.testFolder;
  if (testFolder && rel.split("/").includes(testFolder)) return true;
  return false;
}

/**
 * Checks whether more than one assertion line has a non-blank, non-assertion
 * line sitting between the first and the last of them — the "setup
 * interleaved with assertions" shape this rule is watching for.
 *
 * @param {string} content The file content to scan.
 * @returns {boolean} `true` when there are at least two assertion lines and
 * something else sits between the first and the last.
 */
function hasInterleavedSetup(content) {
  const lines = content.split("\n");
  let first = -1;
  let last = -1;
  let count = 0;

  lines.forEach((line, i) => {
    if (ASSERTION_CALL.test(line)) {
      count += 1;
      if (first === -1) first = i;
      last = i;
    }
  });

  if (count <= 1) return false;

  for (let i = first; i <= last; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (ASSERTION_CALL.test(line)) continue;
    return true;
  }
  return false;
}

module.exports = {
  id: "test-structure",
  title: "Nudge a backend test body toward Arrange-Act-Assert",
  events: ["PreToolUse"],
  tools: FILE_TOOLS,
  defaultAction: "deny",
  group: "code",

  /** backend-only: Arrange-Act-Assert is a backend convention; the agreed frontend standard does not use it */
  stacks: ["backend"],

  /** an existing test's structure predates this convention; restructuring it is a refactor suggestion, not a gate on editing it */
  newCodeOnly: true,

  requiresConfig: [],

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix: string}} `deny`
   * when no structural signal is present at all, `null` otherwise.
   */
  evaluate(ctx) {
    if (!isTestFile(ctx)) return pass();

    // R3 decision: kept on ctx.content, not resultingContent — this nudges
    // the shape of the test body this WRITE authors; an existing test's
    // structure untouched by this write is exactly what `newCodeOnly`
    // (below) already treats as a refactor suggestion, not a gate,
    // reinforcing the same "newly written" scope at the content level too.
    const content = ctx.content || "";
    if (!content.trim()) return pass();

    if (/\n[ \t]*\n/.test(content)) return pass();
    if (STAGE_MARKER.test(content)) return pass();
    if (!hasInterleavedSetup(content)) return pass();

    return deny(
      "This test has no visible Arrange-Act-Assert shape: no blank-line grouping, no stage markers, and more than one assertion interleaved with setup.",
      "Group the body into Arrange/Act/Assert with a blank line between stages, or mark them with `// Arrange`, `// Act`, `// Assert`.",
    );
  },
};
