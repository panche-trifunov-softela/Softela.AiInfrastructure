"use strict";

/**
 * Denies a domain event written to the outbox outside the transaction that
 * carries the data change it describes.
 *
 * An outbox exists for exactly one reason: the row and the event commit
 * together or neither does. Insert the event after the commit and there is
 * a window — short, real, and hit under load rather than in testing — where
 * the write has landed and the event never will, so nothing downstream ever
 * learns the change happened. Insert it with no transaction at all and the
 * guarantee was never there to begin with. Both are silently wrong results
 * rather than failures, which is what puts this rule at `deny`
 * (`docs/internal/RULES.md`'s own bar for the strongest action).
 *
 * SEEING THE WHOLE FILE, OR DECLINING TO JUDGE
 *
 * This rule cannot work from the inserted text alone. A plain `Edit` that
 * adds one outbox line reports only that line as `ctx.content` — the
 * surrounding `BeginTransactionAsync` is elsewhere in the file and simply
 * not visible — so judging the fragment would deny correct code every time
 * somebody edited a perfectly good handler. That is the failure mode that
 * gets a rule switched off.
 *
 * So the file is reconstructed, in the first way available:
 *
 * 1. `ctx.resultingContent` — the whole file after the write, set for every
 *    decoded multi-part write (`core/lib/context.js`).
 * 2. `ctx.content`, when the tool writes a whole file by definition.
 * 3. The on-disk text plus the inserted text, for a plain `Edit`, where the
 *    two fields never disagree but only the fragment is reported.
 *
 * The ordering check — the event written AFTER the commit — needs true
 * positions in a single coherent text, which the concatenation in (3) does
 * not give. It therefore runs only under (1) and (2); under (3) the rule
 * still catches the commoner and worse case, an outbox insert with no
 * transaction anywhere in the file.
 *
 * Every pattern is `ctx.project.conventions.transactions` — how an outbox
 * insert, a begin and a commit are spelled belongs to a service's own
 * template, never to guard code.
 */

const { deny, pass } = require("../lib/decision");
const { compile } = require("../lib/safe-regexp");
const { globToRegex } = require("../lib/project-resolver");

/** Tool names this rule treats as a file write. */
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/;

/** Tools whose payload is the whole file by construction. */
const WHOLE_FILE_TOOLS = /^(Write|write_file)$/;

/** Only C# sources carry a handler. */
const SOURCE_FILE = /\.cs$/i;

/**
 * Reconstructs the file as it will end up, and reports whether the result
 * is positionally coherent.
 *
 * @param {object} ctx The evaluation context.
 * @returns {{text: string, ordered: boolean}} `text` is the fullest view
 * available; `ordered` is `true` only when offsets within it are real.
 */
function wholeFile(ctx) {
  if (typeof ctx.resultingContent === "string") return { text: ctx.resultingContent, ordered: true };
  if (WHOLE_FILE_TOOLS.test(ctx.toolName)) return { text: String(ctx.content || ""), ordered: true };

  let onDisk = null;
  try {
    onDisk = ctx.readFile ? ctx.readFile(ctx.filePath) : null;
  } catch {
    onDisk = null;
  }
  const existing = typeof onDisk === "string" ? onDisk : "";
  return { text: `${existing}\n${String(ctx.content || "")}`, ordered: false };
}

/**
 * Resolves the first index at which a pattern matches.
 *
 * @param {RegExp} re The compiled pattern.
 * @param {string} text The text to search.
 * @returns {number} The index, or `-1`.
 */
function firstIndex(re, text) {
  const scoped = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  scoped.lastIndex = 0;
  const match = scoped.exec(text);
  return match ? match.index : -1;
}

/**
 * Resolves the last index at which a pattern matches.
 *
 * @param {RegExp} re The compiled pattern.
 * @param {string} text The text to search.
 * @returns {number} The index, or `-1`.
 */
function lastIndex(re, text) {
  const scoped = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  scoped.lastIndex = 0;
  let found = -1;
  let match;
  while ((match = scoped.exec(text))) {
    found = match.index;
    if (match.index === scoped.lastIndex) scoped.lastIndex += 1;
  }
  return found;
}

module.exports = {
  id: "transactional-outbox",
  title: "A domain event is written inside the transaction it belongs to",
  events: ["PreToolUse"],
  tools: FILE_TOOLS,
  defaultAction: "deny",
  group: "code",

  /** backend-only: the outbox and its unit of work are a backend pattern */
  stacks: ["backend"],

  requiresConfig: ["conventions.transactions.outboxInsert", "conventions.transactions.beginTransaction"],
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix: string}} The
   * decision, or `null` when nothing configured applies.
   */
  evaluate(ctx) {
    const cfg = ctx.project && ctx.project.conventions && ctx.project.conventions.transactions;
    if (!cfg || !ctx.filePath || !SOURCE_FILE.test(ctx.filePath)) return pass();

    const insertRe = compile(cfg.outboxInsert);
    const beginRe = compile(cfg.beginTransaction);
    if (!insertRe || !beginRe) return pass();

    if (typeof cfg.scope === "string" && cfg.scope) {
      const scopeRe = globToRegex(cfg.scope.replace(/\\/g, "/").replace(/^\.?\/+/, ""));
      if (scopeRe && !scopeRe.test(String(ctx.filePath).replace(/\\/g, "/"))) return pass();
    }

    // Only a write that actually introduces an outbox insert is judged; an
    // edit elsewhere in a handler that already had one is not this rule's
    // business.
    if (firstIndex(insertRe, String(ctx.content || "")) === -1) return pass();

    const { text, ordered } = wholeFile(ctx);

    if (firstIndex(beginRe, text) === -1) {
      return deny(
        "This handler writes a domain event to the outbox but opens no transaction, so the event and the data change it describes cannot commit together.",
        "Wrap the repository write and the outbox insert in the unit of work: begin, then commit inside the try and roll back and rethrow in the catch.",
      );
    }

    const commitRe = compile(cfg.commit);
    if (ordered && commitRe) {
      const commitAt = firstIndex(commitRe, text);
      const insertAt = lastIndex(insertRe, text);
      if (commitAt !== -1 && insertAt > commitAt) {
        return deny(
          "This handler writes to the outbox after the transaction has already committed, so a failure between the two loses the event while keeping the data change.",
          "Move the outbox insert above the commit, so the row and the event land in the same transaction.",
        );
      }
    }

    return pass();
  },
};
