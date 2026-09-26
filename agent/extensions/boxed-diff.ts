/**
 * boxed-diff Extension for Pi
 *
 * Razor-sharp boxed code blocks & diffs:
 * - Markdown transformer for all code blocks in chat (` ```diff `, ` ```rust `, ` ```go `, etc.):
 *   renders both diffs (red/green word diff) and standard code (syntax-highlighted with line numbers)
 *   inside framed, distinctive cyberpunk boxes separated from chat prose with strict terminal width truncation.
 * - Slash command `/diff-box [file|git]`: Inspect git diffs in boxed format.
 */

import {
  highlightCode,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import * as cp from "node:child_process";

// ============================================================================
// ANSI Color Palette & Styling (Cyberpunk High-Contrast)
// ============================================================================

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",

  // Sleek cybernetic borders (steel-cyan slate)
  border: "\x1b[38;2;75;90;110m",
  borderCode: "\x1b[38;2;70;95;120m",

  // Header badges
  tagDiff: "\x1b[1;38;2;130;170;255m",
  tagCode: "\x1b[1;38;2;250;180;60m",
  filePath: "\x1b[1;38;2;240;245;255m",

  // Status indicators
  statusApplied: "\x1b[1;38;2;80;250;120m✔ Applied\x1b[0m",
  statusError: "\x1b[1;38;2;255;70;85m✖ Failed\x1b[0m",

  // Vibrant, high-contrast Red (Removals)
  remSign: "\x1b[1;38;2;255;75;75m-\x1b[0m",
  remText: "\x1b[38;2;255;105;105m",
  remLineNum: "\x1b[38;2;210;75;75m",
  remHighlight: "\x1b[7;1;38;2;255;90;90m",

  // Vibrant, high-contrast Green (Additions)
  addSign: "\x1b[1;38;2;80;250;120m+\x1b[0m",
  addText: "\x1b[38;2;100;245;140m",
  addLineNum: "\x1b[38;2;75;190;105m",
  addHighlight: "\x1b[7;1;38;2;80;250;120m",

  // Context & Structure
  ctxText: "\x1b[38;2;165;175;190m",
  ctxLineNum: "\x1b[38;2;100;110;130m",
  hunkText: "\x1b[38;2;100;180;245m",
  foldText: "\x1b[38;2;115;125;145m",
  gutterBar: "\x1b[38;2;55;70;90m│\x1b[0m",
};

// ============================================================================
// Intra-line Word-Level Diffing Helper
// ============================================================================

interface TokenPart {
  value: string;
  changed: boolean;
}

function computeWordDiff(oldStr: string, newStr: string): { oldParts: TokenPart[]; newParts: TokenPart[] } {
  let commonPrefixLen = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (commonPrefixLen < minLen && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
    commonPrefixLen++;
  }

  let commonSuffixLen = 0;
  while (
    commonSuffixLen < minLen - commonPrefixLen &&
    oldStr[oldStr.length - 1 - commonSuffixLen] === newStr[newStr.length - 1 - commonSuffixLen]
  ) {
    commonSuffixLen++;
  }

  const oldMiddle = oldStr.slice(commonPrefixLen, oldStr.length - commonSuffixLen);
  const newMiddle = newStr.slice(commonPrefixLen, newStr.length - commonSuffixLen);

  const prefix = oldStr.slice(0, commonPrefixLen);
  const suffix = commonSuffixLen > 0 ? oldStr.slice(oldStr.length - commonSuffixLen) : "";

  const oldParts: TokenPart[] = [];
  const newParts: TokenPart[] = [];

  if (prefix) {
    oldParts.push({ value: prefix, changed: false });
    newParts.push({ value: prefix, changed: false });
  }

  if (oldMiddle) {
    oldParts.push({ value: oldMiddle, changed: true });
  }

  if (newMiddle) {
    newParts.push({ value: newMiddle, changed: true });
  }

  if (suffix) {
    oldParts.push({ value: suffix, changed: false });
    newParts.push({ value: suffix, changed: false });
  }

  return { oldParts, newParts };
}

// ============================================================================
// Diff Parser
// ============================================================================

interface ParsedDiffLine {
  type: "header" | "hunk" | "added" | "removed" | "context" | "dots";
  content: string;
  lineNum?: string;
}

