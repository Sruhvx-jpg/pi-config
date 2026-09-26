/**
 * step-intent Extension for Pi
 *
 * Displays the agent's explicit intent/purpose directly at each execution checkpoint
 * (bash, read, write, grep, find, ls) in the chat transcript.
 *
 * Adds an optional `intent` parameter to tool definitions and prepends a sleek
 * cyberpunk intent badge:
 *   ▶ [Intent: Inspect GoCon model definitions & step structures]
 *   read pkg/model/model.go:1-120
 */

import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_FILE = path.join(os.homedir(), ".pi/agent/step-intent.json");

interface StepIntentConfig {
  enabled: boolean;
}

function loadConfig(): StepIntentConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      if (typeof data.enabled === "boolean") {
        return { enabled: data.enabled };
      }
    }
  } catch {}
  return { enabled: true };
}

function saveConfig(config: StepIntentConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch {}
}

function formatIntentPrefix(intent: unknown, theme: any, enabled: boolean): string {
  if (!enabled) return "";
  if (typeof intent !== "string") return "";
  const trimmed = intent.trim();
  if (!trimmed) return "";
  const arrow = theme.fg("accent", "▶ ");
  const badge = theme.bold(theme.fg("accent", `[Intent: ${trimmed}]`));
  return `${arrow}${badge}\n`;
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  let config = loadConfig();

  // ==========================================================================
  // 1. Read Tool with Intent
  // ==========================================================================
  const baseRead = createReadToolDefinition(cwd);
  const readSchema = Type.Object({
    intent: Type.Optional(
      Type.String({
        description: "Concise 1-line reason or goal for reading this file (under 10 words)",
      }),
    ),
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  });

  pi.registerTool({
    name: "read",
    label: "read",
    description: baseRead.description,
    promptSnippet: baseRead.promptSnippet,
    promptGuidelines: [
      ...(baseRead.promptGuidelines || []),
      "Always provide a concise 'intent' parameter (under 10 words) stating your immediate goal for reading this file.",
    ],
    parameters: readSchema,
    constrainedSampling: (baseRead as any).constrainedSampling,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const currentTool = createReadToolDefinition(ctx?.cwd || cwd);
      return currentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context: ToolRenderContext<any, any>) {
      const comp = baseRead.renderCall(args, theme, context);
      if (config.enabled && comp && typeof (comp as any).setText === "function") {
        const prefix = formatIntentPrefix(args?.intent, theme, config.enabled);
        if (prefix) {
          const raw = (comp as any).text || "";
          (comp as any).setText(`${prefix}${raw}`);
        }
      }
      return comp;
    },

    renderResult(result, options, theme, context) {
      return baseRead.renderResult(result, options, theme, context);
    },
  });

  // ==========================================================================
  // 2. Bash Tool with Intent
  // ==========================================================================
  const baseBash = createBashToolDefinition(cwd);
  const bashSchema = Type.Object({
    intent: Type.Optional(
      Type.String({
        description: "Concise 1-line reason or goal for this shell command (under 10 words)",
      }),
    ),
    command: Type.String({ description: "Shell command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: baseBash.description,
    promptSnippet: baseBash.promptSnippet,
    promptGuidelines: [
      ...(baseBash.promptGuidelines || []),
      "Always provide a concise 'intent' parameter (under 10 words) stating your immediate goal for this command.",
    ],
    parameters: bashSchema,
    constrainedSampling: (baseBash as any).constrainedSampling,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const currentTool = createBashToolDefinition(ctx?.cwd || cwd);
      return currentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context: ToolRenderContext<any, any>) {
      const comp = baseBash.renderCall(args, theme, context);
      if (config.enabled && comp && typeof (comp as any).setText === "function") {
        const prefix = formatIntentPrefix(args?.intent, theme, config.enabled);
        if (prefix) {
          const raw = (comp as any).text || "";
          (comp as any).setText(`${prefix}${raw}`);
        }
      }
      return comp;
    },

    renderResult(result, options, theme, context) {
      return baseBash.renderResult(result, options, theme, context);
    },
  });

  // ==========================================================================
  // 3. Write Tool with Intent
  // ==========================================================================
  const baseWrite = createWriteToolDefinition(cwd);
  const writeSchema = Type.Object({
    intent: Type.Optional(
      Type.String({
        description: "Concise 1-line reason or goal for creating/writing this file (under 10 words)",
      }),
    ),
    path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: baseWrite.description,
    promptSnippet: baseWrite.promptSnippet,
    promptGuidelines: [
      ...(baseWrite.promptGuidelines || []),
      "Always provide a concise 'intent' parameter (under 10 words) stating your immediate goal for writing this file.",
    ],
    parameters: writeSchema,
    constrainedSampling: (baseWrite as any).constrainedSampling,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const currentTool = createWriteToolDefinition(ctx?.cwd || cwd);
      return currentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context: ToolRenderContext<any, any>) {
      const comp = baseWrite.renderCall(args, theme, context);
      if (config.enabled && comp && typeof (comp as any).setText === "function") {
        const prefix = formatIntentPrefix(args?.intent, theme, config.enabled);
        if (prefix) {
          const raw = (comp as any).text || "";
          (comp as any).setText(`${prefix}${raw}`);
        }
      }
      return comp;
    },

    renderResult(result, options, theme, context) {
      return baseWrite.renderResult(result, options, theme, context);
    },
  });

  // ==========================================================================
  // 4. Grep Tool with Intent
  // ==========================================================================
  const baseGrep = createGrepToolDefinition(cwd);
  const grepSchema = Type.Object({
    intent: Type.Optional(
      Type.String({
        description: "Concise 1-line reason or goal for pattern searching (under 10 words)",
      }),
    ),
    pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
    context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: baseGrep.description,
    promptSnippet: baseGrep.promptSnippet,
    promptGuidelines: [
      ...(baseGrep.promptGuidelines || []),
      "Always provide a concise 'intent' parameter (under 10 words) stating your immediate goal for this search.",
    ],
    parameters: grepSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const currentTool = createGrepToolDefinition(ctx?.cwd || cwd);
      return currentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context: ToolRenderContext<any, any>) {
      const comp = baseGrep.renderCall(args, theme, context);
      if (config.enabled && comp && typeof (comp as any).setText === "function") {
        const prefix = formatIntentPrefix(args?.intent, theme, config.enabled);
        if (prefix) {
          const raw = (comp as any).text || "";
          (comp as any).setText(`${prefix}${raw}`);
        }
      }
      return comp;
    },

    renderResult(result, options, theme, context) {
      return baseGrep.renderResult(result, options, theme, context);
    },
  });

  // ==========================================================================
  // 5. Find Tool with Intent
  // ==========================================================================
  const baseFind = createFindToolDefinition(cwd);
  const findSchema = Type.Object({
    intent: Type.Optional(
      Type.String({
        description: "Concise 1-line reason or goal for finding files (under 10 words)",
      }),
    ),
    pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: baseFind.description,
    promptSnippet: baseFind.promptSnippet,
    promptGuidelines: [
      ...(baseFind.promptGuidelines || []),
      "Always provide a concise 'intent' parameter (under 10 words) stating your immediate goal for finding files.",
    ],
    parameters: findSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const currentTool = createFindToolDefinition(ctx?.cwd || cwd);
      return currentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context: ToolRenderContext<any, any>) {
      const comp = baseFind.renderCall(args, theme, context);
      if (config.enabled && comp && typeof (comp as any).setText === "function") {
        const prefix = formatIntentPrefix(args?.intent, theme, config.enabled);
        if (prefix) {
          const raw = (comp as any).text || "";
          (comp as any).setText(`${prefix}${raw}`);
        }
      }
      return comp;
    },

    renderResult(result, options, theme, context) {
      return baseFind.renderResult(result, options, theme, context);
    },
  });

  // ==========================================================================
  // 6. LS Tool with Intent
  // ==========================================================================
  const baseLs = createLsToolDefinition(cwd);
  const lsSchema = Type.Object({
    intent: Type.Optional(
      Type.String({
        description: "Concise 1-line reason or goal for listing this directory (under 10 words)",
      }),
    ),
    path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: baseLs.description,
    promptSnippet: baseLs.promptSnippet,
    promptGuidelines: [
      ...(baseLs.promptGuidelines || []),
      "Always provide a concise 'intent' parameter (under 10 words) stating your immediate goal for listing directory contents.",
    ],
    parameters: lsSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const currentTool = createLsToolDefinition(ctx?.cwd || cwd);
      return currentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context: ToolRenderContext<any, any>) {
      const comp = baseLs.renderCall(args, theme, context);
      if (config.enabled && comp && typeof (comp as any).setText === "function") {
        const prefix = formatIntentPrefix(args?.intent, theme, config.enabled);
        if (prefix) {
          const raw = (comp as any).text || "";
          (comp as any).setText(`${prefix}${raw}`);
        }
      }
      return comp;
    },

    renderResult(result, options, theme, context) {
      return baseLs.renderResult(result, options, theme, context);
    },
  });

  // ==========================================================================
  // 7. Interactive /intent Command
  // ==========================================================================
  pi.registerCommand("intent", {
    description: "Toggle step intent badges in chat transcript (on/off)",
    async handler(args, ctx: ExtensionCommandContext) {
      const sub = (args || "").trim().toLowerCase();
      if (sub === "on") {
        config.enabled = true;
        saveConfig(config);
        ctx.ui?.notify("⚡ Step Intent badges: ON", "info");
        return;
      }
      if (sub === "off") {
        config.enabled = false;
        saveConfig(config);
        ctx.ui?.notify("⚡ Step Intent badges: OFF", "info");
        return;
      }

      if (ctx.hasUI) {
        const current = config.enabled ? "ON" : "OFF";
        const choice = await ctx.ui.select(
          `Step Intent Badges (Current: ${current})`,
          [
            "1. ON  - Display [Intent: ...] badges on tool calls",
            "2. OFF - Hide [Intent: ...] badges",
          ]
        );
        if (!choice) return;
        if (choice.startsWith("1")) {
          config.enabled = true;
          saveConfig(config);
          ctx.ui.notify("⚡ Step Intent badges: ON", "info");
        } else if (choice.startsWith("2")) {
          config.enabled = false;
          saveConfig(config);
          ctx.ui.notify("⚡ Step Intent badges: OFF", "info");
        }
        return;
      }

      const current = config.enabled ? "ON" : "OFF";
      console.log(`Step Intent badges are currently ${current}. Use /intent on or /intent off.`);
    },
  });
}
