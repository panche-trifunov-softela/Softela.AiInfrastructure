"use strict";

/**
 * Runs the rule registry against a context and picks the single decision
 * that governs a tool call.
 *
 * Determinism is a hard requirement: the same context always produces the
 * same decision, so nothing here reads the clock, generates randomness, or
 * depends on filesystem iteration order beyond the registry's own fixed
 * order.
 */

const { clamp, severity } = require("./lib/decision");
const approvals = require("./lib/approvals");
const { resolveStack } = require("./lib/stack-resolver");
const { loadPreset } = require("./lib/preset-resolver");
const { loadDefaultProject } = require("./lib/project-resolver");
const { mergeConfigLayer } = require("./lib/config-merge");
const { classifyChange } = require("./lib/change-scope");

/** Actions the project-config rule switch (§8) may name; anything else is ignored. */
const SWITCH_ACTIONS = new Set(["off", "ask", "deny"]);

/**
 * Prefixed onto a `newCodeOnly` rule's own reason when its target file
 * classifies as `"existing"` (`evaluate`'s newCodeOnly-softening step):
 * states plainly that what follows is advice on a pre-existing file, not a
 * requirement, and why. The rule's own reason always survives unedited
 * after this prefix and a blank line.
 */
const NEW_CODE_ONLY_ADVICE_PREFIX =
  "ADVICE — this file already exists in the repository, so the standard below is a refactoring suggestion here, not a requirement:";

/**
 * Reads a dotted path out of an object without ever throwing.
 *
 * `null` and `undefined` are treated as absent at every step — an explicit
 * `false` or `0` is a real, present value and is returned as-is. This is the
 * single place that answers "did the project config actually set this?" so
 * a rule never has to invent a substitute when the answer is no.
 *
 * @param {object} obj The object to walk, typically `ctx.project`.
 * @param {string} dottedPath A path like `"limits.fileLines.ask"`.
 * @returns {*} The value found, or `undefined` when any segment is absent.
 */
function readConfigPath(obj, dottedPath) {
  let cur = obj;
  for (const segment of String(dottedPath || "").split(".")) {
    if (!segment) continue;
    if (cur === null || cur === undefined) return undefined;
    cur = cur[segment];
  }
  return cur;
}

/**
 * Checks whether every path a rule declares in `requiresConfig` resolves to
 * a present value in the project config.
 *
 * @param {object} rule A rule module.
 * @param {object} project The resolved project config, `ctx.project`.
 * @returns {boolean} `true` when `requiresConfig` is empty or absent, or
 * every listed path is present.
 */
function requiresConfigSatisfied(rule, project) {
  const paths = Array.isArray(rule.requiresConfig) ? rule.requiresConfig : [];
  for (const path of paths) {
    const value = readConfigPath(project, path);
    if (value === null || value === undefined) return false;
  }
  return true;
}

/**
 * Normalises one entry of the project config's `rules.groups` / `rules.byId`
 * map to `{action, reason}`, accepting both the bare action string and the
 * `{action, reason}` object shape.
 *
 * @param {*} entry The raw entry, of whatever shape a project file wrote.
 * @returns {{action: string, reason: string|undefined} | null} The
 * normalised entry, or `null` when it names no recognised action.
 */
function normalizeRuleSwitchEntry(entry) {
  if (typeof entry === "string" && SWITCH_ACTIONS.has(entry)) return { action: entry, reason: undefined };
  if (entry && typeof entry === "object" && SWITCH_ACTIONS.has(entry.action)) {
    return { action: entry.action, reason: typeof entry.reason === "string" ? entry.reason : undefined };
  }
  return null;
}

/**
 * Resolves the project config's `rules` switch (§8 of CONTRACTS.md) for one
 * rule — the committed, team-reviewed tier that sits between the rule's own
 * default and the developer's local overrides file.
 *
 * @param {object} project The resolved project config, `ctx.project`.
 * @param {object} rule A rule module.
 * @returns {{action: string, reason: string|undefined} | null} The
 * resolved switch, `byId` beating `groups`, or `null` when the project
 * names nothing for this rule.
 */
