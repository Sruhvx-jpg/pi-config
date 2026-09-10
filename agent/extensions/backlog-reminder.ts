/**
 * Backlog Reminder Extension for Pi
 *
 * Reminds user of active backlogs and queued tasks on new session start.
 * Backlogs are stored persistently in ~/.pi/agent/backlog.json.
 *
 * Features:
 * - Appears on fresh session startup (new / startup).
 * - Keyboard shortcut Alt+b to toggle the backlog widget on/off anytime.
 * - Slash command `/backlog` to view, toggle, add, remove, or clear items:
 *     Alt+b               -> toggle backlog widget visibility
 *     /backlog            -> list pending items / show status
 *     /backlog toggle     -> toggle widget visibility
 *     /backlog add <task> -> add a new backlog item
 *     /backlog rm <id>    -> remove completed item
 *     /backlog clear      -> clear all items
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface BacklogItem {
  id: string;
  text: string;
  created: string;
}

const BACKLOG_FILE = path.join(os.homedir(), ".pi", "agent", "backlog.json");
let isVisible = false;

function loadBacklog(): BacklogItem[] {
  try {
    if (!fs.existsSync(BACKLOG_FILE)) return [];
    const content = fs.readFileSync(BACKLOG_FILE, "utf-8");
    return JSON.parse(content) as BacklogItem[];
  } catch {
    return [];
  }
}

function saveBacklog(items: BacklogItem[]): void {
  try {
    fs.writeFileSync(BACKLOG_FILE, JSON.stringify(items, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save backlog:", err);
  }
}

function renderWidgetLines(items: BacklogItem[]): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [
    `📌 ACTIVE BACKLOG (${items.length} item${items.length === 1 ? "" : "s"} | Alt+b to toggle):`,
  ];
  for (const item of items) {
    lines.push(`  [${item.id}] ${item.text}`);
  }
  return lines;
}

function showWidget(ctx: ExtensionContext, items: BacklogItem[]): void {
  if (!ctx.hasUI || items.length === 0) return;
  ctx.ui.setWidget("backlog-reminder", renderWidgetLines(items), { placement: "aboveEditor" });
  isVisible = true;
}

function hideWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("backlog-reminder", undefined);
  isVisible = false;
}

function toggleWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const items = loadBacklog();

  if (isVisible) {
    hideWidget(ctx);
    ctx.ui.notify("Backlog hidden. (Alt+b to restore)", "info");
  } else {
    if (items.length === 0) {
      ctx.ui.notify("No pending backlog items.", "info");
      return;
    }
    showWidget(ctx, items);
    ctx.ui.notify(`Backlog visible (${items.length} items | Alt+b to hide).`, "info");
  }
}

function refreshIfVisible(ctx: ExtensionContext): void {
  if (!isVisible) return;
  const items = loadBacklog();
  if (items.length > 0) {
    showWidget(ctx, items);
  } else {
    hideWidget(ctx);
  }
}

export default function backlogReminderExtension(pi: ExtensionAPI) {
  // 1. Appears when opening a fresh session (startup or new)
  pi.on("session_start", async (event, ctx) => {
    // Only display on opening a fresh session or fresh startup
    if (event.reason === "startup" || event.reason === "new") {
      const items = loadBacklog();
      if (items.length > 0) {
        showWidget(ctx, items);
        if (ctx.hasUI) {
          ctx.ui.notify(`📌 ${items.length} backlog items pending! (Alt+b to toggle)`, "info");
        }
        return;
      }
    }

    // For other triggers (resume, reload, fork), keep hidden by default
    hideWidget(ctx);
  });

  // 2. Register keyboard shortcut Alt+b to toggle visibility
  pi.registerShortcut("alt+b", {
    description: "Toggle backlog reminder widget",
    handler: async (ctx) => {
      toggleWidget(ctx);
    },
  });

  // 3. Inject backlog context into LLM system prompt
  pi.on("before_agent_start", async (event, _ctx) => {
    const items = loadBacklog();
    if (items.length === 0) return;

    const summary = items.map((it) => `[#${it.id}] ${it.text}`).join("; ");
    return {
      systemPrompt: `${event.systemPrompt}\n\n[Active User Backlog Tasks (from ~/.pi/agent/backlog.json): ${summary}]`,
    };
  });

  // 4. Register `/backlog` command to manage tasks
  pi.registerCommand("backlog", {
    description: "Manage session backlog tasks (/backlog, /backlog toggle, /backlog add <task>, /backlog rm <id>, /backlog clear)",
    handler: async (args, ctx) => {
      const items = loadBacklog();
      const trimmed = (args || "").trim();

      if (trimmed === "toggle") {
        toggleWidget(ctx);
        return;
      }

      if (!trimmed || trimmed === "list") {
        if (items.length === 0) {
          ctx.ui.notify("No pending backlog items.", "info");
          return;
        }
        const text = items.map((it) => `[${it.id}] ${it.text}`).join("\n");
        ctx.ui.notify(`Active Backlog (${items.length} items | Alt+b to toggle):\n${text}`, "info");
        return;
      }

      if (trimmed.startsWith("add ")) {
        const text = trimmed.slice(4).trim();
        if (!text) {
          ctx.ui.notify("Usage: /backlog add <task description>", "warning");
          return;
        }
        const nextId = (
          items.reduce((max, it) => Math.max(max, parseInt(it.id, 10) || 0), 0) + 1
        ).toString();
        items.push({
          id: nextId,
          text,
          created: new Date().toISOString().split("T")[0],
        });
        saveBacklog(items);
        refreshIfVisible(ctx);
        ctx.ui.notify(`Added item [${nextId}]: ${text}`, "info");
        return;
      }

      if (trimmed.startsWith("rm ") || trimmed.startsWith("remove ")) {
        const idToRemove = trimmed.split(" ")[1]?.trim();
        const filtered = items.filter((it) => it.id !== idToRemove);
        if (filtered.length === items.length) {
          ctx.ui.notify(`Backlog item [${idToRemove}] not found.`, "warning");
          return;
        }
        saveBacklog(filtered);
        refreshIfVisible(ctx);
        ctx.ui.notify(`Removed item [${idToRemove}].`, "info");
        return;
      }

      if (trimmed === "clear") {
        saveBacklog([]);
        hideWidget(ctx);
        ctx.ui.notify("Cleared all backlog items.", "info");
        return;
      }

      ctx.ui.notify("Commands: /backlog, /backlog toggle, /backlog add <text>, /backlog rm <id>, /backlog clear", "info");
    },
  });
}