function parseDiffLine(raw: string): ParsedDiffLine {
  if (raw.startsWith("@@")) {
    return { type: "hunk", content: raw };
  }
  if (
    raw.startsWith("diff --git") ||
    raw.startsWith("index ") ||
    raw.startsWith("--- ") ||
    raw.startsWith("+++ ")
  ) {
    return { type: "header", content: raw };
  }
  if (raw.startsWith("...")) {
    return { type: "dots", content: raw };
  }

  const matchLineNum = raw.match(/^\s*(\d+)\s+([+\- ])(.*)$/);
  if (matchLineNum) {
    const [, num, sign, text] = matchLineNum;
    if (sign === "+") return { type: "added", content: text, lineNum: num };
    if (sign === "-") return { type: "removed", content: text, lineNum: num };
    return { type: "context", content: text, lineNum: num };
  }

  if (raw.startsWith("+")) {
    return { type: "added", content: raw.slice(1) };
  }
  if (raw.startsWith("-")) {
    return { type: "removed", content: raw.slice(1) };
  }
  if (raw.startsWith(" ")) {
    return { type: "context", content: raw.slice(1) };
  }

  return { type: "context", content: raw };
}

// ============================================================================
// Boxed Diff Rendering Engine
// ============================================================================

interface BoxRenderOptions {
  tag?: string;
  title?: string;
  statusText?: string;
  diffText?: string;
  errorMessage?: string;
  expanded?: boolean;
  maxCollapsedLines?: number;
}

