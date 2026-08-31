"use strict";

/**
 * Denies a backend patch manifest that declares a database change with no
 * corresponding required entry — the shape of deployment that fails halfway,
 * after the database side has already run.
 *
 * Every fact this rule needs is read from `ctx.project.patchManifest`: which
 * file counts as a patch manifest, how a declared database change is
 * recognised in its content, and the name of the entry that must accompany
 * each one. The wiki pages describing this process reference project paths
 * that could not be verified against the real repository, so nothing about
 * the manifest's actual shape — its file format, its section names, its
 * nesting — is assumed here. A project that has not configured this section
 * is one this rule has nothing to check, and it stays silent.
 *
 * THE RATCHET — a changed-region primitive, not an identity
 *
 * Three earlier versions of this ratchet tried to identify individual
 * declarations across an edit — a `Set` of opening-tag text, then a multiset
 * of per-identity occurrence counts, then per-identity paired/unpaired
 * deltas — so a pre-existing violation could be told apart from a
 * newly-introduced one. Every one of those schemes has a symmetric blind
 * spot, because the manifest carries no identifier a declaration can
 * actually be tracked by:
 *
 * - a bare-count ratchet: repairing one pre-existing gap while opening a
 *   different one nets flat and passes;
 * - a `Set`-of-identity ratchet: two declarations sharing identical
 *   opening-tag text — the ordinary shape once `databasePattern` is a
 *   bare literal with no capturing group, not an exotic one — collapse into
 *   one entry, so a second, genuinely new one with the same text is
 *   invisible;
 * - a multiset (per-identity count) ratchet: the same collapse one level up
 *   — repair one occurrence of an identity while adding a different, new
 *   occurrence of the SAME identity, and the count is unchanged;
 * - a per-identity paired/unpaired-delta ratchet: a compliant NEW
 *   declaration sharing an identity with a pre-existing, already-forgiven
 *   unpaired one is misread as "repairing" that old one, spending
 *   forgiveness budget the old declaration still needed and false-denying
 *   it for a violation this write never touched.
 *
 * This version never identifies a declaration at all. It asks a different
 * question — did THIS WRITE touch the text a declaration begins in? —
 * which needs no identity to answer:
 *
 * - {@link computeChangedRegion} computes a real LCS-based line diff between
 *   the on-disk text and the resulting content, then takes the SPAN from the
 *   first line that diff marks changed to the last one; what falls between
 *   is the CHANGED REGION, contiguous and line-granular.
 * - A declaration is judged when its own opening tag OVERLAPS that region —
 *   any line the tag itself spans, or simply sitting inside a region widened
 *   by edits elsewhere (see CONSEQUENCE below). One that neither overlaps
 *   nor sits inside existed before this write and this write never went
 *   near it — forgiven, whatever its text or however many other
 *   declarations happen to share it.
 *
 * No identity is computed, so no two declarations can ever collide by
 * sharing one, and repairing one can never spend forgiveness a different
 * declaration still needs — each declaration's own fate is decided by
 * where ITS OWN text sits, never by what happened to a declaration that
 * merely looks like it.
 *
 * ALIGNMENT — why a real diff, and not a prefix/suffix trim
 *
 * An earlier version of this primitive computed the region by trimming the
 * common leading lines and the common trailing lines shared between the two
 * texts — a two-pointer walk advancing purely on line-text equality, with no
 * notion of which line actually corresponds to which. That is
 * alignment-blind, and it has a severe failure: when an inserted
 * declaration's own opening-tag line happens to be byte-identical to
 * whatever line already sat at that same index — trivially true whenever the
 * same table name recurs, the ordinary shape once `databasePattern` is a
 * bare literal, not an exotic one — the prefix walk marches straight through
 * the new declaration and stops only at the first REAL difference further
 * down. The new declaration's start then falls BEFORE the region it should
 * have widened, so it is never judged, and a genuinely new database change
 * with no upgrade script ships undetected.
 *
 * A real LCS alignment does not have this hole in the way the trim did, but
 * a single arbitrary LCS alignment has a subtler version of it: two
 * declarations with byte-identical opening tags make the alignment
 * AMBIGUOUS — either occurrence could be "the" one matched to the old line —
 * and a plain backtrack has to guess one. Whichever way it guesses can be
 * wrong: guess "earliest occurrence matches" and a duplicate inserted AFTER
 * the original is the one wrongly forgiven; guess "latest occurrence
 * matches" and a duplicate inserted BEFORE the original is wrongly forgiven
 * instead — and unlike the reviewer's severe case, this is not something a
 * cleverer tie-break direction can fix, because either direction is exactly
 * right for one insertion side and exactly wrong for the other. Nothing
 * about which occurrence is textually "the new one" is recoverable from the
 * text alone.
 *
 * {@link computeMatchedLines} sidesteps the guess rather than trying to win
 * it: a new line counts as matched (trustworthy, unchanged) only when it is
 * matched in EVERY maximum-length alignment, not merely in the one a
 * backtrack happens to produce. Concretely, that means excluding the line
 * from `newLines` entirely must make the best achievable alignment strictly
 * worse — computed from the standard forward/backward LCS split used by
 * Hirschberg's algorithm, not a second full alignment per line. When two
 * declarations share identical text, EITHER could be excluded without
 * costing the alignment anything, so BOTH are judged, not just one — the
 * same conservative direction as CONSEQUENCE below, applied to the
 * alignment itself rather than only to the resulting span.
 *
 * The same alignment also closes a second, narrower finding: an opening tag
 * that spans multiple lines can have an edit that touches only one of its
 * later lines, not its first. A region test keyed only to a declaration's
 * own start offset can miss that — the first line may sit before the region
 * even though a later line of the very same tag sits inside it. Testing the
 * tag's full range for overlap with the region, rather than only its start
 * offset, judges it correctly either way.
 *
 * A plain deletion — old lines removed with nothing put back in their
 * place — has zero width in the resulting content, so it cannot appear as
 * an unmatched line the way an insertion or an edit does; a diff that only
 * tracked unmatched new lines would let a required entry vanish invisibly
 * whenever nothing else on that side of the edit moved. {@link
 * computeMatchedLines} also marks the exact gap a deletion happened at, and
 * {@link computeChangedRegion} folds those gaps into the same span, so a
 * declaration that loses its required entry to a deletion is judged exactly
 * like one that loses it to an edit.
 *
 * CONSEQUENCE — a scattered edit widens the region
 *
 * The region is the SPAN between the first and last changed line, not the
 * union of the individual changed lines, so an edit touching both the top
 * and the bottom of a large manifest widens the region to nearly the whole
 * file — every declaration in between is judged even though most of that
 * stretch is untouched. This is deliberate, not a bug to "fix" by computing
 * a sparser diff: judging a few extra untouched declarations is the
 * conservative, honest direction for a rule whose entire purpose is proving
 * a database change ships with its upgrade script, and per-hunk reasoning is
 * exactly the kind of cleverness that let a declaration slip through every
 * identity-based ratchet before this one.
 *
 * CEILING — bounding the diff's own cost
 *
 * {@link computeMatchedLines} runs three O(n·m) passes over the same
 * (n+1)×(m+1) grid — the backward LCS table, the forward LCS table, and the
 * per-line "does excluding it cost anything" scan the "necessarily matched"
 * check above needs — not the single pass a plain LCS would take. Manifests
 * are small in the ordinary case, but a `PreToolUse` hook has a 5-second
 * budget shared with everything else that runs in it, and a pathological
 * input must not spend that budget on this one comparison.
 * {@link computeChangedRegion} bounds each side to `LINE_COUNT_CEILING`
 * (2000) lines; past that, it falls back to judging the whole resulting
 * content, exactly the same conservative direction as "no on-disk baseline"
 * below — and the denial reason says so, for the same reason that case's
 * reason does. 2000 lines a side, measured end to end through the real rule
 * on an ordinary cold Node process, costs roughly 250-260ms — about 5% of
 * the 5-second budget, with every other rule in the same hook invocation
 * still to run. That is comfortable headroom, not a close call: a real
 * patch manifest is nowhere near 2000 lines, so the ceiling is sized to be
 * generous to a legitimately large one while still refusing to let an
 * adversarial input turn this one comparison into the hook's own timeout.
 *
 * EDGE — no on-disk baseline
 *
 * `ctx.readFile(ctx.filePath)` returns `null` both for a file that does not
 * exist yet (a brand-new manifest) and for one that exists but could not be
 * read (a permission failure, a sandbox boundary) — the two are
 * indistinguishable from here. Either way the whole resulting content
 * becomes the changed region, so every declaration is judged: correct for a
 * brand-new file, since there is nothing yet to forgive, and the
 * conservative, fail-toward-block direction for an unreadable one (`docs/
 * internal/CONTRACTS.md` §7a) rather than silently trusting a file this rule
 * could not actually see. The denial reason states that the whole file was
 * judged and why, rather than leaving a developer to wonder why an
 * apparently untouched declaration was reported.
 *
 * LINE ENDINGS
 *
 * `core/lib/fs-safe.js#readText` normalises every on-disk read to `\n`. The
 * resulting content reaching this rule — a decoded write, or a Codex
 * `apply_patch` reconstruction — carries no such guarantee, so it is
 * normalised the same way before either side of the region comparison runs;
 * otherwise a lone CRLF/LF difference on an otherwise-untouched line would
 * read as a change and widen the region for no real reason.
 */

