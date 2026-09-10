/**
 * gh-review-gate Extension for Pi
 *
 * Enforces strict GitHub modification rule:
 * Whenever ANY GitHub modification or post is initiated (PRs, issues, comments, releases):
 * 1. Showcase the draft clearly.
 * 2. Present the 2 mandatory options:
 *    1. Submit
 *    2. Review from me (request edits)
 * 3. If "Review from me" is chosen, collect feedback, block execution, and return the
 *    edits to the agent to revise the draft in an ongoing loop until "1. Submit" is selected.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as cp from "node:child_process";

// Set of commands approved by user in the current session
const approvedCommands = new Set<string>();

/**
 * Checks if a bash command performs a modifying GitHub action.
 */
function isModifyingGhCommand(command: string): boolean {
  if (!command) return false;
  // Match commands like:
  // gh pr create, gh pr edit, gh pr comment, gh pr close, gh pr reopen, gh pr merge, gh pr ready
  // gh issue create, gh issue edit, gh issue comment, gh issue close, gh issue reopen
  // gh release create, gh release edit, gh release delete
  // gh api with POST, PUT, PATCH, DELETE
  const modifyingPatterns = [
    /\bgh\s+pr\s+(create|edit|comment|close|reopen|merge|ready)\b/i,
    /\bgh\s+issue\s+(create|edit|comment|close|reopen)\b/i,
    /\bgh\s+release\s+(create|edit|delete)\b/i,
    /\bgh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i,
  ];

  return modifyingPatterns.some((pattern) => pattern.test(command));
}

/**
 * Parses details from a modifying gh command for clear preview display.
 */