function buildBoxedDiff(options: BoxRenderOptions, targetWidth: number): string[] {
  const {
    tag = "diff",
    title,
    statusText,
    diffText,
    errorMessage,
    expanded = false,
    maxCollapsedLines = 22,
  } = options;

  if (targetWidth <= 6) {
    const rawTitle = title || tag || "diff";
    return [truncateToWidth(rawTitle, targetWidth, "")];
  }

  // Strictly clamp width: never exceed targetWidth, cap maximum box width at 110
  const width = Math.min(targetWidth, 110);
  const innerWidth = Math.max(1, width - 4); // 2 cols for "│ ", 2 cols for " │"

  const borderColor = C.border;

  // 1. Render Header
  // The header line layout: ╭─ [tag] [title] [status] ────╮
  const maxHeaderInner = Math.max(0, width - 4);
  const tagColor = C.tagDiff;
  const tagBadge = `${tagColor}${tag}${C.reset}`;
  const statusBadge = statusText || "";
  const tagVis = visibleWidth(tagBadge);
  const statusVis = visibleWidth(statusBadge);

  const fixedVis = 1 + tagVis + (statusVis > 0 ? 1 + statusVis : 0) + 1;

  let titleDisplay = "";
  if (title && title !== "diff") {
    const availForTitle = maxHeaderInner - fixedVis - 1;
    if (availForTitle >= 4) {
      const truncatedTitle = truncateToWidth(title, availForTitle, "…");
      titleDisplay = ` ${C.filePath}${truncatedTitle}${C.reset}`;
    }
  }

  const statusPart = statusBadge ? ` ${statusBadge}` : "";
  let titleSection = ` ${tagBadge}${titleDisplay}${statusPart} `;

  if (visibleWidth(titleSection) > maxHeaderInner) {
    titleSection = truncateToWidth(titleSection, maxHeaderInner, "");
  }

  const titleVis = visibleWidth(titleSection);
  const topDashes = Math.max(0, width - 3 - titleVis);
  let headerLine = `${borderColor}╭─${C.reset}${titleSection}${borderColor}${"─".repeat(topDashes)}╮${C.reset}`;
  if (visibleWidth(headerLine) > width) {
    headerLine = truncateToWidth(headerLine, width, "");
  }

  const lines: string[] = [headerLine];

  // 2. Handle Error Case
  if (errorMessage) {
    const errorPrefix = `${C.statusError}: `;
    const wrappedErr = wrapTextWithAnsi(errorPrefix + errorMessage, innerWidth);
    for (const w of wrappedErr) {
      const lineText = visibleWidth(w) > innerWidth ? truncateToWidth(w, innerWidth, "") : w;
      const pad = Math.max(0, innerWidth - visibleWidth(lineText));
      let row = `${borderColor}│${C.reset} ${lineText}${" ".repeat(pad)} ${borderColor}│${C.reset}`;
      if (visibleWidth(row) > width) row = truncateToWidth(row, width, "");
      lines.push(row);
    }
    const botDashes = Math.max(0, width - 2);
    let bot = `${borderColor}╰${"─".repeat(botDashes)}╯${C.reset}`;
    if (visibleWidth(bot) > width) bot = truncateToWidth(bot, width, "");
    lines.push(bot);
    return lines.map((l) => (visibleWidth(l) > targetWidth ? truncateToWidth(l, targetWidth, "") : l));
  }

  // 3. Parse diff lines
  const rawLines = diffText ? diffText.split("\n") : [];
  const parsedLines: ParsedDiffLine[] = [];
  for (const raw of rawLines) {
    if (!raw.trim() && parsedLines.length === 0) continue;
    parsedLines.push(parseDiffLine(raw));
  }

  let maxLineNumLen = 0;
  for (const p of parsedLines) {
    if (p.lineNum && p.lineNum.length > maxLineNumLen) {
      maxLineNumLen = p.lineNum.length;
    }
  }

  let addCount = 0;
  let remCount = 0;
  const formattedRows: string[] = [];

  let i = 0;
  while (i < parsedLines.length) {
    const p = parsedLines[i];

    if (p.type === "header") {
      i++;
      continue;
    }

    if (p.type === "hunk") {
      formattedRows.push(`${C.hunkText}${p.content}${C.reset}`);
      i++;
      continue;
    }

    if (p.type === "dots") {
      formattedRows.push(`${C.foldText}  ···${C.reset}`);
      i++;
      continue;
    }

    // Check for paired modification (1 removed line followed immediately by 1 added line)
    if (
      p.type === "removed" &&
      i + 1 < parsedLines.length &&
      parsedLines[i + 1].type === "added" &&
      (i + 2 >= parsedLines.length || parsedLines[i + 2].type !== "added")
    ) {
      const removed = p;
      const added = parsedLines[i + 1];
      remCount++;
      addCount++;

      const { oldParts, newParts } = computeWordDiff(removed.content, added.content);

      const remNum = maxLineNumLen > 0
        ? `${C.remLineNum}${removed.lineNum.padStart(maxLineNumLen, " ")}${C.reset} `
        : "";
      let remWords = "";
      for (const part of oldParts) {
        remWords += part.changed
          ? `${C.remHighlight}${part.value}${C.reset}${C.remText}`
          : part.value;
      }
      formattedRows.push(`${remNum}${C.remSign} ${C.remText}${remWords}${C.reset}`);

      const addNum = maxLineNumLen > 0
        ? `${C.addLineNum}${added.lineNum.padStart(maxLineNumLen, " ")}${C.reset} `
        : "";
      let addWords = "";
      for (const part of newParts) {
        addWords += part.changed
          ? `${C.addHighlight}${part.value}${C.reset}${C.addText}`
          : part.value;
      }
      formattedRows.push(`${addNum}${C.addSign} ${C.addText}${addWords}${C.reset}`);

      i += 2;
      continue;
    }

    if (p.type === "removed") {
      remCount++;
      const numStr = maxLineNumLen > 0
        ? `${C.remLineNum}${p.lineNum.padStart(maxLineNumLen, " ")}${C.reset} `
        : "";
      formattedRows.push(`${numStr}${C.remSign} ${C.remText}${p.content}${C.reset}`);
      i++;
      continue;
    }

    if (p.type === "added") {
      addCount++;
      const numStr = maxLineNumLen > 0
        ? `${C.addLineNum}${p.lineNum.padStart(maxLineNumLen, " ")}${C.reset} `
        : "";
      formattedRows.push(`${numStr}${C.addSign} ${C.addText}${p.content}${C.reset}`);
      i++;
      continue;
    }

    const numStr = maxLineNumLen > 0
      ? `${C.ctxLineNum}${p.lineNum.padStart(maxLineNumLen, " ")}${C.reset} `
      : "";
    formattedRows.push(`${numStr}  ${C.ctxText}${p.content}${C.reset}`);
    i++;
  }

  // 4. Handle Collapsing / Pagination
  const shouldTruncate = !expanded && formattedRows.length > maxCollapsedLines;
  const visibleRows = shouldTruncate
    ? formattedRows.slice(0, maxCollapsedLines)
    : formattedRows;
  const hiddenCount = formattedRows.length - visibleRows.length;

  for (const row of visibleRows) {
    const wrapped = wrapTextWithAnsi(row, innerWidth);
    for (const w of wrapped) {
      const lineText = visibleWidth(w) > innerWidth ? truncateToWidth(w, innerWidth, "") : w;
      const pad = Math.max(0, innerWidth - visibleWidth(lineText));
      let rowLine = `${borderColor}│${C.reset} ${lineText}${" ".repeat(pad)} ${borderColor}│${C.reset}`;
      if (visibleWidth(rowLine) > width) rowLine = truncateToWidth(rowLine, width, "");
      lines.push(rowLine);
    }
  }

  if (shouldTruncate) {
    const foldNotice = `${C.foldText}... (${hiddenCount} more lines, click or Ctrl+O to expand)${C.reset}`;
    const wrappedNotice = wrapTextWithAnsi(foldNotice, innerWidth);
    for (const w of wrappedNotice) {
      const lineText = visibleWidth(w) > innerWidth ? truncateToWidth(w, innerWidth, "") : w;
      const pad = Math.max(0, innerWidth - visibleWidth(lineText));
      let foldLine = `${borderColor}│${C.reset} ${lineText}${" ".repeat(pad)} ${borderColor}│${C.reset}`;
      if (visibleWidth(foldLine) > width) foldLine = truncateToWidth(foldLine, width, "");
      lines.push(foldLine);
    }
  }

  // 5. Render Footer with +N -M Summary
  let summarySection = "";
  if (addCount > 0 || remCount > 0) {
    summarySection = ` ${C.addText}+${addCount}${C.reset} ${C.remText}-${remCount}${C.reset} lines `;
  } else {
    summarySection = " clean ";
  }

  const maxFooterInner = Math.max(0, width - 4);
  if (visibleWidth(summarySection) > maxFooterInner) {
    summarySection = truncateToWidth(summarySection, maxFooterInner, "");
  }

  const summaryVis = visibleWidth(summarySection);
  const botDashes = Math.max(0, width - 3 - summaryVis);
  let footerLine = `${borderColor}╰${"─".repeat(botDashes)}${summarySection}─╯${C.reset}`;
  if (visibleWidth(footerLine) > width) {
    footerLine = truncateToWidth(footerLine, width, "");
  }
  lines.push(footerLine);

  return lines.map((l) => (visibleWidth(l) > targetWidth ? truncateToWidth(l, targetWidth, "") : l));
}