function resolveProjectRuleSwitch(project, rule) {
  const rulesCfg = project && typeof project === "object" ? project.rules : null;
  if (!rulesCfg || typeof rulesCfg !== "object") return null;

  const byId = rulesCfg.byId && typeof rulesCfg.byId === "object" ? rulesCfg.byId[rule.id] : undefined;
  const byIdEntry = normalizeRuleSwitchEntry(byId);
  if (byIdEntry) return byIdEntry;

  if (rule.group) {
    const groups = rulesCfg.groups && typeof rulesCfg.groups === "object" ? rulesCfg.groups : null;
    const groupEntry = groups ? normalizeRuleSwitchEntry(groups[rule.group]) : null;
    if (groupEntry) return groupEntry;
  }

  return null;
}

/**
 * Checks whether a rule's declared `stacks` (if any) admits a context.
 *
 * A rule with no `stacks` field is never excluded by this check — it is
 * stack-agnostic by construction (RULES.md's git and agent rules, plus a
 * handful of stack-neutral code rules). A rule that does declare `stacks`
 * only runs when the context's file path resolves to one of them; the
 * non-file case and an unmatched monorepo path both resolve to no stack
 * (`lib/stack-resolver.js#resolveStack`) and are treated identically: the
 * rule does not fire.
 *
 * @param {object} rule A rule module.
 * @param {object} ctx The evaluation context, already carrying whatever
 * stack preset applies (§8a) — resolution itself only reads `ctx.project`'s
 * own `stack`/`stacks` routing keys, which a preset never sets.
 * @returns {boolean} `true` when the rule has no `stacks` field, or the
 * resolved stack is one of the ones it lists.
 */
function admittedByStack(rule, ctx) {
  if (!Array.isArray(rule.stacks) || rule.stacks.length === 0) return true;
  const stack = resolveStack(ctx);
  return Boolean(stack) && rule.stacks.includes(stack);
}

/**
 * Checks whether a rule is a candidate for a context, ignoring what its
 * `evaluate` actually returns.
 *
 * @param {object} rule A rule module.
 * @param {object} ctx The evaluation context.
 * @returns {boolean} `true` when the rule's `events`, `tools`,
 * `requiresModule` and `stacks` all admit this context, every
 * `requiresConfig` path is present in `ctx.project`, and — unless the rule
 * is `mandatory` — the project config's rule switch does not resolve to
 * `"off"`.
 */
function applies(rule, ctx) {
  if (!rule || typeof rule.evaluate !== "function") return false;
  if (!Array.isArray(rule.events) || !rule.events.includes(ctx.event)) return false;
  if (rule.tools != null && typeof rule.tools.test === "function" && !rule.tools.test(ctx.toolName)) {
    return false;
  }
  if (rule.requiresModule && !(ctx.modules && ctx.modules.has(rule.requiresModule))) return false;
  if (!admittedByStack(rule, ctx)) return false;
  if (!requiresConfigSatisfied(rule, ctx.project)) return false;
  if (!rule.mandatory) {
    const projectSwitch = resolveProjectRuleSwitch(ctx.project, rule);
    if (projectSwitch && projectSwitch.action === "off") return false;
  }
  return true;
}

/**
 * Builds the context a rule actually runs against, by layering the shipped
 * configuration underneath the project's own.
 *
 * Two layers go under a matched project, weakest first:
 *
 * 1. `projects/_default.json`, so the protections every repository gets do
 *    not disappear the moment somebody writes a project file for it. The
 *    merge is additive for protection lists and replacing everywhere else —
 *    `lib/config-merge.js` owns that distinction, and states why per key.
 * 2. The resolved stack's preset (§8a), so both the `requiresConfig` gate
 *    and the rule body itself see the effective, per-stack conventions — not
 *    only the rules whose own `stacks` field scopes them to one stack.
 *
 * The default layer is applied before the stack is resolved, because
 * `_default.json` is where the per-extension stack detection lives: a
 * project file that declares no `stack` of its own inherits that detection
 * instead of resolving to no stack at all.
 *
 * A stack that resolves to nothing, or one with no preset file on disk,
 * simply contributes no second layer — this never invents configuration a
 * project did not, directly or through its stack, actually declare.
 *
 * @param {object} ctx The evaluation context, as built by `lib/context.js`.
 * @param {{presetsDir?: string, projectsDir?: string}} [options] Directory
 * overrides for the preset and default files, mainly for tests.
 * @returns {object} `ctx`, or a shallow copy whose `project` carries the
 * effective merged configuration.
 */