function parseGhDetails(command: string): {
  action: string;
  target?: string;
  title?: string;
  body?: string;
} {
  let action = "GitHub Modification";
  const prMatch = command.match(/\bgh\s+pr\s+(create|edit|comment|close|reopen|merge|ready)\b/i);
  const issueMatch = command.match(/\bgh\s+issue\s+(create|edit|comment|close|reopen)\b/i);
  const releaseMatch = command.match(/\bgh\s+release\s+(create|edit|delete)\b/i);

  if (prMatch) action = `PR ${prMatch[1].toUpperCase()}`;
  else if (issueMatch) action = `Issue ${issueMatch[1].toUpperCase()}`;
  else if (releaseMatch) action = `Release ${releaseMatch[1].toUpperCase()}`;

  // Extract repo if specified via -R or --repo
  const repoMatch = command.match(/(?:-R|--repo)\s+([^\s"']+)/i);
  // Extract PR/issue number if provided as argument (e.g. gh pr comment 123 ...)
  const numberMatch = command.match(/\b(?:pr|issue)\s+(?:edit|comment|close|reopen|ready|merge)\s+([0-9]+)\b/i);

  let target = repoMatch ? repoMatch[1] : "";
  if (numberMatch) {
    target = target ? `${target}#${numberMatch[1]}` : `#${numberMatch[1]}`;
  }

  // Extract title if present: -t "..." or --title "..."
  const titleMatch = command.match(/(?:-t|--title)\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))/i);
  const title = titleMatch ? (titleMatch[1] || titleMatch[2] || titleMatch[3]) : undefined;

  // Extract body if present: -b "..." or --body "..."
  const bodyMatch = command.match(/(?:-b|--body)\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))/i);
  let body = bodyMatch ? (bodyMatch[1] || bodyMatch[2] || bodyMatch[3]) : undefined;

  // Check for heredoc bodies: << 'EOF' ... EOF
  if (!body && command.includes("<<")) {
    const heredocMatch = command.match(/<<\s*['"]?([A-Za-z0-9_]+)['"]?\n([\s\S]*?)\n\s*\1/);
    if (heredocMatch) {
      body = heredocMatch[2].trim();
    }
  }

  return { action, target: target || undefined, title, body };
}

interface DraftBoxOptions {
  action: string;
  target?: string;
  title?: string;
  body: string;
  command?: string;
  targetWidth?: number;
}

/**
 * Builds a framed, high-contrast cyberpunk boxed container for draft review.
 */
function buildBoxedDraft(options: DraftBoxOptions, targetWidth?: number): string[] {
  const { action, target, title, body } = options;
  const cols = targetWidth || process.stdout.columns || 85;
  const width = Math.min(Math.max(60, cols), 96);
  const innerWidth = width - 4; // 2 cols for "│ ", 2 cols for " │"

  const C = {
    reset: "\x1b[0m",
    border: "\x1b[38;2;85;110;145m",
    tag: "\x1b[1;38;2;0;225;225m",
    action: "\x1b[1;38;2;255;180;60m",
    target: "\x1b[1;38;2;130;180;255m",
    titleVal: "\x1b[1;38;2;245;248;255m",
    label: "\x1b[38;2;140;155;180m",
    h1: "\x1b[1;38;2;0;225;225m",
    h2: "\x1b[1;38;2;130;180;255m",
    h3: "\x1b[1;38;2;140;215;255m",
    bullet: "\x1b[38;2;255;180;60m•\x1b[0m",
    dim: "\x1b[2;38;2;130;140;160m",
  };

  const headerTag = ` ${C.tag}[GitHub Review Gate]${C.reset} ${C.action}${action}${C.reset}${target ? ` ${C.dim}→${C.reset} ${C.target}${target}${C.reset}` : ""} `;
  const topDashes = Math.max(2, width - 2 - visibleWidth(headerTag) - 1);
  const topBorder = `${C.border}╭─${C.reset}${headerTag}${C.border}${"─".repeat(topDashes)}╮${C.reset}`;

  const lines: string[] = [topBorder];

  if (title) {
    const titlePrefix = `${C.label}Title: ${C.reset}${C.titleVal}`;
    const wrappedTitle = wrapTextWithAnsi(titlePrefix + title + C.reset, innerWidth);
    for (const seg of wrappedTitle) {
      const pad = Math.max(0, innerWidth - visibleWidth(seg));
      lines.push(`${C.border}│${C.reset} ${seg}${" ".repeat(pad)} ${C.border}│${C.reset}`);
    }
    lines.push(`${C.border}├${"─".repeat(width - 2)}┤${C.reset}`);
  }

  const rawLines = (body || "(No content)").split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (!raw.trim()) {
      lines.push(`${C.border}│${C.reset}${" ".repeat(innerWidth + 2)}${C.border}│${C.reset}`);
      continue;
    }

    let styled = raw;
    if (raw.startsWith("### ")) {
      styled = `${C.h3}${raw}${C.reset}`;
    } else if (raw.startsWith("## ")) {
      styled = `${C.h2}${raw}${C.reset}`;
    } else if (raw.startsWith("# ")) {
      styled = `${C.h1}${raw}${C.reset}`;
    } else if (/^\s*[-*]\s+/.test(raw)) {
      styled = raw.replace(/^(\s*)[-*]\s+/, `$1${C.bullet} `);
    } else if (/^\s*---+\s*$/.test(raw)) {
      styled = `${C.border}${"─".repeat(Math.min(innerWidth, 40))}${C.reset}`;
    }

    const wrapped = wrapTextWithAnsi(styled, innerWidth);
    for (const seg of wrapped) {
      const pad = Math.max(0, innerWidth - visibleWidth(seg));
      lines.push(`${C.border}│${C.reset} ${seg}${" ".repeat(pad)} ${C.border}│${C.reset}`);
    }
  }

  const footerText = ` ${C.dim}2-Option Review Gate${C.reset} `;
  const botDashes = Math.max(2, width - 2 - visibleWidth(footerText) - 1);
  const botBorder = `${C.border}╰${"─".repeat(botDashes)}${footerText}─╯${C.reset}`;
  lines.push(botBorder);

  return lines;
}

