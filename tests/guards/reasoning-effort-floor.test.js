"use strict";

const path = require("path");
const { suite } = require("../harness");
const rule = require("../../core/guards/reasoning-effort-floor");
const { PROJECT_MINIMAL, decide } = require("./_ctx");
const { readJson } = require("../../core/lib/fs-safe");
const paths = require("../../core/lib/paths");

/** The module that activates this rule; every case must enable it. */
const MODULES = ["agent-orchestration"];

suite("guards/reasoning-effort-floor", ({ test, eq, ok }) => {
  /* ---------------------------------------------------------- the ladder */

  test("minimal on a direct spawn is denied", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "minimal" }, modules: MODULES }), "deny");
  });

  test("low on a direct spawn is denied", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "low" }, modules: MODULES }), "deny");
  });

  test("medium on a direct spawn passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "medium" }, modules: MODULES }), "pass");
  });

  test("high on a direct spawn passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "high" }, modules: MODULES }), "pass");
  });

  test("xhigh on a direct spawn passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "xhigh" }, modules: MODULES }), "pass");
  });

  test("max on a direct spawn passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "max" }, modules: MODULES }), "pass");
  });

  test("ultra on a direct spawn passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "ultra" }, modules: MODULES }), "pass");
  });

  test("an unrecognised effort value passes rather than being treated as a violation", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "turbo" }, modules: MODULES }), "pass");
  });

  test("case does not matter for the ladder", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "LOW" }, modules: MODULES }), "deny");
  });

  /* -------------------------------------------------- Codex effort spellings */

  test("a direct spawn setting reasoning_effort to low is denied — the Codex spelling", () => {
    eq(decide(rule, { toolName: "Agent", input: { reasoning_effort: "low" }, modules: MODULES }), "deny");
  });

  test("a direct spawn setting model_reasoning_effort to low is denied", () => {
    eq(decide(rule, { toolName: "Agent", input: { model_reasoning_effort: "low" }, modules: MODULES }), "deny");
  });

  test("a direct spawn setting reasoningEffort (camelCase) to low is denied", () => {
    eq(decide(rule, { toolName: "Agent", input: { reasoningEffort: "low" }, modules: MODULES }), "deny");
  });

  test("a direct spawn setting modelReasoningEffort (camelCase) to low is denied", () => {
    eq(decide(rule, { toolName: "Agent", input: { modelReasoningEffort: "low" }, modules: MODULES }), "deny");
  });

  test("reasoning_effort set to medium passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { reasoning_effort: "medium" }, modules: MODULES }), "pass");
  });

  test("reasoning_effort set to high passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { reasoning_effort: "high" }, modules: MODULES }), "pass");
  });

  test("model_reasoning_effort set to medium passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { model_reasoning_effort: "medium" }, modules: MODULES }), "pass");
  });

  test("an unrecognised reasoning_effort value passes rather than being treated as a violation", () => {
    eq(decide(rule, { toolName: "Agent", input: { reasoning_effort: "turbo" }, modules: MODULES }), "pass");
  });

  test("when both `effort` and `reasoning_effort` are set, the first-listed spelling (`effort`) is the one read", () => {
    eq(
      decide(rule, { toolName: "Agent", input: { effort: "high", reasoning_effort: "low" }, modules: MODULES }),
      "pass",
    );
  });

  test("an unknown Codex-side spawn-like tool carrying only reasoning_effort is still recognised as a spawn", () => {
    eq(decide(rule, { toolName: "spawn_worker", input: { reasoning_effort: "low" }, modules: MODULES }), "deny");
  });

  test("an unknown Codex-side spawn-like tool carrying only model_reasoning_effort is still recognised as a spawn", () => {
    eq(decide(rule, { toolName: "spawn_worker", input: { model_reasoning_effort: "low" }, modules: MODULES }), "deny");
  });

  /* ------------------------------------------------------------ workflow */

  test("a workflow script that sets a low effort on an agent() call is denied", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "export const meta={}\nawait agent('x',{model:'sonnet',effort:'low'})" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("a workflow script setting minimal effort is denied", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "await agent('x',{model:'sonnet',effort:'minimal'})" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("a workflow script where every effort is at or above medium passes", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script:
            "export const meta={}\nawait agent('x',{model:'sonnet',effort:'medium'})\nawait agent('y',{model:'haiku',effort:'high'})",
        },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a workflow script with an agent() call and no effort at all passes", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "export const meta={}\nconst a=await agent('do x')\nreturn a" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a workflow script whose prompt text merely discusses effort options is not judged on that prose", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script:
            "export const meta={}\nconst P = `rules: a script that sets effort: \"low\" is denied; never request model: \"opus\"`\nawait agent(P,{model:'sonnet',effort:'high'})",
        },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a workflow with no script at all passes", () => {
    eq(decide(rule, { toolName: "Workflow", input: {}, modules: MODULES }), "pass");
  });

  test("a workflow whose script path cannot be read passes rather than denying on uncertainty", () => {
    eq(decide(rule, { toolName: "Workflow", input: { scriptPath: "/nope.js" }, modules: MODULES }), "pass");
  });

  test("a workflow script read from a path is scanned the same as an inline one", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { scriptPath: "/repo/workflow.js" },
        files: { "/repo/workflow.js": "await agent('x',{model:'sonnet',effort:'low'})" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("a workflow script's agent() call setting reasoning_effort to low is denied — the Codex spelling", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "await agent('x',{model:'sonnet',reasoning_effort:'low'})" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("a workflow script's agent() call setting model_reasoning_effort to low is denied", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "await agent('x',{model:'sonnet',model_reasoning_effort:'low'})" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("a prompt string that merely mentions 'reasoning_effort: low' in prose is not judged on that text", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script:
            "export const meta={}\nconst P = `rules: a call that sets reasoning_effort: \"low\" is denied`\nawait agent(P,{model:'sonnet',effort:'high'})",
        },
        modules: MODULES,
      }),
      "pass",
    );
  });

  /* --------------------------------------------------------- negative */

  test("a spawn with no effort field at all passes", () => {
    eq(decide(rule, { toolName: "Agent", input: { model: "sonnet" }, modules: MODULES }), "pass");
  });

  test("a spawn with a non-string effort value passes rather than throwing", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: 3 }, modules: MODULES }), "pass");
  });

  test("an ordinary file write is not a spawn", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: "x", modules: MODULES }), "pass");
  });

  test("an ordinary shell command is not a spawn", () => {
    eq(decide(rule, { toolName: "Bash", command: "npm run build", modules: MODULES }), "pass");
  });

  test("an unrecognised tool with an effort key but no spawn-like name is left alone", () => {
    eq(decide(rule, { toolName: "ConfigureBuild", input: { effort: "low" }, modules: MODULES }), "pass");
  });

  test("a spawn-like tool name with neither effort nor model is left alone", () => {
    eq(decide(rule, { toolName: "spawn_worker", input: { prompt: "x" }, modules: MODULES }), "pass");
  });

  /* ------------------------ the floor never constrains the developer's own turn */

  test("a plain Write call passes untouched even when the session's own effort is low", () => {
    eq(
      decide(rule, {
        toolName: "Write",
        filePath: "a.ts",
        content: "x",
        session: { effort: "low" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a plain Bash call passes untouched even when the session's own effort is low", () => {
    eq(
      decide(rule, {
        toolName: "Bash",
        command: "npm run build",
        session: { effort: "low" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a plain Read call passes untouched even when the session's own effort is low", () => {
    eq(
      decide(rule, {
        toolName: "Read",
        input: { file_path: "a.ts" },
        session: { effort: "low" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("the rule stays silent when the agent-orchestration module is not enabled", () => {
    eq(decide(rule, { toolName: "Agent", input: { effort: "low" }, modules: [] }), "pass");
  });

  test("the rule behaves the same under a minimal project, since it does not read project config", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { effort: "low" },
        modules: MODULES,
        project: PROJECT_MINIMAL,
      }),
      "deny",
    );
  });

  /* ----------------------------------------------------------- evasion */

  test("evasion: a different capitalisation of the spawn tool name still applies", () => {
    eq(decide(rule, { toolName: "TASK", input: { effort: "low" }, modules: MODULES }), "deny");
  });

  test("evasion: a spread-carried options object is still scanned for a real low-effort literal alongside it", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script:
            "const O={model:'sonnet',effort:'medium'}\nawait agent('x',{...O})\nawait agent('y',{model:'haiku',effort:'low'})",
        },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("evasion: extra whitespace around the agent() call and its object literal does not hide a low effort", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "await   agent  ( 'x' , { model: 'sonnet' , effort: 'low' } )" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  /* ------------------------------------------------ Codex's own spawn tool */

  test("Codex's spawn tool is held to the same floor, under the name a live payload carries", () => {
    // Kept in step with `subagent-model`'s own list on purpose: a spawn route
    // one rule knows about and the other does not is a gap by construction.
    for (const toolName of ["collaborationspawn_agent", "collaboration.spawn_agent"]) {
      eq(
        decide(rule, { agent: "codex", toolName, input: { task_name: "t", reasoning_effort: "low" }, modules: MODULES }),
        "deny",
        `${toolName}: a low-effort Codex spawn must be denied`,
      );
      eq(
        decide(rule, { agent: "codex", toolName, input: { task_name: "t", reasoning_effort: "medium" }, modules: MODULES }),
        "pass",
        `${toolName}: the floor itself is allowed`,
      );
      eq(
        decide(rule, { agent: "codex", toolName, input: { task_name: "t", reasoning_effort: "high" }, modules: MODULES }),
        "pass",
        `${toolName}: raising effort is the orchestrator's call, never a violation`,
      );
    }
  });

  /* ------------------------------------------------------- seeded default */

  test("agent-orchestration seeds a medium subagent reasoning-effort default for Codex, at the top level", () => {
    // Top level, not under `[agents]`: that section does not exist in Codex's
    // own `ConfigToml` at all — the field sits alongside `model` and
    // `review_model`. Seeded under the wrong section it was written, parsed as
    // an unknown table, and read by nothing.
    const modulePath = path.join(paths.repoRoot(), "modules", "agent-orchestration", "module.json");
    const json = readJson(modulePath);
    const entry = (json.settings || []).find((s) => s.pointer === "/default_subagent_reasoning_effort");
    ok(entry, "module.json must declare a seed entry for /default_subagent_reasoning_effort");
    eq(entry.agent, "codex");
    eq(entry.mode, "seed");
    eq(entry.value, "medium");

    ok(
      !(json.settings || []).some((s) => String(s.pointer).startsWith("/agents/")),
      "nothing may be seeded into an `[agents]` section Codex does not have",
    );
  });

  test("agent-orchestration seeds the two Codex flags without which delegation cannot work", () => {
    // Measured against the real binary: without `features.multi_agent_v2` a
    // Codex session is offered no spawn tool at all, and without
    // `multi_agent_v2.expose_spawn_agent_model_overrides` the spawn payload
    // carries no model and the subagent runs on the session's own.
    const modulePath = path.join(paths.repoRoot(), "modules", "agent-orchestration", "module.json");
    const settings = readJson(modulePath).settings || [];

    for (const pointer of ["/features/multi_agent_v2", "/multi_agent_v2/expose_spawn_agent_model_overrides"]) {
      const entry = settings.find((s) => s.pointer === pointer);
      ok(entry, `module.json must seed ${pointer}`);
      eq(entry.agent, "codex");
      eq(entry.mode, "seed");
      eq(entry.value, true);
    }

    // `per_spawn_model_override` is not a Codex feature flag at all — it does
    // not appear in `codex features list` on the installed binary. Seeding it
    // wrote a key nothing ever read.
    ok(
      !settings.some((s) => String(s.pointer).includes("per_spawn_model_override")),
      "a feature flag the host does not have must never be seeded",
    );
  });

  /* ----------------------------------------------------------- override */

  test("override softens a deny to ask", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { effort: "low" },
        modules: MODULES,
        overrideSpec: { "reasoning-effort-floor": { action: "ask" } },
      }),
      "ask",
    );
  });
});
