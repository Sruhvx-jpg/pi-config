/**
 * list-user-repos Extension for Pi
 *
 * Scans, indexes, and lists all local git repositories on user's system.
 *
 * Provides:
 * 1. Tool `list_user_repos`:
 *    Allows the assistant to inspect all available repositories, active branches,
 *    clean/dirty status, and active security flags (CFPD shield, Code Review gate).
 *    Used to resolve ambiguous targets, recommend closest typo matches, and populate
 *    interactive questions.
 * 2. Slash Command `/repos [query]` or `/list-repos`:
 *    Displays an interactive, high-contrast cyberpunk table of all discovered repos.
 * 3. Shared discovery & fuzzy matching engine for other extensions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as os from "node:os";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadRepoFlags } from "./repo-flags-helper.ts";

// ============================================================================
// Types
// ============================================================================
export interface RepoInfo {
  name: string;
  path: string;
  branch: string;
  isClean: boolean;
  flags: {
    cfpd?: boolean;
    reviewcode?: boolean;
    [k: string]: boolean | undefined;
  };
}

export interface MatchResult {
  match: RepoInfo | null;
  exact: boolean;
  score: number;
  suggestions: RepoInfo[];
}

// ============================================================================
// Repository Discovery Engine
// ============================================================================
const HOME = process.env.HOME || os.homedir();

const SEARCH_ROOTS = [
  path.join(HOME, "Documents/programming"),
  path.join(HOME, ".config"),
  path.join(HOME, ".pi"),
];

function getBranch(gitDir: string): string {
  try {
    return cp
      .execSync("git branch --show-current", {
        cwd: gitDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .trim() || "detached";
  } catch {
    return "unknown";
  }
}

function checkClean(gitDir: string): boolean {
  try {
    const status = cp
      .execSync("git status --porcelain", {
        cwd: gitDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .trim();
    return status.length === 0;
  } catch {
    return true;
  }
}

export function discoverAllUserRepos(): RepoInfo[] {
  const repoMap = new Map<string, RepoInfo>();
  const repoFlags = loadRepoFlags();

  function scanDir(dir: string, depth = 0, maxDepth = 2) {
    if (depth > maxDepth) return;
    try {
      const gitPath = path.join(dir, ".git");
      if (fs.existsSync(gitPath)) {
        const canonical = path.resolve(dir);
        if (!repoMap.has(canonical)) {
          let name = path.basename(canonical);
          if (canonical === path.join(HOME, ".pi") || name === ".pi") {
            name = "pi-config";
          } else if (canonical === path.join(HOME, ".config/doom")) {
            name = "doom-emacs-config";
          }
          const branch = getBranch(canonical);
          const isClean = checkClean(canonical);
          const flags = repoFlags.repos[canonical] || {};

          repoMap.set(canonical, {
            name,
            path: canonical,
            branch,
            isClean,
            flags,
          });
        }
        return; // Don't recurse inside a git repo
      }

      if (depth < maxDepth) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (
            e.isDirectory() &&
            !e.name.startsWith(".") &&
            e.name !== "node_modules" &&
            e.name !== "target" &&
            e.name !== "vendor" &&
            e.name !== "dist" &&
            e.name !== "build"
          ) {
            scanDir(path.join(dir, e.name), depth + 1, maxDepth);
          }
        }
      }
    } catch {}
  }

  // 1. Scan standard roots
  for (const root of SEARCH_ROOTS) {
    if (fs.existsSync(root)) {
      if (root.endsWith(".pi") || root.endsWith(".config/doom")) {
        scanDir(root, 0, 0);
      } else {
        scanDir(root, 0, 1);
      }
    }
  }

  // 2. Also check specifically for doom emacs if in ~/.config/doom
  const doomPath = path.join(HOME, ".config/doom");
  if (fs.existsSync(doomPath) && !repoMap.has(doomPath)) {
    scanDir(doomPath, 0, 0);
  }

  // Sort alphabetically by name
  return Array.from(repoMap.values()).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
}

// ============================================================================
// String Similarity & Fuzzy Matcher (Levenshtein Distance)
// ============================================================================
function levenshtein(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix: number[][] = Array.from({ length: bn + 1 }, () =>
    new Array(an + 1).fill(0)
  );
  for (let i = 0; i <= an; i++) matrix[0][i] = i;
  for (let j = 0; j <= bn; j++) matrix[j][0] = j;
  for (let j = 1; j <= bn; j++) {
    for (let i = 1; i <= an; i++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[j][i] = matrix[j - 1][i - 1];
      } else {
        matrix[j][i] = Math.min(
          matrix[j - 1][i] + 1,
          matrix[j][i - 1] + 1,
          matrix[j - 1][i - 1] + 1
        );
      }
    }
  }
  return matrix[bn][an];
}

export function findClosestRepo(query: string, repos: RepoInfo[]): MatchResult {
  const cleanQuery = query.replace(/->/g, "").trim().toLowerCase();
  if (!cleanQuery) {
    return { match: null, exact: false, score: 0, suggestions: repos.slice(0, 5) };
  }

  const queryNorm = cleanQuery.replace(/[^a-z0-9]/g, "");

  // Check 1: Exact match (case-insensitive or normalized)
  for (const r of repos) {
    if (r.name.toLowerCase() === cleanQuery || r.name.toLowerCase().replace(/[^a-z0-9]/g, "") === queryNorm) {
      return { match: r, exact: true, score: 1.0, suggestions: [r] };
    }
  }

  // Check 2: Substring / Prefix match
  const substringMatches = repos.filter(
    (r) =>
      r.name.toLowerCase().includes(cleanQuery) ||
      cleanQuery.includes(r.name.toLowerCase()) ||
      r.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(queryNorm)
  );

  if (substringMatches.length === 1) {
    return { match: substringMatches[0], exact: false, score: 0.9, suggestions: substringMatches };
  }

  // Check 3: Levenshtein distance for typos
  let bestMatch: RepoInfo | null = null;
  let bestDist = Infinity;
  const scored = repos.map((r) => {
    const dist = levenshtein(queryNorm, r.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = r;
    }
    return { repo: r, dist };
  });

  scored.sort((a, b) => a.dist - b.dist);
  const topSuggestions = scored.slice(0, 4).map((s) => s.repo);

  return {
    match: bestDist <= 4 ? bestMatch : null,
    exact: false,
    score: bestDist <= 4 ? Math.max(0.2, 1 - bestDist / 10) : 0,
    suggestions: substringMatches.length > 0 ? substringMatches : topSuggestions,
  };
}

// ============================================================================
// Box Renderer for Terminal UI
// ============================================================================
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[38;2;80;210;255m",
  boldCyan: "\x1b[1;38;2;0;225;225m",
  green: "\x1b[38;2;80;230;130m",
  red: "\x1b[38;2;255;85;105m",
  yellow: "\x1b[38;2;255;195;60m",
  purple: "\x1b[38;2;200;120;255m",
  border: "\x1b[38;2;75;105;140m",
  borderActive: "\x1b[38;2;120;170;240m",
  bgHeader: "\x1b[48;2;25;40;65;1;38;2;230;245;255m",
};

function renderRepoTable(repos: RepoInfo[], title = "USER LOCAL REPOSITORIES"): string {
  const width = Math.min(process.stdout.columns || 92, 98);
  const innerWidth = width - 4;
  const hr = "─".repeat(innerWidth);
  const doubleHr = "═".repeat(innerWidth);

  const lines: string[] = [];
  lines.push("");
  lines.push(`${C.borderActive}╔${doubleHr}╗${C.reset}`);
  lines.push(`${C.borderActive}║${C.reset}  ${C.bgHeader} 📂 ${title} (${repos.length} repos) ${C.reset}`.padEnd(width + 12) + `${C.borderActive}║${C.reset}`);
  lines.push(`${C.borderActive}╠${hr}╣${C.reset}`);

  for (const r of repos) {
    const cleanBadge = r.isClean ? `${C.green}clean${C.reset}` : `${C.yellow}dirty${C.reset}`;
    const flags: string[] = [];
    if (r.flags.cfpd) flags.push(`${C.red}🛡️ CFPD${C.reset}`);
    if (r.flags.reviewcode) flags.push(`${C.cyan}🔍 REVIEW${C.reset}`);
    const flagStr = flags.length > 0 ? ` [${flags.join(" ")}]` : "";

    const nameBranch = `${C.bold}${C.boldCyan}${r.name}${C.reset} (${C.purple}${r.branch}${C.reset}, ${cleanBadge})${flagStr}`;
    const shortPath = r.path.replace(HOME, "~");

    lines.push(`${C.border}║${C.reset}  ${nameBranch}`.padEnd(width + 20) + `${C.border}║${C.reset}`);
    lines.push(`${C.border}║${C.reset}    ${C.dim}${shortPath}${C.reset}`.padEnd(width + 8) + `${C.border}║${C.reset}`);
  }

  lines.push(`${C.borderActive}╚${doubleHr}╝${C.reset}`);
  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// Extension Entry Point
// ============================================================================
export default function (pi: ExtensionAPI) {
  // 1. Register Custom Tool: list_user_repos
  pi.registerTool({
    name: "list_user_repos",
    label: "list_user_repos",
    description:
      "List all local git repositories on user's system with active branch, dirty status, and persistent security flags (CFPD shield, Code Review gate). Use whenever target repository is ambiguous, omitted, or contains a typo.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Optional repository name, keyword, or typo to search/match against",
        })
      ),
      includeStatus: Type.Optional(
        Type.Boolean({
          description: "Whether to include git clean/dirty status (default: true)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const all = discoverAllUserRepos();

      if (params.query) {
        const matchRes = findClosestRepo(params.query, all);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query: params.query,
                  bestMatch: matchRes.match,
                  exactMatch: matchRes.exact,
                  matchScore: matchRes.score,
                  suggestions: matchRes.suggestions,
                  totalRepos: all.length,
                },
                null,
                2
              ),
            },
          ],
          details: { allReposCount: all.length },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(all, null, 2),
          },
        ],
        details: { count: all.length },
      };
    },
  });

  // 2. Register Slash Command: /repos [query]
  pi.registerCommand("repos", {
    description: "List all local git repositories with active branches, clean status, and extension locks",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      const all = discoverAllUserRepos();

      if (query) {
        const matchRes = findClosestRepo(query, all);
        if (matchRes.suggestions.length > 0) {
          console.log(renderRepoTable(matchRes.suggestions, `MATCHING REPOSITORIES FOR "${query}"`));
        } else {
          ctx.ui.notify(`No repositories matching "${query}".`, "warning");
        }
        return;
      }

      console.log(renderRepoTable(all, "LOCAL GIT REPOSITORIES"));
    },
  });
}
