"use strict";

/**
 * Resolves the project configuration that applies to a working directory.
 *
 * Resolution never throws: an unreadable projects directory, an unreadable
 * project file, or a `cwd` outside any git repository all degrade to
 * `_default.json`, and even that failing degrades to a minimal safe object.
 */

const fs = require("fs");
const path = require("path");
const { readJson } = require("./fs-safe");
const { gitState } = require("./git-state");
const { repoRoot: infraRoot } = require("./paths");

/** Returned when even `_default.json` cannot be read. */
const MINIMAL_DEFAULT = Object.freeze({
  id: "_default",
  match: { remotes: [], paths: [] },
  baseBranches: [],
  releaseBranchPattern: null,
  branchNaming: null,
  protectedPaths: [],
  notOurs: [],
  commands: {},
  limits: {},
  conventions: {},
  memoryLocation: "repo",
  rules: {},
});

/**
 * Translates a simple glob into an anchored, case-insensitive regular
 * expression: `*` becomes `[^/]*` (one path segment), `**` becomes `.*`
 * (any number of segments).
 *
 * A `**` immediately followed by a separator is the one case that needs its
 * own branch. Translating the pair and the separator independently produces
 * `.*\/`, which requires a directory to actually be there, so a protection
 * written as a path anywhere in the tree silently stopped applying at the
 * one place it matters most: `**` + `/.env` matched `config/.env` but not
 * the repository-root `.env` that carries the credentials. `**` followed by
 * a separator therefore means "zero or more directories", not "one or more".
 *
 * @param {string} glob The glob pattern.
 * @returns {RegExp | null} The compiled regex, or `null` when `glob` is not
 * a string or fails to compile.
 */
function globToRegex(glob) {
  if (typeof glob !== "string") return null;
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      out += "(?:.*\\/)?";
      i += 3;
      continue;
    }
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 2;
      continue;
    }
    if (c === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if ("\\^$+?.()|[]{}".indexOf(c) !== -1) out += `\\${c}`;
    else out += c;
    i += 1;
  }
  try {
    return new RegExp(`^${out}$`, "i");
  } catch {
    return null;
  }
}

/**
 * Normalises a git remote URL down to a comparable `<prefix>/<RepoName>`
 * tail, so `git@host:org/repo.git`, `https://host/org/repo` and the Azure
 * DevOps `https://org@dev.azure.com/org/Project/_git/Repo` shape all
 * resolve to the same kind of value.
 *
 * @param {string} url The remote URL.
 * @returns {string} The two-segment tail, or `""` when `url` is empty.
 */
function normalizeRemoteTail(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  u = u.replace(/\.git$/i, "").replace(/\/+$/, "");

  const scp = u.match(/^[^/@]+@[^/:]+:(.+)$/);
  if (scp) {
    u = scp[1];
  } else {
    u = u.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    const slash = u.indexOf("/");
    u = slash === -1 ? "" : u.slice(slash + 1);
  }

  const segments = u.split("/").filter(Boolean);
  return segments.slice(-2).join("/");
}

/**
 * Loads every project configuration file in a directory.
 *
 * @param {string} projectsDir The directory holding `*.json` project files.
 * @returns {object[]} The parsed project objects; entries that fail to
 * parse are skipped. An empty array when the directory cannot be read.
 */
function loadAllProjects(projectsDir) {
  let files;
  try {
    files = fs.readdirSync(projectsDir).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    return [];
  }
  const projects = [];
  for (const file of files) {
    const data = readJson(path.join(projectsDir, file));
    if (data && typeof data === "object") projects.push(data);
  }
  return projects;
}

/**
 * Caches `_default.json` per projects directory.
 *
 * The engine layers the defaults under the matched project on every single
 * evaluation, and a hook process is short-lived enough that the file cannot
 * change underneath one: re-reading it per tool call bought nothing and
 * showed up directly in the dispatch budget a busy machine has to fit into.
 * Keyed by directory so a test pointing at its own fixtures never collides
 * with the shipped file.
 */
const defaultProjectCache = new Map();

/**
 * Loads the shipped default configuration on its own.
 *
 * `resolveProject` returns this only when nothing matched. The engine needs
 * it in the other case too — as the layer underneath a matched project, so
 * naming a repository adds protections to it rather than replacing the ones
 * every repository gets (`lib/config-merge.js`).
 *
 * @param {{projectsDir?: string}} [options] `projectsDir` overrides the
 * default `<repoRoot>/projects` location, mainly for tests.
 * @returns {object|null} The parsed `_default.json`, or `null` when it
 * cannot be read.
 */
function loadDefaultProject(options = {}) {
  try {
    const projectsDir = options.projectsDir || path.join(infraRoot(), "projects");
    if (defaultProjectCache.has(projectsDir)) return defaultProjectCache.get(projectsDir);

    const loaded = readJson(path.join(projectsDir, "_default.json"));
    defaultProjectCache.set(projectsDir, loaded);
    return loaded;
  } catch {
    return null;
  }
}

/**
 * Resolves the project configuration for a working directory.
 *
 * @param {string} cwd The working directory to resolve from.
 * @param {{projectsDir?: string}} [options] `projectsDir` overrides the
 * default `<repoRoot>/projects` location, mainly for tests.
 * @returns {object} The matched project, `_default.json`'s content when
 * nothing matches, or a minimal safe object when even that is unreadable.
 * Never `null`, never throws.
 */
function resolveProject(cwd, options = {}) {
  try {
    const projectsDir = options.projectsDir || path.join(infraRoot(), "projects");
    const projects = loadAllProjects(projectsDir);
    const state = gitState(cwd);

    const remoteTail = normalizeRemoteTail(state.remote || "");
    if (remoteTail) {
      for (const project of projects) {
        if (project.id === "_default") continue;
        const remotes = (project.match && project.match.remotes) || [];
        for (const pattern of remotes) {
          const re = globToRegex(pattern);
          if (re && re.test(remoteTail)) return project;
        }
      }
    }

    const repoRoot = state.repoRoot;
    const basename = repoRoot ? path.basename(repoRoot) : "";
    if (basename) {
      for (const project of projects) {
        if (project.id === "_default") continue;
        const paths = (project.match && project.match.paths) || [];
        for (const pattern of paths) {
          const re = globToRegex(pattern);
          if (re && re.test(basename)) return project;
        }
      }
    }

    const fallback = projects.find((p) => p.id === "_default");
    return fallback || { ...MINIMAL_DEFAULT };
  } catch {
    return { ...MINIMAL_DEFAULT };
  }
}

module.exports = { resolveProject, loadAllProjects, loadDefaultProject, globToRegex, normalizeRemoteTail };
