/**
 * code-review-gate Extension for Pi
 *
 * Interactive Code Review Gate & Pre-Apply Interceptor:
 * - Intercepts all code modifications (`edit` and `write` tools) before execution.
 * - Displays a high-contrast diff and preview of proposed modifications.
 * - Review Options:
 *     1. Approve & Apply (Proceed with proposed code)
 *     2. Edit in Editor (Open proposal in $EDITOR / Emacs to edit directly before applying)
 *     3. Review from me (Request revisions from the agent with custom feedback)
 *     4. Reject / Abort
 * - Managed directly via `/reviewcode` slash command with interactive repository selector.
 * - Commands:
 *     `/reviewcode`            - Open interactive repository picker to enable/disable review gate
 *     `/reviewcode <repo>`     - Toggle review gate for specific repository (supports pointer syntax)
 *     `/reviewcode on <repo>`  - Explicitly enable review gate for repository
 *     `/reviewcode off <repo>` - Explicitly disable review gate for repository
 *     `/reviewcode status`     - View review gate status across all local repositories
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

// ============================================================================
// ANSI Color Palette & Box Formatting
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

interface EditItem {
  oldText: string;
  newText: string;
}

function renderDiffPreview(filePath: string, edits: EditItem[]): string {
  const width = Math.min(process.stdout.columns || 90, 96);
  const innerWidth = width - 4;
  const hr = "─".repeat(innerWidth);
  const doubleHr = "═".repeat(innerWidth);

  const lines: string[] = [];
  lines.push("");
  lines.push(`${C.borderActive}╔${doubleHr}╗${C.reset}`);
  lines.push(`${C.borderActive}║${C.reset}  ${C.bgHeader} 👁️ CODE REVIEW GATE: PROPOSED CODE MODIFICATION ${C.reset}`.padEnd(width + 12) + `${C.borderActive}║${C.reset}`);
  lines.push(`${C.borderActive}║${C.reset}  ${C.boldCyan}FILE:${C.reset} ${C.bold}${filePath}${C.reset} (${edits.length} edit hunk${edits.length > 1 ? "s" : ""})`.padEnd(width + 10) + `${C.borderActive}║${C.reset}`);
  lines.push(`${C.borderActive}╠${hr}╣${C.reset}`);

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (edits.length > 1) {
      lines.push(`${C.border}║${C.reset}  ${C.yellow}--- [Hunk ${i + 1} of ${edits.length}] ---${C.reset}`.padEnd(width + 8) + `${C.border}║${C.reset}`);
    }

    const oldLines = e.oldText.split("\n");
    const newLines = e.newText.split("\n");

    for (const l of oldLines.slice(0, 10)) {
      const truncated = l.length > innerWidth - 6 ? l.slice(0, innerWidth - 9) + "..." : l;
      lines.push(`${C.border}║${C.reset}  ${C.red}- ${truncated}${C.reset}`.padEnd(width + 8) + `${C.border}║${C.reset}`);
    }
    if (oldLines.length > 10) {
      lines.push(`${C.border}║${C.reset}  ${C.dim}... (${oldLines.length - 10} more removed lines)${C.reset}`.padEnd(width + 8) + `${C.border}║${C.reset}`);
    }

    for (const l of newLines.slice(0, 15)) {
      const truncated = l.length > innerWidth - 6 ? l.slice(0, innerWidth - 9) + "..." : l;
      lines.push(`${C.border}║${C.reset}  ${C.green}+ ${truncated}${C.reset}`.padEnd(width + 8) + `${C.border}║${C.reset}`);
    }
    if (newLines.length > 15) {
      lines.push(`${C.border}║${C.reset}  ${C.dim}... (${newLines.length - 15} more added lines)${C.reset}`.padEnd(width + 8) + `${C.border}║${C.reset}`);
    }
  }

  lines.push(`${C.borderActive}╚${doubleHr}╝${C.reset}`);
  lines.push("");
  return lines.join("\n");
}

function renderWritePreview(filePath: string, content: string): string {
  const width = Math.min(process.stdout.columns || 90, 96);
  const innerWidth = width - 4;
  const hr = "─".repeat(innerWidth);
  const doubleHr = "═".repeat(innerWidth);

  const contentLines = content.split("\n");
  const lines: string[] = [];

  lines.push("");
  lines.push(`${C.borderActive}╔${doubleHr}╗${C.reset}`);
  lines.push(`${C.borderActive}║${C.reset}  ${C.bgHeader} 👁️ CODE REVIEW GATE: PROPOSED FILE CREATION / REWRITE ${C.reset}`.padEnd(width + 12) + `${C.borderActive}║${C.reset}`);
  lines.push(`${C.borderActive}║${C.reset}  ${C.boldCyan}FILE:${C.reset} ${C.bold}${filePath}${C.reset} (${contentLines.length} lines, ${content.length} bytes)`.padEnd(width + 10) + `${C.borderActive}║${C.reset}`);
  lines.push(`${C.borderActive}╠${hr}╣${C.reset}`);

  for (const l of contentLines.slice(0, 15)) {
    const truncated = l.length > innerWidth - 6 ? l.slice(0, innerWidth - 9) + "..." : l;
    lines.push(`${C.border}║${C.reset}  ${C.green}+ ${truncated}${C.reset}`.padEnd(width + 8) + `${C.border}║${C.reset}`);
  }
  if (contentLines.length > 15) {
    lines.push(`${C.border}║${C.reset}  ${C.dim}... (${contentLines.length - 15} more lines)${C.reset}`.padEnd(width + 8) + `${C.border}║${C.reset}`);
  }

  lines.push(`${C.borderActive}╚${doubleHr}╝${C.reset}`);
  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// Extension Entry Point
// ============================================================================
export default function (pi: ExtensionAPI) {
  // Session Start: Initialize status badge for current repository
  pi.on("session_start", async (_event, ctx) => {
    const currentGitRoot = getGitRoot(ctx.cwd);
    if (isRepoFlagEnabled(currentGitRoot, "reviewcode")) {
      ctx.ui.setStatus("reviewcode", "👁️ REVIEW: ON");
    } else {
      ctx.ui.setStatus("reviewcode", undefined);
    }
  });

  // Intercept `edit` and `write` tool calls before execution
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const currentGitRoot = getGitRoot(ctx.cwd);
    if (!isRepoFlagEnabled(currentGitRoot, "reviewcode")) return;
    if (!ctx.hasUI) return;

    // Case 1: Intercept `edit` tool
    if (event.toolName === "edit") {
      const filePath = String(event.input?.path || "");
      const edits: EditItem[] = Array.isArray(event.input?.edits) ? event.input.edits : [];

      if (!filePath || edits.length === 0) return;

      console.log(renderDiffPreview(filePath, edits));

      const reviewChoice = await ctx.ui.select(
        `👁️ Code Review: ${path.basename(filePath)} (${edits.length} edit hunk${edits.length > 1 ? "s" : ""})`,
        [
          "1. Approve & Apply",
          "2. Edit Code in Editor ($EDITOR / Emacs)",
          "3. Review from me (Request revisions from agent)",
          "4. Reject & Abort",
        ]
      );

      // 1. Approve & Apply
      if (!reviewChoice || reviewChoice.startsWith("1.")) {
        ctx.ui.notify(`✔ [CODE REVIEW] Approved: ${path.basename(filePath)}`, "info");
        return;
      }

      // 2. Edit Code in Editor
      if (reviewChoice.startsWith("2.")) {
        let anyModified = false;
        for (let i = 0; i < edits.length; i++) {
          const hunkTitle = edits.length > 1 ? `Hunk ${i + 1} of ${edits.length}` : "Proposed Change";
          const edited = await ctx.ui.editor(
            `Code Review: Edit replacement text for ${hunkTitle} in ${path.basename(filePath)}`,
            edits[i].newText
          );

          if (edited !== undefined && edited !== edits[i].newText) {
            edits[i].newText = edited;
            anyModified = true;
          }
        }

        if (anyModified) {
          event.input.edits = edits;
          ctx.ui.notify(`✔ [CODE REVIEW] Custom user edits applied to ${path.basename(filePath)}.`, "info");
        }
        return;
      }

      // 3. Review from me (Request revisions)
      if (reviewChoice.startsWith("3.")) {
        const feedback = await ctx.ui.input(
          "Enter review feedback / requested changes for the agent:",
          "e.g. Refactor error handling, use match instead of if-let..."
        );

        const reason = feedback && feedback.trim()
          ? `Code review requested revisions on ${filePath}: "${feedback.trim()}". Revise your proposed changes.`
          : `Code review requested revisions on ${filePath}. Re-evaluate and revise your proposed changes.`;

        return { block: true, reason };
      }

      // 4. Reject & Abort
      return {
        block: true,
        reason: `User rejected proposed code edit on ${filePath}. Do not apply this change.`,
      };
    }

    // Case 2: Intercept `write` tool
    if (event.toolName === "write") {
      const filePath = String(event.input?.path || "");
      const content = String(event.input?.content || "");

      if (!filePath) return;

      console.log(renderWritePreview(filePath, content));

      const reviewChoice = await ctx.ui.select(
        `👁️ Code Review: ${path.basename(filePath)} (${content.split("\n").length} lines)`,
        [
          "1. Approve & Write",
          "2. Edit Code in Editor ($EDITOR / Emacs)",
          "3. Review from me (Request revisions from agent)",
          "4. Reject & Abort",
        ]
      );

      // 1. Approve & Write
      if (!reviewChoice || reviewChoice.startsWith("1.")) {
        ctx.ui.notify(`✔ [CODE REVIEW] Approved: ${path.basename(filePath)}`, "info");
        return;
      }

      // 2. Edit in Editor
      if (reviewChoice.startsWith("2.")) {
        const edited = await ctx.ui.editor(
          `Code Review: File Content for ${path.basename(filePath)}`,
          content
        );

        if (edited !== undefined && edited !== content) {
          event.input.content = edited;
          ctx.ui.notify(`✔ [CODE REVIEW] Custom user edits applied to ${path.basename(filePath)}.`, "info");
        }
        return;
      }

      // 3. Review from me (Request revisions)
      if (reviewChoice.startsWith("3.")) {
        const feedback = await ctx.ui.input(
          "Enter review feedback / requested changes for the agent:",
          "e.g. Add unit tests, adjust struct fields..."
        );

        const reason = feedback && feedback.trim()
          ? `Code review requested revisions on ${filePath}: "${feedback.trim()}". Revise your proposed file content.`
          : `Code review requested revisions on ${filePath}. Re-evaluate and revise your proposed file content.`;

        return { block: true, reason };
      }

      // 4. Reject & Abort
      return {
        block: true,
        reason: `User rejected proposed file creation/rewrite on ${filePath}. Do not apply this change.`,
      };
    }
  });

  // Register command: /reviewcode [status|on <repo>|off <repo>|<repo>]
  pi.registerCommand("reviewcode", {
    description: "Interactive code review gate: manage repository code review enforcement",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "").toLowerCase();

      // Subcommand: /reviewcode status
      if (sub === "status") {
        const allRepos = discoverAllUserRepos();
        const currentGitRoot = getGitRoot(ctx.cwd);
        const lines = allRepos.map((r) => {
          const isCurrent = currentGitRoot && path.resolve(r.path) === path.resolve(currentGitRoot);
          const isEnabled = isRepoFlagEnabled(r.path, "reviewcode");
          const badge = isEnabled ? "● ACTIVE" : "○ OFF";
          const curr = isCurrent ? " [CURRENT]" : "";
          return `  ${badge.padEnd(12)} ${r.name}${curr} (${r.branch})`;
        });
        ctx.ui.notify(`Code Review Gate Status:\n${lines.join("\n")}`, "info");
        return;
      }

      // Subcommand: /reviewcode on [repo] / /reviewcode enable [repo]
      if (sub === "on" || sub === "enable") {
        const targetHint = parts.slice(1).join(" ") || null;
        const diag = resolveRepoWithDiagnostics(targetHint, ctx.cwd);
        const targetRoot = diag.gitRoot || (diag.closestMatch && diag.exact ? diag.closestMatch.path : null);

        if (!targetRoot) {
          ctx.ui.notify(`Code Review: Repository not found "${targetHint || "current"}".`, "error");
          return;
        }

        setRepoFlag(targetRoot, "reviewcode", true);
        const currentGitRoot = getGitRoot(ctx.cwd);
        if (currentGitRoot && path.resolve(targetRoot) === path.resolve(currentGitRoot)) {
          ctx.ui.setStatus("reviewcode", "👁️ REVIEW: ON");
        }
        ctx.ui.notify(`✔ Code Review: ENABLED for ${path.basename(targetRoot)}.`, "info");
        return;
      }

      // Subcommand: /reviewcode off [repo] / /reviewcode disable [repo]
      if (sub === "off" || sub === "disable") {
        const targetHint = parts.slice(1).join(" ") || null;
        const diag = resolveRepoWithDiagnostics(targetHint, ctx.cwd);
        const targetRoot = diag.gitRoot || (diag.closestMatch && diag.exact ? diag.closestMatch.path : null);

        if (!targetRoot) {
          ctx.ui.notify(`Code Review: Repository not found "${targetHint || "current"}".`, "error");
          return;
        }

        setRepoFlag(targetRoot, "reviewcode", false);
        const currentGitRoot = getGitRoot(ctx.cwd);
        if (currentGitRoot && path.resolve(targetRoot) === path.resolve(currentGitRoot)) {
          ctx.ui.setStatus("reviewcode", undefined);
        }
        ctx.ui.notify(`Code Review: DISABLED for ${path.basename(targetRoot)}.`, "info");
        return;
      }

      // If a specific repo target was passed directly: /reviewcode <repo>
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
          ctx.ui.notify(`Code Review: Could not resolve repository "${trimmed}".`, "error");
          return;
        }

        const currentlyEnabled = isRepoFlagEnabled(finalRoot, "reviewcode");
        const nextState = !currentlyEnabled;
        setRepoFlag(finalRoot, "reviewcode", nextState);

        const currentGitRoot = getGitRoot(ctx.cwd);
        if (currentGitRoot && path.resolve(finalRoot) === path.resolve(currentGitRoot)) {
          ctx.ui.setStatus("reviewcode", nextState ? "👁️ REVIEW: ON" : undefined);
        }

        ctx.ui.notify(
          nextState
            ? `✔ Code Review: ENABLED for ${path.basename(finalRoot)}.`
            : `Code Review: DISABLED for ${path.basename(finalRoot)}.`,
          "info"
        );
        return;
      }

      // No arguments: Interactive repository selector loop
      if (!ctx.hasUI) {
        const allRepos = discoverAllUserRepos();
        const currentGitRoot = getGitRoot(ctx.cwd);
        const lines = allRepos.map((r) => {
          const isCurrent = currentGitRoot && path.resolve(r.path) === path.resolve(currentGitRoot);
          const isEnabled = isRepoFlagEnabled(r.path, "reviewcode");
          const badge = isEnabled ? "● ACTIVE" : "○ OFF";
          const curr = isCurrent ? " [CURRENT]" : "";
          return `  ${badge.padEnd(12)} ${r.name}${curr} (${r.branch})`;
        });
        ctx.ui.notify(`Code Review Gate Status:\n${lines.join("\n")}`, "info");
        return;
      }

      while (true) {
        const allRepos = discoverAllUserRepos();
        const currentGitRoot = getGitRoot(ctx.cwd);

        // Sort repos: current repo first, then active repos, then alphabetical
        const sorted = [...allRepos].sort((a, b) => {
          const aIsCurrent = currentGitRoot && path.resolve(a.path) === path.resolve(currentGitRoot);
          const bIsCurrent = currentGitRoot && path.resolve(b.path) === path.resolve(currentGitRoot);
          if (aIsCurrent) return -1;
          if (bIsCurrent) return 1;

          const aEnabled = isRepoFlagEnabled(a.path, "reviewcode");
          const bEnabled = isRepoFlagEnabled(b.path, "reviewcode");
          if (aEnabled && !bEnabled) return -1;
          if (!aEnabled && bEnabled) return 1;

          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });

        const options: string[] = [];
        const repoMap = new Map<string, RepoInfo>();

        for (const r of sorted) {
          const isCurrent = currentGitRoot && path.resolve(r.path) === path.resolve(currentGitRoot);
          const isEnabled = isRepoFlagEnabled(r.path, "reviewcode");
          const statusBadge = isEnabled ? "● [ACTIVE]    " : "○ [INACTIVE]  ";
          const currentBadge = isCurrent ? " ⭐ (current)" : "";
          const action = isEnabled ? "-> Click to Disable" : "-> Click to Enable";
          const label = `${statusBadge} ${r.name}${currentBadge} (${r.branch}) ${action}`;
          options.push(label);
          repoMap.set(label, r);
        }

        options.push("✔ Done");

        const selection = await ctx.ui.select(
          "👁️ Code Review Gate: Manage Protected Repositories",
          options
        );

        if (!selection || selection === "✔ Done") {
          break;
        }

        const chosenRepo = repoMap.get(selection);
        if (chosenRepo) {
          const currentlyEnabled = isRepoFlagEnabled(chosenRepo.path, "reviewcode");
          const nextState = !currentlyEnabled;
          setRepoFlag(chosenRepo.path, "reviewcode", nextState);

          if (currentGitRoot && path.resolve(chosenRepo.path) === path.resolve(currentGitRoot)) {
            ctx.ui.setStatus("reviewcode", nextState ? "👁️ REVIEW: ON" : undefined);
          }

          ctx.ui.notify(
            nextState
              ? `✔ Code Review: ENABLED for ${chosenRepo.name}. Edits/writes will prompt for review.`
              : `Code Review: DISABLED for ${chosenRepo.name}.`,
            "info"
          );
        }
      }
    },
  });
}
