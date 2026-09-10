/**
 * cfpd-guard Extension for Pi
 *
 * Commit For Personal Data (CFPD) Pre-Commit Guard & Daemon:
 * - Scans git staged commits for personal identifiable information (PII),
 *   personal emails, API keys, private keys, auth tokens, and sensitive files.
 * - Flags:
 *     --ext-reviewCFPD: Enable CFPD scanner for the active session.
 *     --ext-always-on / --ext-alwayson: Permanently lock CFPD for the repo.
 *                                       Supports `<repo> ->` pointer syntax.
 *     --ext-off:                        Deactivates permanent lock for the repo.
 * - Intercepts:
 *     `git commit` in both bash tool calls and interactive `!` user bash.
 * - Commands:
 *     `/cfpd [status|scan|always-on [repo ->]|off [repo ->]]`
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getGitRoot,
  isRepoFlagEnabled,
  resolveRepoPath,
  resolveRepoWithDiagnostics,
  setRepoFlag,
} from "./repo-flags-helper.ts";

const SCANNER_BIN = path.join(os.homedir(), ".pi/agent/bin/cfpd-scanner");
const HOOK_TAG = "# CFPD Pre-Commit Guard (Installed by Pi cfpd-guard)";

// ============================================================================
// Git Pre-Commit Hook Installer / Uninstaller
// ============================================================================
function installGitHook(gitRoot: string): boolean {
  try {
    const hooksDir = path.join(gitRoot, ".git", "hooks");
    const hookPath = path.join(hooksDir, "pre-commit");

    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const hookSnippet = `\n${HOOK_TAG}\nif [ -x "${SCANNER_BIN}" ]; then\n  "${SCANNER_BIN}"\n  EXIT_CODE=$?\n  if [ $EXIT_CODE -ne 0 ]; then\n    exit $EXIT_CODE\n  fi\nfi\n`;

    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, "utf-8");
      if (!existing.includes(HOOK_TAG)) {
        fs.writeFileSync(hookPath, existing + hookSnippet, { mode: 0o755 });
      }
    } else {
      fs.writeFileSync(hookPath, `#!/bin/sh${hookSnippet}`, { mode: 0o755 });
    }
    return true;
  } catch {
    return false;
  }
}

function removeGitHook(gitRoot: string): boolean {
  try {
    const hookPath = path.join(gitRoot, ".git", "hooks", "pre-commit");
    if (!fs.existsSync(hookPath)) return true;

    const content = fs.readFileSync(hookPath, "utf-8");
    if (!content.includes(HOOK_TAG)) return true;

    const cleaned = content
      .split("\n")
      .filter((line) => !line.includes("cfpd-scanner") && !line.includes(HOOK_TAG) && !line.includes("CFPD Pre-Commit Guard"))
      .join("\n")
      .trim();

    if (!cleaned || cleaned === "#!/bin/sh") {
      fs.unlinkSync(hookPath);
    } else {
      fs.writeFileSync(hookPath, cleaned + "\n", { mode: 0o755 });
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Scanner Invocation Helper
// ============================================================================
interface Finding {
  ruleId: string;
  ruleName: string;
  severity: string;
  file: string;
  line: number;
  snippet: string;
  redacted: string;
}

function runScanner(cwd: string): Finding[] {
  try {
    const output = cp.execSync(`"${SCANNER_BIN}" --json`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch (err: any) {
    if (err && err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {}
    }
    return [];
  }
}

function isGitCommitCommand(command: string): boolean {
  if (!command) return false;
  if (/\b--no-verify\b/.test(command)) return false;
  return /\bgit\s+(?:-[^\s]+\s+)*commit\b/i.test(command);
}

// ============================================================================
// Extension Entry Point
// ============================================================================
export default function (pi: ExtensionAPI) {
  // 1. Register CLI Flags
  pi.registerFlag("ext-reviewCFPD", {
    description: "Commit For Personal Data (CFPD): scan staged git commits for personal/sensitive data",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ext-review-cfpd", {
    description: "Alias for --ext-reviewCFPD",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ext-review-CFPD", {
    description: "Alias for --ext-reviewCFPD",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ext-always-on", {
    description: "Permanently lock paired extension flag for repository (supports <repo> -> pointer)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ext-alwayson", {
    description: "Alias for --ext-always-on",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ext-off", {
    description: "Permanently deactivate paired extension flag for repository (supports <repo> -> pointer)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("repo", {
    description: "Target repository name or path for paired extension actions (e.g. my-project ->)",
    type: "string",
  });

  // Session Start: Handle paired modifier flags and initialize status
  pi.on("session_start", async (_event, ctx) => {
    const flagCfpd = Boolean(
      pi.getFlag("ext-reviewCFPD") ||
      pi.getFlag("ext-review-cfpd") ||
      pi.getFlag("ext-review-CFPD")
    );
    const alwaysOnVal = pi.getFlag("ext-always-on") ?? pi.getFlag("ext-alwayson");
    const offVal = pi.getFlag("ext-off");
    const repoFlagVal = pi.getFlag("repo");

    // Resolve target repo hint (from flag value or --repo flag)
    const targetHint = (typeof alwaysOnVal === "string" ? alwaysOnVal : null)
      || (typeof offVal === "string" ? offVal : null)
      || (typeof repoFlagVal === "string" ? repoFlagVal : null);

    const targetGitRoot = resolveRepoPath(targetHint, ctx.cwd);

    if (flagCfpd && targetGitRoot) {
      if (Boolean(alwaysOnVal)) {
        setRepoFlag(targetGitRoot, "cfpd", true);
        installGitHook(targetGitRoot);
        ctx.ui.notify(`🛡️ CFPD: Repository permanently locked with pre-commit guard: ${path.basename(targetGitRoot)}`, "info");
      } else if (Boolean(offVal)) {
        setRepoFlag(targetGitRoot, "cfpd", false);
        removeGitHook(targetGitRoot);
        ctx.ui.notify(`🛡️ CFPD: Permanent lock removed for: ${path.basename(targetGitRoot)}`, "info");
      }
    }

    const currentGitRoot = getGitRoot(ctx.cwd);
    const isLocked = isRepoFlagEnabled(currentGitRoot, "cfpd");
    const active = flagCfpd || isLocked;

    if (active) {
      const tag = isLocked ? "CFPD: LOCKED" : "CFPD: ON";
      ctx.ui.setStatus("cfpd", `🛡️ ${tag}`);
    }
  });

  // Intercept `bash` tool calls before execution
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input?.command || "");
    if (!isGitCommitCommand(command)) return;

    const currentGitRoot = getGitRoot(ctx.cwd);
    const active =
      Boolean(
        pi.getFlag("ext-reviewCFPD") ||
        pi.getFlag("ext-review-cfpd") ||
        pi.getFlag("ext-review-CFPD")
      ) || isRepoFlagEnabled(currentGitRoot, "cfpd");

    if (!active) return;

    // Run CFPD scan on staged diff
    const findings = runScanner(ctx.cwd);
    if (findings.length === 0) return;

    if (ctx.hasUI) {
      const choice = await ctx.ui.select(
        "🛡️ CFPD Guard: Block Personal Data Leak",
        [
          "1. Abort Commit (Recommended - prevent data leak)",
          "2. Override & Commit Anyway",
        ]
      );

      if (!choice || choice.startsWith("1.")) {
        return {
          block: true,
          reason: `CFPD: Commit aborted to prevent personal/sensitive data leak (${findings.length} findings). Run 'git restore --staged <file>' to fix.`,
        };
      }
      ctx.ui.notify("CFPD: Override accepted for this commit.", "warning");
    } else {
      return {
        block: true,
        reason: `CFPD: Commit blocked. Detected ${findings.length} personal/sensitive data leaks in staged changes.`,
      };
    }
  });

  // Intercept interactive `!` user bash commands
  pi.on("user_bash", async (event, ctx) => {
    if (!isGitCommitCommand(event.command)) return;

    const currentGitRoot = getGitRoot(ctx.cwd);
    const active =
      Boolean(
        pi.getFlag("ext-reviewCFPD") ||
        pi.getFlag("ext-review-cfpd") ||
        pi.getFlag("ext-review-CFPD")
      ) || isRepoFlagEnabled(currentGitRoot, "cfpd");

    if (!active) return;

    const findings = runScanner(ctx.cwd);
    if (findings.length === 0) return;

    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "🛡️ CFPD Guard: Sensitive Data Leak Detected",
        `Staged changes contain ${findings.length} personal or confidential leaks. Abort commit?`
      );
      if (ok) {
        return {
          result: {
            output: "CFPD: Commit aborted by user.",
            exitCode: 1,
            cancelled: true,
            truncated: false,
          },
        };
      }
    }
  });

  // Register command: /cfpd [status|scan|always-on [repo ->]|off [repo ->]]
  pi.registerCommand("cfpd", {
    description: "Commit For Personal Data (CFPD) guard: check staged files or manage repository lock",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = (parts[0] || "").toLowerCase();
      const targetHint = parts.slice(1).join(" ") || null;
      const targetGitRoot = resolveRepoPath(targetHint, ctx.cwd);

      if (sub === "scan") {
        const findings = runScanner(targetGitRoot || ctx.cwd);
        if (findings.length === 0) {
          ctx.ui.notify("✔ CFPD: Staged files are clean. No sensitive leaks found.", "info");
        } else {
          ctx.ui.notify(`⚠️ CFPD: Detected ${findings.length} sensitive item(s) staged!`, "error");
          const summary = findings
            .map((f) => `• [${f.severity}] ${f.ruleName} in ${f.file} (${f.redacted})`)
            .join("\n");
          ctx.ui.notify(summary, "warning");
        }
        return;
      }

      if (sub === "always-on" || sub === "lock" || sub === "on") {
        const diag = resolveRepoWithDiagnostics(targetHint, ctx.cwd);
        let finalRoot = diag.gitRoot;

        if (!finalRoot && ctx.hasUI) {
          if (diag.closestMatch) {
            const pick = await ctx.ui.select(
              `Repo "${diag.targetRaw}" not found. Did you mean "${diag.closestMatch.name}"?`,
              [
                `1. Yes, use "${diag.closestMatch.name}"`,
                "2. Choose from all repositories",
                "3. Cancel",
              ]
            );
            if (pick?.startsWith("1.")) {
              finalRoot = diag.closestMatch.path;
            } else if (pick?.startsWith("2.")) {
              const options = diag.allRepos.map((r) => `${r.name} (${r.branch}) -> ${r.path}`);
              const chosen = await ctx.ui.select("Select target repository:", options);
              if (chosen) {
                const found = diag.allRepos.find((r) => r.name === chosen.split(" ")[0]);
                if (found) finalRoot = found.path;
              }
            }
          } else {
            const options = diag.allRepos.map((r) => `${r.name} (${r.branch}) -> ${r.path}`);
            const chosen = await ctx.ui.select("Select repository to lock with CFPD:", options);
            if (chosen) {
              const found = diag.allRepos.find((r) => r.name === chosen.split(" ")[0]);
              if (found) finalRoot = found.path;
            }
          }
        }

        if (!finalRoot) {
          ctx.ui.notify(`CFPD: No repository selected.`, "warning");
          return;
        }

        setRepoFlag(finalRoot, "cfpd", true);
        installGitHook(finalRoot);
        ctx.ui.setStatus("cfpd", "🛡️ CFPD: LOCKED");
        ctx.ui.notify(`✔ CFPD: Permanently locked for ${path.basename(finalRoot)}. Pre-commit hook installed.`, "info");
        return;
      }

      if (sub === "off" || sub === "unlock") {
        const diag = resolveRepoWithDiagnostics(targetHint, ctx.cwd);
        let finalRoot = diag.gitRoot;

        if (!finalRoot && ctx.hasUI) {
          if (diag.closestMatch) {
            const pick = await ctx.ui.select(
              `Repo "${diag.targetRaw}" not found. Did you mean "${diag.closestMatch.name}"?`,
              [
                `1. Yes, remove lock on "${diag.closestMatch.name}"`,
                "2. Choose from all repositories",
                "3. Cancel",
              ]
            );
            if (pick?.startsWith("1.")) {
              finalRoot = diag.closestMatch.path;
            } else if (pick?.startsWith("2.")) {
              const options = diag.allRepos.map((r) => `${r.name} (${r.branch}) -> ${r.path}`);
              const chosen = await ctx.ui.select("Select target repository:", options);
              if (chosen) {
                const found = diag.allRepos.find((r) => r.name === chosen.split(" ")[0]);
                if (found) finalRoot = found.path;
              }
            }
          } else {
            const options = diag.allRepos.map((r) => `${r.name} (${r.branch}) -> ${r.path}`);
            const chosen = await ctx.ui.select("Select repository to remove CFPD lock:", options);
            if (chosen) {
              const found = diag.allRepos.find((r) => r.name === chosen.split(" ")[0]);
              if (found) finalRoot = found.path;
            }
          }
        }

        if (!finalRoot) {
          ctx.ui.notify(`CFPD: No repository selected.`, "warning");
          return;
        }

        setRepoFlag(finalRoot, "cfpd", false);
        removeGitHook(finalRoot);
        ctx.ui.setStatus("cfpd", "");
        ctx.ui.notify(`CFPD: Removed permanent lock for ${path.basename(finalRoot)}.`, "info");
        return;
      }

      // Default: Status
      const currentGitRoot = getGitRoot(ctx.cwd);
      const isLocked = isRepoFlagEnabled(currentGitRoot, "cfpd");
      const isFlagOn = Boolean(
        pi.getFlag("ext-reviewCFPD") ||
        pi.getFlag("ext-review-cfpd") ||
        pi.getFlag("ext-review-CFPD")
      );
      const repoName = currentGitRoot ? path.basename(currentGitRoot) : "none";

      const statusMsg = [
        `CFPD Guard Status:`,
        `  • Active for session (--ext-reviewCFPD): ${isFlagOn ? "YES" : "NO"}`,
        `  • Current Repo (${repoName}): ${isLocked ? "LOCKED (Always-On)" : "NOT LOCKED"}`,
        `Commands:`,
        `  /cfpd scan                       - Test staged diff for leaks`,
        `  /cfpd always-on [repo ->]        - Permanently protect repo`,
        `  /cfpd off [repo ->]              - Disable permanent protection`,
      ].join("\n");

      ctx.ui.notify(statusMsg, "info");
    },
  });
}