function withEffectivePreset(ctx, options = {}) {
  const withDefaults = withDefaultLayer(ctx, options);

  const stack = resolveStack(withDefaults);
  if (!stack) return withDefaults;
  const preset = loadPreset(stack, { presetsDir: options.presetsDir });
  if (!preset) return withDefaults;
  return { ...withDefaults, project: mergeConfigLayer(preset, withDefaults.project) };
}

/**
 * Layers `projects/_default.json` underneath a matched project's config.
 *
 * A context already running under `_default` itself is returned unchanged:
 * it is the default layer, and merging it with itself would only duplicate
 * every entry in it.
 *
 * @param {object} ctx The evaluation context.
 * @param {{projectsDir?: string}} [options] `projectsDir` override.
 * @returns {object} `ctx`, or a shallow copy carrying the merged config.
 */
function withDefaultLayer(ctx, options = {}) {
  const project = ctx.project;
  if (!project || typeof project !== "object") return ctx;
  if (project.id === "_default") return ctx;

  const defaults = loadDefaultProject({ projectsDir: options.projectsDir });
  if (!defaults) return ctx;
  return { ...ctx, project: mergeConfigLayer(defaults, project) };
}

/**
 * Resolves the default rule registry's full status, lazily and
 * defensively, so a broken registry never breaks loading this module
 * itself.
 *
 * `core/guards/index.js` isolates every file it loads, so `require("./guards")`
 * itself should now only ever throw on something outside a single rule
 * module's control (the module system itself failing, for example) — this
 * `try` is defense in depth for that remaining case, not the primary
 * isolation mechanism. Per CONTRACTS.md's "Fail open, always": an empty
 * result here is a state `doctor` and `SOFTELA_AI_DEBUG=1` must report loudly
 * (§7a, `ruleLoadErrors` exists precisely for that), never a reason for the
 * engine itself to deny — a guard that cannot even load must not be able to
 * brick the developer's session either.
 *
 * @returns {{rules: object[], loadErrors: {file: string | null, error: string}[]}}
 * `rules` is the registry's successfully loaded rules, empty on total
 * failure. `loadErrors` is `core/guards/index.js`'s own record of every
 * module it could not load or validate, one entry per skipped file; empty on
 * total failure too, since nothing could even be inspected to report.
 */
function ruleRegistryStatus() {
  try {
    const guards = require("./guards");
    return { rules: guards.rules || [], loadErrors: guards.loadErrors || [] };
  } catch {
    return { rules: [], loadErrors: [] };
  }
}

/**
 * Resolves the default rule registry.
 *
 * @returns {object[]} The registered rules, or an empty array on failure —
 * see {@link ruleRegistryStatus}, which this delegates to.
 */
function defaultRules() {
  return ruleRegistryStatus().rules;
}

/**
 * Lists the rules that would run for a context, without running them.
 *
 * @param {object} ctx The evaluation context.
 * @param {{rules?: object[], presetsDir?: string}} [options] `rules`
 * overrides the default registry, mainly for tests and for `doctor`;
 * `presetsDir` overrides the default stack-preset location, mainly for
 * tests.
 * @returns {object[]} The candidate rules, in registry order, judged against
 * the resolved stack's preset merged under the project config (§8a).
 */
function applicableRules(ctx, options = {}) {
  const ruleSet = options.rules || defaultRules();
  const effectiveCtx = withEffectivePreset(ctx, options);
  return ruleSet.filter((rule) => applies(rule, effectiveCtx));
}