const { compile } = require("../lib/safe-regexp");
const { deny, pass } = require("../lib/decision");

/**
 * Escapes a literal string for safe embedding inside a regular expression.
 *
 * @param {string} text The literal text.
 * @returns {string} `text` with every regex-special character escaped.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reads and validates the project's patch-manifest configuration.
 *
 * @param {object} project `ctx.project`.
 * @returns {null | {filePattern: RegExp, databasePattern: RegExp, requiredEntry: string}}
 * The compiled configuration, or `null` when it is absent or malformed.
 */
function readConfig(project) {
  const cfg = project && project.patchManifest;
  if (!cfg) return null;
  if (typeof cfg.filePattern !== "string" || typeof cfg.databasePattern !== "string") return null;
  if (typeof cfg.requiredEntry !== "string" || !cfg.requiredEntry.trim()) return null;

  const filePattern = compile(cfg.filePattern);
  const databasePattern = compile(cfg.databasePattern, "gi");
  if (!filePattern || !databasePattern) return null;

  return { filePattern, databasePattern, requiredEntry: cfg.requiredEntry };
}

/**
 * Normalises line endings to `\n`, matching `core/lib/fs-safe.js#readText` so
 * a CRLF/LF difference between the on-disk baseline and the resulting
 * content is never mistaken for a real change.
 *
 * @param {string} text The text to normalise.
 * @returns {string} `text` with every `\r\n` replaced by `\n`.
 */
function normaliseLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Finds the full span of every declared database change's own opening tag in
 * the manifest text.
 *
 * @param {string} content The manifest content.
 * @param {RegExp} databasePattern A global regex marking each declaration.
 * @returns {{start: number, end: number}[]} Each match's own half-open
 * character range `[start, end)`, in order — `end` is the offset right after
 * the tag's own closing `>`, which can sit on a later line than `start` for
 * a tag spread across several lines.
 */
function findDeclarations(content, databasePattern) {
  const re = new RegExp(databasePattern.source, databasePattern.flags.includes("g") ? databasePattern.flags : `${databasePattern.flags}g`);
  const spans = [];
  let m;
  while ((m = re.exec(content))) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return spans;
}

/**
 * Analyses a manifest's own declared database changes, pairing each
 * declaration with the text window up to the next declaration (or the end of
 * the document) to decide whether it carries its own required entry.
 *
 * @param {string} content The manifest content.
 * @param {RegExp} databasePattern A global regex marking each declaration.
 * @param {RegExp} requiredRe Matches the required entry's own open tag.
 * @returns {{start: number, end: number, paired: boolean}[]} One entry per
 * declaration found, in document order — `start`/`end` are its own opening
 * tag's half-open character range in `content`, `paired` is whether its own
 * window carries the required entry.
 */
