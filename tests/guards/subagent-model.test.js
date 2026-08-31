"use strict";

const { suite } = require("../harness");
const rule = require("../../core/guards/subagent-model");
const { PROJECT_MINIMAL, decide } = require("./_ctx");

/** The module that activates this rule; every case must enable it. */
const MODULES = ["agent-orchestration"];

suite("guards/subagent-model", ({ test, eq, ok }) => {
  /* --------------------------------------------------- direct spawn: deny */

  test("a spawn with no model at all is denied", () => {
    eq(decide(rule, { toolName: "Agent", input: { prompt: "x" }, modules: MODULES }), "deny");
  });

  test("a spawn with an empty-string model is denied", () => {
    eq(decide(rule, { toolName: "Agent", input: { prompt: "x", model: "" }, modules: MODULES }), "deny");
  });

  test("a spawn with a whitespace-only model is denied", () => {
    eq(decide(rule, { toolName: "Agent", input: { prompt: "x", model: "   " }, modules: MODULES }), "deny");
  });

  /* ------------------------------------------------ Codex's own spawn tool */

  test("Codex's spawn tool is recognised under the name a live payload actually carries", () => {
    // Measured on Codex 0.149.1: the tool the model sees as
    // `collaboration.spawn_agent` reaches a PreToolUse hook as
    // `collaborationspawn_agent`, with its namespace punctuation stripped.
    // Anchored on `^…$`, the old list matched neither spelling, so this rule
    // was silently inert on that host — every Codex spawn passed unchecked.
    for (const toolName of ["collaborationspawn_agent", "collaboration.spawn_agent", "collaboration_spawn_agent"]) {
      eq(
        decide(rule, {
          agent: "codex",
          toolName,
          input: { task_name: "read the files", fork_turns: "none", message: "..." },
          session: { model: "gpt-5.6-sol" },
          modules: MODULES,
        }),
        "deny",
        `${toolName}: a modelless Codex spawn must be denied, not ignored`,
      );
    }
  });

  test("a Codex spawn naming the cheap tier passes, and one naming the session's frontier tier asks", () => {
    const spawn = (model) =>
      decide(rule, {
        agent: "codex",
        toolName: "collaborationspawn_agent",
        input: { task_name: "t", model, message: "..." },
        session: { model: "gpt-5.6-sol" },
        modules: MODULES,
      });
    eq(spawn("gpt-5.6-luna"), "pass");
    eq(spawn("gpt-5.6-terra"), "pass");
    eq(spawn("gpt-5.6-sol"), "ask");
  });

  test("the modelless-spawn fix names Codex's own config flag, since without it no model can be set", () => {
    // A rule that cannot be complied with is a wall. Codex's spawn tool only
    // accepts `model` when `multi_agent_v2.expose_spawn_agent_model_overrides`
    // is on, so the fix has to say so on that host.
    const codex = rule.evaluate({
      agent: "codex",
      toolName: "collaborationspawn_agent",
      input: { task_name: "t" },
      session: { model: "gpt-5.6-sol" },
      modules: MODULES,
      project: PROJECT_MINIMAL,
    });
    ok(codex.fix.includes("expose_spawn_agent_model_overrides"), codex.fix);
    ok(codex.fix.includes("gpt-5.6-luna"), "and must name Codex's own tier ids, not Claude Code's");

    const claude = rule.evaluate({
      agent: "claude",
      toolName: "Agent",
      input: { prompt: "x" },
      session: { model: "opus" },
      modules: MODULES,
      project: PROJECT_MINIMAL,
    });
    ok(claude.fix.includes("haiku"), claude.fix);
    ok(
      !claude.fix.includes("expose_spawn_agent_model_overrides"),
      "Claude Code has no such flag and must not be told to set one",
    );
  });

  /* ---------------------------------------------- direct spawn: pass/ask */

  test("a spawn at the same tier as the session passes", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "sonnet" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a spawn cheaper than the session passes", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "haiku" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a spawn more expensive than the session asks", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "sonnet" },
        session: { model: "haiku" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("a frontier spawn asks even when the session is itself frontier", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "opus" },
        session: { model: "opus" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("a frontier spawn (fable) asks regardless of session", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "fable" },
        session: { model: "haiku" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("an unrecognised session model is compared against the balanced tier", () => {
    // sonnet (balanced) against an unknown session model must pass, since the
    // unknown session is treated as balanced, not as the cheapest tier.
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "sonnet" },
        session: { model: "some-custom-model" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("an unrecognised session model still lets a cheap spawn through", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "haiku" },
        session: { model: null },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("an unrecognised spawn model asks rather than denying", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "gpt-4" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  /* ---------------------------------------------------- Codex tier names */

  test("a Codex spawn at the balanced tier against a balanced session passes", () => {
    eq(
      decide(rule, {
        toolName: "Task",
        input: { model: "gpt-5.6-terra" },
        session: { model: "gpt-5.6-terra" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a Codex frontier spawn asks", () => {
    eq(
      decide(rule, {
        toolName: "Task",
        input: { model: "gpt-5.6-sol" },
        session: { model: "gpt-5.6-terra" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  /* --------------------------------------------------- unrecognised tool */

  test("an unrecognised tool matching the spawn pattern with a model key is treated as a spawn", () => {
    eq(
      decide(rule, {
        toolName: "delegate_task",
        input: { model: "opus" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("an unrecognised tool matching the spawn pattern with no model key is left alone", () => {
    eq(
      decide(rule, {
        toolName: "delegate_task",
        input: { prompt: "x" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  /* ------------------------------------------------------------ workflow */

  test("a workflow script with an agent() call and no model at all is denied", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "export const meta={}\nconst a=await agent('do x')\nreturn a" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("a workflow script with one modelled call out of two is denied", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script: "export const meta={}\nawait agent('x',{model:'sonnet'})\nawait agent('y')",
        },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("a workflow script assigning opus to an agent() call asks", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "export const meta={}\nconst a=await agent('x',{model:'opus'})" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("a workflow script where every call is at or under the session tier passes", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script:
            "export const meta={}\nawait agent('x',{model:'sonnet',effort:'medium'})\nawait agent('y',{model:'haiku',effort:'medium'})",
        },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a workflow script carrying the model via a spread is not denied for a missing per-call model", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script:
            "export const meta={}\nconst O={model:'sonnet',effort:'medium'}\nawait agent('x',{...O})\nawait agent('y',{...O})",
        },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a workflow script whose prompt text merely discusses model options is not judged on that prose", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script:
            "export const meta={}\nconst P = `rules: a script whose agent() calls lack a model, or that set effort: \"low\", is denied; never request model: \"opus\"`\nawait agent(P,{model:'sonnet',effort:'high'})",
        },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a workflow script whose only agent() mention is inside a comment is not counted", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script: "export const meta={}\n// agent('y') would be wrong here\nawait agent('x',{model:'haiku'})",
        },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a workflow script that aliases the spawn function before calling it is still parsed", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script: "const spawn = agent\nawait spawn('do the dangerous task', {model:'opus', effort:'high'})",
        },
        session: { model: "haiku" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("a workflow script with a model set via object shorthand asks rather than denying", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script: "const model = 'haiku'; const effort = 'medium'; await agent('x', {model, effort})",
        },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("a workflow script with a model set via a property reference asks rather than denying", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "await agent('x', {model: config.defaultModel, effort: 'medium'})" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("a workflow with no agent() calls at all passes", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "export const meta={}\nreturn 1" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  test("a workflow with no inline script and no path asks rather than denying", () => {
    eq(decide(rule, { toolName: "Workflow", input: {}, modules: MODULES }), "ask");
  });

  test("a workflow whose script path cannot be read asks", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { scriptPath: "/does/not/exist.js" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("a workflow script read from a path is parsed the same as an inline one", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { scriptPath: "/repo/workflow.js" },
        files: { "/repo/workflow.js": "export const meta={}\nawait agent('x',{model:'opus'})" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("a variable merely named like the spawn function is not mistaken for an alias", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: {
          script: "const agentConfig = loadConfig()\nawait agent('x',{model:'sonnet',effort:'medium'})",
        },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "pass",
    );
  });

  /* ---------------------------------------------------------- negative */

  test("a plain file read is not a spawn", () => {
    eq(decide(rule, { toolName: "Read", input: { file_path: "a.ts" }, modules: MODULES }), "pass");
  });

  test("an ordinary shell command is not a spawn", () => {
    eq(decide(rule, { toolName: "Bash", command: "npm run build", modules: MODULES }), "pass");
  });

  test("a file write is not a spawn", () => {
    eq(decide(rule, { toolName: "Write", filePath: "a.ts", content: "x", modules: MODULES }), "pass");
  });

  test("an ordinary web search tool is not a spawn even with an unrelated model-shaped field", () => {
    eq(decide(rule, { toolName: "WebSearch", input: { query: "agentic workflows" }, modules: MODULES }), "pass");
  });

  test("a tool merely named 'Agentic' without a model key is left alone", () => {
    eq(decide(rule, { toolName: "AgenticSearch", input: { query: "x" }, modules: MODULES }), "pass");
  });

  test("a PostToolUse event is not evaluated by this PreToolUse rule", () => {
    eq(decide(rule, { event: "PostToolUse", toolName: "Agent", input: { model: "opus" }, modules: MODULES }), "pass");
  });

  test("the rule stays silent when the agent-orchestration module is not enabled", () => {
    eq(decide(rule, { toolName: "Agent", input: {}, modules: [] }), "pass");
  });

  test("the rule stays silent when no modules are enabled at all, even for a frontier spawn", () => {
    eq(decide(rule, { toolName: "Agent", input: { model: "opus" }, modules: [] }), "pass");
  });

  test("the rule behaves the same under a minimal project, since it does not read project config", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "sonnet" },
        session: { model: "sonnet" },
        modules: MODULES,
        project: PROJECT_MINIMAL,
      }),
      "pass",
    );
    eq(
      decide(rule, {
        toolName: "Agent",
        input: {},
        modules: MODULES,
        project: PROJECT_MINIMAL,
      }),
      "deny",
    );
  });

  /* --------------------------------------------------------- evasion */

  test("evasion: a lower-cased spelling of the direct spawn tool name still applies", () => {
    eq(decide(rule, { toolName: "task", input: {}, modules: MODULES }), "deny");
  });

  test("evasion: an upper-cased model name is still recognised by tier", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: { model: "OPUS" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("evasion: a lower-cased tool name spelling for the spawn-like fallback still counts", () => {
    eq(
      decide(rule, {
        toolName: "spawn_agent",
        input: { model: "opus" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  test("evasion: a workflow that aliases the spawn function still gets its missing model denied", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "const spawn = agent\nawait spawn('do x')" },
        modules: MODULES,
      }),
      "deny",
    );
  });

  test("evasion: PowerShell-style Workflow tool naming is still parsed", () => {
    eq(
      decide(rule, {
        toolName: "Workflow",
        input: { script: "await agent('x', { model: 'opus' })" },
        session: { model: "sonnet" },
        modules: MODULES,
      }),
      "ask",
    );
  });

  /* ----------------------------------------------------------- override */

  test("override softens a deny to ask", () => {
    eq(
      decide(rule, {
        toolName: "Agent",
        input: {},
        modules: MODULES,
        overrideSpec: { "subagent-model": { action: "ask" } },
      }),
      "ask",
    );
  });
});