/**
 * Evaluates the rule registry against a context and returns the single
 * decision that governs the tool call.
 *
 * Flow:
 * 1. Resolve the effective context: the matching stack preset merged under
 *    the project config (§8a), when a stack can be resolved at all.
 * 2. Select the rules whose `events`, `tools`, `requiresModule`, `stacks`
 *    and `requiresConfig` admit the effective context, and whose
 *    project-config switch (§8) does not resolve to `"off"` (skipped for a
 *    `mandatory` rule).
 * 3. Skip a rule with a live approval for its id (CONTRACTS §7a) — granted
 *    only from the developer's own terminal, never from inside a tool call.
 * 4. Run each remaining rule in isolation against the effective context; a
 *    thrown rule is skipped and, when `options.diagnostics` is an array,
 *    recorded on it as `{ruleId, error}`.
 * 5. Clamp a non-`null` result to at most the rule's own `defaultAction`
 *    (RULES.md's stated contract) before anything else touches it.
 * 6. Unless the rule is `mandatory`, let the project-config switch replace
 *    the (already clamped) result's action outright — `byId` beating
 *    `groups` — before the developer override is even considered.
 * 7. Unless the rule is `mandatory`, when the rule declares `newCodeOnly`
 *    and the target file classifies as `"existing"` (§`lib/change-scope.js`
 *    — never having proved a file pre-exists is treated the same as proof
 *    it is new), clamp the action to at most `"ask"` and prefix the reason
 *    with an advisory note; the rule's own reason survives unedited after
 *    the prefix. This can only soften, and it runs before the developer
 *    override is even considered.
 * 8. Unless the rule is `mandatory`, drop a result whose `allow` override
 *    matches `ctx.command` or `ctx.filePath`, then clamp its action to at
 *    most as severe as its override action.
 * 9. Keep the most severe surviving result; ties are broken by registry
 *    order, so the earliest-registered rule wins.
 * 10. Mark the kept result `advisory: true` when it is an `ask` that is a
 *    NUDGE rather than a request for the developer's decision — the rule
 *    declares `advisoryAsk`, the rule's own `evaluate` result carries
 *    `advisory: true` (a per-call value a rule with more than one code path
 *    can set for itself, e.g. a rule that judges different kinds of matches
 *    with different confidence), or step 7 has just reframed its reason as
 *    advice. Every adapter emits a nudge as advice the call proceeds
 *    through — the agent reads it as context and the developer sees it as a
 *    system message, never a permission prompt — because even on a host with
 *    a native `ask`, a nudge that fires once per call inside a fan-out of
 *    subagents turns into many prompts nobody but a person can answer. An
 *    `ask` WITHOUT this mark is a genuine "look at this before it happens" —
 *    a protected path, a destructive git command, a generated file — and
 *    still blocks everywhere, on every host. See `adapters/claude/dispatch.js`
 *    and `adapters/codex/dispatch.js` for the emission side on each host.
 *
 * @param {object} ctx The evaluation context, as built by
 * `lib/context.js#buildContext`.
 * @param {{rules?: object[], diagnostics?: object[], now?: number, presetsDir?: string, classifyChange?: Function}} [options]
 * `rules` overrides the default registry, mainly for tests; `diagnostics`
 * collects `{ruleId, error}` for rules that threw; `now` is the clock an
 * approval's expiry is checked against, defaulting to `Date.now()` — tests
 * inject it so the same context always produces the same decision;
 * `presetsDir` overrides the default stack-preset location, mainly for
 * tests; `classifyChange` overrides `lib/change-scope.js#classifyChange`,
 * mainly for tests that want the `newCodeOnly` softening step (7) without a
 * real git repository.
 * @returns {null | {action: string, reason: string, fix?: string, ruleId: string}}
 * The winning decision, or `null` when nothing has anything to say.
 */
