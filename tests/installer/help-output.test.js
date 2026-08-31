"use strict";

/**
 * Mechanical width-safety for every list-shaped surface `softela-ai` prints:
 * the top-level overview, every `<command> --help`, `module list`, and the
 * two other free-text lists a developer can drive into an unbounded value
 * (`override --list`'s reason, most notably).
 *
 * Every case here drives the real binary via {@link runCli} with
 * `SOFTELA_AI_COLUMNS` forced to a fixed width — the same seam
 * `core/installer/index.js#outputWidth` reads instead of a piped
 * subprocess's own (always-absent) `stdout.columns` — and asserts two
 * mechanical properties against the captured stdout: no line's display
 * width (Unicode code points, matching `core/installer/tty.js#displayWidth`)
 * exceeds the forced width, and no line ends in the `truncate()` ellipsis.
 * Reading the text for meaning is `installer/help.test.js`'s job; this file
 * only ever measures columns.
 */

const { suite } = require("../harness");
const { runCli, agentHomePath } = require("./_home");
const { COMMANDS } = require("../../core/installer/index.js");
const { formatDoctorReport } = require("../../core/installer/doctor.js");
const fs = require("fs");

/** The widths every surface below is checked at — the narrowest, the reported bug's own, and the widest `tty.js#MAX_WIDTH` allows. */
const WIDTHS = [60, 80, 120];

/**
 * Widths `doctor`'s own parity table is checked at — the same five named in
 * the reported bug (60, 80, 100, 120) plus 200, wider than
 * `core/installer/tty.js#MAX_WIDTH` ever clamps a real terminal to, driven
 * here only because {@link formatDoctorReport} is called directly rather
 * than through `outputWidth()`'s clamp — see the comment above {@link
 * DOCTOR_PARITY_REPORT} for why.
 */
const DOCTOR_PARITY_WIDTHS = [60, 80, 100, 120, 200];

/**
 * A synthetic `doctor` report exercising only the parity table — no agents,
 * no invalid projects, no unhandled schema keywords — built directly rather
 * than produced by installing real claude/codex homes and driving the CLI.
 *
 * `doctor --agent all` against two real installed agents pulls each Codex
 * hook's own absolute command path into the "hooks never approved" block,
 * and that path's length depends on the scratch home's own directory name —
 * machine- and run-dependent, unrelated to the parity table this suite is
 * actually checking, and already capable of overflowing a narrow column on
 * its own (a separate, pre-existing limitation of the single-long-word case
 * `wrapPrefixed`/`tty.wrap` hard-cuts, not something this suite's change is
 * scoped to fix). Driving {@link formatDoctorReport} directly instead
 * isolates the parity-table assertions from that noise, and additionally
 * reaches a genuine 200-column width, which `outputWidth()` would otherwise
 * clamp to `tty.js#MAX_WIDTH` (120) before the table ever saw it.
 *
 * Rows reproduce the exact aspects and value shapes from the reported bug:
 * a short version string, a long comma-joined module list (both sides
 * identical), a row where one side is structurally absent, and the longest
 * single-sentence values doctor prints (the codex askMode row).
 */
const DOCTOR_PARITY_REPORT = {
  agents: [],
  invalidProjects: [],
  schemaKeywordsUnhandled: [],
  parity: {
    comparable: true,
    verdict: "mismatch",
    rows: [
      { aspect: "installed", claude: "0.1.0", codex: "0.1.0", matched: true, note: "" },
      {
        aspect: "enabled modules",
        claude: "agent-orchestration, analyze-first, memory-as-context, reply-language",
        codex: "agent-orchestration, analyze-first, memory-as-context, reply-language",
        matched: true,
        note: "",
      },
      {
        aspect: "hook: after compaction (memory re-injection)",
        claude: "(no counterpart event on Claude Code)",
        codex: "registered (PostCompact)",
        matched: true,
        note: "Claude Code has no event for this job",
      },
      { aspect: "main model", claude: "opus (frontier)", codex: "gpt-5.6-sol (frontier)", matched: false, note: "" },
      {
        aspect: "reasoning effort",
        claude: "(not configurable for Claude Code)",
        codex: "high",
        matched: true,
        note: "Claude Code has no persisted reasoning-effort setting to compare",
      },
      {
        aspect: "codex askMode",
        claude: '(no native "ask" — Claude Code shows the decision to the developer directly)',
        codex: '"block" (default) — an ask decision becomes a deny until approved',
        matched: true,
        note:
          'informational — Codex has no native "ask"; adapters/codex/dispatch.js always maps it onto a deny or an advisory, so the two hosts never reach the same outcome for a rule that returns "ask"',
      },
      { aspect: "seed settings changed from shipped default", claude: "(none)", codex: "(none)", matched: true, note: "" },
    ],
  },
};

