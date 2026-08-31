"use strict";

/**
 * `core/installer/settings-toml.js` — the minimal, confidence-checked TOML
 * editor Codex's `config.toml` is seeded through. A real config is extensive
 * and hand-maintained, so every assertion here is about what survives
 * untouched, not just what gets written.
 */

const { suite } = require("../harness");
const st = require("../../core/installer/settings-toml");

const REALISTIC = [
  "# personal config, hand maintained -- must survive verbatim",
  'model_provider = "custom-provider"',
  "",
  "[agents]",
  "# already running a stronger subagent model than the shipped default",
  'default_subagent_model = "gpt-6-titan"',
  "",
  "[sandbox]",
  'mode = "workspace-write"',
  "",
].join("\n");

suite("installer/settings-toml", ({ test, eq, ok }) => {
  test("analyze finds every top-level key across sections, including the root", () => {
    // `analyze` joins `<section>` and `<key>` with a literal U+0000
    // character (verified against the shipped source; it renders as
    // invisible whitespace in an editor). The rest of this suite stays
    // black-box and goes through `planSeedKey` instead of reaching into
    // `keys` directly, so only this one test needs to know that.
    const SEP = String.fromCharCode(0);
    const result = st.analyze(REALISTIC);
    eq(result.ok, true);
    ok(result.keys.has(`${SEP}model_provider`));
    ok(result.keys.has(`agents${SEP}default_subagent_model`));
    ok(result.keys.has(`sandbox${SEP}mode`));
    ok(!result.keys.has(`agents${SEP}model_provider`));
  });

  test("analyze refuses a file containing a multi-line string literal", () => {
    const result = st.analyze('notes = """\nmultiple\nlines\n"""\n');
    eq(result.ok, false);
    ok(typeof result.reason === "string" && result.reason.length > 0);
  });

  test("analyze refuses a file containing an array-of-tables section", () => {
    const result = st.analyze('[[servers]]\nname = "a"\n');
    eq(result.ok, false);
  });

  test("pointerToSectionKey splits a settings pointer into section and key", () => {
    eq(JSON.stringify(st.pointerToSectionKey("/agents/default_subagent_model")), JSON.stringify({ section: "agents", key: "default_subagent_model" }));
    eq(JSON.stringify(st.pointerToSectionKey("/model")), JSON.stringify({ section: "", key: "model" }));
  });

  test("formatValue renders TOML literals for every value type this installer seeds", () => {
    eq(st.formatValue("gpt-5.6-sol"), '"gpt-5.6-sol"');
    eq(st.formatValue('has "quotes"'), '"has \\"quotes\\""');
    eq(st.formatValue(true), "true");
    eq(st.formatValue(42), "42");
    eq(st.formatValue(["a", "b"]), '["a", "b"]');
  });

  test("planSeedKey reports present for a key already in the file, absent otherwise", () => {
    const present = st.planSeedKey(REALISTIC, "/agents/default_subagent_model");
    eq(present.confident, true);
    eq(present.present, true);
    eq(present.action, "keep");

    const absent = st.planSeedKey(REALISTIC, "/model");
    eq(absent.confident, true);
    eq(absent.present, false);
    eq(absent.action, "write");
  });

  test("planSeedKey is not confident about a file it cannot follow", () => {
    const result = st.planSeedKey('notes = """\nx\n"""\n', "/model");
    eq(result.confident, false);
  });

  test("insertKey into an existing section preserves every other line verbatim, in order", () => {
    const result = st.insertKey(REALISTIC, "agents", "default_subagent_model_extra", "x");
    eq(result.ok, true);
    eq(result.written, true);
    ok(result.content.includes("# personal config, hand maintained -- must survive verbatim"));
    ok(result.content.includes('default_subagent_model = "gpt-6-titan"'));
    ok(result.content.includes("# already running a stronger subagent model than the shipped default"));
    const agentsIdx = result.content.indexOf("[agents]");
    const sandboxIdx = result.content.indexOf("[sandbox]");
    ok(agentsIdx > -1 && sandboxIdx > agentsIdx);
  });

  test("insertKey never rewrites a key that is already present", () => {
    const result = st.insertKey(REALISTIC, "agents", "default_subagent_model", "should-not-be-written");
    eq(result.ok, true);
    eq(result.written, false);
    eq(result.content, REALISTIC);
  });

  test("insertKey creates a new section at the end of the file when the section is absent", () => {
    const result = st.insertKey(REALISTIC, "brand-new-section", "key", "value");
    eq(result.ok, true);
    eq(result.written, true);
    ok(result.content.includes("[brand-new-section]"));
    ok(result.content.trim().endsWith('key = "value"'));
  });

  test("insertKey into a brand-new section on genuinely empty content never leaves a leading blank line", () => {
    // A truly empty file (`content === ""`) still splits into one blank
    // line, since `"".split("\n")` is `[""]`, not `[]` — with nothing above
    // it to separate a new `[section]` header from, that line must not
    // survive into the output, or a file this call is creating fresh would
    // start with a stray blank line.
    const result = st.insertKey("", "agents", "default_subagent_model", "gpt-5.6-luna");
    eq(result.ok, true);
    eq(result.written, true);
    eq(result.content, '[agents]\ndefault_subagent_model = "gpt-5.6-luna"');
  });

  test("insertKey adds a root-level key without disturbing any section", () => {
    const result = st.insertKey(REALISTIC, "", "model", "gpt-5.6-sol");
    eq(result.ok, true);
    eq(result.written, true);
    const modelLine = result.content.split("\n").findIndex((l) => l.trim() === 'model = "gpt-5.6-sol"');
    const agentsLine = result.content.split("\n").indexOf("[agents]");
    ok(modelLine > -1 && modelLine < agentsLine);
  });

  test("writeSeedKeys applies every absent entry and skips every present one, preserving comments and order", () => {
    const result = st.writeSeedKeys(REALISTIC, [
      { pointer: "/model", value: "gpt-5.6-sol" },
      { pointer: "/agents/default_subagent_model", value: "gpt-5.6-luna" },
      { pointer: "/model_reasoning_effort", value: "high" },
    ]);
    eq(result.ok, true);
    eq(result.written.length, 2);
    eq(result.skipped.length, 1);
    ok(result.skipped.includes("/agents/default_subagent_model"));
    ok(result.content.includes('default_subagent_model = "gpt-6-titan"'));
    ok(!result.content.includes("gpt-5.6-luna"));
    ok(result.content.includes("# personal config, hand maintained -- must survive verbatim"));
    ok(result.content.includes("[sandbox]"));
  });

  test("writeSeedKeys refuses rather than guesses when the file cannot be parsed confidently", () => {
    const result = st.writeSeedKeys('notes = """\nx\n"""\n', [{ pointer: "/model", value: "gpt-5.6-sol" }]);
    eq(result.ok, false);
    ok(typeof result.reason === "string" && result.reason.length > 0);
    eq(result.written.length, 0);
  });

  test("writeSeedKeys on an empty (nonexistent) file seeds cleanly into a new section", () => {
    const result = st.writeSeedKeys("", [{ pointer: "/agents/default_subagent_model", value: "gpt-5.6-luna" }]);
    eq(result.ok, true);
    ok(result.content.includes("[agents]"));
    ok(result.content.includes('default_subagent_model = "gpt-5.6-luna"'));
    ok(!result.content.startsWith("\n"), "a file seeded from scratch must never start with a stray blank line");
  });

  test("writeSeedKeys on an empty (nonexistent) file seeds every Codex module.json declares, in order, with no leading blank line", () => {
    // Mirrors `agent-orchestration`'s own seed list and declaration order
    // exactly (`modules/agent-orchestration/module.json`) — the real shape
    // an absent `config.toml` is seeded against end to end.
    const result = st.writeSeedKeys("", [
      { pointer: "/model", value: "gpt-5.6-sol" },
      { pointer: "/agents/default_subagent_model", value: "gpt-5.6-luna" },
      { pointer: "/agents/default_subagent_reasoning_effort", value: "medium" },
      { pointer: "/model_reasoning_effort", value: "high" },
      { pointer: "/approval_policy", value: "on-request" },
      { pointer: "/approvals_reviewer", value: "auto_review" },
      { pointer: "/features/per_spawn_model_override", value: true },
    ]);
    eq(result.ok, true);
    eq(result.written.length, 7);
    eq(result.skipped.length, 0);
    ok(!result.content.startsWith("\n"), "a file seeded from scratch must never start with a stray blank line");
    for (const line of [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "high"',
      'approval_policy = "on-request"',
      'approvals_reviewer = "auto_review"',
      "[agents]",
      'default_subagent_model = "gpt-5.6-luna"',
      'default_subagent_reasoning_effort = "medium"',
      "[features]",
      "per_spawn_model_override = true",
    ]) {
      ok(result.content.includes(line), `expected "${line}" in:\n${result.content}`);
    }
  });
});
