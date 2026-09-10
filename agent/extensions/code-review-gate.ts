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
 *
 * - Flags:
 *     --ext-reviewcode: Enable code review gate for the active session.
 *     --ext-always-on / --ext-alwayson: Permanently lock code review for repository.
 *                                       Supports `<repo> ->` pointer syntax.
 *     --ext-off:                        Deactivates permanent lock for repository.
 *
 * - Commands:
 *     `/reviewcode [status|always-on [repo ->]|off [repo ->]]`
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
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
  lines.push(`${C.borderActive}║${C.reset}  ${C.bgHeader} 🔍 CODE REVIEW GATE: PROPOSED CODE MODIFICATION ${C.reset}`.padEnd(width + 12) + `${C.borderActive}║${C.reset}`);
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
  lines.push(`${C.borderActive}║${C.reset}  ${C.bgHeader} 🔍 CODE REVIEW GATE: PROPOSED FILE CREATION / REWRITE ${C.reset}`.padEnd(width + 12) + `${C.borderActive}║${C.reset}`);
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
  // 1. Register CLI Flags
  pi.registerFlag("ext-reviewcode", {
    description: "Code Review Gate: interactive review & edit approval before code changes are applied",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ext-review-code", {
    description: "Alias for --ext-reviewcode",
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
    const flagReviewCode = Boolean(pi.getFlag("ext-reviewcode") || pi.getFlag("ext-review-code"));
    const alwaysOnVal = pi.getFlag("ext-always-on") ?? pi.getFlag("ext-alwayson");
    const offVal = pi.getFlag("ext-off");
    const repoFlagVal = pi.getFlag("repo");

    // Resolve target repo hint (from flag value or --repo flag)
    const targetHint = (typeof alwaysOnVal === "string" ? alwaysOnVal : null)
      || (typeof offVal === "string" ? offVal : null)
      || (typeof repoFlagVal === "string" ? repoFlagVal : null);

    const targetGitRoot = resolveRepoPath(targetHint, ctx.cwd);

    if (flagReviewCode && targetGitRoot) {
      if (Boolean(alwaysOnVal)) {
        setRepoFlag(targetGitRoot, "reviewcode", true);
        ctx.ui.notify(`🔍 Code Review: Repository permanently locked with interactive review gate: ${path.basename(targetGitRoot)}`, "info");
      } else if (Boolean(offVal)) {
        setRepoFlag(targetGitRoot, "reviewcode", false);
        ctx.ui.notify(`🔍 Code Review: Permanent lock removed for: ${path.basename(targetGitRoot)}`, "info");
      }
    }

    const currentGitRoot = getGitRoot(ctx.cwd);
    const isLocked = isRepoFlagEnabled(currentGitRoot, "reviewcode");
    const active = flagReviewCode || isLocked;

    if (active) {
      const tag = isLocked ? "CODE-REVIEW: LOCKED" : "CODE-REVIEW: ON";
      ctx.ui.setStatus("reviewcode", `🔍 ${tag}`);
    }
  });

  // Intercept `edit` and `write` tool calls before execution
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const currentGitRoot = getGitRoot(ctx.cwd);
    const active =
      Boolean(pi.getFlag("ext-reviewcode") || pi.getFlag("ext-review-code")) ||
      isRepoFlagEnabled(currentGitRoot, "reviewcode");

    if (!active) return;
    if (!ctx.hasUI) return;

    // Case 1: Intercept `edit` tool
    if (event.toolName === "edit") {
      const filePath = String(event.input?.path || "");
      const edits: EditItem[] = Array.isArray(event.input?.edits) ? event.input.edits : [];

      if (!filePath || edits.length === 0) return;

      console.log(renderDiffPreview(filePath, edits));

      const reviewChoice = await ctx.ui.select(
        `🔍 Code Review: ${path.basename(filePath)} (${edits.length} edit hunk${edits.length > 1 ? "s" : ""})`,
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
          const hunkTitle = edits.length > 1 ? `Edit Hunk ${i + 1}/${edits.length}` : `Edit Code Replacement`;
          const edited = await ctx.ui.editor(
            `Code Review: ${hunkTitle} for ${path.basename(filePath)}`,
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
        `🔍 Code Review: ${path.basename(filePath)} (${content.split("\n").length} lines)`,
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

  // Register command: /reviewcode [status|always-on [repo ->]|off [repo ->]]
  pi.registerCommand("reviewcode", {
    description: "Interactive code review gate: view status or manage repository lock",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = (parts[0] || "").toLowerCase();
      const targetHint = parts.slice(1).join(" ") || null;
      const targetGitRoot = resolveRepoPath(targetHint, ctx.cwd);

      if (sub === "always-on" || sub === "lock" || sub === "on") {
        const diag = resolveRepoWithDiagnostics(targetHint, ctx.cwd);
        let finalRoot = diag.gitRoot;

        if (!finalRoot && ctx.hasUI) {
          if (diag.closestMatch) {
            const pick = await ctx.ui.select(
              `Repo "${diag.targetRaw}" not found. Did you mean "${diag.closestMatch.name}"?`,
              [
                `1. Yes, lock "${diag.closestMatch.name}"`,
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
            const chosen = await ctx.ui.select("Select repository to lock with Code Review Gate:", options);
            if (chosen) {
              const found = diag.allRepos.find((r) => r.name === chosen.split(" ")[0]);
              if (found) finalRoot = found.path;
            }
          }
        }

        if (!finalRoot) {
          ctx.ui.notify(`Code Review: No repository selected.`, "warning");
          return;
        }

        setRepoFlag(finalRoot, "reviewcode", true);
        ctx.ui.setStatus("reviewcode", "🔍 CODE-REVIEW: LOCKED");
        ctx.ui.notify(`✔ Code Review: Permanently locked for ${path.basename(finalRoot)}.`, "info");
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
            const chosen = await ctx.ui.select("Select repository to remove Code Review lock:", options);
            if (chosen) {
              const found = diag.allRepos.find((r) => r.name === chosen.split(" ")[0]);
              if (found) finalRoot = found.path;
            }
          }
        }

        if (!finalRoot) {
          ctx.ui.notify(`Code Review: No repository selected.`, "warning");
          return;
        }

        setRepoFlag(finalRoot, "reviewcode", false);
        ctx.ui.setStatus("reviewcode", "");
        ctx.ui.notify(`Code Review: Removed permanent lock for ${path.basename(finalRoot)}.`, "info");
        return;
      }

      // Default: Status
      const currentGitRoot = getGitRoot(ctx.cwd);
      const isLocked = isRepoFlagEnabled(currentGitRoot, "reviewcode");
      const isFlagOn = Boolean(pi.getFlag("ext-reviewcode") || pi.getFlag("ext-review-code"));
      const repoName = currentGitRoot ? path.basename(currentGitRoot) : "none";

      const statusMsg = [
        `Code Review Gate Status:`,
        `  • Active for session (--ext-reviewcode): ${isFlagOn ? "YES" : "NO"}`,
        `  • Current Repo (${repoName}): ${isLocked ? "LOCKED (Always-On)" : "NOT LOCKED"}`,
        `Commands:`,
        `  /reviewcode always-on [repo ->]  - Permanently lock code review for repo`,
        `  /reviewcode off [repo ->]        - Disable permanent lock for repo`,
      ].join("\n");

      ctx.ui.notify(statusMsg, "info");
    },
  });
}