function analyzeDeclarations(content, databasePattern, requiredRe) {
  const spans = findDeclarations(content, databasePattern);
  return spans.map((span, i) => {
    const windowEnd = i + 1 < spans.length ? spans[i + 1].start : content.length;
    return { start: span.start, end: span.end, paired: requiredRe.test(content.slice(span.start, windowEnd)) };
  });
}

/**
 * Computes each line's own start offset within a text already split on
 * `"\n"`.
 *
 * @param {string[]} lines The text's own lines, in `String.prototype.split("\n")` order.
 * @returns {number[]} `starts[i]` is the character offset line `i` begins at.
 */
function lineStartOffsets(lines) {
  const starts = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = offset;
    offset += lines[i].length + 1;
  }
  return starts;
}

/**
 * Line-count bound on either side of {@link computeChangedRegion}'s own
 * LCS diff — see this module's own top-of-file doc comment ("CEILING") for
 * the measured cost this was picked against.
 */
const LINE_COUNT_CEILING = 2000;

/**
 * Computes a line-level LCS alignment between `oldLines` and `newLines` — a
 * full O(n·m) dynamic-programming LCS, not a positional walk. See this
 * module's own top-of-file doc comment ("ALIGNMENT") for why a real
 * alignment is required here rather than a two-pointer trim, and why
 * `matched[j]` is decided by whether `newLines[j]` is REQUIRED by every
 * maximum alignment rather than by picking one arbitrary alignment: a single
 * backtrack can call either side of a byte-identical pair "the match", and
 * whichever guess it makes can be wrong in either direction depending on
 * which side of the pair is the one actually inserted.
 *
 * @param {string[]} oldLines The on-disk text's own lines.
 * @param {string[]} newLines The resulting content's own lines.
 * @returns {{matched: Uint8Array, cut: Uint8Array}} `matched[j] === 1` when
 * every maximum-length alignment matches `newLines[j]` to some old line —
 * trustworthy as unchanged only then. `0` when this write changed or
 * inserted it, OR when some equally-valid alignment could leave it
 * unmatched — an ambiguous line is judged the conservative way, same as
 * everything else this rule stays deliberately conservative about. `cut[g]
 * === 1` when an old line was deleted with nothing inserted in its place,
 * right at the gap before `newLines[g]` (`g === newLines.length` for a
 * deletion at the very end) — a plain deletion has zero width in
 * `newLines`, so it cannot show up as an unmatched line the way an
 * insertion or edit does, and would otherwise vanish from the region
 * entirely.
 */
function computeMatchedLines(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const stride = m + 1;

  // suf[i*stride+j] is the LCS length of oldLines[i:] and newLines[j:].
  const suf = new Int32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * stride;
    const nextRow = (i + 1) * stride;
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        suf[row + j] = suf[nextRow + j + 1] + 1;
      } else {
        const skipOld = suf[nextRow + j];
        const skipNew = suf[row + j + 1];
        suf[row + j] = skipOld > skipNew ? skipOld : skipNew;
      }
    }
  }
  const total = suf[0];

  // pre[i*stride+j] is the LCS length of oldLines[0:i] and newLines[0:j] —
  // together with suf, this is enough to compute, for any single new line,
  // the best score reachable while excluding that one line entirely: split
  // oldLines at some position i, match old[0:i] against new[0:j] (pre) and
  // old[i:] against new[j+1:] (suf), and maximise over every split. That is
  // the standard LCS split identity Hirschberg's algorithm relies on.
  const pre = new Int32Array((n + 1) * stride);
  for (let i = 1; i <= n; i++) {
    const row = i * stride;
    const prevRow = (i - 1) * stride;
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        pre[row + j] = pre[prevRow + j - 1] + 1;
      } else {
        const skipOld = pre[prevRow + j];
        const skipNew = pre[row + j - 1];
        pre[row + j] = skipOld > skipNew ? skipOld : skipNew;
      }
    }
  }

  const matched = new Uint8Array(m);
  for (let j = 0; j < m; j++) {
    let bestExcludingJ = 0;
    for (let i = 0; i <= n; i++) {
      const score = pre[i * stride + j] + suf[i * stride + j + 1];
      if (score > bestExcludingJ) bestExcludingJ = score;
    }
    // Only when leaving this line out actually costs something is matching
    // it required by every optimal alignment — see the doc comment above.
    matched[j] = bestExcludingJ < total ? 1 : 0;
  }

  // Deletion boundaries: any single valid backtrack over `suf` finds them,
  // since over-marking a gap only widens the region — always the safe
  // direction here, unlike matched[] above which must never hide a real
  // insertion behind a coincidentally-equal old line.
  const cut = new Uint8Array(m + 1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (suf[(i + 1) * stride + j] >= suf[i * stride + j + 1]) {
      cut[j] = 1;
      i++;
    } else {
      j++;
    }
  }
  // Old lines left over once newLines is exhausted are a trailing deletion,
  // never visited by the loop above since it stops as soon as j === m.
  if (i < n) cut[j] = 1;
  return { matched, cut };
}

