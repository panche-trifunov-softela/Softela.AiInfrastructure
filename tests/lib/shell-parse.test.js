"use strict";

const { suite } = require("../harness");
const {
  START,
  hasCommand,
  gitVerb,
  hasFlag,
  extractQuoted,
  splitStatements,
  splitTokens,
  unwrapNestedShells,
} = require("../../core/lib/shell-parse");

suite("lib/shell-parse", ({ test, eq, ok, deepEq }) => {
  test("START exposes the command-start fragment", () => {
    eq(typeof START, "string");
    ok(new RegExp(`${START}git`).test("git push"));
  });

  /* ------------------------------------------------------------ gitVerb */

  test("gitVerb matches a plain invocation", () => {
    ok(gitVerb("git push origin HEAD", "push"));
  });

  test("gitVerb matches after a compound statement", () => {
    ok(gitVerb("cd x && git push", "push"));
  });

  test("gitVerb matches nested after other separators", () => {
    ok(gitVerb("cd x; git push --force", "push"));
  });

  test("gitVerb tolerates a -c key=value global flag", () => {
    ok(gitVerb("git -c x=y push", "push"));
  });

  test("gitVerb tolerates a -C path global flag", () => {
    ok(gitVerb("git -C /repo push origin HEAD", "push"));
  });

  test("gitVerb tolerates a boolean global flag", () => {
    ok(gitVerb("git --no-pager push", "push"));
  });

  test("gitVerb does not match a pipeline's second stage", () => {
    eq(gitVerb("git log --oneline | head -5", "push"), false);
  });

  test("gitVerb does not match a hyphenated lookalike verb", () => {
    eq(gitVerb("git merge-base HEAD origin/dev-ng", "merge"), false);
  });

  test("gitVerb does not match a quoted mention", () => {
    eq(gitVerb('echo "please run git push later"', "push"), false);
  });

  test("gitVerb does not match a single-quoted mention", () => {
    eq(gitVerb("echo 'never git push from here'", "push"), false);
  });

  test("gitVerb ignores the verb word appearing without git before it", () => {
    eq(gitVerb("echo remember to push your luck", "push"), false);
  });

  test("gitVerb matches when the command word is double-quoted", () => {
    ok(gitVerb('"git" push origin main', "push"));
  });

  test("gitVerb matches when the command word is single-quoted", () => {
    ok(gitVerb("'git' push origin main", "push"));
  });

  test("gitVerb matches when the command word is quoted after a compound statement", () => {
    ok(gitVerb('cd x && "git" push', "push"));
  });

  test("gitVerb matches a partially-quoted command word (quote/bare concatenation)", () => {
    ok(gitVerb('gi"t" push origin main', "push"));
  });

  test("gitVerb still ignores a quoted mention deeper in the line once the command word is unquoted", () => {
    eq(gitVerb('echo "git push" is forbidden', "push"), false);
  });

  /* --------------------------------------------------------- hasCommand */

  test("hasCommand matches a simple invocation", () => {
    ok(hasCommand("npx cypress run", "(?:npx\\s+)?cypress\\s+(?:run|open)"));
  });

  test("hasCommand does not match inside a quoted argument", () => {
    eq(hasCommand('echo "cypress run is forbidden"', "cypress\\s+run"), false);
  });

  test("hasCommand respects a command start after a pipe", () => {
    ok(hasCommand("echo hi | npm install", "npm\\s+install"));
  });

  test("hasCommand does not match a substring mid-word", () => {
    eq(hasCommand("npmrunsomething install", "npm\\s+install"), false);
  });

  test("hasCommand matches when the command word is single-quoted", () => {
    ok(hasCommand("'npm' install left-pad", "npm\\s+(?:install|i)"));
  });

  test("hasCommand matches when the command word is double-quoted, PowerShell call-operator style", () => {
    ok(hasCommand('& "softela-ai" approve infra-self-protection', "softela-ai\\s+approve"));
  });

  test("hasCommand still ignores a quoted argument once the command word is unquoted", () => {
    eq(hasCommand('echo "cypress run is forbidden"', "cypress\\s+run"), false);
  });

  /* -------------------------------------------------------------- hasFlag */

  test("hasFlag finds a flag", () => {
    ok(hasFlag("git pull --rebase origin dev-ng", "--rebase"));
  });

  test("hasFlag is absent when the flag is missing", () => {
    eq(hasFlag("git pull origin dev-ng", "--rebase"), false);
  });

  test("hasFlag ignores a flag mentioned inside quotes", () => {
    eq(hasFlag('git commit -m "use --force next time"', "--force"), false);
  });

  /* --------------------------------------------------------- extractQuoted */

  test("extractQuoted reads a double-quoted value", () => {
    eq(extractQuoted('git commit -m "Fix the thing"', /-m\s*/), "Fix the thing");
  });

  test("extractQuoted reads a single-quoted value", () => {
    eq(extractQuoted("git commit -m 'Fix the thing'", /-m\s*/), "Fix the thing");
  });

  test("extractQuoted unescapes double-quoted escapes", () => {
    eq(extractQuoted('git commit -m "say \\"hi\\""', /-m\s*/), 'say "hi"');
  });

  test("extractQuoted returns null when the flag is absent", () => {
    eq(extractQuoted('git commit --amend', /-m\s*/), null);
  });

  test("extractQuoted returns null when the value is not quoted", () => {
    eq(extractQuoted("git commit -m fixup", /-m\s*/), null);
  });

  test("extractQuoted accepts a plain string pattern", () => {
    eq(extractQuoted('git commit -m "hello"', "-m\\s*"), "hello");
  });

  /* ------------------------------------------------------- splitStatements */

  test("splitStatements splits on semicolons", () => {
    deepEq(splitStatements("git status; git push"), ["git status", "git push"]);
  });

  test("splitStatements splits on &&", () => {
    deepEq(splitStatements("cd x && git push"), ["cd x", "git push"]);
  });

  test("splitStatements splits on ||", () => {
    deepEq(splitStatements("git push || echo failed"), ["git push", "echo failed"]);
  });

  test("splitStatements splits on newlines", () => {
    deepEq(splitStatements("git status\ngit push"), ["git status", "git push"]);
  });

  test("splitStatements ignores separators inside double quotes", () => {
    deepEq(splitStatements('git commit -m "a; b && c"'), ['git commit -m "a; b && c"']);
  });

  test("splitStatements ignores separators inside single quotes", () => {
    deepEq(splitStatements("git commit -m 'a && b'"), ["git commit -m 'a && b'"]);
  });

  test("splitStatements drops empty statements", () => {
    deepEq(splitStatements("git push;;  "), ["git push"]);
  });

  /* ------------------------------------------------- unwrapNestedShells */

  test("unwrapNestedShells unwraps a double-quoted bash -c argument", () => {
    eq(unwrapNestedShells('bash -c "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps a single-quoted argument", () => {
    eq(unwrapNestedShells("sh -c 'git push origin dev-ng'"), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps zsh -c", () => {
    eq(unwrapNestedShells('zsh -c "git status"'), "git status");
  });

  test("unwrapNestedShells unwraps dash -c", () => {
    eq(unwrapNestedShells('dash -c "git status"'), "git status");
  });

  test("unwrapNestedShells unwraps powershell -Command", () => {
    eq(unwrapNestedShells('powershell -Command "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps powershell -c, the short spelling", () => {
    eq(unwrapNestedShells('powershell -c "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps pwsh -Command", () => {
    eq(unwrapNestedShells('pwsh -Command "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps cmd /c", () => {
    eq(unwrapNestedShells('cmd /c "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps cmd /k", () => {
    eq(unwrapNestedShells('cmd /k "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps env setting a variable ahead of sh -c", () => {
    eq(unwrapNestedShells('env FOO=bar sh -c "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps a bare eval with a quoted argument", () => {
    eq(unwrapNestedShells('eval "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps an eval with an unquoted single-token argument", () => {
    eq(unwrapNestedShells("eval some-alias"), "some-alias");
  });

  test("unwrapNestedShells unwraps an unquoted single-token bash -c argument", () => {
    eq(unwrapNestedShells("bash -c some-alias"), "some-alias");
  });

  test("unwrapNestedShells peels through two layers of nesting", () => {
    eq(unwrapNestedShells('bash -c "bash -c \\"git push origin dev-ng\\""'), "git push origin dev-ng");
  });

  test("unwrapNestedShells returns null for an ordinary command", () => {
    eq(unwrapNestedShells("git push origin dev-ng"), null);
  });

  test("unwrapNestedShells returns null when the wrapper carries no argument at all", () => {
    eq(unwrapNestedShells("bash -c"), null);
  });

  test("unwrapNestedShells does not read a wrapper name mentioned inside a quoted argument", () => {
    eq(unwrapNestedShells('echo "run bash -c to test"'), null);
  });

  test("unwrapNestedShells unescapes a double-quoted argument's escapes", () => {
    eq(unwrapNestedShells('bash -c "echo \\"hi\\""'), 'echo "hi"');
  });

  test("unwrapNestedShells unwraps Invoke-Expression", () => {
    eq(unwrapNestedShells('Invoke-Expression "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells unwraps its alias, iex", () => {
    eq(unwrapNestedShells('iex "git push origin dev-ng"'), "git push origin dev-ng");
  });

  test("unwrapNestedShells does not read Invoke-Expression mentioned inside a quoted argument", () => {
    eq(unwrapNestedShells('echo "run Invoke-Expression to test"'), null);
  });

  /* ------------------------------------ splitStatements: nested shells */

  test("splitStatements includes both the wrapped statement and its unwrapped inner statement", () => {
    deepEq(splitStatements('bash -c "git push origin dev-ng"'), [
      'bash -c "git push origin dev-ng"',
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a PowerShell -Command wrapper", () => {
    deepEq(splitStatements('powershell -Command "git pull"'), [
      'powershell -Command "git pull"',
      "git pull",
    ]);
  });

  test("splitStatements unwraps cmd /c", () => {
    deepEq(splitStatements('cmd /c "git status"'), ['cmd /c "git status"', "git status"]);
  });

  test("splitStatements unwraps env ahead of sh -c", () => {
    deepEq(splitStatements('env FOO=bar sh -c "git status"'), [
      'env FOO=bar sh -c "git status"',
      "git status",
    ]);
  });

  test("splitStatements splits a compound statement hidden inside a wrapper into its own entries", () => {
    deepEq(splitStatements('bash -c "git status && git push origin dev-ng"'), [
      'bash -c "git status && git push origin dev-ng"',
      "git status",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements recurses into a nested wrapper hiding inside a compound inner statement", () => {
    deepEq(splitStatements("bash -c \"git status && bash -c 'git push origin dev-ng'\""), [
      "bash -c \"git status && bash -c 'git push origin dev-ng'\"",
      "git status",
      "bash -c 'git push origin dev-ng'",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements peels through two layers of nesting", () => {
    deepEq(splitStatements('bash -c "bash -c \\"git status\\""'), [
      'bash -c "bash -c \\"git status\\""',
      'bash -c "git status"',
      "git status",
    ]);
  });

  test("splitStatements combines a top-level compound line with a wrapped statement", () => {
    deepEq(splitStatements('git fetch && bash -c "git push origin dev-ng"'), [
      "git fetch",
      'bash -c "git push origin dev-ng"',
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements leaves an ordinary command line alone, no wrapper present", () => {
    deepEq(splitStatements("git status; git push"), ["git status", "git push"]);
  });

  test("splitStatements does not unwrap a wrapper name that only appears inside a commit message", () => {
    deepEq(splitStatements('git commit -m "run bash -c to reproduce"'), [
      'git commit -m "run bash -c to reproduce"',
    ]);
  });

  test("splitStatements does not treat a nested-shell exploit's quoted commit message as inert prose", () => {
    // The regression this whole helper exists to close: a forbidden statement
    // hidden behind a nested shell must appear in the returned list on its
    // own, unmasked, so a rule iterating statements can judge it directly.
    const got = splitStatements(`bash -c 'git commit -m "feat: x"'`);
    ok(got.includes('git commit -m "feat: x"'));
  });

  /* ------------------------- splitStatements: wrapper mid-statement */

  test("splitStatements does not unwrap a wrapper word appearing mid-statement, after eval", () => {
    deepEq(splitStatements('echo do not eval "git push origin dev-ng"'), [
      'echo do not eval "git push origin dev-ng"',
    ]);
  });

  test("splitStatements does not unwrap a wrapper word appearing mid-statement, after bash -c", () => {
    deepEq(splitStatements('echo never run bash -c "git push origin dev-ng"'), [
      'echo never run bash -c "git push origin dev-ng"',
    ]);
  });

  test("splitStatements does not unwrap eval when it is not the statement's own first word", () => {
    deepEq(splitStatements('printf %s eval "git push origin dev-ng"'), [
      'printf %s eval "git push origin dev-ng"',
    ]);
  });

  test("splitStatements does not unwrap eval mid-statement inside a parenthesised expression", () => {
    deepEq(splitStatements('node -e console.log( eval "git push origin dev-ng" )'), [
      'node -e console.log( eval "git push origin dev-ng" )',
    ]);
  });

  test("splitStatements does not unwrap eval mid-statement in the second half of a compound command", () => {
    deepEq(splitStatements('git commit -m subject && echo eval "npm install"'), [
      "git commit -m subject",
      'echo eval "npm install"',
    ]);
  });

  test("splitStatements still unwraps a genuine wrapper starting its own statement after &&", () => {
    deepEq(splitStatements('ls && cmd /c "git push origin dev-ng"'), [
      "ls",
      'cmd /c "git push origin dev-ng"',
      "git push origin dev-ng",
    ]);
  });

  /* ---------------------------------------- splitStatements: size bound */

  test("splitStatements still unwraps a nested shell just under the size threshold", () => {
    // 256 KiB minus generous headroom for the wrapper text itself, so the
    // total command length stays under the bound.
    const padding = "a".repeat(250 * 1024);
    const command = `echo "${padding}"; bash -c "git push origin dev-ng"`;
    ok(command.length < 256 * 1024, "fixture must stay under the threshold");
    const got = splitStatements(command);
    ok(got.includes('bash -c "git push origin dev-ng"'), "outer wrapped statement present");
    ok(got.includes("git push origin dev-ng"), "unwrapped inner statement still produced under the bound");
  });

  test("splitStatements skips nested-shell unwrapping once the command exceeds the size threshold, but still splits", () => {
    const padding = "a".repeat(300 * 1024);
    const command = `echo "${padding}"; bash -c "git push origin dev-ng"`;
    ok(command.length > 256 * 1024, "fixture must exceed the threshold");
    const got = splitStatements(command);
    ok(got.includes('bash -c "git push origin dev-ng"'), "raw separator split still runs, outer statement present");
    eq(
      got.includes("git push origin dev-ng"),
      false,
      "nested-shell probe is skipped above the bound, so the wrapper is not unwrapped",
    );
  });

  /* -------------------------------------------------------- required cases */

  test("git push inside a quoted string is not an invocation (required)", () => {
    eq(gitVerb('echo "reminder: git push before lunch"', "push"), false);
  });

  test("cd x && git push is an invocation (required)", () => {
    ok(gitVerb("cd x && git push", "push"));
  });

  test("mentioning a forbidden word in prose is not an invocation (required)", () => {
    eq(hasCommand('echo "never run cypress run here"', "cypress\\s+run"), false);
  });

  /* ----------------------------------- backslash-newline line continuation */

  test("splitStatements joins a backslash-newline continuation into one statement instead of splitting on it", () => {
    deepEq(splitStatements("softela-ai\\\napprove infra-self-protection"), ["softela-ai approve infra-self-protection"]);
  });

  test("hasCommand matches an invocation split by a backslash-newline continuation", () => {
    ok(hasCommand("softela-ai\\\napprove infra-self-protection", "softela-ai\\s+approve"));
  });

  test("gitVerb matches a verb split from its command word by a backslash-newline continuation", () => {
    ok(gitVerb("git\\\npush origin dev", "push"));
  });

  test("hasCommand matches rm split from its -rf flag by a backslash-newline continuation", () => {
    ok(hasCommand("rm\\\n-rf ~/.claude/.softela-ai", "rm"));
  });

  test("a backslash-newline continuation inside single quotes stays literal, not a join point", () => {
    // Real POSIX shells never treat backslash-newline as continuation inside
    // single quotes, so this must keep reading as one opaque quoted mention.
    eq(gitVerb("echo 'git\\\npush is forbidden'", "push"), false);
  });

  /* --------------------------------------------------- ${IFS} substitution */

  test("hasCommand matches an invocation joined by ${IFS} instead of whitespace", () => {
    ok(hasCommand("softela-ai${IFS}approve${IFS}infra-self-protection", "softela-ai\\s+approve"));
  });

  test("gitVerb matches a verb joined to its command word by ${IFS}", () => {
    ok(gitVerb("git${IFS}push${IFS}origin${IFS}dev", "push"));
  });

  test("hasCommand matches rm joined to its -rf flag by ${IFS}", () => {
    ok(hasCommand("rm${IFS}-rf${IFS}~/.claude/.softela-ai", "rm"));
  });

  test("a bare $IFS (no braces) is recognised the same way", () => {
    // A real shell greedily reads the longest identifier after `$`, so a
    // bare $IFS only stands alone when what follows it is not itself a
    // valid identifier character — here, the space already in the source.
    ok(gitVerb("git$IFS push origin dev", "push"));
  });

  test("$IFS does not match as a prefix of a longer, unrelated variable name", () => {
    eq(gitVerb("git$IFSXpush origin dev", "push"), false);
  });

  test("${IFS} inside single quotes stays literal, not a join point", () => {
    eq(gitVerb("echo 'git${IFS}push is forbidden'", "push"), false);
  });

  /* ------------------------------------------------------- ANSI-C quoting */

  test("gitVerb matches when the command word is ANSI-C quoted", () => {
    ok(gitVerb("$'git' push origin dev", "push"));
  });

  test("hasCommand matches rm when ANSI-C quoted", () => {
    ok(hasCommand("$'rm' -rf ~/.claude/.softela-ai", "rm"));
  });

  test("gitVerb still ignores an ANSI-C quoted mention deeper in the line", () => {
    eq(gitVerb("echo $'reminder: git push before lunch'", "push"), false);
  });

  /* -------------------------------------------------------- splitTokens */

  test("splitTokens dequotes a plain, unquoted statement", () => {
    deepEq(splitTokens("git add -A"), ["git", "add", "-A"]);
  });

  test("splitTokens dequotes a single-quoted leading word", () => {
    deepEq(splitTokens("'git' add -A"), ["git", "add", "-A"]);
  });

  test("splitTokens dequotes an ANSI-C quoted leading word", () => {
    deepEq(splitTokens("$'git' add -A"), ["git", "add", "-A"]);
  });

  test("splitTokens treats ${IFS} as a token boundary", () => {
    deepEq(splitTokens("git${IFS}add${IFS}-A"), ["git", "add", "-A"]);
  });

  test("splitTokens joins a backslash-newline continuation into a boundary, not a token", () => {
    deepEq(splitTokens("git\\\nadd -A"), ["git", "add", "-A"]);
  });

  test("splitTokens keeps an entire double-quoted argument as one token", () => {
    deepEq(splitTokens('git commit -m "a; b && c"'), ["git", "commit", "-m", "a; b && c"]);
  });

  test("splitTokens stops at an unquoted statement separator", () => {
    deepEq(splitTokens("git add -A; echo done"), ["git", "add", "-A"]);
  });

  test("splitTokens returns an empty list for an empty statement", () => {
    deepEq(splitTokens(""), []);
  });

  /* ------------------------------ splitTokens: double-quoted Windows paths */

  test("splitTokens keeps every backslash in a double-quoted Windows path literal", () => {
    deepEq(splitTokens('cd "C:\\Users\\dev\\repos\\SomeRepo"'), ["cd", "C:\\Users\\dev\\repos\\SomeRepo"]);
  });

  test("splitTokens still unescapes an escaped double quote inside a double-quoted argument", () => {
    deepEq(splitTokens('echo "say \\"hi\\" now"'), ["echo", 'say "hi" now']);
  });

  test("splitTokens keeps a single-quoted Windows path literal, same as before the fix", () => {
    deepEq(splitTokens("cd 'C:\\Users\\dev\\repos\\SomeRepo'"), ["cd", "C:\\Users\\dev\\repos\\SomeRepo"]);
  });

  test("splitTokens keeps an unquoted Windows path literal, same as before the fix", () => {
    deepEq(splitTokens("cd C:\\Users\\dev\\repos\\SomeRepo"), ["cd", "C:\\Users\\dev\\repos\\SomeRepo"]);
  });

  test("splitTokens dequotes a double-quoted forward-slash path unchanged", () => {
    deepEq(splitTokens('cd "C:/Users/dev/repos/SomeRepo"'), ["cd", "C:/Users/dev/repos/SomeRepo"]);
  });

  test("splitTokens keeps a double-quoted path with an internal space as one token", () => {
    deepEq(splitTokens('cd "C:\\Program Files\\App"'), ["cd", "C:\\Program Files\\App"]);
  });

  test("splitTokens does not swallow the character following a literal backslash inside double quotes", () => {
    // A backslash not immediately before a closing quote is ordinary content
    // — the character right after it (here "z") must survive as its own
    // literal character too, not be consumed the way a POSIX escape would.
    deepEq(splitTokens('echo "a\\zb"'), ["echo", "a\\zb"]);
  });

  /* --------------------------- nested shells: Windows paths (regression) */
  // peelNestedShellLayer carries the same double-quote dequoting as
  // splitTokens, so a Windows path survives a nested-shell wrapper the same
  // way it survives a direct command line.

  test("unwrapNestedShells keeps a Windows path literal through a double-quoted bash -c wrapper", () => {
    eq(
      unwrapNestedShells('bash -c "cd C:\\Users\\dev\\repos\\SomeRepo && npx tsc --noEmit"'),
      "cd C:\\Users\\dev\\repos\\SomeRepo && npx tsc --noEmit",
    );
  });

  test("unwrapNestedShells keeps a Windows path literal through a double-quoted sh -c wrapper", () => {
    eq(unwrapNestedShells('sh -c "cd C:\\Users\\dev\\repos\\SomeRepo"'), "cd C:\\Users\\dev\\repos\\SomeRepo");
  });

  test("unwrapNestedShells keeps a Windows path literal through powershell -Command", () => {
    eq(
      unwrapNestedShells('powershell -Command "cd C:\\Users\\dev\\repos\\SomeRepo; npx tsc --noEmit"'),
      "cd C:\\Users\\dev\\repos\\SomeRepo; npx tsc --noEmit",
    );
  });

  test("unwrapNestedShells keeps a Windows path literal through cmd /c", () => {
    eq(
      unwrapNestedShells('cmd /c "cd C:\\Users\\dev\\repos\\SomeRepo && npx tsc --noEmit"'),
      "cd C:\\Users\\dev\\repos\\SomeRepo && npx tsc --noEmit",
    );
  });

  test("unwrapNestedShells keeps a single-quoted Windows path literal through bash -c, unaffected by the double-quote rule", () => {
    eq(unwrapNestedShells("bash -c 'cd C:\\Users\\dev\\repos\\SomeRepo'"), "cd C:\\Users\\dev\\repos\\SomeRepo");
  });

  test("splitStatements produces the unwrapped inner statement with the Windows path intact", () => {
    deepEq(splitStatements('bash -c "cd C:\\Users\\dev\\repos\\SomeRepo && npx tsc --noEmit"'), [
      'bash -c "cd C:\\Users\\dev\\repos\\SomeRepo && npx tsc --noEmit"',
      "cd C:\\Users\\dev\\repos\\SomeRepo",
      "npx tsc --noEmit",
    ]);
  });

  test("splitTokens dequotes the unwrapped Windows-path statement's cd target correctly", () => {
    const [, cdStatement] = splitStatements('bash -c "cd C:\\Users\\dev\\repos\\SomeRepo && npx tsc --noEmit"');
    deepEq(splitTokens(cdStatement), ["cd", "C:\\Users\\dev\\repos\\SomeRepo"]);
  });

  test("unwrapNestedShells still unescapes a genuinely escaped quote next to a Windows path", () => {
    // The closing quote of the cd argument is escaped (`\"`) so the wrapper's
    // own argument keeps going, exactly like the plain escaped-quote case —
    // this is what distinguishes "backslash before the closing quote" from
    // every other backslash in the same argument, which must stay literal.
    eq(
      unwrapNestedShells('bash -c "echo \\"C:\\Users\\dev\\repos\\SomeRepo\\" done"'),
      'echo "C:\\Users\\dev\\repos\\SomeRepo" done',
    );
  });

  test("unwrapNestedShells peels a Windows path through two layers of nested bash -c", () => {
    eq(
      unwrapNestedShells('bash -c "bash -c \\"cd C:\\Users\\dev\\repos\\SomeRepo\\""'),
      "cd C:\\Users\\dev\\repos\\SomeRepo",
    );
  });

  test("splitStatements recurses a Windows path through a nested wrapper inside a nested wrapper", () => {
    deepEq(splitStatements('bash -c "bash -c \\"cd C:\\Users\\dev\\repos\\SomeRepo\\""'), [
      'bash -c "bash -c \\"cd C:\\Users\\dev\\repos\\SomeRepo\\""',
      'bash -c "cd C:\\Users\\dev\\repos\\SomeRepo"',
      "cd C:\\Users\\dev\\repos\\SomeRepo",
    ]);
  });

  /* ------------------ nested shells: Windows paths, negative/unaffected */

  test("unwrapNestedShells still unwraps a wrapper whose argument names no directory at all", () => {
    eq(unwrapNestedShells('bash -c "echo just some text"'), "echo just some text");
  });

  test("unwrapNestedShells does not treat a bare word that merely resembles a wrapper verb as one", () => {
    // "bashful" starts with "bash" but is not followed by whitespace, so the
    // wrapper regex's own `\s+` requirement rules it out — same behaviour
    // before and after the Windows-path fix.
    eq(unwrapNestedShells('bashful -c "cd C:\\Users\\dev\\repos\\SomeRepo"'), null);
  });

  test("unwrapNestedShells does not unwrap a wrapper form the parser deliberately does not recognise", () => {
    // `python -c` is not one of the wrapper spellings NESTED_SHELL_RE knows,
    // so this must stay null — and, since nothing is peeled, the Windows
    // path inside it is never inspected at all.
    eq(unwrapNestedShells('python -c "cd C:\\Users\\dev\\repos\\SomeRepo"'), null);
  });

  test("splitStatements leaves an unrecognised wrapper's Windows-path argument untouched, single statement only", () => {
    deepEq(splitStatements('python -c "cd C:\\Users\\dev\\repos\\SomeRepo"'), [
      'python -c "cd C:\\Users\\dev\\repos\\SomeRepo"',
    ]);
  });

  /* ------------------------------------------- splitStatements: grouping */

  test("splitStatements unwraps a bare subshell around a single command", () => {
    deepEq(splitStatements("(git push origin dev-ng)"), [
      "(git push origin dev-ng)",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a subshell with internal spacing", () => {
    deepEq(splitStatements("( git push origin dev-ng )"), [
      "( git push origin dev-ng )",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a subshell carrying a compound statement", () => {
    deepEq(splitStatements("(cd sub && git push origin dev-ng)"), [
      "(cd sub && git push origin dev-ng)",
      "cd sub",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a group command", () => {
    deepEq(splitStatements("{ git push origin dev-ng; }"), [
      "{ git push origin dev-ng; }",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a command substitution", () => {
    deepEq(splitStatements("$(git push origin dev-ng)"), [
      "$(git push origin dev-ng)",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a backtick substitution", () => {
    deepEq(splitStatements("`git push origin dev-ng`"), [
      "`git push origin dev-ng`",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements splits a pipeline's second stage into its own statement", () => {
    deepEq(splitStatements("git status | xargs git push origin dev-ng"), [
      "git status",
      "xargs git push origin dev-ng",
    ]);
  });

  test("splitStatements splits on the POSIX |& pipe-with-stderr operator", () => {
    deepEq(splitStatements("git status |& cat"), ["git status", "cat"]);
  });

  test("splitStatements splits a background & into its own statement", () => {
    deepEq(splitStatements("git push origin dev-ng &"), ["git push origin dev-ng"]);
  });

  test("splitStatements splits two background jobs on the same line", () => {
    deepEq(splitStatements("job1 & job2"), ["job1", "job2"]);
  });

  test("splitStatements unwraps a bare <( … ) process substitution", () => {
    deepEq(splitStatements("<(git push origin dev-ng)"), [
      "<(git push origin dev-ng)",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a bare >( … ) process substitution", () => {
    deepEq(splitStatements(">(git push origin dev-ng)"), [
      ">(git push origin dev-ng)",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps process substitution used as another command's argument", () => {
    deepEq(splitStatements("diff <(git push origin dev-ng) x"), [
      "diff <(git push origin dev-ng) x",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a >( … ) process substitution used as a write target", () => {
    deepEq(splitStatements("echo hi > >(git push origin dev-ng)"), [
      "echo hi > >(git push origin dev-ng)",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements unwraps a compound statement inside process substitution", () => {
    deepEq(splitStatements("diff <(cd sub && git push origin dev-ng) x"), [
      "diff <(cd sub && git push origin dev-ng) x",
      "cd sub",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements does not read $((…)) arithmetic expansion as a statement", () => {
    deepEq(splitStatements("echo $((2 + 2))"), ["echo $((2 + 2))"]);
  });

  test("splitStatements does not read a nested-paren arithmetic expression as a statement", () => {
    deepEq(splitStatements("echo $(( (1 + 2) * 3 ))"), ["echo $(( (1 + 2) * 3 ))"]);
  });

  test("splitStatements still unwraps a real command substitution right after an arithmetic expansion", () => {
    // `$(( … ))` immediately followed by `$( … )` must not let the
    // arithmetic-skip logic swallow the genuine substitution that follows it.
    deepEq(splitStatements("echo $((2 + 2)) $(git push origin dev-ng)"), [
      "echo $((2 + 2)) $(git push origin dev-ng)",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements recognises a PowerShell & { … } call-operator script block", () => {
    deepEq(splitStatements("& { git push origin dev-ng }"), [
      "{ git push origin dev-ng }",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements recognises a script block passed to Invoke-Command", () => {
    deepEq(splitStatements("Invoke-Command -ScriptBlock { git push origin dev-ng }"), [
      "Invoke-Command -ScriptBlock { git push origin dev-ng }",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements recognises a positional script block passed to Invoke-Command", () => {
    deepEq(splitStatements("Invoke-Command { git push origin dev-ng }"), [
      "Invoke-Command { git push origin dev-ng }",
      "git push origin dev-ng",
    ]);
  });

  test("splitStatements does not treat a brace mentioned after Invoke-Command in unrelated prose as its script block", () => {
    // The cmdlet name appears, but not as the statement's own leading run of
    // words — this must stay exactly the ordinary brace-expansion case.
    deepEq(splitStatements("echo remember Invoke-Command later { odd }"), [
      "echo remember Invoke-Command later { odd }",
    ]);
  });

  test("splitStatements treats a ;; case terminator as two statement boundaries", () => {
    deepEq(splitStatements("case $x in push) git push origin dev-ng ;; esac"), [
      "case $x in push) git push origin dev-ng",
      "esac",
    ]);
  });

  test("splitStatements treats a ;& case fallthrough terminator as a statement boundary", () => {
    deepEq(splitStatements("foo ;& git push origin dev-ng"), ["foo", "git push origin dev-ng"]);
  });

  test("splitStatements unwraps a blanket git add inside a subshell", () => {
    deepEq(splitStatements("(git add -A)"), ["(git add -A)", "git add -A"]);
  });

  test("splitStatements unwraps a compound add-then-commit inside a subshell", () => {
    deepEq(splitStatements("(git add . && git commit -m x)"), [
      "(git add . && git commit -m x)",
      "git add .",
      "git commit -m x",
    ]);
  });

  /* --------------------------------- splitStatements: grouping, untouched */

  test("splitStatements leaves parentheses inside a quoted commit message alone", () => {
    deepEq(splitStatements('git commit -m "(fix) parenthesised subject"'), [
      'git commit -m "(fix) parenthesised subject"',
    ]);
  });

  test("splitStatements leaves a push mentioned only inside a quoted string alone", () => {
    deepEq(splitStatements('echo "run git push origin dev-ng later"'), [
      'echo "run git push origin dev-ng later"',
    ]);
  });

  test("splitStatements leaves a quoted git add mention inside a commit message alone", () => {
    deepEq(splitStatements(`git commit -m 'run git add "." first'`), [
      `git commit -m 'run git add "." first'`,
    ]);
  });

  test("splitStatements leaves grep's unrelated quoted argument alone", () => {
    deepEq(splitStatements('grep -r "git push" docs/'), ['grep -r "git push" docs/']);
  });

  test("splitStatements does not read a quoted redirection as a background operator", () => {
    deepEq(splitStatements('echo "2>&1 is a redirection"'), ['echo "2>&1 is a redirection"']);
  });

  test("splitStatements leaves quoted arithmetic expansion alone", () => {
    deepEq(splitStatements('echo "result is $((2 + 2))"'), ['echo "result is $((2 + 2))"']);
  });

  test("splitStatements leaves quoted process-substitution-shaped text alone", () => {
    deepEq(splitStatements('echo "run <(git push origin dev-ng) later"'), [
      'echo "run <(git push origin dev-ng) later"',
    ]);
  });

  test("splitStatements does not read parentheses inside a Windows path as grouping", () => {
    const cmd = 'cd "C:/Program Files (x86)/tool" && tool.exe';
    deepEq(splitStatements(cmd), ['cd "C:/Program Files (x86)/tool"', "tool.exe"]);
  });

  test("splitStatements does not read an unquoted stderr-to-stdout duplication as background", () => {
    deepEq(splitStatements("cmd 2>&1"), ["cmd 2>&1"]);
  });

  test("splitStatements does not read an unquoted fd2 duplication as background", () => {
    deepEq(splitStatements("cmd >&2"), ["cmd >&2"]);
  });

  test("splitStatements does not read the &> combined-redirect operator as background", () => {
    deepEq(splitStatements("cmd &> file.log"), ["cmd &> file.log"]);
  });

  test("splitStatements does not treat brace expansion mid-word as a group command", () => {
    deepEq(splitStatements("echo file.{js,ts}"), ["echo file.{js,ts}"]);
  });

  test("splitStatements does not treat a function-call-style paren as a subshell", () => {
    const cmd = '[Environment]::SetEnvironmentVariable("SOFTELA_AI_HOME", "C:/tmp/decoy", "User")';
    deepEq(splitStatements(cmd), [cmd]);
  });

  /* -------------------------------------------------------- splitTokens: grouping */

  test("splitTokens strips a leading and trailing bare-subshell paren", () => {
    deepEq(splitTokens("(git add -A)"), ["git", "add", "-A"]);
  });

  test("splitTokens strips leading/trailing punctuation with internal spacing", () => {
    deepEq(splitTokens("( git add -A )"), ["git", "add", "-A"]);
  });

  test("splitTokens strips a leading and trailing group-command brace", () => {
    deepEq(splitTokens("{ git status }"), ["git", "status"]);
  });

  test("splitTokens strips trailing subshell punctuation glued onto the final word", () => {
    deepEq(splitTokens("(git status)"), ["git", "status"]);
  });

  test("splitTokens drops a final token that is nothing but grouping punctuation", () => {
    deepEq(splitTokens("(git status )"), ["git", "status"]);
  });

  test("splitTokens still stops at a mid-statement separator once grouping is stripped", () => {
    deepEq(splitTokens("(cd sub && git push)"), ["cd", "sub"]);
  });

  /* --------------------------------------------------- deep nesting, long input */

  test("splitStatements fully unwraps a subshell nested exactly MAX_GROUPING_DEPTH deep", () => {
    const depth = 16;
    const cmd = "(".repeat(depth) + "git push origin dev-ng" + ")".repeat(depth);
    ok(splitStatements(cmd).includes("git push origin dev-ng"), "the fully unwrapped inner statement is present");
  });

  test("splitStatements does not throw or hang on nesting well past MAX_GROUPING_DEPTH", () => {
    const depth = 200;
    const cmd = "(".repeat(depth) + "git push origin dev-ng" + ")".repeat(depth);
    const got = splitStatements(cmd);
    ok(Array.isArray(got) && got.length > 0, "returns an ordinary statement list rather than throwing or hanging");
  });

  /* -------------------------------------------------------- heredoc bodies */

  test("splitStatements drops a heredoc body instead of judging it as statements", () => {
    deepEq(splitStatements("cat <<EOF\nrun: git push origin dev-ng\nEOF"), ["cat <<EOF"]);
  });

  test("splitStatements handles a single-quoted heredoc delimiter", () => {
    deepEq(splitStatements("cat <<'EOF'\nrun: git push origin dev-ng\nEOF"), ["cat <<'EOF'"]);
  });

  test("splitStatements handles a double-quoted heredoc delimiter", () => {
    deepEq(splitStatements('cat <<"EOF"\nrun: git push origin dev-ng\nEOF'), ['cat <<"EOF"']);
  });

  test("splitStatements handles the <<- heredoc spelling", () => {
    deepEq(splitStatements("cat <<-EOF\nrun: git push origin dev-ng\nEOF"), ["cat <<-EOF"]);
  });

  test("splitStatements handles the <<~ indented heredoc spelling", () => {
    deepEq(splitStatements("cat <<~EOF\nrun: git push origin dev-ng\nEOF"), ["cat <<~EOF"]);
  });

  test("splitStatements drops a heredoc body containing text that looks like forbidden statements", () => {
    const cmd = "cat <<EOF\ngit push origin dev-ng\nrm -rf /\na && b\nEOF";
    deepEq(splitStatements(cmd), ["cat <<EOF"]);
  });

  test("splitStatements consumes both bodies of two heredocs opened by the same statement, in order", () => {
    const cmd = "cmd <<A <<B\nbodyA\nA\nbodyB\nB";
    deepEq(splitStatements(cmd), ["cmd <<A <<B"]);
  });

  test("splitStatements consumes an unterminated heredoc to the end of the input", () => {
    const cmd = "cat <<EOF\ngit push origin dev-ng\nstill no terminator here";
    deepEq(splitStatements(cmd), ["cat <<EOF"]);
  });

  test("splitStatements still reads a command after the heredoc terminator as its own statement", () => {
    const cmd = "cat <<EOF\nbody\nEOF\ngit push origin dev-ng";
    deepEq(splitStatements(cmd), ["cat <<EOF", "git push origin dev-ng"]);
  });

  test("splitStatements treats a quoted <<EOF as ordinary text, not a heredoc opener", () => {
    deepEq(splitStatements('echo "<<EOF"'), ['echo "<<EOF"']);
  });

  test("splitStatements completes quickly on a very long, ordinary command line", () => {
    // ~188 KB of semicolon-joined statements, comfortably under
    // MAX_COMMAND_LENGTH_FOR_UNWRAP, so the full boundary-and-nested-shell
    // probe runs rather than the cheap separator-only fallback.
    const statements = [];
    for (let i = 0; i < 4500; i += 1) statements.push(`echo "step number ${i} of the long line"`);
    statements.push('bash -c "git push origin dev-ng"');
    const cmd = statements.join("; ");
    ok(cmd.length < 256 * 1024, "fixture must stay under the unwrap size threshold");

    const start = Date.now();
    const got = splitStatements(cmd);
    const elapsedMs = Date.now() - start;

    ok(got.includes("git push origin dev-ng"), "the wrapped statement at the end is still unwrapped");
    ok(
      elapsedMs < 2000,
      `splitStatements on a ${cmd.length}-byte, ${statements.length}-statement command took ${elapsedMs}ms, expected well under 2000ms`,
    );
  });
});
