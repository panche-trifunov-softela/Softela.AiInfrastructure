"use strict";

const { suite } = require("../harness");
const { decide, decision } = require("./_ctx");
const rule = require("../../core/guards/shell-file-write");

suite("guards/shell-file-write", ({ test, eq, ok }) => {
  /* -------------------------------------------------------- every mechanism, denied */

  const denyCases = [
    { label: "a plain output redirect", command: "echo x > src/components/Widget/index.ts" },
    { label: "an append redirect", command: "echo x >> src/components/Widget/index.ts" },
    { label: "a stderr-only redirect", command: "build 2> src/components/Widget/index.ts" },
    {
      label: "a heredoc combined with a redirect",
      command: "cat > src/components/Widget/index.ts <<'EOF'",
    },
    { label: "tee", command: "echo x | tee src/components/Widget/index.ts" },
    { label: "tee -a", command: "echo x | tee -a src/components/Widget/index.ts" },
    {
      label: "PowerShell Out-File",
      command: "$code | Out-File src/components/Widget/index.ts",
      toolName: "PowerShell",
    },
    {
      label: "PowerShell Set-Content",
      command: 'Set-Content -Path src/components/Widget/index.ts -Value "x"',
      toolName: "PowerShell",
    },
    {
      label: "PowerShell Add-Content",
      command: "Add-Content src/components/Widget/index.ts -Value x",
      toolName: "PowerShell",
    },
    {
      label: "PowerShell Tee-Object",
      command: "Get-Content x | Tee-Object -FilePath src/components/Widget/index.ts",
      toolName: "PowerShell",
    },
    { label: "sed -i", command: "sed -i 's/foo/bar/' src/components/Widget/index.ts" },
    {
      label: "sed --in-place",
      command: "sed --in-place -e 's/a/b/' src/components/Widget/index.ts",
    },
    { label: "perl -pi -e", command: "perl -pi -e 's/x/y/' src/components/Widget/index.ts" },
    { label: "perl -ni -e", command: "perl -ni -e 'print' src/components/Widget/index.ts" },
    {
      label: "node -e with fs.writeFileSync",
      command: "node -e \"require('fs').writeFileSync('src/components/Widget/index.ts', s)\"",
    },
    {
      label: "python -c with open(...,'w')",
      command: "python -c \"open('src/components/Widget/index.ts','w').write(s)\"",
    },
    { label: "cp destination", command: "cp somewhere.ts src/components/Widget/index.ts" },
    { label: "mv destination", command: "mv somewhere.ts src/components/Widget/index.ts" },
    {
      label: "Copy-Item -Destination",
      command: "Copy-Item -Path somewhere.ts -Destination src/components/Widget/index.ts",
      toolName: "PowerShell",
    },
    {
      label: "Move-Item positional",
      command: "Move-Item somewhere.ts src/components/Widget/index.ts",
      toolName: "PowerShell",
    },
    { label: "truncate -s", command: "truncate -s 0 src/components/Widget/index.ts" },
    { label: "dd of=", command: "dd of=src/components/Widget/index.ts if=/dev/zero" },
    {
      label: "New-Item -Force -Path",
      command: "New-Item -Force -Path src/components/Widget/index.ts",
      toolName: "PowerShell",
    },
  ];

  for (const c of denyCases) {
    test(`denies ${c.label} aimed at a governed source file`, () => {
      eq(decide(rule, { command: c.command, toolName: c.toolName }), "deny");
    });
  }

  test("the denial names the path and the mechanism, and carries a fix", () => {
    const result = decision(rule, { command: "sed -i 's/foo/bar/' src/components/Widget/index.ts" });
    ok(result.reason.includes("src/components/Widget/index.ts"), "reason should name the path");
    ok(result.reason.includes("sed-inplace"), "reason should name the mechanism");
    ok(result.fix.includes("Write") || result.fix.includes("apply_patch"), "fix should point at the write tool");
  });

  /* -------------------------------- ordinary ways of writing a file the guard used to miss */

  test("denies git checkout <ref> -- <path> aimed at a governed source file", () => {
    eq(decide(rule, { command: "git checkout other-branch -- src/components/Widget/index.ts" }), "deny");
  });

  test("denies git restore --source=<ref> <path> aimed at a governed source file", () => {
    eq(decide(rule, { command: "git restore --source=other-branch src/components/Widget/index.ts" }), "deny");
  });

  test("denies git restore --worktree <path>, explicit worktree with no --staged", () => {
    eq(decide(rule, { command: "git restore --worktree src/components/Widget/index.ts" }), "deny");
  });

  test("passes git restore --staged <path> — an index-only restore leaves the working tree untouched", () => {
    eq(decide(rule, { command: "git restore --staged src/components/Widget/index.ts" }), "pass");
  });

  test("passes git restore --staged . — the same, pathspec-wide", () => {
    eq(decide(rule, { command: "git restore --staged ." }), "pass");
  });

  test("denies git restore --staged --worktree <path> — the working tree is overwritten too", () => {
    eq(decide(rule, { command: "git restore --staged --worktree src/components/Widget/index.ts" }), "deny");
  });

  test("asks on git apply — the patch names its own targets, which the command line does not", () => {
    eq(decide(rule, { command: "git apply /tmp/some.patch" }), "ask");
  });

  test("asks on git am — same reasoning as git apply", () => {
    eq(decide(rule, { command: "git am /tmp/mbox" }), "ask");
  });

  test("passes git stash pop — restores the developer's own prior work, not unreviewed content", () => {
    eq(decide(rule, { command: "git stash pop" }), "pass");
  });

  test("passes git stash apply", () => {
    eq(decide(rule, { command: "git stash apply" }), "pass");
  });

  test("passes git revert — it moves commits, not unreviewed content", () => {
    eq(decide(rule, { command: "git revert HEAD~1" }), "pass");
  });

  test("passes git cherry-pick", () => {
    eq(decide(rule, { command: "git cherry-pick abc123" }), "pass");
  });

  test("passes a bare git checkout <branch> — ordinary branch switching is left unhandled", () => {
    eq(decide(rule, { command: "git checkout other-branch" }), "pass");
  });

  test("passes git stash push — it does not restore stashed content", () => {
    eq(decide(rule, { command: "git stash push" }), "pass");
  });

  test("denies curl -o aimed at a governed source file", () => {
    eq(decide(rule, { command: "curl -o src/components/Widget/index.ts https://example.invalid/x.tsx" }), "deny");
  });

  test("asks on curl -O — the file name comes from the URL, not the command line", () => {
    eq(decide(rule, { command: "curl -O https://example.invalid/x.tsx" }), "ask");
  });

  test("passes curl with neither -o nor -O — it streams to stdout, no write at all", () => {
    eq(decide(rule, { command: "curl https://example.invalid/x.tsx" }), "pass");
  });

  test("denies wget -O aimed at a governed source file", () => {
    eq(decide(rule, { command: "wget -O src/components/Widget/index.ts https://example.invalid/x.tsx" }), "deny");
  });

  test("denies Invoke-WebRequest -OutFile aimed at a governed source file", () => {
    eq(
      decide(rule, {
        command: "Invoke-WebRequest -Uri https://example.invalid/x.tsx -OutFile src/components/Widget/index.ts",
        toolName: "PowerShell",
      }),
      "deny",
    );
  });

  test("denies xcopy's destination operand when it names a governed source file", () => {
    eq(decide(rule, { command: "xcopy other/x.ts src/components/Widget/index.ts /Y" }), "deny");
  });

  test("asks on robocopy — a bulk directory copy whose exact members are never named", () => {
    eq(decide(rule, { command: "robocopy srcdir src/components/Widget /E" }), "ask");
  });

  test("asks on Expand-Archive — an extracted archive's members are never named on the command line", () => {
    eq(
      decide(rule, {
        command: "Expand-Archive -Path bundle.zip -DestinationPath src/components/Widget -Force",
        toolName: "PowerShell",
      }),
      "ask",
    );
  });

  test("asks on tar -x extracting into a governed source directory", () => {
    eq(decide(rule, { command: "tar -xf archive.tar -C src/components/Widget" }), "ask");
  });

  test("asks on unzip -d extracting into a governed source directory", () => {
    eq(decide(rule, { command: "unzip bundle.zip -d src/components/Widget" }), "ask");
  });

  test("passes Expand-Archive with no destination at all — extracting into the current directory", () => {
    eq(decide(rule, { command: "Expand-Archive -Path bundle.zip -Force", toolName: "PowerShell" }), "pass");
  });

  test("passes tar -xzf with no destination at all", () => {
    eq(decide(rule, { command: "tar -xzf node-fixture.tgz" }), "pass");
  });

  test("passes unzip with no destination at all", () => {
    eq(decide(rule, { command: "unzip bundle.zip" }), "pass");
  });

  test("passes robocopy whose destination sits under an excluded directory", () => {
    eq(decide(rule, { command: "robocopy srcdir node_modules/pkg /E" }), "pass");
  });

  test("passes Expand-Archive extracting into an excluded directory", () => {
    eq(
      decide(rule, {
        command: "Expand-Archive -Path bundle.zip -DestinationPath dist -Force",
        toolName: "PowerShell",
      }),
      "pass",
    );
  });

  /* ------------------------------------------ widened governed extensions: .md, .json */

  test("denies a redirect into a memory file's .md extension", () => {
    eq(decide(rule, { command: "cat >> ACTIVE-WORK.md <<'EOF'" }), "deny");
  });

  test("denies a heredoc write into a docs/standards/ .md file", () => {
    eq(decide(rule, { command: "cat > docs/standards/naming.md <<'EOF'" }), "deny");
  });

  test("denies sed -i aimed at a .json project config", () => {
    eq(decide(rule, { command: "sed -i 's/dev-ng/dev/' projects/Softela.ReactSCExpert.json" }), "deny");
  });

  test("denies a redirect into a module.json file", () => {
    eq(decide(rule, { command: "echo '{}' > modules/some-module/module.json" }), "deny");
  });

  /* --------------------------------------------- ordinary shell work stays silent */

  test("passes a redirect into a .lock file — a lock file is never governed", () => {
    eq(decide(rule, { command: "echo x > yarn.lock" }), "pass");
  });

  test("passes a redirect into package-lock.json's sibling .lock spelling", () => {
    eq(decide(rule, { command: "echo x > composer.lock" }), "pass");
  });

  test("passes a redirect into a .yml pipeline file — ordinary CI editing, deliberately ungoverned", () => {
    eq(decide(rule, { command: "echo x > azure-pipelines.yml" }), "pass");
  });

  test("passes a redirect into a .yaml config file — deliberately ungoverned", () => {
    eq(decide(rule, { command: "echo x > pnpm-lock.yaml" }), "pass");
  });

  test("passes npm test > run.log — a log file stays silent", () => {
    eq(decide(rule, { command: "npm test > run.log" }), "pass");
  });

  test("passes a redirect into a .md file that also sits under an excluded directory", () => {
    eq(decide(rule, { command: "echo x > dist/README.md" }), "pass");
  });

  test("passes a redirect into a .json file that also sits under an excluded directory", () => {
    eq(decide(rule, { command: "echo x > coverage/report.json" }), "pass");
  });

  test("passes a redirect into a .md file at an absolute path outside a known repository root", () => {
    eq(
      decide(rule, {
        command: "echo x > /outside/repo/notes.md",
        git: { repoRoot: "/repo" },
      }),
      "pass",
    );
  });

  test("passes sed -i into a .json file at an absolute path outside a known repository root", () => {
    eq(
      decide(rule, {
        command: "sed -i 's/a/b/' /outside/repo/config.json",
        git: { repoRoot: "/repo" },
      }),
      "pass",
    );
  });

  test("passes a redirect into a .json file nested under node_modules/, even with an unknown repository root", () => {
    eq(decide(rule, { command: "echo x > node_modules/pkg/package.json", git: { repoRoot: null } }), "pass");
  });

  test("passes New-Item without -Force aimed at a governed extension — it refuses to overwrite, so nothing is a write target", () => {
    eq(decide(rule, { command: "New-Item -Path src/components/Widget/index.ts", toolName: "PowerShell" }), "pass");
  });

  test("passes cp with only a source operand — nothing to name as the destination", () => {
    eq(decide(rule, { command: "cp src/components/Widget/index.ts" }), "pass");
  });

  test("passes a plain read of a memory file with no redirect at all — not a write target", () => {
    eq(decide(rule, { command: "cat ACTIVE-WORK.md" }), "pass");
  });

  test("passes tee into a .lock file", () => {
    eq(decide(rule, { command: "echo x | tee yarn.lock" }), "pass");
  });

  test("passes sed -i into a .log file", () => {
    eq(decide(rule, { command: "sed -i 's/a/b/' run.log" }), "pass");
  });

  test("passes a redirect into a dotfile with no extension at all", () => {
    eq(decide(rule, { command: "echo x > .gitignore" }), "pass");
  });

  /* ---------------------------------------------------- excluded directories pass */

  const excludedPathCases = [
    { label: "a redirect into dist/", command: "echo x > dist/bundle.js" },
    { label: "a redirect into node_modules/", command: "echo x > node_modules/x/index.js" },
    { label: "a redirect into coverage/", command: "echo x > coverage/lcov.info" },
    { label: "sed -i into build/", command: "sed -i 's/a/b/' build/x.ts" },
    { label: "cp into out/", command: "cp somewhere.ts out/x.ts" },
    { label: "tee into bin/", command: "echo x | tee bin/x.ts" },
    {
      label: "New-Item -Force into obj/",
      command: "New-Item -Force -Path obj/x.cs",
      toolName: "PowerShell",
    },
    {
      label: "Set-Content into .git/",
      command: "Set-Content -Path .git/x.ts",
      toolName: "PowerShell",
    },
    { label: "node -e into __pycache__/", command: "node -e \"require('fs').writeFileSync('__pycache__/x.js', s)\"" },
    {
      label: "Out-File into .next/",
      command: "$code | Out-File .next/x.ts",
      toolName: "PowerShell",
    },
  ];

  for (const c of excludedPathCases) {
    test(`passes ${c.label} — not source`, () => {
      eq(decide(rule, { command: c.command, toolName: c.toolName }), "pass");
    });
  }

  test("passes a redirect to an absolute path outside the repository root", () => {
    eq(
      decide(rule, {
        command: "echo x > /outside/repo/src/a.ts",
        git: { repoRoot: "/repo" },
      }),
      "pass",
    );
  });

  test("passes sed -i aimed at an absolute path outside the repository root", () => {
    eq(
      decide(rule, {
        command: "sed -i 's/a/b/' /outside/repo/src/a.ts",
        git: { repoRoot: "/repo" },
      }),
      "pass",
    );
  });

  /* --------------------------------------------------- an unknown repository root */

  test("denies echo hi > notes.md when the working directory is not a git repository — a null repoRoot is unknown, not outside", () => {
    eq(decide(rule, { command: "echo hi > notes.md", git: { repoRoot: null } }), "deny");
  });

  test("denies a heredoc write into a .tsx file when the working directory is not a git repository", () => {
    eq(decide(rule, { command: "cat > src/components/Widget/index.tsx <<'EOF'", git: { repoRoot: null } }), "deny");
  });

  test("denies an absolute governed-extension target when repoRoot is unknown — a null root excludes nothing on its own", () => {
    eq(
      decide(rule, {
        command: "sed -i 's/a/b/' /anywhere/src/components/Widget/index.ts",
        git: { repoRoot: null },
      }),
      "deny",
    );
  });

  test("still passes node_modules/ even when repoRoot is unknown — the directory exclusion holds independently", () => {
    eq(decide(rule, { command: "echo x > node_modules/x/index.js", git: { repoRoot: null } }), "pass");
  });

  test("still passes the OS temp directory even when repoRoot is unknown", () => {
    // Forward-slashed and unquoted on purpose: a quoted, backslash-laden
    // Windows path is a `shellWriteTargets` POSIX-dequoting concern
    // (`core/lib/shell-write.js`, not owned here) unrelated to what this
    // case exists to prove.
    const tmpPath = `${require("os").tmpdir().replace(/\\/g, "/")}/scratch.ts`;
    eq(decide(rule, { command: `echo x > ${tmpPath}`, git: { repoRoot: null } }), "pass");
  });

  test("passes an ungoverned extension when repoRoot is unknown — widened governance still stops at the extension list", () => {
    eq(decide(rule, { command: "echo x > notes.txt", git: { repoRoot: null } }), "pass");
  });

  /* -------------------------------------------------- ordinary work is unaffected */

  test("passes npm test > test.log — not a governed extension", () => {
    eq(decide(rule, { command: "npm test > test.log" }), "pass");
  });

  test("passes echo hi > notes.txt — not a governed extension", () => {
    eq(decide(rule, { command: "echo hi > notes.txt" }), "pass");
  });

  test("passes git diff > /dev/null — not a write target at all", () => {
    eq(decide(rule, { command: "git diff > /dev/null" }), "pass");
  });

  test("passes cmd 2>&1 — fd duplication, not a write target", () => {
    eq(decide(rule, { command: "cmd 2>&1" }), "pass");
  });

  test("passes an unrelated command entirely", () => {
    eq(decide(rule, { command: "npx tsc -b" }), "pass");
  });

  test("passes entirely for a non-shell tool call", () => {
    eq(decide(rule, { command: "sed -i 's/a/b/' src/components/Widget/index.ts", toolName: "Write" }), "pass");
  });

  /* -------------------------------------------------------- unextractable targets */

  test("an unresolved redirect variable asks, rather than being guessed at", () => {
    eq(decide(rule, { command: 'cmd > "$OUT"' }), "ask");
  });

  test("a PowerShell -Path argument set from a variable asks", () => {
    eq(decide(rule, { command: "Set-Content -Path $p", toolName: "PowerShell" }), "ask");
  });

  test("a node -e write call with a computed path asks, rather than passing in silence", () => {
    eq(
      decide(rule, {
        command: "node -e \"require('fs').writeFileSync(path.join(d,'a.ts'), s)\"",
      }),
      "ask",
    );
  });

  test("a python -c write call with a computed path asks, rather than passing in silence", () => {
    eq(decide(rule, { command: "python -c \"open(target,'w').write(s)\"" }), "ask");
  });

  test("a node -e read-only call through a variable path passes", () => {
    eq(
      decide(rule, {
        command: "node -e \"const s=require('fs').readFileSync(p,'utf8');console.log(s)\"",
      }),
      "pass",
    );
  });

  test("a python -c open() with no mode passes — it only reads", () => {
    eq(decide(rule, { command: 'python -c "print(open(p).read())"' }), "pass");
  });

  /* ------------------------------------------------------------- quote-masking */

  test("a > inside a quoted commit message is not a redirect", () => {
    eq(decide(rule, { command: 'git commit -m "a > b"' }), "pass");
  });

  test("a PowerShell -gt comparison inside a script block is not a redirect", () => {
    eq(
      decide(rule, {
        command: "Get-ChildItem | Where-Object { $_.Length -gt 5 }",
        toolName: "PowerShell",
      }),
      "pass",
    );
  });

  /* ------------------------------------------------------------------- evasion */

  test("a nested bash -c wrapper hiding a sed -i write is still denied", () => {
    eq(decide(rule, { command: "bash -c \"sed -i 's/a/b/' src/components/Widget/index.ts\"" }), "deny");
  });

  test("a PowerShell path with backslashes is denied without corruption", () => {
    eq(
      decide(rule, {
        command: "Set-Content -Path src\\components\\Widget\\index.ts",
        toolName: "PowerShell",
      }),
      "deny",
    );
  });

  /* ------------------------------------------------------------------ overrides */

  test("clamps to ask under a developer override", () => {
    eq(
      decide(rule, {
        command: "sed -i 's/foo/bar/' src/components/Widget/index.ts",
        overrideSpec: { "shell-file-write": { action: "ask" } },
      }),
      "ask",
    );
  });

  test("an allow override for this exact command drops the decision", () => {
    eq(
      decide(rule, {
        command: "sed -i 's/foo/bar/' src/components/Widget/index.ts",
        overrideSpec: { "shell-file-write": { allow: ["\\bsed\\s+-i\\b"] } },
      }),
      "pass",
    );
  });
});
