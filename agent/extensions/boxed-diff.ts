/**
 * boxed-diff & Live Code Panel Extension for Pi
 *
 * 1. Razor-sharp boxed code blocks & diffs:
 *    - Built-in `edit` tool override with live execution preview & self-shell.
 *    - Markdown transformer for all code blocks in chat (` ```diff `, ` ```rust `, ` ```go `, etc.):
 *      renders both diffs (red/green) and standard code (syntax-highlighted with line numbers)
 *      inside framed, distinctive cyberpunk boxes separated from chat prose.
 * 2. Live Coding Panel above the editor:
 *    - Spawns a cyberpunk HUD panel in real-time when code is being edited or written.
 *    - Streams live code diffs and changes directly in the panel.
 * 3. Commands:
 *    - `/diff-box [file|git]`: Inspect git diffs in boxed format.
 *    - `/live-panel [on|off|clear|demo]`: Toggle or demo the live coding panel.
 */

import {
  createEditToolDefinition,
  generateDiffString,
  highlightCode,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { constants } from "node:fs";
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
  borderLive: "\x1b[38;2;110;80;130m",

  // Header badges
  tagEdit: "\x1b[1;38;2;0;225;225m",
  tagDiff: "\x1b[1;38;2;130;170;255m",
  tagCode: "\x1b[1;38;2;250;180;60m",
  tagLive: "\x1b[1;38;2;255;40;130m",
  filePath: "\x1b[1;38;2;240;245;255m",

  // Status indicators
  statusPending: "\x1b[38;2;250;185;60m● Pending\x1b[0m",
  statusStreaming: "\x1b[38;2;255;0;128m● STREAMING\x1b[0m",
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
  foldText: "\x1b[38;2;120;130;150m",
  gutterBar: "\x1b[38;2;80;90;110m│\x1b[0m",
};

// ============================================================================
// State
// ============================================================================

let livePanelEnabled = true;

// ============================================================================
// Token / Word Diff for Intra-Line Highlighting
// ============================================================================

interface TokenPart {
  value: string;
  changed: boolean;
}