/**
 * Computes the region of `newText` this write actually changed: a real
 * LCS-based line diff against `oldText`, then the SPAN from the first line
 * that diff marks changed to the last one — see this module's own
 * top-of-file doc comment ("THE RATCHET", "ALIGNMENT") for why this replaces
 * both every earlier identity-based scheme and the prefix/suffix trim that
 * replaced them.
 *
 * @param {string} oldText The file's own content on disk, already
 * line-ending-normalised.
 * @param {string} newText The resulting content this write would produce,
 * already line-ending-normalised.
 * @returns {{start: number, end: number, wholeFileFallback: boolean}} The
 * changed region as a half-open character range `[start, end)` into
 * `newText` — empty (`start === end`) when the two texts share every line.
 * `wholeFileFallback` is `true` when either side exceeded
 * {@link LINE_COUNT_CEILING} and the region was widened to the whole of
 * `newText` instead of being diffed.
 */
function computeChangedRegion(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length > LINE_COUNT_CEILING || newLines.length > LINE_COUNT_CEILING) {
    return { start: 0, end: newText.length, wholeFileFallback: true };
  }

  const { matched, cut } = computeMatchedLines(oldLines, newLines);
  const newStarts = lineStartOffsets(newLines);
  /**
   * The character offset of gap `g` between `newLines[g - 1]` and
   * `newLines[g]` — `g === newLines.length` is the very end of `newText`.
   *
   * @param {number} g A gap index in `[0, newLines.length]`.
   * @returns {number} The character offset of that gap in `newText`.
   */
  const gapOffset = (g) => (g < newLines.length ? newStarts[g] : newText.length);

  let start = Infinity;
  let end = -Infinity;
  for (let j = 0; j < matched.length; j++) {
    if (matched[j]) continue;
    const lineStart = gapOffset(j);
    const lineEnd = gapOffset(j + 1);
    if (lineStart < start) start = lineStart;
    if (lineEnd > end) end = lineEnd;
  }
  // A plain deletion has zero width in newText, so it cannot widen the
  // region as an unmatched line would — fold in its own gap offset too, or
  // a required entry removed with nothing put back in its place would leave
  // the declaration it used to pair completely outside the region.
  for (let g = 0; g <= newLines.length; g++) {
    if (!cut[g]) continue;
    const p = gapOffset(g);
    if (p < start) start = p;
    if (p > end) end = p;
  }

  if (start === Infinity) return { start: newText.length, end: newText.length, wholeFileFallback: false };
  return { start, end, wholeFileFallback: false };
}

