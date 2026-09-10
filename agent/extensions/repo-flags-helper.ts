/**
 * repo-flags-helper: Persistent Repository Configuration for Pi Extensions
 *
 * Tracks repository-level flags (e.g. CFPD shield, Code Review gate)
 * in ~/.pi/agent/repo-flags.json.
 *
 * Supports dynamic repository resolution, typo detection, and the pointer syntax:
 *   `<repo> ->`  or  `-> <repo>`
 */

import * as os from "node:os";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  discoverAllUserRepos,
  findClosestRepo,
  type RepoInfo,
} from "./list-user-repos.ts";

export const REPO_FLAGS_FILE = path.join(
  os.homedir(),
  ".pi/agent/repo-flags.json"
);

export interface RepoFlagsConfig {
  repos: Record<string, Record<string, boolean>>;
}

export function loadRepoFlags(): RepoFlagsConfig {
  let config: RepoFlagsConfig = { repos: {} };

  try {
    if (fs.existsSync(REPO_FLAGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(REPO_FLAGS_FILE, "utf-8"));
      if (parsed && typeof parsed.repos === "object") {
        config = parsed;
      }
    }
  } catch {}

  return config;
}

export function saveRepoFlags(config: RepoFlagsConfig): void {
  try {
    fs.mkdirSync(path.dirname(REPO_FLAGS_FILE), { recursive: true });
    fs.writeFileSync(REPO_FLAGS_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save repo-flags:", err);
  }
}

export function getGitRoot(dir: string): string | null {
  try {
    return cp
      .execSync("git rev-parse --show-toplevel", {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .trim();
  } catch {
    return null;
  }
}

/**
 * Extracts target repository name from strings that may contain the pointer syntax:
 *   "my-project ->" => "my-project"
 *   "-> my-project" => "my-project"
 *   "my-project"    => "my-project"
 */
export function extractTargetRepoName(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  let trimmed = raw.trim();
  if (!trimmed || trimmed === "->") return null;

  if (trimmed.includes("->")) {
    const parts = trimmed.split("->").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      trimmed = parts[0];
    }
  }
  return trimmed || null;
}

export interface ResolvedRepoResult {
  gitRoot: string | null;
  targetRaw: string | null;
  exact: boolean;
  closestMatch: RepoInfo | null;
  allRepos: RepoInfo[];
}

/**
 * Resolves repository target with typo detection and fuzzy suggestion.
 */
export function resolveRepoWithDiagnostics(target: unknown, cwd: string): ResolvedRepoResult {
  const extracted = extractTargetRepoName(target);
  const allRepos = discoverAllUserRepos();

  // If no target provided, default to current git root
  if (!extracted) {
    const currentRoot = getGitRoot(cwd);
    return {
      gitRoot: currentRoot,
      targetRaw: null,
      exact: true,
      closestMatch: null,
      allRepos,
    };
  }

  // 1. Direct path check
  if (fs.existsSync(extracted) && fs.statSync(extracted).isDirectory()) {
    const root = getGitRoot(extracted);
    if (root) {
      return {
        gitRoot: root,
        targetRaw: extracted,
        exact: true,
        closestMatch: null,
        allRepos,
      };
    }
  }

  // 2. Exact match against all known repos
  for (const r of allRepos) {
    if (
      r.name.toLowerCase() === extracted.toLowerCase() ||
      r.path.toLowerCase() === extracted.toLowerCase()
    ) {
      return {
        gitRoot: r.path,
        targetRaw: extracted,
        exact: true,
        closestMatch: r,
        allRepos,
      };
    }
  }

  // 3. Typo / Substring fuzzy match
  const matchRes = findClosestRepo(extracted, allRepos);
  return {
    gitRoot: matchRes.exact && matchRes.match ? matchRes.match.path : null,
    targetRaw: extracted,
    exact: matchRes.exact,
    closestMatch: matchRes.match,
    allRepos,
  };
}

export function resolveRepoPath(target: unknown, cwd: string): string | null {
  const res = resolveRepoWithDiagnostics(target, cwd);
  return res.gitRoot || (res.closestMatch && res.exact ? res.closestMatch.path : null);
}

export function isRepoFlagEnabled(gitRoot: string | null, flagName: string): boolean {
  if (!gitRoot) return false;
  const config = loadRepoFlags();
  return Boolean(config.repos[gitRoot] && config.repos[gitRoot][flagName]);
}

export function setRepoFlag(gitRoot: string, flagName: string, enabled: boolean): void {
  const config = loadRepoFlags();
  config.repos[gitRoot] = config.repos[gitRoot] || {};
  if (enabled) {
    config.repos[gitRoot][flagName] = true;
  } else {
    delete config.repos[gitRoot][flagName];
    if (Object.keys(config.repos[gitRoot]).length === 0) {
      delete config.repos[gitRoot];
    }
  }
  saveRepoFlags(config);
}