function computeWordDiff(oldStr: string, newStr: string): { oldParts: TokenPart[]; newParts: TokenPart[] } {
  const tokenize = (s: string) => s.match(/\w+|\s+|[^\w\s]+/g) || [];
  const oldTokens = tokenize(oldStr);
  const newTokens = tokenize(newStr);

  const m = oldTokens.length;
  const n = newTokens.length;

  if (m === 0 || n === 0) {
    return {
      oldParts: oldTokens.map((v) => ({ value: v, changed: true })),
      newParts: newTokens.map((v) => ({ value: v, changed: true })),
    };
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldTokens[i] === newTokens[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  let i = m;
  let j = n;
  const oldParts: TokenPart[] = [];
  const newParts: TokenPart[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      oldParts.unshift({ value: oldTokens[i - 1], changed: false });
      newParts.unshift({ value: newTokens[j - 1], changed: false });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      newParts.unshift({ value: newTokens[j - 1], changed: true });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      oldParts.unshift({ value: oldTokens[i - 1], changed: true });
      i--;
    }
  }

  return { oldParts, newParts };
}

// ============================================================================
// Diff Parser
// ============================================================================

interface ParsedDiffLine {
  type: "context" | "removed" | "added" | "hunk" | "dots" | "header";
  lineNum: string;
  content: string;
}

function parseDiffLine(raw: string): ParsedDiffLine {
  const clean = raw.replace(/\t/g, "   ");

  if (clean.startsWith("@@")) {
    return { type: "hunk", lineNum: "", content: clean };
  }
  if (
    clean.startsWith("---") ||
    clean.startsWith("+++") ||
    clean.startsWith("diff --git") ||
    clean.startsWith("index ")
  ) {
    return { type: "header", lineNum: "", content: clean };
  }
  if (/^\s*\.{3,}\s*$/.test(clean)) {
    return { type: "dots", lineNum: "", content: "..." };
  }

  const m = clean.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
  if (m) {
    const prefix = m[1];
    const lineNum = m[2].trim();
    const content = m[3];
    if (prefix === "-") return { type: "removed", lineNum, content };
    if (prefix === "+") return { type: "added", lineNum, content };
    return { type: "context", lineNum, content };
  }

  if (clean.startsWith("+")) {
    return { type: "added", lineNum: "", content: clean.slice(1) };
  }
  if (clean.startsWith("-")) {
    return { type: "removed", lineNum: "", content: clean.slice(1) };
  }
  if (clean.startsWith(" ")) {
    return { type: "context", lineNum: "", content: clean.slice(1) };
  }

  return { type: "context", lineNum: "", content: clean };
}

// ============================================================================
// Boxed Diff Layout Engine
// ============================================================================

interface BoxRenderOptions {
  tag: string;
  title: string;
  statusText?: string;
  diffText: string;
  errorMessage?: string;
  expanded?: boolean;
  maxCollapsedLines?: number;
  isLivePanel?: boolean;
}

function buildBoxedDiff(options: BoxRenderOptions, targetWidth: number): string[] {
  const {
    tag,
    title,
    statusText,
    diffText,
    errorMessage,
    expanded = false,
    maxCollapsedLines = 22,
    isLivePanel = false,
  } = options;

  let width = targetWidth;
  if (width > 110) {
    width = Math.min(width, 110);
  }
  width = Math.max(45, width);
  const innerWidth = width - 4; // 2 cols for "│ ", 2 cols for " │"

  const borderColor = isLivePanel ? C.borderLive : C.border;

  // 1. Render Header
  const statusPart = statusText ? ` ${statusText}` : "";
  let tagColor = C.tagDiff;
  if (tag === "edit") tagColor = C.tagEdit;
  if (isLivePanel) tagColor = C.tagLive;

  const titleDisplay = title && title !== "diff" ? ` ${C.filePath}${title}${C.reset}` : "";
  const titleSection = ` ${tagColor}${tag}${C.reset}${titleDisplay}${statusPart} `;
  const titleVis = visibleWidth(titleSection);
  const topDashes = Math.max(1, width - 2 - titleVis - 1);
  const headerLine = `${borderColor}╭─${C.reset}${titleSection}${borderColor}${"─".repeat(topDashes)}╮${C.reset}`;

  const lines: string[] = [headerLine];

  // 2. Handle Error Case
  if (errorMessage) {
    const errorPrefix = `${C.statusError}: `;
    const wrappedErr = wrapTextWithAnsi(errorPrefix + errorMessage, innerWidth);
    for (const w of wrappedErr) {
      const pad = Math.max(0, innerWidth - visibleWidth(w));
      lines.push(`${borderColor}│${C.reset} ${w}${" ".repeat(pad)} ${borderColor}│${C.reset}`);
    }
    const botDashes = Math.max(1, width - 2);
    lines.push(`${borderColor}╰${"─".repeat(botDashes)}╯${C.reset}`);
    return lines;
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
      const pad = Math.max(0, innerWidth - visibleWidth(w));
      lines.push(`${borderColor}│${C.reset} ${w}${" ".repeat(pad)} ${borderColor}│${C.reset}`);
    }
  }

  if (shouldTruncate) {
    const foldNotice = `${C.foldText}... (${hiddenCount} more lines, click or Ctrl+O to expand)${C.reset}`;
    const wrappedNotice = wrapTextWithAnsi(foldNotice, innerWidth);
    for (const w of wrappedNotice) {
      const pad = Math.max(0, innerWidth - visibleWidth(w));
      lines.push(`${borderColor}│${C.reset} ${w}${" ".repeat(pad)} ${borderColor}│${C.reset}`);
    }
  }

  // 5. Render Footer with +N -M Summary
  let summarySection = "";
  if (addCount > 0 || remCount > 0) {
    summarySection = ` ${C.addText}+${addCount}${C.reset} ${C.remText}-${remCount}${C.reset} lines `;
  } else {
    summarySection = isLivePanel ? " live code stream " : " clean ";
  }

  const summaryVis = visibleWidth(summarySection);
  const botDashes = Math.max(1, width - 2 - summaryVis - 1);
  const footerLine = `${borderColor}╰${"─".repeat(botDashes)}${summarySection}─╯${C.reset}`;
  lines.push(footerLine);

  return lines;
}

// ============================================================================
// Boxed Standard Code Block Engine
// ============================================================================