function evaluate(ctx, options = {}) {
  const diagnostics = options.diagnostics;
  const presetCtx = withEffectivePreset(ctx, options);
  const ruleSet = options.rules || defaultRules();
  const candidates = ruleSet.filter((rule) => applies(rule, presetCtx));

  /**
   * The `newCodeOnly` softening step (7) needs to know whether the target
   * file already existed before this write, but resolving that shells out
   * to git — so it is computed at most once here, and only when a candidate
   * rule could actually use the answer. A shell-only context (`filePath`
   * empty) or a candidate set with no rule that wants the answer in it never
   * pays for the shell-out at all.
   *
   * Two kinds of rule want it, and they point in opposite directions. A
   * `newCodeOnly` rule never reads `changeScope` itself — step 7 applies it
   * on the rule's behalf, softening a structural expectation for code that
   * predates the standard. A `readsChangeScope` rule reads
   * `ctx.changeScope` in its own `evaluate` and decides for itself, which is
   * what a rule needs when pre-existence is the very thing that makes a
   * write wrong rather than the thing that excuses it
   * (`guards/immutable-migrations.js`). Declaring `readsChangeScope` buys
   * only the computed value; it triggers no softening of its own.
   */
  const classifyFn = typeof options.classifyChange === "function" ? options.classifyChange : classifyChange;
  const needsChangeScope =
    Boolean(presetCtx.filePath) &&
    candidates.some((rule) => rule.newCodeOnly === true || rule.readsChangeScope === true);
  const changeScope = needsChangeScope ? classifyFn(presetCtx.filePath, presetCtx.git) : null;
  const effectiveCtx = { ...presetCtx, changeScope };

  const target = effectiveCtx.command || effectiveCtx.filePath || "";
  const now = typeof options.now === "number" ? options.now : Date.now();

  let best = null;

  for (const rule of candidates) {
    if (approvals.isApproved(rule.id, { agent: effectiveCtx.agent, now })) continue;

    let result;
    try {
      result = rule.evaluate(effectiveCtx);
    } catch (error) {
      if (Array.isArray(diagnostics)) diagnostics.push({ ruleId: rule.id, error });
      continue;
    }
    if (!result) continue;

    /**
     * RULES.md states `defaultAction` as the strongest action a rule may
     * ever return, and that the engine clamps it if it tries to exceed its
     * own declaration. This is that clamp — applied before the project
     * config or the developer override sees the result, so neither of those
     * tiers can be blamed for a rule that simply lied about its own ceiling.
     */
    let action = clamp(result.action, rule.defaultAction);
    let reason = result.reason;

    if (!rule.mandatory) {
      const projectSwitch = resolveProjectRuleSwitch(effectiveCtx.project, rule);
      if (projectSwitch) action = projectSwitch.action;
    }

    /**
     * A `mandatory` rule ignores this too, for the same reason it ignores
     * the project switch and the developer override (§6/§8): it is the one
     * rule immune to every softening tier this engine has. Every other
     * `newCodeOnly` rule, on a file `changeScope` proved already existed,
     * is capped at `"ask"` and its reason is reframed as advice — never
     * strengthened, only softened, and only when the target file's
     * pre-existence was actually established.
     */
    let advisory = rule.advisoryAsk === true || result.advisory === true;
    if (!rule.mandatory && rule.newCodeOnly === true && changeScope === "existing") {
      action = clamp(action, "ask");
      reason = `${NEW_CODE_ONLY_ADVICE_PREFIX}\n\n${reason}`;
      // The step above has just reframed this decision as advice in so many
      // words. Recording that on the decision itself is what lets a host
      // with no interactive ask act on it — see `best.advisory` below.
      advisory = true;
    }

    const override =
      !rule.mandatory && effectiveCtx.overrides && typeof effectiveCtx.overrides.forRule === "function"
        ? effectiveCtx.overrides.forRule(rule.id)
        : null;

    if (override && Array.isArray(override.allow) && target) {
      if (override.allow.some((re) => re.test(target))) continue;
    }

    if (override && override.action !== undefined) action = clamp(action, override.action);
    if (severity(action) === 0) continue;

    if (!best || severity(action) > severity(best.action)) {
      best = { action, reason, ruleId: rule.id };
      if (result.fix !== undefined) best.fix = result.fix;
      // Only ever meaningful on an `ask`: a `deny` blocks on every host, and
      // an override that raised a nudge to a denial is a deliberate
      // strengthening this flag must not quietly undo.
      if (advisory && action === "ask") best.advisory = true;
    }
  }

  return best;
}

module.exports = { evaluate, applicableRules, ruleRegistryStatus };