export default function (pi: ExtensionAPI) {
  // Intercept bash tool calls executing modifying gh commands
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = (event.input as { command?: string })?.command || "";
    if (!isModifyingGhCommand(command)) return;

    const trimmed = command.trim();
    if (approvedCommands.has(trimmed)) {
      approvedCommands.delete(trimmed);
      return; // Execution approved by user
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "Blocked: GitHub modification detected in non-interactive mode. Must showcase draft and get review approval first.",
      };
    }

    const { action, target, title, body } = parseGhDetails(command);

    const boxLines = buildBoxedDraft({
      action,
      target,
      title,
      body: body || `Command:\n${command.slice(0, 300)}`,
      command,
    });

    const choice = await ctx.ui.select(
      `${boxLines.join("\n")}\n\nSelect action:`,
      ["1. Submit", "2. Review from me (request edits)"]
    );

    if (choice === "1. Submit") {
      approvedCommands.add(trimmed);
      return; // Approved, execute command
    }

    if (choice === "2. Review from me (request edits)") {
      const feedback = await ctx.ui.input(
        "Review Feedback (specify edits/modifications for the draft):",
        ""
      );

      const edits = feedback ? feedback.trim() : "Requested revisions to draft";

      return {
        block: true,
        reason: `Draft halted for review by user. Feedback: "${edits}". Update the draft with these edits, show the updated draft, and ask the 2 questions again until "1. Submit" is selected.`,
      };
    }

    // User dismissed or pressed Esc
    return {
      block: true,
      reason: "GitHub action cancelled by user.",
    };
  });

  // Dedicated custom tool for explicit draft review cycles
  pi.registerTool({
    name: "gh_review_draft",
    label: "GitHub Review Draft",
    description: "Showcase a draft GitHub modification/post (PR, issue, comment) and present the 2-option review prompt: 1. Submit, 2. Review from me.",
    parameters: Type.Object({
      action: Type.String({ description: "Action type (e.g. 'Create PR', 'Edit PR', 'Issue Comment')" }),
      target: Type.String({ description: "Target repository or issue/PR (e.g. 'actix/actix-web#3797')" }),
      title: Type.Optional(Type.String({ description: "Draft title if applicable" })),
      body: Type.String({ description: "Draft content/body (keep concise and fast to read)" }),
      command: Type.Optional(Type.String({ description: "The exact gh command to run upon submission approval" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action, target, title, body, command } = params;

      if (!ctx.hasUI) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "pending_manual_review",
              message: "Non-interactive UI. Show draft in text and ask user directly.",
            }),
          }],
        };
      }

      const boxLines = buildBoxedDraft({
        action,
        target,
        title,
        body,
        command,
      });

      const prompt = `${boxLines.join("\n")}\n\nSelect action:`;

      const choice = await ctx.ui.select(prompt, [
        "1. Submit",
        "2. Review from me (request edits)",
      ]);

      if (choice === "1. Submit") {
        if (command && command.trim()) {
          try {
            const out = cp.execSync(command, { encoding: "utf8" });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "submitted",
                  message: "Draft approved and executed successfully.",
                  output: out.trim(),
                }),
              }],
            };
          } catch (err: any) {
            return {
              isError: true,
              content: [{
                type: "text",
                text: `Draft approved but command failed: ${err.message || String(err)}`,
              }],
            };
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "approved",
              message: "User approved draft. Proceed to submit via bash.",
            }),
          }],
        };
      }

      if (choice === "2. Review from me (request edits)") {
        const feedback = await ctx.ui.input(
          "Review Feedback (specify edits/modifications):",
          ""
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "needs_edits",
              feedback: (feedback && feedback.trim()) || "Please refine the draft.",
              instruction: "Apply the requested feedback to the draft and present the revised draft for review again.",
            }),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "cancelled",
            message: "User cancelled the review prompt.",
          }),
        }],
      };
    },
  });
}
