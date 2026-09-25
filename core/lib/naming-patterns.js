"use strict";

/**
 * The naming shapes `docs/standards/naming.md` defines, in one place.
 *
 * More than one rule has to answer "is this name a component, a hook, or a
 * context?" — `naming-standards` to judge a file's own name,
 * `colocated-tests` to work out whether a spec's subject is a component
 * folder or one of the modules a component folder owns. Two copies of the
 * same pattern would be two things to keep in step with the standard, so
 * they live here and are imported.
 */

/** A React component and its file: `OrderPanel`. */
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

/** A hook: camelCase behind a `use` prefix — `useOrderPersistence`. */
const HOOK_NAME = /^use[A-Z][A-Za-z0-9]*$/;

/**
 * A hook's own file: `HOOK_NAME`'s shape plus the extension a file carries —
 * `useOrderPersistence.ts`, `useOrderPersistence.tsx`, and, since Softela's
 * own target repositories include plain-JavaScript React apps alongside
 * TypeScript ones, `useOrderPersistence.js` and `useOrderPersistence.jsx`
 * too. A hook takes the `x` extensions only when it genuinely returns JSX,
 * so all four belong here.
 *
 * The uppercase letter after `use` is load-bearing rather than cosmetic. A
 * looser `use[A-Za-z0-9_]` also matches `usedFieldsPanel.tsx` and
 * `userProfileCard.tsx` — ordinary camelCase views that happen to begin with
 * the English words "used" and "user". Where that answer only decides a
 * nudge it is a tolerable miss; where it decides whether a file may cross a
 * layer boundary, it is a hole.
 */
const HOOK_FILE_NAME = /^use[A-Z][A-Za-z0-9]*\.[jt]sx?$/;

/** A context: PascalCase behind a `Context` suffix — `OrderPanelContext`. */
const CONTEXT_NAME = /^[A-Z][A-Za-z0-9]*Context$/;

/**
 * Reports whether a name is shaped like a React component.
 *
 * Almost everything else a component folder holds — its hook, its utilities,
 * its constants — is camelCase, so this is close to the test for "not a
 * component". The exception is the context `isContextName` covers.
 *
 * @param {string} name The bare name, with no extension or dotted qualifier.
 * @returns {boolean} Whether the name is PascalCase.
 */
function isComponentName(name) {
  return typeof name === "string" && PASCAL_CASE.test(name);
}

/**
 * Reports whether a name is shaped like a context.
 *
 * A context is the one thing a component folder holds that is PascalCase
 * without being a component, which is why it needs a shape of its own
 * instead of falling out of `isComponentName` being false.
 *
 * @param {string} name The bare name, with no extension or dotted qualifier.
 * @returns {boolean} Whether the name is PascalCase behind a `Context` suffix.
 */
function isContextName(name) {
  return typeof name === "string" && CONTEXT_NAME.test(name);
}

/**
 * Reports whether a file's own name is a hook's file.
 *
 * Takes the basename rather than the bare name the other two answer on: the
 * extension is part of what makes a file a hook's file rather than a view's,
 * so stripping it first would throw away half the question.
 *
 * @param {string} fileName The file's own basename, extension included.
 * @returns {boolean} Whether the file is a hook's.
 */
function isHookFileName(fileName) {
  return typeof fileName === "string" && HOOK_FILE_NAME.test(fileName);
}

module.exports = {
  PASCAL_CASE,
  HOOK_NAME,
  HOOK_FILE_NAME,
  CONTEXT_NAME,
  isComponentName,
  isContextName,
  isHookFileName,
};