function buildBoxedCode(code: string, lang: string, targetWidth: number): string[] {
  let width = targetWidth;
  if (width > 110) {
    width = Math.min(width, 110);
  }
  width = Math.max(45, width);
  const innerWidth = width - 4;

  // Syntax highlighting via pi's built-in engine
  let highlightedLines: string[];
  try {
    highlightedLines = highlightCode(code, lang);
  } catch {
    highlightedLines = code.split("\n");
  }

  const displayLang = lang || "code";
  const headerTitle = ` ${C.tagCode}code${C.reset} ${C.filePath}${displayLang}${C.reset} `;
  const titleVis = visibleWidth(headerTitle);
  const topDashes = Math.max(1, width - 2 - titleVis - 1);
  const headerLine = `${C.borderCode}╭─${C.reset}${headerTitle}${C.borderCode}${"─".repeat(topDashes)}╮${C.reset}`;

  const lines: string[] = [headerLine];
  const totalLines = highlightedLines.length;
  const gutterWidth = Math.max(2, String(totalLines).length);

  for (let i = 0; i < totalLines; i++) {
    const num = `${C.ctxLineNum}${String(i + 1).padStart(gutterWidth, " ")}${C.reset}`;
    const cleanContent = highlightedLines[i].replace(/\t/g, "   ");
    const formattedRow = `${num} ${C.gutterBar} ${cleanContent}`;

    const wrapped = wrapTextWithAnsi(formattedRow, innerWidth);
    for (const w of wrapped) {
      const pad = Math.max(0, innerWidth - visibleWidth(w));
      lines.push(`${C.borderCode}│${C.reset} ${w}${" ".repeat(pad)} ${C.borderCode}│${C.reset}`);
    }
  }

  const footerText = ` ${C.foldText}${totalLines} lines${C.reset} `;
  const footerVis = visibleWidth(footerText);
  const botDashes = Math.max(1, width - 2 - footerVis - 1);
  const footerLine = `${C.borderCode}╰${"─".repeat(botDashes)}${footerText}─╯${C.reset}`;
  lines.push(footerLine);

  return lines;
}

// ============================================================================
// Boxed Diff TUI Component (For Edit Tool)
// ============================================================================

class BoxedDiffToolComponent implements Component {
  filePath: string;
  status: "pending" | "success" | "error" = "pending";
  diffText = "";
  errorMessage?: string;
  expanded = false;
  previewArgsKey?: string;
  previewPending = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  setDiff(diff: string) {
    this.diffText = diff;
    this.errorMessage = undefined;
  }

  setError(err: string) {
    this.errorMessage = err;
    this.status = "error";
  }

  setSuccess(diff?: string) {
    this.status = "success";
    if (diff) this.diffText = diff;
  }

  invalidate(): void {
    // Required by Component interface & MouseRegion
  }

  render(width: number): string[] {
    let statusText: string;
    if (this.status === "pending") {
      statusText = C.statusPending;
    } else if (this.status === "success") {
      statusText = C.statusApplied;
    } else {
      statusText = C.statusError;
    }

    return buildBoxedDiff(
      {
        tag: "edit",
        title: this.filePath,
        statusText,
        diffText: this.diffText,
        errorMessage: this.errorMessage,
        expanded: this.expanded,
        maxCollapsedLines: 25,
      },
      width,
    );
  }
}

// ============================================================================
// Live Coding Panel Component (Widget Above Editor)
// ============================================================================

class LiveCodePanelComponent implements Component {
  tag: string;
  title: string;
  statusText: string;
  diffText: string;
  errorMessage?: string;

  constructor(tag = "LIVE CODE", title = "", statusText = C.statusStreaming, diffText = "") {
    this.tag = tag;
    this.title = title;
    this.statusText = statusText;
    this.diffText = diffText;
  }

  invalidate(): void {
    // Required by Component interface
  }

  render(width: number): string[] {
    return buildBoxedDiff(
      {
        tag: this.tag,
        title: this.title,
        statusText: this.statusText,
        diffText: this.diffText,
        errorMessage: this.errorMessage,
        expanded: true,
        maxCollapsedLines: 12,
        isLivePanel: true,
      },
      width,
    );
  }
}

