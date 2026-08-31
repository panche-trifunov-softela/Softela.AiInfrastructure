# CI and branch protection

This is the developer-facing guide to `azure-pipelines.yml`: what it runs,
why, how to wire it into Azure DevOps the first time, and how to turn it
into a required gate on `main`. It assumes nothing about the reader beyond
having a browser open on this project's Azure DevOps organisation.

## What the pipeline runs, and why

`azure-pipelines.yml` at the repository root defines a single run — see
[Why one leg](#why-one-leg) below. It does, in order:

- **Check out the repository.**
- **Install Node.js 18** (`NodeTool@0`), the floor from `package.json`'s
  `engines` field, so the oldest supported version is actually exercised
  rather than assumed compatible.
- **Print `node`, `npm` and `git` versions.** Purely diagnostic — when a run
  goes red, the first thing worth knowing is exactly what environment it ran
  in, and that should be in the log without anyone having to re-run it.
- **Run `npm test -- --junit $(Common.TestResultsDirectory)/junit.xml`.**
  This is the whole suite (`tests/run.js`), writing a JUnit report to the
  path Azure DevOps' predefined `Common.TestResultsDirectory` variable
  points at, so the next step can pick it up.
- **Publish the JUnit report** (`PublishTestResults@2`), with
  `condition: succeededOrFailed()` so a red run still gets its results
  published — a pull request reviewer should see *which* tests failed, not
  just that the build did.
- **Verify the generated standards document is current**
  (`npm run build:check`, i.e. `node tools/build-standard.js --check`).
  `docs/standards/assembled/FRONTEND-ARCHITECTURE-STANDARD.md` is generated from the
  individual files in `docs/standards/`; this step fails the build if
  someone edited a part and forgot to regenerate the whole, instead of
  letting the generated file quietly drift out of sync.

There is deliberately no `npm install` step anywhere in this pipeline. This
repository ships zero npm dependencies — no `dependencies`, no
`devDependencies`, no `node_modules` — and its own `package-install-flags`
rule enforces that on itself. Nothing needs installing, restoring or
caching, which is also most of why this pipeline is fast.

### Why one leg

```yaml
pool:
  vmImage: "windows-latest"
```

One run, on Windows, on Node 18.

Windows is the platform every developer here actually runs, and Node 18 is
this repository's own `engines` floor. That combination is the single leg
that catches the most: code written against a newer Node API passes on a
newer leg and then fails on a developer machine nobody has upgraded, while
code that runs on the floor runs on every version above it.

More legs are not free — they cost build minutes on every pull request. Add
one when there is a failure it would have caught, not before. Two candidates
if that day comes: a Linux leg, to keep the cross-platform claim honest (no
shell dependency, no path-separator or line-ending assumption baked in), and
a current-LTS leg on Windows.

## Creating the pipeline in Azure DevOps (first time only)

1. Azure DevOps → this project → **Pipelines** → **New pipeline**.
2. **Where is your code?** → **Azure Repos Git**.
3. Select this repository (`Softela.AiInfrastructure`).
4. **Configure your pipeline** → **Existing Azure Pipelines YAML file**.
5. Branch `main`, path `/azure-pipelines.yml` → **Continue**.
6. Review the YAML Azure DevOps shows you (it should be exactly the checked-in
   file) → **Run**, or **Save** if you would rather trigger the first run
   yourself later.

That single pipeline definition is what both the `main`-branch CI trigger and
the pull-request trigger below run against — there is nothing further to
create.

## Protecting `main`

This is the part the pipeline exists to serve: once it exists, `main` can
require it before a pull request is allowed to complete.

1. Project settings → **Repos** → **Branches**.
2. Find `main` → **⋯** → **Branch policies** (or **Repos** → **Branches** →
   click `main` directly, depending on your Azure DevOps version).
3. Turn on:
   - **Require a minimum number of reviewers.** Pick a number the team
     agrees on; this is a people decision, not a technical one.
   - **Check for linked work items** — optional, team's call.
   - **Check for comment resolution** — require every PR comment thread to
     be resolved before completion.
   - **Build Validation** → **+ Add build policy** → select the pipeline
     created above → set it to **Required** → pick a reasonable
     **Build expiration** (e.g. "immediately" if the branch moves fast
     enough that a stale green build shouldn't count, or a short time
     window otherwise).
   - **Limit merge types**: the team squash-merges into `main`, so allow
     **Squash merge** (and disable the merge strategies the team does not
     use, so nobody picks one by accident).

With **Build Validation** set to **Required**, a pull request cannot
complete while the pipeline is red — which is exactly the outcome asked
for: every change to `main` goes through a pull request, and that pull
request cannot merge while `node tests/run.js` is failing.

## The honest limitation: what CI does not validate

`tests/probes/` empirically checks the real `claude` and `codex` binaries —
not this repository's own code, but facts about how each host CLI actually
behaves (hook-config shape, event-key casing, hook trust). A hosted Azure
DevOps agent has neither CLI installed, and installing them just for CI is
not currently worth the cost. So on every pipeline run, both probe files
report their cases as **skipped**, never as failed — the pipeline log shows
exactly this, with each skip's reason, and the summary line ends
`... skipped` rather than folding them into the pass count.

Concretely, this pipeline validates:

- the rule engine (`core/`) and every guard's decisions,
- the installer's install / update / uninstall behaviour,
- every opt-in module,
- the generated standards document staying in sync with its parts.

It does **not** validate that Claude Code or Codex actually behaves the way
`tests/probes/` says they do — that only happens where the real binaries are
installed, i.e. a developer machine, or a self-hosted agent that has them.
Do not read a green pipeline run as proof the host-CLI contract still holds;
read it as proof everything else does.

If the team ever wants the probes covered in CI too, the option is a
**self-hosted Azure DevOps agent** with both `claude` and `codex` installed
and authenticated, added as an additional job. Nothing in `tests/probes/`
needs to change for that — it already runs, and skips, based on what it
finds on `PATH`.

## Running the suite locally

```
npm test                              # the whole suite
node tests/run.js                     # identical — npm test just calls this
node tests/run.js guards/commit-message   # filter: only paths containing this substring
node tests/run.js probes/                 # both probe files only
```

Any number of positional arguments works as an `OR` of substring filters
against each test file's repository-relative path; without any, everything
runs.

Two flags, usable together with filters:

- **`--strict-skips`** turns every skipped probe into a failure. Never used
  in the pipeline — a hosted agent legitimately has neither CLI installed —
  but useful on your own machine to prove the probes actually ran rather
  than silently skipped, e.g. after installing or updating `claude` or
  `codex`:
  ```
  npm run test:strict-skips
  node tests/run.js probes/ --strict-skips
  ```
- **`--junit <path>`** writes a JUnit-XML report to `path`, the same report
  format the pipeline publishes. Mostly useful for feeding a local test
  results viewer; not needed for a normal local run.

The summary line reports all three counts:

```
=== 1350 passed, 0 failed, 0 skipped ===
```

When any probe's host CLI is missing, the skipped count reflects it instead
of folding into a false pass:

```
=== 1338 passed, 0 failed, 12 skipped ===
```
