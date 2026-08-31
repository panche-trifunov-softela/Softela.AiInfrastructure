"use strict";

/**
 * Coverage for `core/installer/rulebook.js` — the base rulebook every
 * install generates fresh at plan time (`detect.js#gather` calls
 * `buildRulebookBody`, `plan.js#planGlobalInstructions` places its result
 * first in the managed instructions block) — and for how it reacts to an
 * install's own live facts: which modules are enabled, and Codex's own
 * `askMode`.
 */

const path = require("path");
const { suite } = require("../harness");
const { runCli, agentHomePath, readText } = require("./_home");
const rulebook = require("../../core/installer/rulebook");
const { ruleRegistryStatus } = require("../../core/engine");
const { TIERS, TIER_PATTERNS } = require("../../core/lib/model-tiers");
const { FALLBACK_MODEL_IDS } = require("../../core/lib/codex-models");

/** Every registered rule, once, shared by every case below. */
const { rules: REGISTERED_RULES } = ruleRegistryStatus();

/** The three modules whose own instruction now lives only in the rulebook's conditional sections. */
const ALL_PROMPT_MODULES = new Set(["memory-as-context", "analyze-first", "agent-orchestration"]);

/**
 * Collapses whitespace — including the line breaks the generator's own word
 * wrap inserts into its prose — down to single spaces, so a multi-word
 * phrase can be matched with a plain substring check regardless of exactly
 * where the generator happened to wrap it.
 *
 * @param {string} text The text to flatten.
 * @returns {string} `text` with every run of whitespace replaced by one
 * space.
 */
function flatten(text) {
  return text.replace(/\s+/g, " ");
}