// ============================================================================
// Live Diff Computation Helper
// ============================================================================

async function computeEditsPreview(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
  cwd: string,
): Promise<{ diff?: string; error?: string }> {
  try {
    const home = process.env.HOME || "";
    const editDiffMod = await import(
      `${home}/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js`
    );
    if (typeof editDiffMod.computeEditsDiff === "function") {
      const res = await editDiffMod.computeEditsDiff(path, edits, cwd);
      if ("error" in res) return { error: res.error };
      if ("diff" in res) return { diff: res.diff };
    }
  } catch {
    // Fall back to direct replacement logic below
  }

  const absPath = resolve(cwd, path);
  try {
    await access(absPath, constants.R_OK);
  } catch (err: any) {
    return { error: `File not accessible: ${path}` };
  }

  try {
    const rawContent = await readFile(absPath, "utf-8");
    let newContent = rawContent;
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      if (!newContent.includes(edit.oldText)) {
        return { error: `Edit block #${i + 1} pattern not found in ${path}` };
      }
      newContent = newContent.replace(edit.oldText, edit.newText);
    }
    const diffResult = generateDiffString(rawContent, newContent);
    return { diff: diffResult.diff };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
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
  // Matches all fenced code blocks: ```lang ... ```
  const CODE_BLOCK_REGEX = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  const targetWidth = availableWidth || 80;

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
  let activeLivePanel: LiveCodePanelComponent | null = null;
  let activeLiveTimer: NodeJS.Timeout | null = null;

  function updateLivePanel(ctx: ExtensionContext, panel: LiveCodePanelComponent | null, autoDismissMs = 0) {
    if (!ctx.hasUI || !livePanelEnabled) return;
    if (activeLiveTimer) {
      clearTimeout(activeLiveTimer);
      activeLiveTimer = null;
    }

    if (!panel) {
      activeLivePanel = null;
      ctx.ui.setWidget("live-coding-panel", undefined);
      return;
    }

    activeLivePanel = panel;
    ctx.ui.setWidget("live-coding-panel", () => panel, { placement: "aboveEditor" });

    if (autoDismissMs > 0) {
      activeLiveTimer = setTimeout(() => {
        activeLivePanel = null;
        ctx.ui.setWidget("live-coding-panel", undefined);
      }, autoDismissMs);
    }
  }

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

  // 2. Lifecycle Hooks for Live Code Panel
  pi.on("turn_start", (_event, ctx) => {
    updateLivePanel(ctx, null);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!livePanelEnabled || !ctx.hasUI) return;

    if (event.toolName === "edit") {
      const filePath = event.args?.path || event.args?.file_path || "file";
      const panel = new LiveCodePanelComponent("LIVE EDIT", filePath, C.statusStreaming, "  Preparing file modification...");
      updateLivePanel(ctx, panel);

      const edits = Array.isArray(event.args?.edits)
        ? event.args.edits
        : (event.args?.oldText && event.args?.newText ? [{ oldText: event.args.oldText, newText: event.args.newText }] : []);

      if (edits.length > 0) {
        void computeEditsPreview(filePath, edits, ctx.cwd).then((preview) => {
          if (activeLivePanel && activeLivePanel.title === filePath) {
            if (preview.diff) {
              activeLivePanel.diffText = preview.diff;
            } else if (preview.error) {
              activeLivePanel.errorMessage = preview.error;
            }
            updateLivePanel(ctx, activeLivePanel);
          }
        });
      }
    } else if (event.toolName === "write") {
      const filePath = event.args?.path || "file";
      const content = typeof event.args?.content === "string" ? event.args.content : "";
      const previewLines = content.split("\n").slice(0, 8).map((l) => `+ ${l}`).join("\n");
      const panel = new LiveCodePanelComponent("LIVE WRITE", filePath, C.statusStreaming, previewLines || "+ (new file)");
      updateLivePanel(ctx, panel);
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!livePanelEnabled || !ctx.hasUI || !activeLivePanel) return;

    if (event.toolName === "edit" || event.toolName === "write") {
      if (event.isError) {
        activeLivePanel.statusText = C.statusError;
      } else {
        activeLivePanel.statusText = C.statusApplied;
        if (event.toolName === "edit" && (event.result as any)?.details?.diff) {
          activeLivePanel.diffText = (event.result as any).details.diff;
        }
      }
      updateLivePanel(ctx, activeLivePanel, 8000);
    }
  });

  // 3. Override Built-in `edit` Tool with Boxed Diff UI
  const baseEditTool = createEditToolDefinition(process.cwd());

  pi.registerTool({
    ...baseEditTool,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const currentTool = createEditToolDefinition(ctx?.cwd || process.cwd());
      return currentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args: any, _theme, context: ToolRenderContext<any, any>) {
      const filePath = typeof args?.path === "string" ? args.path : (args?.file_path || "unknown");
      let component = context.lastComponent as BoxedDiffToolComponent | undefined;

      if (!(component instanceof BoxedDiffToolComponent)) {
        component = new BoxedDiffToolComponent(filePath);
        context.state.callComponent = component;
      }

      component.filePath = filePath;
      component.expanded = context.expanded;

      const edits = Array.isArray(args?.edits)
        ? args.edits
        : (args?.oldText && args?.newText ? [{ oldText: args.oldText, newText: args.newText }] : []);

      const argsKey = JSON.stringify({ path: filePath, edits });
      if (component.previewArgsKey !== argsKey) {
        component.previewArgsKey = argsKey;
        component.previewPending = false;
      }

      if (context.argsComplete && edits.length > 0 && !component.diffText && !component.previewPending) {
        component.previewPending = true;
        const requestKey = argsKey;

        void computeEditsPreview(filePath, edits, context.cwd).then((preview) => {
          if (component?.previewArgsKey === requestKey) {
            component.previewPending = false;
            if (preview.error) {
              component.setError(preview.error);
            } else if (preview.diff) {
              component.setDiff(preview.diff);
            }
            context.invalidate();
          }
        });
      }

      return component;
    },

    renderResult(result: any, options, _theme, context: ToolRenderContext<any, any>) {
      const component = context.state.callComponent as BoxedDiffToolComponent | undefined;
      if (component) {
        component.expanded = options.expanded;
        if (context.isError) {
          const errText = result.content
            ?.filter((c: any) => c.type === "text")
            ?.map((c: any) => c.text || "")
            ?.join("\n") || "Edit failed";
          component.setError(errText);
        } else {
          const finalDiff = result.details?.diff;
          component.setSuccess(finalDiff);
        }
      }

      return new Container();
    },
  });

  // 4. Slash Command `/diff-box`
  pi.registerCommand("diff-box", {
    description: "Display a git diff or file diff in the cyberpunk red & green boxed format",
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
        80,
      );

      ctx.ui.notify(`Displaying boxed diff for ${title}`, "info");
      pi.sendMessage({
        customType: "boxed-diff-preview",
        content: boxLines.join("\n"),
        display: "user",
      });
    },
  });

  // 5. Slash Command `/live-panel`
  pi.registerCommand("live-panel", {
    description: "Manage the live coding panel widget (on | off | clear | demo)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cmd = args.trim().toLowerCase();

      if (cmd === "off") {
        livePanelEnabled = false;
        updateLivePanel(ctx, null);
        ctx.ui.notify("Live coding panel disabled", "info");
        return;
      }

      if (cmd === "on") {
        livePanelEnabled = true;
        ctx.ui.notify("Live coding panel enabled", "info");
        return;
      }

      if (cmd === "clear") {
        updateLivePanel(ctx, null);
        ctx.ui.notify("Live panel cleared", "info");
        return;
      }

      if (cmd === "demo" || !cmd) {
        livePanelEnabled = true;
        const demoDiff = [
          " 42 func ProcessStream(buf []byte) error {",
          "-43 \treturn legacyProcessor(buf)",
          "+43 \treturn zeroCopyPipeline(buf)",
          " 44 }",
        ].join("\n");
        const panel = new LiveCodePanelComponent("LIVE CODE", "core/engine.go", C.statusStreaming, demoDiff);
        updateLivePanel(ctx, panel, 10000);
        ctx.ui.notify("Spawning live code HUD panel demo above editor (10s auto-fade)", "info");
        return;
      }

      ctx.ui.notify("Usage: /live-panel [on | off | clear | demo]", "warning");
    },
  });
}
