"use strict";

const { suite } = require("../harness");
const { shellWriteTargets, WRITE_MECHANISMS } = require("../../core/lib/shell-write");

/**
 * Finds the first result matching a mechanism, for a test that only cares
 * about one of several targets a statement might produce.
 *
 * @param {Array<{path: string, mechanism: string, certain: boolean}>} results
 * The targets `shellWriteTargets` returned.
 * @param {string} mechanism The mechanism name to look for.
 * @returns {object | undefined} The first matching entry.
 */
function byMechanism(results, mechanism) {
  return results.find((r) => r.mechanism === mechanism);
}

suite("lib/shell-write", ({ test, eq, ok, deepEq }) => {
  /* --------------------------------------------------------- POSIX redirect */

  test("a plain output redirect is a certain target", () => {
    const [r] = shellWriteTargets("echo hi > src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "redirect", certain: true });
  });

  test("an append redirect is a certain target", () => {
    const [r] = shellWriteTargets("echo hi >> src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "redirect", certain: true });
  });

  test("a stderr-only redirect still writes a file and still counts", () => {
    const [r] = shellWriteTargets("cmd 2> src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "redirect", certain: true });
  });

  test("a heredoc combined with a redirect reports the redirect's own target", () => {
    const [r] = shellWriteTargets("cat > src/a.ts <<'EOF'", {});
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "redirect");
    eq(r.certain, true);
  });

  test("a pure fd duplication is not a write target", () => {
    eq(shellWriteTargets("cmd 2>&1", {}).length, 0);
  });

  test("a stdout-to-stderr duplication with no leading digit is not a write target", () => {
    eq(shellWriteTargets("cmd >&2", {}).length, 0);
  });

  test("/dev/null is never reported as a write target", () => {
    eq(shellWriteTargets("git diff > /dev/null", {}).length, 0);
  });

  test("$null is never reported as a write target", () => {
    eq(shellWriteTargets("Get-Content x | Out-Null > $null", { powershell: true }).length, 0);
  });

  test("NUL (any case) is never reported as a write target", () => {
    eq(shellWriteTargets("echo hi > NUL", { powershell: true }).length, 0);
  });

  test("a > inside a double-quoted string is not a redirect", () => {
    eq(shellWriteTargets('git commit -m "a > b"', {}).length, 0);
  });

  test("a > inside a single-quoted string is not a redirect", () => {
    eq(shellWriteTargets("echo 'a > b'", {}).length, 0);
  });

  test("an unresolved variable target is reported uncertain", () => {
    const [r] = shellWriteTargets('cmd > "$OUT"', {});
    eq(r.mechanism, "redirect");
    eq(r.certain, false);
  });

  /* -------------------------------------------------------------------- tee */

  test("tee reports its target", () => {
    const [r] = shellWriteTargets("echo hi | tee src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "tee", certain: true });
  });

  test("tee -a reports its target, skipping the flag", () => {
    const [r] = shellWriteTargets("echo hi | tee -a src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "tee", certain: true });
  });

  /* ------------------------------------------------------------ PowerShell */

  test("Out-File reached through a pipe reports its positional target", () => {
    const [r] = shellWriteTargets("$code | Out-File src/a.ts", { powershell: true });
    deepEq(r, { path: "src/a.ts", mechanism: "powershell-out-file", certain: true });
  });

  test("Set-Content reports its named -Path target", () => {
    const [r] = shellWriteTargets('Set-Content -Path src/a.ts -Value "x"', { powershell: true });
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "powershell-set-content");
    eq(r.certain, true);
  });

  test("Add-Content reports its positional target", () => {
    const [r] = shellWriteTargets("Add-Content src/a.ts -Value x", { powershell: true });
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "powershell-add-content");
  });

  test("Tee-Object reports its named -FilePath target", () => {
    const [r] = shellWriteTargets("Get-Content x | Tee-Object -FilePath src/a.ts", { powershell: true });
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "powershell-tee-object");
  });

  test("Set-Content with a variable path is reported uncertain, not guessed at", () => {
    const [r] = shellWriteTargets("Set-Content -Path $p", { powershell: true });
    eq(r.mechanism, "powershell-set-content");
    eq(r.certain, false);
  });

  test("a PowerShell path with backslashes is not corrupted by POSIX backslash-unescaping", () => {
    const [r] = shellWriteTargets("Set-Content -Path src\\a.ts", { powershell: true });
    eq(r.path, "src\\a.ts");
    eq(r.certain, true);
  });

  /* --------------------------------------------------------------- sed/perl */

  test("sed -i reports its trailing operand as the target, not the script", () => {
    const results = shellWriteTargets("sed -i 's/foo/bar/' src/components/Widget/index.ts", {});
    deepEq(results, [{ path: "src/components/Widget/index.ts", mechanism: "sed-inplace", certain: true }]);
  });

  test("sed --in-place with an explicit -e reports every remaining operand", () => {
    const results = shellWriteTargets("sed --in-place -e 's/a/b/' src/a.ts", {});
    deepEq(results, [{ path: "src/a.ts", mechanism: "sed-inplace", certain: true }]);
  });

  test("perl -pi -e reports its trailing operand, consuming the -e script", () => {
    const [r] = shellWriteTargets("perl -pi -e 's/x/y/' src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "perl-inplace", certain: true });
  });

  test("perl -ni -e reports its trailing operand", () => {
    const [r] = shellWriteTargets("perl -ni -e 'print' src/a.ts", {});
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "perl-inplace");
  });

  test("sed without an in-place flag reports nothing", () => {
    eq(shellWriteTargets("sed 's/a/b/' src/a.ts", {}).length, 0);
  });

  /* --------------------------------------------------------- node / python */

  test("node -e with fs.writeFileSync extracts the literal path", () => {
    const source = "node -e \"require('fs').writeFileSync('src/a.ts', s)\"";
    const [r] = shellWriteTargets(source, {});
    deepEq(r, { path: "src/a.ts", mechanism: "node-inline-write", certain: true });
  });

  test("node --eval with fs.appendFileSync extracts the literal path", () => {
    const source = "node --eval \"require('fs').appendFileSync('src/a.ts', s)\"";
    const [r] = shellWriteTargets(source, {});
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "node-inline-write");
  });

  test("python -c with open(...,'w') extracts the literal path", () => {
    const source = "python -c \"open('src/a.ts','w').write(src)\"";
    const [r] = shellWriteTargets(source, {});
    deepEq(r, { path: "src/a.ts", mechanism: "python-inline-write", certain: true });
  });

  test("python3 -c with Path(...).write_text( extracts the literal path", () => {
    const source = "python3 -c \"Path('src/a.ts').write_text(x)\"";
    const [r] = shellWriteTargets(source, {});
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "python-inline-write");
  });

  test("node -e with a read-only script reports nothing", () => {
    const source = "node -e \"console.log(require('fs').readFileSync('src/a.ts', 'utf8'))\"";
    eq(shellWriteTargets(source, {}).length, 0);
  });

  test("node -e with a computed writeFileSync path is reported uncertain, not silent", () => {
    const source = "node -e \"require('fs').writeFileSync(path.join(d,'a.ts'), s)\"";
    const [r] = shellWriteTargets(source, {});
    deepEq(r, { path: "", mechanism: "node-inline-write", certain: false });
  });

  test("python -c with a computed open(...,'w') path is reported uncertain, not silent", () => {
    const source = "python -c \"open(target,'w').write(s)\"";
    const [r] = shellWriteTargets(source, {});
    deepEq(r, { path: "", mechanism: "python-inline-write", certain: false });
  });

  test("node -e reading through a variable path reports nothing", () => {
    const source = "node -e \"const s=require('fs').readFileSync(p,'utf8');console.log(s)\"";
    eq(shellWriteTargets(source, {}).length, 0);
  });

  test("python -c reading through open() with no mode reports nothing", () => {
    const source = 'python -c "print(open(p).read())"';
    eq(shellWriteTargets(source, {}).length, 0);
  });

  /* --------------------------------------------------------------- cp / mv */

  test("cp reports the destination operand, not the source", () => {
    const [r] = shellWriteTargets("cp somewhere.ts src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "copy-move", certain: true });
  });

  test("mv reports the destination operand", () => {
    const [r] = shellWriteTargets("mv somewhere.ts src/a.ts", {});
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "copy-move");
  });

  test("Copy-Item reports its named -Destination target", () => {
    const [r] = shellWriteTargets("Copy-Item -Path somewhere.ts -Destination src/a.ts", { powershell: true });
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "copy-move");
  });

  test("Move-Item reports its positional destination", () => {
    const [r] = shellWriteTargets("Move-Item somewhere.ts src/a.ts", { powershell: true });
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "copy-move");
  });

  test("cp with only one operand reports nothing — no discoverable destination", () => {
    eq(shellWriteTargets("cp -r src/a.ts", {}).length, 0);
  });

  /* ---------------------------------------------- truncate / dd / New-Item */

  test("truncate -s reports its target, skipping the size value", () => {
    const [r] = shellWriteTargets("truncate -s 0 src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "truncate", certain: true });
  });

  test("dd of= reports its output target", () => {
    const [r] = shellWriteTargets("dd of=src/a.ts if=/dev/zero", {});
    deepEq(r, { path: "src/a.ts", mechanism: "dd", certain: true });
  });

  test("New-Item -Force -Path reports its target", () => {
    const [r] = shellWriteTargets("New-Item -Force -Path src/a.ts", { powershell: true });
    deepEq(r, { path: "src/a.ts", mechanism: "new-item-force", certain: true });
  });

  test("New-Item without -Force reports nothing — it cannot truncate an existing file", () => {
    eq(shellWriteTargets("New-Item -Path src/a.ts", { powershell: true }).length, 0);
  });

  /* ---------------------------------------------------- xcopy / robocopy */

  test("xcopy reports its second operand as the destination, skipping /-switches", () => {
    const [r] = shellWriteTargets("xcopy src\\a.ts src/b.ts /Y", {});
    deepEq(r, { path: "src/b.ts", mechanism: "xcopy", certain: true });
  });

  test("xcopy with only a source operand reports nothing", () => {
    eq(shellWriteTargets("xcopy /Y src/a.ts", {}).length, 0);
  });

  test("robocopy always reports uncertain, carrying its destination directory", () => {
    const [r] = shellWriteTargets("robocopy srcdir src/components /E", {});
    deepEq(r, { path: "src/components", mechanism: "robocopy", certain: false });
  });

  test("a bare robocopy with no destination reports uncertain with no path at all", () => {
    const [r] = shellWriteTargets("robocopy", {});
    deepEq(r, { path: "", mechanism: "robocopy", certain: false });
  });

  /* --------------------------------------------------------------- git */

  test("git checkout <ref> -- <path> reports every path after -- as certain", () => {
    const [r] = shellWriteTargets("git checkout other-branch -- src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "git-checkout", certain: true });
  });

  test("git checkout -- <path> with no ref still reports the path", () => {
    const [r] = shellWriteTargets("git checkout -- src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "git-checkout", certain: true });
  });

  test("a bare git checkout <branch> with no -- reports nothing — branch switching is left unhandled", () => {
    eq(shellWriteTargets("git checkout other-branch", {}).length, 0);
  });

  test("git restore --source=<ref> <path> reports the path as certain", () => {
    const [r] = shellWriteTargets("git restore --source=other-branch src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "git-restore", certain: true });
  });

  test("git restore --source <ref> -- <path> reports the path, skipping the source value", () => {
    const [r] = shellWriteTargets("git restore --source other-branch -- src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "git-restore", certain: true });
  });

  test("git restore <path> with no --source restores from HEAD and still reports the path", () => {
    const [r] = shellWriteTargets("git restore src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "git-restore", certain: true });
  });

  test("git restore --worktree <path>, explicit worktree with no --staged, still reports the path", () => {
    const [r] = shellWriteTargets("git restore --worktree src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "git-restore", certain: true });
  });

  test("git restore --staged <path> only touches the index and reports nothing", () => {
    eq(shellWriteTargets("git restore --staged src/a.ts", {}).length, 0);
  });

  test("git restore --staged . only touches the index and reports nothing, even pathspec-wide", () => {
    eq(shellWriteTargets("git restore --staged .", {}).length, 0);
  });

  test("git restore -S <path>, the short flag spelling, also reports nothing", () => {
    eq(shellWriteTargets("git restore -S src/a.ts", {}).length, 0);
  });

  test("git restore --staged --worktree <path> touches the working tree too and still reports the path", () => {
    const [r] = shellWriteTargets("git restore --staged --worktree src/a.ts", {});
    deepEq(r, { path: "src/a.ts", mechanism: "git-restore", certain: true });
  });

  test("git apply reports an uncertain, pathless target — the patch names its own files", () => {
    const [r] = shellWriteTargets("git apply /tmp/some.patch", {});
    deepEq(r, { path: "", mechanism: "git-apply", certain: false });
  });

  test("git apply --check is inspection-only and reports nothing", () => {
    eq(shellWriteTargets("git apply --check /tmp/some.patch", {}).length, 0);
  });

  test("git apply --stat is inspection-only and reports nothing", () => {
    eq(shellWriteTargets("git apply --stat /tmp/some.patch", {}).length, 0);
  });

  test("git am reports an uncertain, pathless target", () => {
    const [r] = shellWriteTargets("git am /tmp/mbox", {});
    deepEq(r, { path: "", mechanism: "git-am", certain: false });
  });

  test("git am --abort is a control operation and reports nothing", () => {
    eq(shellWriteTargets("git am --abort", {}).length, 0);
  });

  test("git stash pop is not recognised at all and reports nothing — restoring the developer's own stash", () => {
    eq(shellWriteTargets("git stash pop", {}).length, 0);
  });

  test("git stash apply is not recognised at all and reports nothing", () => {
    eq(shellWriteTargets("git stash apply", {}).length, 0);
  });

  test("git stash push does not restore stashed content and reports nothing", () => {
    eq(shellWriteTargets("git stash push", {}).length, 0);
  });

  test("git stash list reports nothing", () => {
    eq(shellWriteTargets("git stash list", {}).length, 0);
  });

  test("git revert is not recognised at all and reports nothing — it moves commits, not unreviewed content", () => {
    eq(shellWriteTargets("git revert HEAD~1", {}).length, 0);
  });

  test("git cherry-pick is not recognised at all and reports nothing", () => {
    eq(shellWriteTargets("git cherry-pick abc123", {}).length, 0);
  });

  test("git log reports nothing — an unrelated subcommand", () => {
    eq(shellWriteTargets("git log --oneline", {}).length, 0);
  });

  /* ---------------------------------------------------------- downloads */

  test("curl -o reports its explicit target as certain", () => {
    const [r] = shellWriteTargets("curl -o src/a.ts https://example.invalid/x.tsx", {});
    deepEq(r, { path: "src/a.ts", mechanism: "curl", certain: true });
  });

  test("curl --output=<path> reports the =-joined target", () => {
    const [r] = shellWriteTargets("curl --output=src/a.ts https://example.invalid/x.tsx", {});
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "curl");
    eq(r.certain, true);
  });

  test("curl -O reports an uncertain, pathless target — named from the URL, not parsed out", () => {
    const [r] = shellWriteTargets("curl -O https://example.invalid/x.tsx", {});
    deepEq(r, { path: "", mechanism: "curl", certain: false });
  });

  test("curl with neither -o nor -O streams to stdout and reports nothing", () => {
    eq(shellWriteTargets("curl https://example.invalid/x.tsx", {}).length, 0);
  });

  test("wget -O reports its explicit target as certain", () => {
    const [r] = shellWriteTargets("wget -O src/a.ts https://example.invalid/x.tsx", {});
    deepEq(r, { path: "src/a.ts", mechanism: "wget", certain: true });
  });

  test("wget --output-document=<path> reports the =-joined target", () => {
    const [r] = shellWriteTargets("wget --output-document=src/a.ts https://example.invalid/x.tsx", {});
    eq(r.path, "src/a.ts");
    eq(r.mechanism, "wget");
  });

  test("Invoke-WebRequest -OutFile reports its target as certain", () => {
    const [r] = shellWriteTargets("Invoke-WebRequest -Uri https://example.invalid/x.tsx -OutFile src/a.ts", {
      powershell: true,
    });
    deepEq(r, { path: "src/a.ts", mechanism: "invoke-webrequest", certain: true });
  });

  test("Invoke-WebRequest with no -OutFile reports nothing — it returns an object, not a file", () => {
    eq(shellWriteTargets("Invoke-WebRequest -Uri https://example.invalid/x.tsx", { powershell: true }).length, 0);
  });

  /* ---------------------------------------------------- archive extraction */

  test("Expand-Archive with -DestinationPath reports an uncertain target carrying that directory", () => {
    const [r] = shellWriteTargets(
      "Expand-Archive -Path bundle.zip -DestinationPath src/components/layout -Force",
      { powershell: true },
    );
    deepEq(r, { path: "src/components/layout", mechanism: "expand-archive", certain: false });
  });

  test("Expand-Archive with no destination reports nothing at all — extracting into the current directory", () => {
    eq(shellWriteTargets("Expand-Archive -Path bundle.zip -Force", { powershell: true }).length, 0);
  });

  test("tar's old-style bundled extract flag (xzf) is recognised, reporting the -C directory", () => {
    const [r] = shellWriteTargets("tar xzf archive.tar.gz -C src/components", {});
    deepEq(r, { path: "src/components", mechanism: "tar-extract", certain: false });
  });

  test("tar -x with no -C reports nothing at all — extracting into the current directory", () => {
    eq(shellWriteTargets("tar -xf archive.tar", {}).length, 0);
  });

  test("tar xzf with no -C reports nothing at all, the old-style bundled spelling", () => {
    eq(shellWriteTargets("tar xzf node-fixture.tgz", {}).length, 0);
  });

  test("tar --directory=<dir> reports that directory", () => {
    const [r] = shellWriteTargets("tar -xf archive.tar --directory=src/components", {});
    eq(r.path, "src/components");
    eq(r.mechanism, "tar-extract");
  });

  test("tar without an extract flag reports nothing — e.g. listing an archive's contents", () => {
    eq(shellWriteTargets("tar -tf archive.tar", {}).length, 0);
  });

  test("unzip -d reports the destination directory, uncertain", () => {
    const [r] = shellWriteTargets("unzip bundle.zip -d src/components", {});
    deepEq(r, { path: "src/components", mechanism: "unzip", certain: false });
  });

  test("unzip with no -d reports nothing at all — extracting into the current directory", () => {
    eq(shellWriteTargets("unzip bundle.zip", {}).length, 0);
  });

  /* -------------------------------------------------------------- evasion */

  test("a nested bash -c wrapper still reports the inner sed -i target", () => {
    const results = shellWriteTargets("bash -c \"sed -i 's/a/b/' src/a.ts\"", {});
    const found = byMechanism(results, "sed-inplace");
    ok(found, "expected the inner sed -i target to be found");
    eq(found.path, "src/a.ts");
  });

  test("a compound statement still reports the redirect in its second half", () => {
    const results = shellWriteTargets("cd apps && echo hi > src/a.ts", {});
    const found = byMechanism(results, "redirect");
    ok(found, "expected the redirect after && to be found");
    eq(found.path, "src/a.ts");
  });

  /* ------------------------------------------------------------- robustness */

  test("never throws on malformed input", () => {
    eq(Array.isArray(shellWriteTargets('cmd > "unterminated', {})), true);
    eq(Array.isArray(shellWriteTargets("", {})), true);
    eq(Array.isArray(shellWriteTargets(null, {})), true);
    eq(Array.isArray(shellWriteTargets(undefined, undefined)), true);
  });

  test("an ordinary command with no write mechanism reports nothing", () => {
    eq(shellWriteTargets("npx tsc -b", {}).length, 0);
  });

  /* --------------------------------------------------- catalogue pinning */

  /**
   * One command that actually exercises each mechanism `WRITE_MECHANISMS`
   * names, keyed by the exact mechanism string it must produce. Driving
   * these through `shellWriteTargets` itself — rather than only comparing
   * two hand-written string arrays — is what makes this a pin against real
   * behaviour: a mechanism added to the array without the code to back it,
   * or code that silently starts reporting a different string, both fail
   * this test the same way a removed mechanism would.
   */
  const MECHANISM_SAMPLES = {
    redirect: ["echo hi > src/a.ts", {}],
    tee: ["echo hi | tee src/a.ts", {}],
    "powershell-out-file": ["$code | Out-File src/a.ts", { powershell: true }],
    "powershell-set-content": ['Set-Content -Path src/a.ts -Value "x"', { powershell: true }],
    "powershell-add-content": ["Add-Content src/a.ts -Value x", { powershell: true }],
    "powershell-tee-object": ["Get-Content x | Tee-Object -FilePath src/a.ts", { powershell: true }],
    "sed-inplace": ["sed -i 's/a/b/' src/a.ts", {}],
    "perl-inplace": ["perl -pi -e 's/x/y/' src/a.ts", {}],
    "node-inline-write": ["node -e \"require('fs').writeFileSync('src/a.ts', s)\"", {}],
    "python-inline-write": ["python -c \"open('src/a.ts','w').write(s)\"", {}],
    "copy-move": ["cp somewhere.ts src/a.ts", {}],
    truncate: ["truncate -s 0 src/a.ts", {}],
    dd: ["dd of=src/a.ts if=/dev/zero", {}],
    "new-item-force": ["New-Item -Force -Path src/a.ts", { powershell: true }],
    xcopy: ["xcopy src/a.ts src/b.ts /Y", {}],
    robocopy: ["robocopy srcdir destdir /E", {}],
    "git-checkout": ["git checkout other-branch -- src/a.ts", {}],
    "git-restore": ["git restore src/a.ts", {}],
    "git-apply": ["git apply /tmp/some.patch", {}],
    "git-am": ["git am /tmp/mbox", {}],
    curl: ["curl -o src/a.ts https://example.invalid/x.tsx", {}],
    wget: ["wget -O src/a.ts https://example.invalid/x.tsx", {}],
    "invoke-webrequest": ["Invoke-WebRequest -Uri https://example.invalid/x.tsx -OutFile src/a.ts", { powershell: true }],
    "expand-archive": ["Expand-Archive -Path bundle.zip -DestinationPath src/components -Force", { powershell: true }],
    "tar-extract": ["tar -xf archive.tar -C src/components", {}],
    unzip: ["unzip bundle.zip -d src/components", {}],
  };

  test("WRITE_MECHANISMS is pinned: every named mechanism is reachable and nothing unnamed leaks out", () => {
    const sampleKeys = Object.keys(MECHANISM_SAMPLES).sort();
    deepEq(sampleKeys, WRITE_MECHANISMS.slice().sort(), "every catalogued mechanism must have a driving sample, and vice versa");

    const producedMechanisms = new Set();
    for (const [mechanism, [command, opts]] of Object.entries(MECHANISM_SAMPLES)) {
      const results = shellWriteTargets(command, opts);
      const found = byMechanism(results, mechanism);
      ok(found, `sample command for "${mechanism}" did not produce that mechanism: ${command}`);
      producedMechanisms.add(mechanism);
    }
    deepEq(
      Array.from(producedMechanisms).sort(),
      WRITE_MECHANISMS.slice().sort(),
      "the set of mechanisms actually reachable at runtime must match the catalogue exactly",
    );
  });
});