// ============================================================================
// Boxed Standard Code Block Engine
// ============================================================================

function buildBoxedCode(code: string, lang: string, targetWidth: number): string[] {
  if (targetWidth <= 6) {
    return [truncateToWidth(code.split("\n")[0] || "code", targetWidth, "")];
  }
  const width = Math.min(targetWidth, 110);
  const innerWidth = Math.max(1, width - 4);

  // Syntax highlighting via pi's built-in engine
  let highlightedLines: string[];
  try {
    highlightedLines = highlightCode(code, lang);
  } catch {
    highlightedLines = code.split("\n");
  }

  const maxHeaderInner = Math.max(0, width - 4);
  const displayLang = lang || "code";
  let headerTitle = ` ${C.tagCode}code${C.reset} ${C.filePath}${displayLang}${C.reset} `;
  if (visibleWidth(headerTitle) > maxHeaderInner) {
    headerTitle = truncateToWidth(headerTitle, maxHeaderInner, "");
  }
  const titleVis = visibleWidth(headerTitle);
  const topDashes = Math.max(0, width - 3 - titleVis);
  let headerLine = `${C.borderCode}╭─${C.reset}${headerTitle}${C.borderCode}${"─".repeat(topDashes)}╮${C.reset}`;
  if (visibleWidth(headerLine) > width) {
    headerLine = truncateToWidth(headerLine, width, "");
  }

  const lines: string[] = [headerLine];
  const totalLines = highlightedLines.length;
  const gutterWidth = Math.max(2, String(totalLines).length);

  for (let i = 0; i < totalLines; i++) {
    const num = `${C.ctxLineNum}${String(i + 1).padStart(gutterWidth, " ")}${C.reset}`;
    const cleanContent = highlightedLines[i].replace(/\t/g, "   ");
    const formattedRow = `${num} ${C.gutterBar} ${cleanContent}`;

    const wrapped = wrapTextWithAnsi(formattedRow, innerWidth);
    for (const w of wrapped) {
      const lineText = visibleWidth(w) > innerWidth ? truncateToWidth(w, innerWidth, "") : w;
      const pad = Math.max(0, innerWidth - visibleWidth(lineText));
      let row = `${C.borderCode}│${C.reset} ${lineText}${" ".repeat(pad)} ${C.borderCode}│${C.reset}`;
      if (visibleWidth(row) > width) row = truncateToWidth(row, width, "");
      lines.push(row);
    }
  }

  const maxFooterInner = Math.max(0, width - 4);
  let footerText = ` ${C.foldText}${totalLines} lines${C.reset} `;
  if (visibleWidth(footerText) > maxFooterInner) {
    footerText = truncateToWidth(footerText, maxFooterInner, "");
  }
  const footerVis = visibleWidth(footerText);
  const botDashes = Math.max(0, width - 3 - footerVis);
  let footerLine = `${C.borderCode}╰${"─".repeat(botDashes)}${footerText}─╯${C.reset}`;
  if (visibleWidth(footerLine) > width) {
    footerLine = truncateToWidth(footerLine, width, "");
  }
  lines.push(footerLine);

  return lines.map((l) => (visibleWidth(l) > targetWidth ? truncateToWidth(l, targetWidth, "") : l));
}