/**
 * A synthetic `doctor` report exercising `formatDoctorReport`'s per-agent
 * block — installed version, drift, overrides, approvals, modules, changed
 * seed settings, the Codex hook-trust line and the "run via:" command — the
 * region {@link DOCTOR_PARITY_REPORT} above deliberately leaves at `agents:
 * []` so the parity table's own assertions stay isolated from it.
 *
 * `runCommand` carries a real, unbreakable absolute path (quoted, as
 * `buildReport` writes it) long enough that it cannot share a line with the
 * `"run via:"` label at the narrowest tested width and must wrap onto its
 * own hanging-indented continuation line — proving the fix actually wraps
 * the command rather than merely fitting by coincidence — while staying
 * short enough to still fit that continuation line whole, so this case
 * proves the command survives intact rather than getting hard-truncated by
 * `tty.wrap`'s own single-long-word fallback (a separate, pre-existing
 * limitation shared with the Codex hook-command lines below the "hooks
 * awaiting approval" heading, and not something this case is scoped to
 * exercise).
 */
const DOCTOR_AGENT_REPORT = {
  agents: [
    {
      agent: "codex",
      installed: true,
      installedVersion: "0.1.0",
      repoVersion: "0.2.0",
      updateAvailable: true,
      manifestUnreadable: false,
      drift: [{ relPath: "hooks/dispatch.js", issue: "locally modified" }],
      missing: [],
      overrides: [],
      overridesSchemaErrors: [],
      approvals: [],
      enabledModules: ["agent-orchestration", "analyze-first", "memory-as-context", "reply-language"],
      changedSeedSettings: [{ module: "agent-orchestration", pointer: "/model_reasoning_effort", shipped: "high" }],
      unrecognizedTierModels: [],
      settingsParseOk: true,
      settingsFile: "C:\\devuser\\.codex\\hooks.json",
      configTomlReadable: true,
      unspawnableCodexHooks: [],
      codexHookTrust: { applicable: true, unapproved: [], allApproved: true },
      runCommand: 'node "C:\\devuser\\.codex\\softela-ai\\bin\\softela-ai"',
      registeredHookEvents: [],
      effectiveModel: "gpt-5.6-sol",
      effectiveReasoningEffort: "high",
      askMode: "block",
    },
  ],
  invalidProjects: [{ file: "C:\\Users\\dev-user\\project\\.softela-ai\\config.json", errors: ["/rules/0/id must be string"] }],
  schemaKeywordsUnhandled: ["patternProperties"],
  parity: { comparable: false, missing: "claude" },
};

/**
 * Asserts that no line of `stdout` exceeds `width` display columns and that
 * no line carries a truncation ellipsis anywhere in it — not only at the
 * very end, since a table row that truncates one cell and still has
 * further columns to print after it carries the ellipsis mid-line, not as
 * the row's last character — listing every offending line in one failure
 * rather than stopping at the first.
 *
 * @param {(actual: *, expected: *, message?: string) => void} eq The
 * suite's own equality assertion, reused so a failure renders through the
 * harness's normal `describe()` formatting.
 * @param {string} stdout The captured output to check.
 * @param {number} width The column budget every line must fit within.
 * @param {string} label Identifies the run in a failure message, e.g.
 * `"install --help @80"`.
 * @returns {void}
 */
function assertFits(eq, stdout, width, label) {
  const offenders = [];
  for (const line of stdout.split("\n")) {
    const cols = Array.from(line).length;
    if (cols > width) offenders.push(`line exceeds ${width} cols (${cols}): ${JSON.stringify(line)}`);
    else if (line.includes("…")) offenders.push(`line carries an ellipsis: ${JSON.stringify(line)}`);
  }
  eq(offenders.join("\n"), "", `${label}: ${offenders.length} offending line(s)`);
}

