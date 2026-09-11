/**
 * cfpd-guard Extension for Pi
 *
 * Commit For Personal Data (CFPD) Pre-Commit Guard & Daemon:
 * - Scans git staged commits for personal identifiable information (PII),
 *   personal emails, API keys, private keys, auth tokens, and sensitive files.
 * - Managed directly via `/cfpd` slash command with interactive repository selector.
 * - Intercepts:
 *     `git commit` in both bash tool calls and interactive `!` user bash.
 * - Commands:
 *     `/cfpd`                 - Open interactive repository picker to enable/disable CFPD
 *     `/cfpd scan`            - Run CFPD scanner on staged files now
 *     `/cfpd <repo>`          - Toggle CFPD for specific repository (supports pointer syntax)
 *     `/cfpd on <repo>`       - Explicitly enable CFPD for repository
 *     `/cfpd off <repo>`      - Explicitly disable CFPD for repository
 *     `/cfpd status`          - View CFPD status across all local repositories
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  discoverAllUserRepos,
  type RepoInfo,
} from "./list-user-repos.ts";
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
  // Session Start: Initialize status badge for current repository
  pi.on("session_start", async (_event, ctx) => {
    const currentGitRoot = getGitRoot(ctx.cwd);
    if (isRepoFlagEnabled(currentGitRoot, "cfpd")) {
      ctx.ui.setStatus("cfpd", "🛡️ CFPD: ON");
    } else {
      ctx.ui.setStatus("cfpd", undefined);
    }
  });

  // Intercept `bash` tool calls before execution
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input?.command || "");
    if (!isGitCommitCommand(command)) return;

    const currentGitRoot = getGitRoot(ctx.cwd);
    if (!isRepoFlagEnabled(currentGitRoot, "cfpd")) return;

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
    if (!isRepoFlagEnabled(currentGitRoot, "cfpd")) return;

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

  // Register command: /cfpd [scan|status|on <repo>|off <repo>|<repo>]
  pi.registerCommand("cfpd", {
    description: "Commit For Personal Data (CFPD) guard: manage repository protection and scan staged commits",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "").toLowerCase();

      // Subcommand: /cfpd scan
      if (sub === "scan") {
        const currentGitRoot = getGitRoot(ctx.cwd);
        const scanTarget = currentGitRoot || ctx.cwd;
        const findings = runScanner(scanTarget);
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

      // Subcommand: /cfpd status
      if (sub === "status") {
        const allRepos = discoverAllUserRepos();
        const currentGitRoot = getGitRoot(ctx.cwd);
        const lines = allRepos.map((r) => {
          const isCurrent = currentGitRoot && path.resolve(r.path) === path.resolve(currentGitRoot);
          const isEnabled = isRepoFlagEnabled(r.path, "cfpd");
          const badge = isEnabled ? "● PROTECTED" : "○ OFF";
          const curr = isCurrent ? " [CURRENT]" : "";
          return `  ${badge.padEnd(14)} ${r.name}${curr} (${r.branch})`;
        });
        ctx.ui.notify(`CFPD Repository Status:\n${lines.join("\n")}`, "info");
        return;
      }

      // Subcommand: /cfpd on [repo] / /cfpd enable [repo]
      if (sub === "on" || sub === "enable") {
        const targetHint = parts.slice(1).join(" ") || null;
        const diag = resolveRepoWithDiagnostics(targetHint, ctx.cwd);
        const targetRoot = diag.gitRoot || (diag.closestMatch && diag.exact ? diag.closestMatch.path : null);

        if (!targetRoot) {
          ctx.ui.notify(`CFPD: Repository not found "${targetHint || "current"}".`, "error");
          return;
        }

        setRepoFlag(targetRoot, "cfpd", true);
        installGitHook(targetRoot);
        const currentGitRoot = getGitRoot(ctx.cwd);
        if (currentGitRoot && path.resolve(targetRoot) === path.resolve(currentGitRoot)) {
          ctx.ui.setStatus("cfpd", "🛡️ CFPD: ON");
        }
        ctx.ui.notify(`✔ CFPD: Protection ENABLED for ${path.basename(targetRoot)} (pre-commit hook installed).`, "info");
        return;
      }

      // Subcommand: /cfpd off [repo] / /cfpd disable [repo]
      if (sub === "off" || sub === "disable") {
        const targetHint = parts.slice(1).join(" ") || null;
        const diag = resolveRepoWithDiagnostics(targetHint, ctx.cwd);
        const targetRoot = diag.gitRoot || (diag.closestMatch && diag.exact ? diag.closestMatch.path : null);

        if (!targetRoot) {
          ctx.ui.notify(`CFPD: Repository not found "${targetHint || "current"}".`, "error");
          return;
        }

        setRepoFlag(targetRoot, "cfpd", false);
        removeGitHook(targetRoot);
        const currentGitRoot = getGitRoot(ctx.cwd);
        if (currentGitRoot && path.resolve(targetRoot) === path.resolve(currentGitRoot)) {
          ctx.ui.setStatus("cfpd", undefined);
        }
        ctx.ui.notify(`CFPD: Protection DISABLED for ${path.basename(targetRoot)} (pre-commit hook removed).`, "info");
        return;
      }

      // If a specific repo target was passed directly: /cfpd <repo>
      if (trimmed.length > 0) {
        const diag = resolveRepoWithDiagnostics(trimmed, ctx.cwd);
        let finalRoot = diag.gitRoot;

        if (!finalRoot && diag.closestMatch && diag.exact) {
          finalRoot = diag.closestMatch.path;
        }

        if (!finalRoot && ctx.hasUI && diag.closestMatch) {
          const pick = await ctx.ui.select(
            `Repo "${diag.targetRaw}" not found. Did you mean "${diag.closestMatch.name}"?`,
            [
              `1. Yes, toggle "${diag.closestMatch.name}"`,
              "2. Cancel",
            ]
          );
          if (pick?.startsWith("1.")) {
            finalRoot = diag.closestMatch.path;
          }
        }

        if (!finalRoot) {
          ctx.ui.notify(`CFPD: Could not resolve repository "${trimmed}".`, "error");
          return;
        }

        const currentlyEnabled = isRepoFlagEnabled(finalRoot, "cfpd");
        const nextState = !currentlyEnabled;
        setRepoFlag(finalRoot, "cfpd", nextState);

        const currentGitRoot = getGitRoot(ctx.cwd);
        if (currentGitRoot && path.resolve(finalRoot) === path.resolve(currentGitRoot)) {
          ctx.ui.setStatus("cfpd", nextState ? "🛡️ CFPD: ON" : undefined);
        }

        if (nextState) {
          installGitHook(finalRoot);
          ctx.ui.notify(`✔ CFPD: Protection ENABLED for ${path.basename(finalRoot)} (pre-commit hook installed).`, "info");
        } else {
          removeGitHook(finalRoot);
          ctx.ui.notify(`CFPD: Protection DISABLED for ${path.basename(finalRoot)} (pre-commit hook removed).`, "info");
        }
        return;
      }

      // No arguments: Interactive repository selector loop
      if (!ctx.hasUI) {
        const allRepos = discoverAllUserRepos();
        const currentGitRoot = getGitRoot(ctx.cwd);
        const lines = allRepos.map((r) => {
          const isCurrent = currentGitRoot && path.resolve(r.path) === path.resolve(currentGitRoot);
          const isEnabled = isRepoFlagEnabled(r.path, "cfpd");
          const badge = isEnabled ? "● PROTECTED" : "○ OFF";
          const curr = isCurrent ? " [CURRENT]" : "";
          return `  ${badge.padEnd(14)} ${r.name}${curr} (${r.branch})`;
        });
        ctx.ui.notify(`CFPD Repository Status:\n${lines.join("\n")}`, "info");
        return;
      }

      while (true) {
        const allRepos = discoverAllUserRepos();
        const currentGitRoot = getGitRoot(ctx.cwd);

        // Sort repos: current repo first, then protected repos, then alphabetical
        const sorted = [...allRepos].sort((a, b) => {
          const aIsCurrent = currentGitRoot && path.resolve(a.path) === path.resolve(currentGitRoot);
          const bIsCurrent = currentGitRoot && path.resolve(b.path) === path.resolve(currentGitRoot);
          if (aIsCurrent) return -1;
          if (bIsCurrent) return 1;

          const aEnabled = isRepoFlagEnabled(a.path, "cfpd");
          const bEnabled = isRepoFlagEnabled(b.path, "cfpd");
          if (aEnabled && !bEnabled) return -1;
          if (!aEnabled && bEnabled) return 1;

          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });

        const options: string[] = [];
        const repoMap = new Map<string, RepoInfo>();

        for (const r of sorted) {
          const isCurrent = currentGitRoot && path.resolve(r.path) === path.resolve(currentGitRoot);
          const isEnabled = isRepoFlagEnabled(r.path, "cfpd");
          const statusBadge = isEnabled ? "● [PROTECTED]  " : "○ [UNPROTECTED]";
          const currentBadge = isCurrent ? " ⭐ (current)" : "";
          const action = isEnabled ? "-> Click to Disable" : "-> Click to Enable";
          const label = `${statusBadge} ${r.name}${currentBadge} (${r.branch}) ${action}`;
          options.push(label);
          repoMap.set(label, r);
        }

        options.push("🔍 Scan staged files in current repository");
        options.push("✔ Done");

        const selection = await ctx.ui.select(
          "🛡️ CFPD Guard: Manage Protected Repositories",
          options
        );

        if (!selection || selection === "✔ Done") {
          break;
        }

        if (selection.startsWith("🔍 Scan")) {
          const scanTarget = currentGitRoot || ctx.cwd;
          const findings = runScanner(scanTarget);
          if (findings.length === 0) {
            ctx.ui.notify("✔ CFPD: Staged files are clean. No sensitive leaks found.", "info");
          } else {
            ctx.ui.notify(`⚠️ CFPD: Detected ${findings.length} sensitive item(s) staged!`, "error");
            const summary = findings
              .map((f) => `• [${f.severity}] ${f.ruleName} in ${f.file} (${f.redacted})`)
              .join("\n");
            ctx.ui.notify(summary, "warning");
          }
          continue;
        }

        const chosenRepo = repoMap.get(selection);
        if (chosenRepo) {
          const currentlyEnabled = isRepoFlagEnabled(chosenRepo.path, "cfpd");
          const nextState = !currentlyEnabled;
          setRepoFlag(chosenRepo.path, "cfpd", nextState);

          if (currentGitRoot && path.resolve(chosenRepo.path) === path.resolve(currentGitRoot)) {
            ctx.ui.setStatus("cfpd", nextState ? "🛡️ CFPD: ON" : undefined);
          }

          if (nextState) {
            installGitHook(chosenRepo.path);
            ctx.ui.notify(`✔ CFPD: Protection ENABLED for ${chosenRepo.name} (hook installed).`, "info");
          } else {
            removeGitHook(chosenRepo.path);
            ctx.ui.notify(`CFPD: Protection DISABLED for ${chosenRepo.name} (hook uninstalled).`, "info");
          }
        }
      }
    },
  });
}
