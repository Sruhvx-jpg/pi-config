/**
 * emacs-sync Extension for Pi
 *
 * Real-time Auto-Sync Engine for GNU Emacs:
 * - Subscribes to `tool_result` events for `edit` and `write` tool executions.
 * - Instantly signals Emacs via `emacsclient` IPC to reload open buffers visiting modified files.
 * - Forces buffer reversion without query dialogs or stale dirty state blocks.
 * - Works hand-in-hand with Emacs inotify `global-auto-revert-mode`.
 *
 * Commands:
 *   /emacssync         - Display Emacs server status, socket path, and sync config
 *   /emacssync on      - Enable automatic Emacs syncing after code modifications
 *   /emacssync off     - Disable automatic Emacs syncing
 *   /emacssync ping    - Test IPC connection with Emacs server
 *   /emacssync revert  - Force-revert all open file buffers in Emacs immediately
 *
 * Tool:
 *   emacs_sync         - Explicitly trigger Emacs buffer sync for a file or all buffers
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// ANSI Color Palette (Cyberpunk High-Contrast)
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

// ============================================================================
// Persistence & Configuration
// ============================================================================
export const SYNC_CONFIG_FILE = path.join(
  os.homedir(),
  ".pi/agent/emacs-sync.json"
);

export interface EmacsSyncConfig {
  enabled: boolean;
  notify: boolean;
}

const DEFAULT_CONFIG: EmacsSyncConfig = {
  enabled: true,
  notify: true,
};

export function loadSyncConfig(): EmacsSyncConfig {
  try {
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SYNC_CONFIG_FILE, "utf-8"));
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
        notify: typeof parsed.notify === "boolean" ? parsed.notify : true,
      };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

export function saveSyncConfig(config: EmacsSyncConfig): void {
  try {
    fs.mkdirSync(path.dirname(SYNC_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save emacs-sync config:", err);
  }
}

// ============================================================================
// Emacs IPC Engine
// ============================================================================
function findEmacsClient(): string {
  const candidatePaths = [
    "emacsclient",
    "/snap/bin/emacsclient",
    "/usr/bin/emacsclient",
    "/usr/local/bin/emacsclient",
  ];

  for (const p of candidatePaths) {
    try {
      const res = cp.spawnSync(p, ["--version"], { stdio: "ignore" });
      if (res.status === 0) return p;
    } catch {}
  }
  return "emacsclient";
}

function runEmacsClient(
  elisp: string,
  timeoutMs = 1500
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const client = findEmacsClient();
    const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000));

    cp.execFile(
      client,
      ["-w", String(timeoutSec), "--eval", elisp],
      { timeout: timeoutMs, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            output: (stderr || error.message || "").trim(),
          });
        } else {
          resolve({ success: true, output: (stdout || "").trim() });
        }
      }
    );
  });
}

export async function pingEmacs(): Promise<{
  ok: boolean;
  serverName?: string;
  version?: string;
  error?: string;
}> {
  const res = await runEmacsClient(
    `(list (if (boundp 'server-name) server-name "server") emacs-version)`
  );
  if (!res.success) {
    return { ok: false, error: res.output };
  }

  try {
    const match = res.output.match(/\("([^"]+)"\s+"([^"]+)"\)/);
    if (match) {
      return { ok: true, serverName: match[1], version: match[2] };
    }
    return { ok: true, serverName: "server", version: res.output };
  } catch {
    return { ok: true, version: res.output };
  }
}

export async function syncFileWithEmacs(
  filePath: string
): Promise<{ synced: boolean; bufferFound: boolean; output: string }> {
  const escapedPath = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const elisp = `(if (fboundp '+pi/sync-file)
    (+pi/sync-file "${escapedPath}")
  (let* ((f "${escapedPath}")
         (truename (file-truename f))
         (buf (find-buffer-visiting truename)))
    (if buf
        (progn
          (with-current-buffer buf
            (set-buffer-modified-p nil)
            (revert-buffer t t t)
            (message "⚡ [Pi Auto-Sync] Reverted %s" (buffer-name buf)))
          (when (fboundp 'doom-auto-revert-buffers-h)
            (doom-auto-revert-buffers-h))
          "reverted")
      (progn
        (when (fboundp 'doom-auto-revert-buffers-h)
          (doom-auto-revert-buffers-h))
        "not-open"))))`;

  const res = await runEmacsClient(elisp);
  if (!res.success) {
    return { synced: false, bufferFound: false, output: res.output };
  }

  const isReverted = res.output.includes("reverted");
  return {
    synced: true,
    bufferFound: isReverted,
    output: res.output,
  };
}

export async function syncAllBuffersWithEmacs(): Promise<{
  ok: boolean;
  count: number;
  output: string;
}> {
  const elisp = `(let ((count 0))
  (dolist (buf (buffer-list))
    (with-current-buffer buf
      (when (and buffer-file-name (file-exists-p buffer-file-name))
        (set-buffer-modified-p nil)
        (revert-buffer t t t)
        (setq count (1+ count)))))
  (when (fboundp 'doom-auto-revert-buffers-h)
    (doom-auto-revert-buffers-h))
  count)`;

  const res = await runEmacsClient(elisp);
  if (!res.success) {
    return { ok: false, count: 0, output: res.output };
  }

  const count = parseInt(res.output, 10) || 0;
  return { ok: true, count, output: res.output };
}

// ============================================================================
// Extension Entry Point
// ============================================================================
export default function (pi: ExtensionAPI) {
  let config = loadSyncConfig();

  function updateStatus(ctx: ExtensionContext) {
    if (config.enabled) {
      ctx.ui.setStatus("emacs-sync", "⚡ EMACS: SYNC");
    } else {
      ctx.ui.setStatus("emacs-sync", undefined);
    }
  }

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    config = loadSyncConfig();
    updateStatus(ctx);
  });

  // Intercept all successful edit and write executions to trigger instant auto-sync
  pi.on("tool_result", async (event, ctx) => {
    if (!config.enabled) return;
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const rawPath = (event.input as { path?: string })?.path;
    if (!rawPath || typeof rawPath !== "string") return;

    const absPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(ctx.cwd || process.cwd(), rawPath);

    const res = await syncFileWithEmacs(absPath);

    if (res.synced && res.bufferFound && config.notify && ctx.hasUI) {
      const fileName = path.basename(absPath);
      ctx.ui.notify(`⚡ Emacs buffer synced: ${fileName}`, "info");
    }
  });

  // Register Custom Tool: emacs_sync
  pi.registerTool({
    name: "emacs_sync",
    label: "Emacs Sync",
    description:
      "Instantly syncs and reloads open GNU Emacs buffers from disk via emacsclient IPC.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Specific file path to sync in Emacs. If omitted, syncs all open buffers.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.path) {
        const absPath = path.isAbsolute(params.path)
          ? params.path
          : path.resolve(ctx.cwd || process.cwd(), params.path);
        const res = await syncFileWithEmacs(absPath);
        if (!res.synced) {
          return {
            content: [
              {
                type: "text",
                text: `Emacs server unreachable or not running: ${res.output}`,
              },
            ],
            details: { synced: false, error: res.output },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: res.bufferFound
                ? `⚡ Successfully reverted Emacs buffer: ${path.basename(absPath)}`
                : `⚡ File ${path.basename(absPath)} synced (not currently open in any Emacs buffer).`,
            },
          ],
          details: { synced: true, bufferFound: res.bufferFound },
        };
      } else {
        const res = await syncAllBuffersWithEmacs();
        if (!res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Emacs server unreachable or not running: ${res.output}`,
              },
            ],
            details: { synced: false, error: res.output },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `⚡ Successfully reverted ${res.count} open buffer(s) in GNU Emacs.`,
            },
          ],
          details: { synced: true, count: res.count },
        };
      }
    },
  });

  // Register Command: /emacssync (and alias /sync)
  const handleSyncCommand = async (
    args: string,
    ctx: ExtensionCommandContext
  ) => {
    const sub = (args || "").trim().toLowerCase();

    if (sub === "on") {
      config.enabled = true;
      saveSyncConfig(config);
      updateStatus(ctx);
      ctx.ui.notify("⚡ Emacs auto-sync enabled!", "info");
      return;
    }

    if (sub === "off") {
      config.enabled = false;
      saveSyncConfig(config);
      updateStatus(ctx);
      ctx.ui.notify("⚡ Emacs auto-sync disabled.", "warning");
      return;
    }

    if (sub === "ping") {
      const ping = await pingEmacs();
      if (ping.ok) {
        ctx.ui.notify(
          `⚡ Emacs server online! [${ping.serverName}] Emacs v${ping.version}`,
          "info"
        );
      } else {
        ctx.ui.notify(
          `✖ Emacs server offline or unreachable: ${ping.error}`,
          "error"
        );
      }
      return;
    }

    if (sub === "all" || sub === "revert") {
      const res = await syncAllBuffersWithEmacs();
      if (res.ok) {
        ctx.ui.notify(
          `⚡ Reverted ${res.count} open buffer(s) in GNU Emacs!`,
          "info"
        );
      } else {
        ctx.ui.notify(
          `✖ Failed to sync buffers with Emacs: ${res.output}`,
          "error"
        );
      }
      return;
    }

    // Default: Display status banner & instructions
    const ping = await pingEmacs();
    const width = Math.min(process.stdout.columns || 80, 84);
    const inner = width - 4;
    const hr = "─".repeat(inner);
    const dhr = "═".repeat(inner);

    const lines: string[] = [];
    lines.push("");
    lines.push(`${C.borderActive}╔${dhr}╗${C.reset}`);
    lines.push(
      `${C.borderActive}║${C.reset}  ${C.bgHeader} ⚡ PI GNU EMACS AUTO-SYNC ENGINE ${C.reset}`.padEnd(
        width + 12
      ) + `${C.borderActive}║${C.reset}`
    );
    lines.push(`${C.borderActive}╠${hr}╣${C.reset}`);

    const statusStr = config.enabled
      ? `${C.green}${C.bold}ENABLED (Instant IPC + Inotify)${C.reset}`
      : `${C.red}${C.bold}DISABLED${C.reset}`;
    lines.push(
      `${C.border}║${C.reset}  Auto-Sync:       ${statusStr}`.padEnd(width + 8) +
        `${C.border}║${C.reset}`
    );

    const serverStr = ping.ok
      ? `${C.green}${C.bold}CONNECTED${C.reset} (${ping.serverName} | Emacs ${ping.version})`
      : `${C.yellow}${C.bold}OFFLINE / STANDBY${C.reset} (Starts when Emacs opens)`;
    lines.push(
      `${C.border}║${C.reset}  Emacs Server:    ${serverStr}`.padEnd(width + 8) +
        `${C.border}║${C.reset}`
    );

    lines.push(`${C.border}╠${hr}╣${C.reset}`);
    lines.push(
      `${C.border}║${C.reset}  ${C.boldCyan}Usage Commands:${C.reset}`.padEnd(
        width + 8
      ) + `${C.border}║${C.reset}`
    );
    lines.push(
      `${C.border}║${C.reset}    /emacssync on       - Enable real-time buffer sync`.padEnd(
        width
      ) + `${C.border}║${C.reset}`
    );
    lines.push(
      `${C.border}║${C.reset}    /emacssync off      - Disable buffer sync`.padEnd(
        width
      ) + `${C.border}║${C.reset}`
    );
    lines.push(
      `${C.border}║${C.reset}    /emacssync ping     - Check emacsclient IPC connection`.padEnd(
        width
      ) + `${C.border}║${C.reset}`
    );
    lines.push(
      `${C.border}║${C.reset}    /emacssync revert   - Revert all open buffers right now`.padEnd(
        width
      ) + `${C.border}║${C.reset}`
    );
    lines.push(`${C.borderActive}╚${dhr}╝${C.reset}`);
    lines.push("");

    console.log(lines.join("\n"));
  };

  pi.registerCommand("emacssync", {
    description: "Manage real-time GNU Emacs buffer auto-sync",
    handler: handleSyncCommand,
  });

  pi.registerCommand("sync", {
    description: "Manage real-time GNU Emacs buffer auto-sync (alias)",
    handler: handleSyncCommand,
  });
}