module.exports = {
  /** kebab-case, unique, equals the filename without .js */
  id: "patch-manifest",

  /** one line, shown by `softela-ai doctor` */
  title: "A declared database change needs its upgrade-script entry",

  /** which host events this rule can fire on */
  events: ["PreToolUse"],

  /** which tool names it applies to; null means every tool */
  tools: /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file)$/,

  /** the strongest action this rule may ever return */
  defaultAction: "deny",

  /** which catalogue group this rule belongs to */
  group: "code",

  /** backend-only: a deployable patch manifest is a backend deployment artefact */
  stacks: ["backend"],

  /** dotted project-config paths this rule needs to be meaningful */
  requiresConfig: ["patchManifest.filePattern", "patchManifest.databasePattern", "patchManifest.requiredEntry"],

  /** optional: only active when this module is enabled */
  requiresModule: null,

  /**
   * @param {object} ctx The evaluation context.
   * @returns {null | {action: "deny", reason: string, fix?: string}} The
   * decision, or `null` when the project has not configured this rule, the
   * file is not a patch manifest, or no unpaired declaration's own opening
   * tag overlaps the region this write actually changed.
   */
  evaluate(ctx) {
    const config = readConfig(ctx.project);
    if (!config) return pass();

    const filePath = String(ctx.filePath || "");
    if (!filePath || !config.filePattern.test(filePath)) return pass();

    // R3: pairing a declared database change with its required entry is
    // inherently a whole-DOCUMENT question — each declaration's own "next
    // declaration, or end of document" window cannot be computed from a
    // decoded MultiEdit's own inserted snippet alone. Falls back to
    // ctx.content when reconstruction failed: a Write/apply_patch add
    // already has content === resultingContent, and an unreconstructable
    // update degrades to pairing only within the inserted snippet — under
    // rather than over-reporting missing entries, the conservative side for
    // a deny-level rule per CONTRACTS §7a's fail-open requirement.
    const rawContent = String(typeof ctx.resultingContent === "string" ? ctx.resultingContent : ctx.content || "");
    if (!rawContent.trim()) return pass();
    const content = normaliseLineEndings(rawContent);

    /**
     * Matched as an element open tag (`<UpgradeScript`), never as a bare
     * substring — a comment or attribute value that merely mentions the
     * entry name must not satisfy a rule whose entire purpose is proving the
     * element itself is present.
     */
    const requiredRe = new RegExp(`<${escapeRegExp(config.requiredEntry)}\\b`, "i");
    const declarations = analyzeDeclarations(content, config.databasePattern, requiredRe);
    const unpaired = declarations.filter((d) => !d.paired);
    if (unpaired.length === 0) return pass();

    // Ratchet against the file as it already is on disk — see this file's
    // own top-of-file doc comment ("THE RATCHET"): a changed-region
    // comparison, not an identity-based one. `onDisk === null` covers both
    // "no file yet" and "exists but unreadable" (see "EDGE" above); either
    // way the whole content becomes the region, so nothing needs forgiving.
    const rawOnDisk = ctx.readFile(ctx.filePath);
    const onDisk = rawOnDisk === null ? null : normaliseLineEndings(rawOnDisk);
    const region =
      onDisk === null ? { start: 0, end: content.length, wholeFileFallback: false } : computeChangedRegion(onDisk, content);

    // Overlap, not a start-offset check: a declaration is judged when its
    // own tag range touches the region at all, so a multi-line tag whose
    // later line is the one this write actually changed is still caught
    // even when its first line sits before the region starts — see
    // "ALIGNMENT" above.
    const newlyUnpaired = unpaired.filter((d) => d.start < region.end && d.end > region.start);
    if (newlyUnpaired.length === 0) return pass();

    let regionNote = "";
    if (onDisk === null) {
      regionNote =
        " The file on disk could not be read for that comparison — either it does not exist yet or it could not " +
        "be opened — so this write's whole content was judged instead of only what changed.";
    } else if (region.wholeFileFallback) {
      regionNote =
        ` This manifest exceeds ${LINE_COUNT_CEILING} lines on one side of the edit, past the line-count ceiling ` +
        "this rule diffs within a hook's time budget — so this write's whole content was judged instead of only " +
        "what changed.";
    }

    return deny(
      `PATCH MANIFEST: ${unpaired.length} of ${declarations.length} declared database change(s) in this manifest ` +
        `has no "${config.requiredEntry}" entry. ${newlyUnpaired.length} of those ${unpaired.length} are counted as ` +
        "new by this write's own comparison against the file on disk: each one's own opening tag touches the text " +
        `this write actually changed, not a stretch neither side touched.${regionNote} A manifest like that deploys ` +
        "the database half of a change with no way to apply the other half.",
      `Add a "${config.requiredEntry}" entry for every declared database change this write introduces or edits ` +
        "that is missing one, before writing this manifest.",
    );
  },
};