suite("installer/rulebook", ({ test, eq, ok, fakeHome }) => {
  test("the registry actually has rules to check against — a regression guard for the fixture itself", () => {
    ok(REGISTERED_RULES.length > 20, `expected a substantial rule registry, got ${REGISTERED_RULES.length}`);
  });

  for (const agent of rulebook.AGENTS) {
    test(`[${agent}] every registered rule id appears in the generated text, regardless of which modules are enabled`, () => {
      const body = rulebook.buildRulebookBody(agent);
      for (const rule of REGISTERED_RULES) {
        ok(body.includes(`\`${rule.id}\``), `expected the ${agent} rulebook to mention rule "${rule.id}"`);
      }
    });

    test(`[${agent}] carries the authority hierarchy, naming that an in-repo instruction file never outranks it, with no modules enabled at all`, () => {
      const body = flatten(rulebook.buildRulebookBody(agent));
      ok(body.includes("## Authority hierarchy"));
      ok(
        body.includes("does not outrank this rulebook"),
        "expected the explicit statement that a checked-in AGENTS.md/CLAUDE.md never outranks this block",
      );
    });

    test(`[${agent}] carries the analyse-first sequence with an explicit approval gate when "analyze-first" is enabled`, () => {
      const body = flatten(rulebook.buildRulebookBody(agent, { enabledModuleIds: new Set(["analyze-first"]) }));
      ok(body.includes("## Analyse first, then wait"));
      ok(body.includes("Wait for the developer's explicit go-ahead"), "expected an explicit gate between a proposed plan and building it");
      ok(body.includes("Only then build"), "expected the sequence to end on building only after the gate");
    });

    test(`[${agent}] omits the analyse-first section entirely when "analyze-first" is not enabled`, () => {
      const body = rulebook.buildRulebookBody(agent, { enabledModuleIds: new Set(["agent-orchestration"]) });
      ok(!body.includes("Analyse first, then wait"), "the section must not appear when its module is disabled");
      ok(!body.includes("## Analyze first"), "the module's own retired heading must not appear either — it ships no prompt.md any more");
    });

    test(`[${agent}] carries the reuse-before-writing instruction with real, searchable locations, with no modules enabled at all`, () => {
      const body = flatten(rulebook.buildRulebookBody(agent));
      ok(body.includes("## Reuse before writing anything new"));
      ok(body.includes("src/components/**"), "expected a concrete, searchable location drawn from the frontend preset");
      ok(body.includes("src/hooks/**"), "expected the shared-hooks location drawn from the frontend preset");
    });

    test(`[${agent}] carries the delegation section, naming its own concrete model tiers, when "agent-orchestration" is enabled`, () => {
      const body = flatten(rulebook.buildRulebookBody(agent, { enabledModuleIds: new Set(["agent-orchestration"]) }));
      const t = rulebook.tierNames(agent);
      ok(body.includes("## Delegation and model tier"));
      ok(body.includes(t.cheap), `expected the cheap tier name ${t.cheap}`);
      ok(body.includes(t.balanced), `expected the balanced tier name ${t.balanced}`);
      ok(body.includes(t.frontier), `expected the frontier tier name ${t.frontier}`);
    });

    test(`[${agent}] omits the delegation section entirely when "agent-orchestration" is not enabled`, () => {
      const body = rulebook.buildRulebookBody(agent, { enabledModuleIds: new Set(["analyze-first"]) });
      ok(!body.includes("## Delegation and model tier"), "the section must not appear when its module is disabled");
      ok(!body.includes("## Agent orchestration"), "the module's own retired heading must not appear either — it ships no prompt.md any more");
    });

    test(`[${agent}] the delegation section states the subagent's own lack of memory injection, contrasted with a parent session, when "memory-as-context" is ALSO enabled`, () => {
      const body = flatten(rulebook.buildRulebookBody(agent, { enabledModuleIds: new Set(["agent-orchestration", "memory-as-context"]) }));
      ok(body.includes("no `MEMORY.md`, no index, no prior session"), "expected the subagent-vs-parent contrast when memory-as-context is enabled");
      ok(body.includes("which memory entries the subagent should open for itself"), "expected the delegation-prompt bullet to mention memory entries when memory-as-context is enabled");
    });

    test(`[${agent}] the delegation section makes no claim about MEMORY.md, an index or memory entries when "agent-orchestration" is enabled WITHOUT "memory-as-context"`, () => {
      // Regression for the finding that buildDelegationSection was gated only
      // on agent-orchestration: the two modules are independently toggleable
      // (agent-orchestration's own module.json declares "requires": []), and
      // when memory-as-context is off, NO session — parent or subagent — has
      // a MEMORY.md, an index or any memory entries, so the shipped text must
      // not imply otherwise.
      const body = flatten(rulebook.buildRulebookBody(agent, { enabledModuleIds: new Set(["agent-orchestration"]) }));
      ok(body.includes("## Delegation and model tier"), "expected the delegation section to still render");
      ok(!body.includes("no `MEMORY.md`, no index, no prior session"), "must not contrast a subagent's lack of memory injection against a parent session that has none either");
      ok(!body.includes("which memory entries the subagent should open for itself"), "must not instruct naming memory entries when this install has no memory mechanism at all");
      ok(!body.includes("## Memory"), "no memory section or heading should appear anywhere in this body at all");
    });

    test(`[${agent}] ends on the standards pointer as its very last line, with no modules enabled at all`, () => {
      const body = rulebook.buildRulebookBody(agent).trimEnd();
      const lastLine = body.split("\n").pop();
      eq(lastLine, "Full standards, distilled above: `{{STANDARDS_PATH}}`.");
    });

    test(`[${agent}] the override escape hatch names a fully backslashed local path, matching STATE_DIR's own Windows separator`, () => {
      const body = rulebook.buildRulebookBody(agent);
      ok(body.includes("{{STATE_DIR}}\\overrides.json"), 'expected "{{STATE_DIR}}\\overrides.json", a mixed separator would render wrong on Windows once {{STATE_DIR}} substitutes to a backslash path');
      ok(!body.includes("{{STATE_DIR}}/overrides.json"), "must not mix a literal forward slash with the substituted backslash path");
    });

    for (const location of ["global", "infrastructure", "repo"]) {
      test(`[${agent}] the memory section's "${location}" clause names AGENT_HOME with a backslash, matching STATE_DIR's own Windows separator`, () => {
        const body = rulebook.buildRulebookBody(agent, { enabledModuleIds: new Set(["memory-as-context"]), memoryLocation: location });
        ok(!body.includes("{{AGENT_HOME}}/memory"), 'a literal forward slash would mix with the substituted backslash AGENT_HOME path once plan.js resolves it on Windows');
        ok(!body.includes("{{AGENT_HOME}}/softela-ai"), 'a literal forward slash would mix with the substituted backslash AGENT_HOME path once plan.js resolves it on Windows');
        if (location === "global") ok(body.includes("{{AGENT_HOME}}\\memory"), 'expected "{{AGENT_HOME}}\\memory" for the global location');
        if (location === "infrastructure") ok(body.includes("{{AGENT_HOME}}\\softela-ai\\memory\\"), 'expected "{{AGENT_HOME}}\\softela-ai\\memory\\<repository name>" for the infrastructure location');
        if (location === "repo") ok(body.includes("{{AGENT_HOME}}\\memory"), 'expected the repo clause\'s own global fallback to be backslashed too');
      });
    }

    test(`[${agent}] the "repo" memory clause's own fallback names a concrete path instead of a dangling "below" reference`, () => {
      const body = flatten(rulebook.buildRulebookBody(agent, { enabledModuleIds: new Set(["memory-as-context"]), memoryLocation: "repo" }));
      ok(!body.includes("the global directory below"), 'the old phrasing pointed at a "below" clause that never actually existed in the document');
      ok(body.includes("{{AGENT_HOME}}\\memory"), "expected the repo clause's own fallback to name the concrete global directory path directly");
    });

    test(`[${agent}] stays within the stated line-count ceiling, with every prompt-gating module enabled`, () => {
      const lineCount = rulebook.buildRulebookBody(agent, { enabledModuleIds: ALL_PROMPT_MODULES }).split("\n").length;
      ok(
        lineCount <= rulebook.MAX_BODY_LINES,
        `expected at most ${rulebook.MAX_BODY_LINES} lines, got ${lineCount} — grow the ceiling deliberately in core/installer/rulebook.js if this is intended`,
      );
      // Also a floor, loosely — this is meant to carry real coverage, not
      // shrink back down to a pointer with a paragraph of prose above it.
      ok(lineCount >= 150, `expected substantial coverage (at least 150 lines), got ${lineCount}`);
    });

    test(`[${agent}] a rule with a non-empty requiresConfig states, honestly, that it is silent until a project config sets that path`, () => {
      const body = flatten(rulebook.buildRulebookBody(agent));
      const gatedRules = REGISTERED_RULES.filter((r) => Array.isArray(r.requiresConfig) && r.requiresConfig.length);
      ok(gatedRules.length > 0, "expected at least one rule with a non-empty requiresConfig — a regression guard for the fixture itself");
      for (const rule of gatedRules) {
        const configPaths = rule.requiresConfig.map((p) => `\`${p}\``).join(" and ");
        ok(
          body.includes(`silent until a repository's project config sets ${configPaths}`),
          `expected rule "${rule.id}" to state it is silent until the project config sets ${configPaths}`,
        );
      }
    });

    test(`[${agent}] a rule with no requiresConfig carries no such scope note`, () => {
      const body = rulebook.buildRulebookBody(agent);
      const mandatoryRule = REGISTERED_RULES.find((r) => r.mandatory && (!Array.isArray(r.requiresConfig) || !r.requiresConfig.length));
      ok(mandatoryRule, "expected at least one mandatory rule with no requiresConfig — a regression guard for the fixture itself");
      const line = flatten(body)
        .split(/(?=`[a-z-]+` — )/)
        .find((l) => l.startsWith(`\`${mandatoryRule.id}\` — `));
      ok(line, `expected to find the rendered line for "${mandatoryRule.id}"`);
      ok(!line.includes("silent until"), `"${mandatoryRule.id}" declares no requiresConfig — its line must not claim one`);
    });

    test(`[${agent}] the default-repository facts are derived from projects/_default.json itself, including branchNaming and localConfig`, () => {
      const body = flatten(rulebook.buildRulebookBody(agent));
      const defaultConfig = require("../../projects/_default.json");
      ok(body.includes(`Branch names look like \`${defaultConfig.branchNaming.preferred}\``), "expected the default's own branchNaming.preferred to be rendered, not omitted");
      ok(
        body.includes(`\`${defaultConfig.localConfig[0].tracked}\` is a tracked, shipped file`),
        "expected the default's own localConfig entry to be rendered, not omitted",
      );
      for (const entry of defaultConfig.protectedPaths) {
        ok(body.includes(`\`${entry.path}\` is protected`), `expected the default's own protected path "${entry.path}" to be rendered`);
      }
    });
  }

  test("buildReuseSection's backend-language clause degrades to omission, never to the literal string \"undefined\", when conventions.language is absent", () => {
    eq(rulebook.formatBackendLanguageNote({}), "", "a missing conventions.language must format to an empty string, not interpolate undefined");
    eq(rulebook.formatBackendLanguageNote(undefined), "", "an entirely missing conventions object must format to an empty string too");
    eq(rulebook.formatBackendLanguageNote({ language: "csharp" }), ' (`conventions.language: "csharp"`)', "a present language must still render exactly as before");
  });

  test("buildReuseSection's real output, against the real checked-in backend.json, never contains the literal string \"undefined\"", () => {
    const body = flatten(rulebook.buildReuseSection());
    ok(!body.includes("undefined"), 'expected no literal "undefined" in the rendered reuse section');
    ok(body.includes("On a backend repository"), "expected the backend clause's own sentence to still render");
  });

  test("the clean-code section names the principles and both concrete cases, and ships on every install", () => {
    // Unlike every other section here, this one is gated on no module and
    // backed by no rule — which is exactly why it needs pinning: nothing
    // else would fail if it silently stopped being emitted.
    const section = flatten(rulebook.buildCleanCodeSection());
    ok(/DRY, SOLID, KISS/.test(section), "the principles are named, since that is how an agent recognises them");
    ok(section.includes("`utils/`"), "the component-folder utils case must be named concretely");
    ok(section.includes("blank line"), "the backend whitespace case must be named concretely");
    ok(section.includes("docs/standards/clean-code.md"), "the full argument must be reachable from here");

    for (const agent of ["claude", "codex"]) {
      const body = flatten(rulebook.buildRulebookBody(agent, { enabledModuleIds: [] }));
      ok(body.includes("Write it as blocks"), `${agent}: the section must ship even with every optional module off`);
    }
  });

  test("Codex's tier names are read from codex-models.js#FALLBACK_MODEL_IDS, not re-typed here", () => {
    const t = rulebook.tierNames("codex");
    eq(t.cheap, `\`${FALLBACK_MODEL_IDS.cheap}\``);
    eq(t.balanced, `\`${FALLBACK_MODEL_IDS.balanced}\``);
    eq(t.frontier, `\`${FALLBACK_MODEL_IDS.frontier}\``);
  });

  test("Claude Code's tier names are read from model-tiers.js#TIER_PATTERNS, not re-typed here", () => {
    const t = rulebook.tierNames("claude");
    const aliasesOf = (tier) => {
      const entry = TIER_PATTERNS.find((p) => p.tier === tier);
      return entry.pattern.source.match(/\(([^)]+)\)/)[1].split("|").slice(0, -1);
    };
    eq(t.cheap, aliasesOf(TIERS.CHEAP).map((a) => `\`${a}\``).join("/"));
    eq(t.balanced, aliasesOf(TIERS.BALANCED).map((a) => `\`${a}\``).join("/"));
    eq(t.frontier, aliasesOf(TIERS.FRONTIER).map((a) => `\`${a}\``).join("/"));
  });

  test("the Codex text names the exact approval command under the default askMode (block); the Claude text makes no claim about Codex's own constraint", () => {
    const codexBody = flatten(rulebook.buildRulebookBody("codex"));
    const claudeBody = flatten(rulebook.buildRulebookBody("claude"));

    ok(codexBody.includes("softela-ai approve <ruleId>"), "expected Codex's text to name the approval command");
    ok(codexBody.includes("no native `ask`"), "expected Codex's text to state its own lack of a native ask");
    ok(!codexBody.includes("askMode: \"advise\""), "the default (block) text must not describe advise mode");

    ok(!claudeBody.includes("no native `ask`"), "Claude Code does have a native ask — its text must not claim Codex's constraint");
    ok(
      !claudeBody.includes("softela-ai approve <ruleId>"),
      "the approval command belongs to the Codex-specific ask workaround, not Claude's own ask behaviour",
    );
  });

  test("askMode: \"advise\" changes only Codex's enforcement text — the call now proceeds, and the approval-command denial language is gone", () => {
    const adviseBody = flatten(rulebook.buildRulebookBody("codex", { askMode: "advise" }));
    ok(adviseBody.includes('askMode: "advise"'), "expected the advisory text to name the active setting");
    ok(adviseBody.includes("proceeds"), "expected the text to state the call proceeds rather than blocks");
    ok(!adviseBody.includes("softela-ai approve <ruleId>"), "the block-mode approval command must not appear under advise mode");
    ok(adviseBody.includes("`deny` below is unaffected"), "deny must still be described as unaffected by askMode");
  });

  test("askMode is ignored for Claude Code — its enforcement text is identical under both values", () => {
    const withBlock = rulebook.buildRulebookBody("claude", { askMode: "block" });
    const withAdvise = rulebook.buildRulebookBody("claude", { askMode: "advise" });
    eq(withBlock, withAdvise);
  });

  test("the two hosts' generated bodies differ only in their host-scoped fragments, never in the shared rule catalogue or project facts", () => {
    const codexBody = rulebook.buildRulebookBody("codex", { enabledModuleIds: ALL_PROMPT_MODULES });
    const claudeBody = rulebook.buildRulebookBody("claude", { enabledModuleIds: ALL_PROMPT_MODULES });
    ok(codexBody.includes("## Concrete facts, by repository") && claudeBody.includes("## Concrete facts, by repository"));
    ok(codexBody.includes("Softela.ReactSCExpert") && claudeBody.includes("Softela.ReactSCExpert"));
    for (const rule of REGISTERED_RULES) {
      ok(
        codexBody.includes(`\`${rule.id}\``) === claudeBody.includes(`\`${rule.id}\``),
        `rule "${rule.id}" must appear in both hosts' text identically`,
      );
    }
  });

  test("a fresh install writes the base rulebook into both CLAUDE.md and AGENTS.md, including the two conditional sections its default-enabled modules gate", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "all", "--yes"]).code, 0);

    const claudeMd = readText(path.join(agentHomePath(home, "claude"), "CLAUDE.md"));
    const agentsMd = readText(path.join(agentHomePath(home, "codex"), "AGENTS.md"));

    ok(claudeMd && claudeMd.includes("## Authority hierarchy"), "expected the base rulebook in CLAUDE.md");
    ok(agentsMd && agentsMd.includes("## Authority hierarchy"), "expected the base rulebook in AGENTS.md");
    ok(claudeMd.includes("## Analyse first, then wait"), "analyze-first defaults on — its section must appear");
    ok(agentsMd.includes("## Analyse first, then wait"), "analyze-first defaults on — its section must appear");
    ok(claudeMd.includes("## Delegation and model tier"), "agent-orchestration defaults on — its section must appear");
    ok(agentsMd.includes("## Delegation and model tier"), "agent-orchestration defaults on — its section must appear");
    ok(!claudeMd.includes("Generated file — do not edit directly."), "no generator banner belongs in an installed file");
    ok(!agentsMd.includes("Generated file — do not edit directly."), "no generator banner belongs in an installed file");
  });

  test("a fresh install with analyze-first disabled writes the rulebook without its section, on both hosts", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "all", "--modules", "agent-orchestration", "--yes"]).code, 0);

    const claudeMd = readText(path.join(agentHomePath(home, "claude"), "CLAUDE.md"));
    const agentsMd = readText(path.join(agentHomePath(home, "codex"), "AGENTS.md"));

    ok(claudeMd.includes("## Authority hierarchy"), "the rest of the base rulebook is unaffected");
    ok(!claudeMd.includes("Analyse first, then wait"), "the disabled module's instruction must not appear on Claude Code");
    ok(!agentsMd.includes("Analyse first, then wait"), "the disabled module's instruction must not appear on Codex");
  });

  test("a fresh install running agent-orchestration without memory-as-context ships no MEMORY.md/memory-entries claim and no Memory section at all", () => {
    // Reproduces the reported defect end-to-end through a real scratch
    // install: agent-orchestration's own module.json declares "requires": [],
    // so this combination is fully supported, not an edge case.
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--modules", "analyze-first,agent-orchestration", "--yes"]).code, 0);

    const claudeMd = readText(path.join(agentHomePath(home, "claude"), "CLAUDE.md"));
    ok(claudeMd.includes("## Delegation and model tier"), "agent-orchestration is enabled — its section must still appear");
    ok(!claudeMd.includes("no `MEMORY.md`, no index, no prior session"), "no session here has a MEMORY.md at all — the subagent-vs-parent contrast must not appear");
    ok(!claudeMd.includes("which memory entries the subagent should open for itself"), "there is no memory mechanism installed to name entries from");
    ok(!claudeMd.includes("## Memory"), "memory-as-context is disabled — no memory section or heading should appear anywhere");
  });

  test("a fresh install with memory-as-context enabled states the INTENT/AS-OBSERVED/CONFLICT authority model exactly once, not twice under two headings", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    const claudeMd = readText(path.join(agentHomePath(home, "claude"), "CLAUDE.md"));

    const countOf = (needle) => claudeMd.split(needle).length - 1;
    eq(countOf("## INTENT — <topic>"), 1, "the full INTENT heading convention must be stated once, not restated verbatim-in-spirit under a second heading");
    eq(countOf("## AS-OBSERVED <date> @ <ref>"), 1, "the full AS-OBSERVED heading convention must be stated once");
    eq(countOf("## CONFLICT <date>"), 1, "the full CONFLICT heading convention must be stated once");
  });

  test("a fresh install resolves the memory directory to a consistently-backslashed path in the installed CLAUDE.md, never a mixed separator", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--memory-location", "global", "--yes"]).code, 0);
    const claudeMd = readText(path.join(agentHomePath(home, "claude"), "CLAUDE.md"));

    const resolvedGlobalDir = path.join(agentHomePath(home, "claude"), "memory");
    ok(claudeMd.includes(resolvedGlobalDir), `expected the resolved memory directory "${resolvedGlobalDir}" to appear verbatim in CLAUDE.md`);
    ok(!claudeMd.includes(`${agentHomePath(home, "claude")}/memory`), "must never mix a literal forward slash onto the substituted (backslash) AGENT_HOME path");
  });

  test("update rewrites the block in place — one BEGIN/END pair, no duplication, byte-identical on a no-op run", () => {
    const home = fakeHome();
    eq(runCli(home, ["install", "--agent", "claude", "--yes"]).code, 0);
    const claudeMdPath = path.join(agentHomePath(home, "claude"), "CLAUDE.md");
    const afterInstall = readText(claudeMdPath);

    const updated = runCli(home, ["update", "--agent", "claude", "--yes"]);
    ok(updated.code === 0 || updated.code === 2, `expected update to succeed (0) or report nothing to do (2), got ${updated.code}:\n${updated.stdout}\n${updated.stderr}`);
    const afterUpdate = readText(claudeMdPath);

    eq(afterUpdate, afterInstall, "a no-op update must reproduce the exact same file");
    eq((afterUpdate.match(/BEGIN softela-ai/g) || []).length, 1, "exactly one managed block, never duplicated");
    eq((afterUpdate.match(/END softela-ai/g) || []).length, 1, "exactly one managed block, never duplicated");
  });
});