// ============================================================================
// Markdown Code & Diff Block Transformer
// ============================================================================

function extractDiffFilename(code: string): string {
  const matchGit = code.match(/diff --git\s+a\/(.+?)\s+b\//);
  if (matchGit) return matchGit[1];

  const matchPatch = code.match(/^[+-]{3}\s+[ab]\/(.+)$/m);
  if (matchPatch) return matchPatch[1];

  const matchIndex = code.match(/Index:\s*(.+)$/m);
  if (matchIndex) return matchIndex[1];

  return "diff";
}

function transformMarkdownCodeBlocks(markdown: string, availableWidth: number): string {
  const CODE_BLOCK_REGEX = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  const targetWidth = Math.max(10, availableWidth || 80);

  return markdown.replace(CODE_BLOCK_REGEX, (_match, rawLang: string, rawCode: string) => {
    const lang = (rawLang || "").trim().toLowerCase();
    const code = rawCode.trimEnd();
    if (!code) return _match;

    // Diff / patch blocks get the boxed diff layout
    if (lang === "diff" || lang === "patch") {
      const filename = extractDiffFilename(code);
      const boxLines = buildBoxedDiff(
        {
          tag: "diff",
          title: filename,
          diffText: code,
          expanded: true,
        },
        targetWidth,
      );
      return `\n\n${boxLines.join("\n")}\n\n`;
    }

    // Standard code blocks get the boxed code layout
    const boxLines = buildBoxedCode(code, lang, targetWidth);
    return `\n\n${boxLines.join("\n")}\n\n`;
  });
}

// ============================================================================
// Extension Export
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 1. Register Markdown Transformer for Both Diffs & Standard Code Blocks
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType === "assistant-thinking") {
      return markdown;
    }
    // During active token-by-token streaming, don't interrupt open fences
    if (context.isStreaming && !markdown.includes("```\n") && !markdown.endsWith("```")) {
      return markdown;
    }
    return transformMarkdownCodeBlocks(markdown, context.availableWidth);
  });

  // 2. Slash Command `/diff-box`
  pi.registerCommand("diff-box", {
    description: "Display a git diff or file diff in boxed cyberpunk format",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const target = args.trim();
      let diffOutput = "";
      let title = "git diff";

      if (!target || target === "git") {
        try {
          diffOutput = cp.execSync("git diff --no-color HEAD", { cwd: ctx.cwd, encoding: "utf-8" });
          if (!diffOutput.trim()) {
            diffOutput = cp.execSync("git diff --no-color", { cwd: ctx.cwd, encoding: "utf-8" });
          }
        } catch {
          ctx.ui.notify("Not a git repo or no git diff available", "warning");
          return;
        }
      } else {
        title = target;
        try {
          diffOutput = cp.execSync(`git diff --no-color -- "${target}"`, { cwd: ctx.cwd, encoding: "utf-8" });
        } catch {
          ctx.ui.notify(`Could not get git diff for ${target}`, "warning");
          return;
        }
      }

      if (!diffOutput.trim()) {
        ctx.ui.notify("Working directory clean - no changes detected", "info");
        return;
      }

      const boxLines = buildBoxedDiff(
        {
          tag: "diff",
          title,
          statusText: C.statusApplied,
          diffText: diffOutput.trim(),
          expanded: true,
        },
        ctx.ui ? 80 : 80,
      );

      ctx.ui.notify(`Displaying boxed diff for ${title}`, "info");
      pi.sendMessage({
        customType: "boxed-diff-preview",
        content: boxLines.join("\n"),
        display: "user",
      });
    },
  });
}
