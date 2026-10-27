/**
 * Session Goals Extension for Pi
 *
 * Provides a strictly session-tied, in-memory KV store for tracking goals during an interactive session:
 * - Key: "not_done" | "done"
 * - Value: Array of goals ({ id, text })
 *
 * Features:
 * - ZERO disk persistence: state is strictly ephemeral and tied to the active Pi session memory.
 * - Tool `goals` for the assistant to add, mark done/todo, list, remove, or clear goals.
 * - Slash command `/goals` for the user to view or manage goals directly in the terminal:
 *     /goals                  -> display session goals KV store
 *     /goals add <goal>       -> add goal to [not_done]
 *     /goals done <id>        -> move goal to [done]
 *     /goals todo <id>        -> move goal back to [not_done]
 *     /goals rm <id>          -> remove goal
 *     /goals clear            -> clear all session goals
 * - Context hook: automatically provides the model with active session goals on each turn.
 * - TUI status badge: updates footer with goal progress (e.g. 🎯 Goals: 1 pending, 2 done).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export type GoalStatusKey = "not_done" | "done";

export interface GoalItem {
  id: number;
  text: string;
}

export interface SessionGoalsKV {
  not_done: GoalItem[];
  done: GoalItem[];
}

// Strictly in-memory session KV store (never persisted to disk)
let goalsKV: SessionGoalsKV = {
  not_done: [],
  done: [],
};
let nextId = 1;

function resetGoals(): void {
  goalsKV = {
    not_done: [],
    done: [],
  };
  nextId = 1;
}

function addGoal(text: string): GoalItem {
  const item: GoalItem = { id: nextId++, text: text.trim() };
  goalsKV.not_done.push(item);
  return item;
}

function markGoal(id: number, targetStatus: GoalStatusKey): { item?: GoalItem; changed: boolean } {
  const sourceStatus: GoalStatusKey = targetStatus === "done" ? "not_done" : "done";
  const sourceList = goalsKV[sourceStatus];
  const idx = sourceList.findIndex((g) => g.id === id);

  if (idx !== -1) {
    const [item] = sourceList.splice(idx, 1);
    goalsKV[targetStatus].push(item);
    return { item, changed: true };
  }

  // Already in target status?
  const existing = goalsKV[targetStatus].find((g) => g.id === id);
  return { item: existing, changed: false };
}

function removeGoal(id: number): GoalItem | undefined {
  for (const key of ["not_done", "done"] as const) {
    const list = goalsKV[key];
    const idx = list.findIndex((g) => g.id === id);
    if (idx !== -1) {
      return list.splice(idx, 1)[0];
    }
  }
  return undefined;
}

function formatKVOutput(): string {
  const pending = goalsKV.not_done;
  const completed = goalsKV.done;

  if (pending.length === 0 && completed.length === 0) {
    return "🎯 Session Goals: (Empty - no goals set for this session)";
  }

  const lines: string[] = ["🎯 Session Goals KV Store:"];
  lines.push("  [not_done]:");
  if (pending.length === 0) {
    lines.push("    (None pending)");
  } else {
    for (const g of pending) {
      lines.push(`    #${g.id} ○ ${g.text}`);
    }
  }

  lines.push("  [done]:");
  if (completed.length === 0) {
    lines.push("    (None completed)");
  } else {
    for (const g of completed) {
      lines.push(`    #${g.id} ✓ ${g.text}`);
    }
  }

  return lines.join("\n");
}

function updateFooterStatus(ctx?: ExtensionContext): void {
  const pendingCount = goalsKV.not_done.length;
  const doneCount = goalsKV.done.length;
  const total = pendingCount + doneCount;

  if (!ctx?.ui) return;

  if (total === 0) {
    ctx.ui.setStatus("session_goals", undefined);
  } else {
    ctx.ui.setStatus("session_goals", `🎯 Goals: ${pendingCount} pending, ${doneCount} done`);
  }
}

export default function (pi: ExtensionAPI) {
  // Reset store whenever a new session starts or shuts down
  pi.on("session_start", async (_event, ctx) => {
    resetGoals();
    updateFooterStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetGoals();
    updateFooterStatus(ctx);
  });

  // Inject current session goals into model context so the assistant always knows them
  pi.on("before_agent_start", async (_event) => {
    const pending = goalsKV.not_done;
    const completed = goalsKV.done;
    if (pending.length === 0 && completed.length === 0) {
      return undefined;
    }

    const summary: string[] = ["[Active Session Goals KV Store]"];
    if (pending.length > 0) {
      summary.push("not_done:");
      for (const g of pending) {
        summary.push(`  - #${g.id}: ${g.text}`);
      }
    }
    if (completed.length > 0) {
      summary.push("done:");
      for (const g of completed) {
        summary.push(`  - #${g.id}: ${g.text}`);
      }
    }

    return {
      message: {
        customType: "session_goals",
        content: summary.join("\n"),
        display: false,
      },
    };
  });

  // Register Assistant Tool
  pi.registerTool({
    name: "goals",
    label: "Session Goals",
    description:
      "Manage session-scoped goals in an in-memory KV store (keys: 'not_done' and 'done'). Use this tool whenever the user tells you to track, complete, list, or update a goal during this session.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"),
        Type.Literal("mark_done"),
        Type.Literal("mark_not_done"),
        Type.Literal("list"),
        Type.Literal("remove"),
        Type.Literal("clear"),
      ]),
      goal: Type.Optional(Type.String({ description: "Goal text (required for 'add')" })),
      id: Type.Optional(Type.Number({ description: "Goal ID (required for 'mark_done', 'mark_not_done', 'remove')" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "add": {
          if (!params.goal || !params.goal.trim()) {
            return {
              content: [{ type: "text", text: "Error: 'goal' description is required for action 'add'" }],
              details: { error: "goal description required" },
            };
          }
          const item = addGoal(params.goal);
          updateFooterStatus(ctx);
          return {
            content: [
              {
                type: "text",
                text: `Added goal to [not_done]: #${item.id} "${item.text}"\n\n${formatKVOutput()}`,
              },
            ],
            details: { action: "add", item, goals: { ...goalsKV } },
          };
        }

        case "mark_done": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for action 'mark_done'" }],
              details: { error: "id required" },
            };
          }
          const { item, changed } = markGoal(params.id, "done");
          if (!item) {
            return {
              content: [{ type: "text", text: `Error: Goal #${params.id} not found in session` }],
              details: { error: "not found" },
            };
          }
          updateFooterStatus(ctx);
          return {
            content: [
              {
                type: "text",
                text: changed
                  ? `Marked goal #${item.id} as [done]: "${item.text}"\n\n${formatKVOutput()}`
                  : `Goal #${item.id} was already [done]: "${item.text}"\n\n${formatKVOutput()}`,
              },
            ],
            details: { action: "mark_done", item, goals: { ...goalsKV } },
          };
        }

        case "mark_not_done": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for action 'mark_not_done'" }],
              details: { error: "id required" },
            };
          }
          const { item, changed } = markGoal(params.id, "not_done");
          if (!item) {
            return {
              content: [{ type: "text", text: `Error: Goal #${params.id} not found in session` }],
              details: { error: "not found" },
            };
          }
          updateFooterStatus(ctx);
          return {
            content: [
              {
                type: "text",
                text: changed
                  ? `Moved goal #${item.id} back to [not_done]: "${item.text}"\n\n${formatKVOutput()}`
                  : `Goal #${item.id} was already [not_done]: "${item.text}"\n\n${formatKVOutput()}`,
              },
            ],
            details: { action: "mark_not_done", item, goals: { ...goalsKV } },
          };
        }

        case "remove": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for action 'remove'" }],
              details: { error: "id required" },
            };
          }
          const removed = removeGoal(params.id);
          if (!removed) {
            return {
              content: [{ type: "text", text: `Error: Goal #${params.id} not found in session` }],
              details: { error: "not found" },
            };
          }
          updateFooterStatus(ctx);
          return {
            content: [
              {
                type: "text",
                text: `Removed goal #${removed.id} "${removed.text}"\n\n${formatKVOutput()}`,
              },
            ],
            details: { action: "remove", item: removed, goals: { ...goalsKV } },
          };
        }

        case "clear": {
          resetGoals();
          updateFooterStatus(ctx);
          return {
            content: [{ type: "text", text: "Cleared all session goals." }],
            details: { action: "clear", goals: { ...goalsKV } },
          };
        }

        case "list":
        default: {
          return {
            content: [{ type: "text", text: formatKVOutput() }],
            details: { action: "list", goals: { ...goalsKV } },
          };
        }
      }
    },

    renderCall(args, theme) {
      let label = theme.fg("toolTitle", theme.bold("goals ")) + theme.fg("accent", args.action);
      if (args.id !== undefined) label += ` ${theme.fg("muted", `#${args.id}`)}`;
      if (args.goal) label += ` ${theme.fg("dim", `"${args.goal}"`)}`;
      return new Text(label, 0, 0);
    },

    renderResult(result, _options, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("muted", text), 0, 0);
    },
  });

  // Register User Slash Command /goals
  pi.registerCommand("goals", {
    description: "Manage session-scoped goals KV store (/goals [add|done|todo|rm|clear])",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (!sub || sub === "list") {
        ctx.ui.notify(formatKVOutput(), "info");
        return;
      }

      if (sub === "add") {
        const text = parts.slice(1).join(" ");
        if (!text) {
          ctx.ui.notify("Usage: /goals add <goal description>", "error");
          return;
        }
        const item = addGoal(text);
        updateFooterStatus(ctx);
        ctx.ui.notify(`Added goal #${item.id} to [not_done]: "${item.text}"`, "info");
        return;
      }

      if (sub === "done" || sub === "complete") {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) {
          ctx.ui.notify("Usage: /goals done <id>", "error");
          return;
        }
        const { item, changed } = markGoal(id, "done");
        if (!item) {
          ctx.ui.notify(`Goal #${id} not found in current session`, "error");
          return;
        }
        updateFooterStatus(ctx);
        ctx.ui.notify(changed ? `Goal #${id} marked as [done]` : `Goal #${id} already [done]`, "info");
        return;
      }

      if (sub === "todo") {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) {
          ctx.ui.notify("Usage: /goals todo <id>", "error");
          return;
        }
        const { item, changed } = markGoal(id, "not_done");
        if (!item) {
          ctx.ui.notify(`Goal #${id} not found in current session`, "error");
          return;
        }
        updateFooterStatus(ctx);
        ctx.ui.notify(changed ? `Goal #${id} moved back to [not_done]` : `Goal #${id} already [not_done]`, "info");
        return;
      }

      if (sub === "rm" || sub === "remove") {
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) {
          ctx.ui.notify("Usage: /goals rm <id>", "error");
          return;
        }
        const removed = removeGoal(id);
        if (!removed) {
          ctx.ui.notify(`Goal #${id} not found in current session`, "error");
          return;
        }
        updateFooterStatus(ctx);
        ctx.ui.notify(`Removed goal #${id} ("${removed.text}")`, "info");
        return;
      }

      if (sub === "clear") {
        resetGoals();
        updateFooterStatus(ctx);
        ctx.ui.notify("Cleared all session goals", "info");
        return;
      }

      ctx.ui.notify(`Unknown subcommand: ${sub}. Use /goals [add|done|todo|rm|clear]`, "error");
    },
  });
}