suite("installer/help-output", ({ test, eq, ok, fakeHome }) => {
  for (const width of WIDTHS) {
    test(`--help: no line exceeds ${width} columns or ends in an ellipsis`, () => {
      const home = fakeHome();
      const result = runCli(home, ["--help"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      eq(result.code, 0, result.stdout + result.stderr);
      assertFits(eq, result.stdout, width, `--help @${width}`);
    });

    for (const command of Object.keys(COMMANDS)) {
      test(`"${command} --help": no line exceeds ${width} columns or ends in an ellipsis`, () => {
        const home = fakeHome();
        const result = runCli(home, [command, "--help"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
        eq(result.code, 0, result.stdout + result.stderr);
        assertFits(eq, result.stdout, width, `${command} --help @${width}`);
      });
    }

    test(`"module list": no line exceeds ${width} columns or ends in an ellipsis`, () => {
      const home = fakeHome();
      fs.mkdirSync(agentHomePath(home, "claude"), { recursive: true });
      const result = runCli(home, ["module", "list"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      eq(result.code, 0, result.stdout + result.stderr);
      assertFits(eq, result.stdout, width, `module list @${width}`);
    });
  }

  test("the top-level command list still mentions every command, unshortened by the width fix", () => {
    const home = fakeHome();
    const result = runCli(home, ["--help"], { env: { SOFTELA_AI_COLUMNS: "80" } });
    for (const name of Object.keys(COMMANDS)) {
      ok(result.stdout.includes(name), `overview must still mention "${name}", got:\n${result.stdout}`);
    }
  });

  test('"override --list" wraps an unbounded developer-supplied reason instead of overflowing the width', () => {
    const home = fakeHome();
    fs.mkdirSync(agentHomePath(home, "claude"), { recursive: true });
    const reason =
      "an unusually long reason string that a developer might actually type out in full to explain exactly why a rule needed softening for this one machine";
    const set = runCli(home, ["override", "colocated-tests", "off", "--reason", reason, "--agent", "claude", "--yes"]);
    eq(set.code, 0, set.stdout + set.stderr);

    for (const width of WIDTHS) {
      const result = runCli(home, ["override", "--list"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      eq(result.code, 0, result.stdout + result.stderr);
      assertFits(eq, result.stdout, width, `override --list @${width}`);
      // The reason must still be readable in full, only reflowed across
      // lines — collapse the wrap's own newline+indent back to one space
      // before checking it is still there verbatim.
      const collapsed = result.stdout.replace(/\n\s+/g, " ");
      ok(collapsed.includes(reason), `override --list @${width} must still contain the full reason, got:\n${result.stdout}`);
    }
  });

  test('"approve --list" (no exceptions granted yet): no line exceeds any tested width', () => {
    const home = fakeHome();
    fs.mkdirSync(agentHomePath(home, "claude"), { recursive: true });
    for (const width of WIDTHS) {
      const result = runCli(home, ["approve", "--list"], { env: { SOFTELA_AI_COLUMNS: String(width) } });
      eq(result.code, 0, result.stdout + result.stderr);
      assertFits(eq, result.stdout, width, `approve --list @${width}`);
    }
  });

  test('"doctor --agent all"\'s parity table: no line exceeds any tested width, none carries an ellipsis, at every width from the narrowest to well past the widest a real terminal clamps to', () => {
    // The ellipsis check above is also the content-preservation check: the
    // only mechanism in `core/installer/tty.js` that ever drops characters
    // is `truncate()`, and it always appends the `"…"` marker when it does
    // — so a line with no ellipsis anywhere in it is a line nothing was cut
    // from, whether it was rendered as one wrapped table cell or reflowed
    // across several continuation lines.
    for (const width of DOCTOR_PARITY_WIDTHS) {
      const lines = formatDoctorReport(DOCTOR_PARITY_REPORT, width);
      assertFits(eq, lines.join("\n"), width, `doctor --agent all parity table @${width}`);
    }
  });

  test('"doctor --agent all"\'s parity table still fits comfortably at a single-line-per-row width, unshortened', () => {
    // At a width the whole table's natural column widths fit within
    // without any wrapping, every value must appear on its own row intact
    // — this is the one width where a plain substring check is meaningful
    // for a three-column grid, since no cell's text is ever split across a
    // continuation line here.
    const width = 400;
    const lines = formatDoctorReport(DOCTOR_PARITY_REPORT, width);
    assertFits(eq, lines.join("\n"), width, `doctor --agent all parity table @${width}`);
    const collapsed = lines.join("\n");
    for (const row of DOCTOR_PARITY_REPORT.parity.rows) {
      ok(collapsed.includes(row.aspect), `@${width} must still contain the full aspect "${row.aspect}", got:\n${collapsed}`);
      ok(collapsed.includes(row.claude), `@${width} must still contain the full claude value "${row.claude}", got:\n${collapsed}`);
      ok(collapsed.includes(row.codex), `@${width} must still contain the full codex value "${row.codex}", got:\n${collapsed}`);
    }
  });

  test('"doctor"\'s per-agent block (drift, modules, changed seed settings, hook trust, "run via:"): no line exceeds any tested width, none carries an ellipsis', () => {
    for (const width of DOCTOR_PARITY_WIDTHS) {
      const lines = formatDoctorReport(DOCTOR_AGENT_REPORT, width);
      assertFits(eq, lines.join("\n"), width, `doctor per-agent block @${width}`);
    }
  });

  test('"doctor"\'s "run via:" line wraps a long absolute command under a hanging indent instead of overflowing, and never drops any of it', () => {
    const command = DOCTOR_AGENT_REPORT.agents[0].runCommand;
    for (const width of DOCTOR_PARITY_WIDTHS) {
      const lines = formatDoctorReport(DOCTOR_AGENT_REPORT, width);
      ok(lines.some((l) => l.startsWith("  run via:")), `@${width} expected a "run via:" line, got:\n${lines.join("\n")}`);

      // The command may now span this line and a hanging-indented
      // continuation — collapse the wrap's own newline+indent back to one
      // space, the same way "override --list"'s own reason-wrapping case
      // above does, before checking the full command is still there intact.
      const collapsed = lines.join("\n").replace(/\n\s+/g, " ");
      ok(collapsed.includes(command), `@${width} the "run via:" line must still contain the full command, unwrapped, got:\n${lines.join("\n")}`);
    }
  });
});
