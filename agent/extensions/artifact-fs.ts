/**
 * artifact-fs Extension for Pi
 *
 * Integrates Cloudflare's ArtifactFS (Git-backed FUSE filesystem) into Pi.
 *
 * Provides:
 * 1. Tool `artifact_fs_mount`:
 *    Instantly mounts any remote Git repository over FUSE without performing
 *    a full clone. Downloads commits/trees in seconds (~MBs) and hydrates file
 *    blobs on demand when read/edited.
 * 2. Tool `artifact_fs_status`:
 *    Inspects mount status, head commit, and blob hydration metrics.
 * 3. Tool `artifact_fs_unmount`:
 *    Unmounts or removes registered repositories.
 * 4. Tool `artifact_fs_prefetch`:
 *    Triggers heuristic background hydration for a mounted repository.
 * 5. Slash Command `/artifact` (or `/afs`):
 *    Interactive CLI management for mounting, unmounting, status, and daemon control.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as os from "node:os";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Configuration & Paths
// ============================================================================
const HOME = process.env.HOME || os.homedir();
const ARTIFACT_FS_ROOT =
  process.env.ARTIFACT_FS_ROOT || path.join(HOME, ".local/share/artifact-fs");
const MOUNT_ROOT = path.join(ARTIFACT_FS_ROOT, "mnt");
const DAEMON_LOG = path.join(ARTIFACT_FS_ROOT, "daemon.log");
const BIN_PATH = path.join(HOME, ".local/bin/artifact-fs");

// Ensure directories exist
function ensureDirs() {
  if (!fs.existsSync(ARTIFACT_FS_ROOT)) {
    fs.mkdirSync(ARTIFACT_FS_ROOT, { recursive: true });
  }
  if (!fs.existsSync(MOUNT_ROOT)) {
    fs.mkdirSync(MOUNT_ROOT, { recursive: true });
  }
}

// ============================================================================
// Terminal Colors & Box Formatting
// ============================================================================
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[38;2;80;210;255m",
  boldCyan: "\x1b[1;38;2;0;225;225m",
  green: "\x1b[38;2;80;230;130m",
  boldGreen: "\x1b[1;38;2;80;230;130m",
  yellow: "\x1b[38;2;255;200;60m",
  magenta: "\x1b[38;2;220;120;255m",
  boldMagenta: "\x1b[1;38;2;220;120;255m",
  red: "\x1b[38;2;255;90;90m",
  border: "\x1b[38;2;60;70;90m",
  borderActive: "\x1b[38;2;0;225;225m",
};

// ============================================================================
// Daemon Lifecycle Manager
// ============================================================================
export function isDaemonRunning(): boolean {
  try {
    const out = cp.execSync("pgrep -f 'artifact-fs daemon'", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function ensureDaemonRunning(): { started: boolean; running: boolean; error?: string } {
  ensureDirs();
  if (isDaemonRunning()) {
    return { started: false, running: true };
  }

  try {
    const logFd = fs.openSync(DAEMON_LOG, "a");
    const child = cp.spawn(
      "artifact-fs",
      ["daemon", "--root", MOUNT_ROOT],
      {
        env: {
          ...process.env,
          ARTIFACT_FS_ROOT,
        },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      }
    );
    child.unref();

    // Give daemon 500ms to bind sockets
    cp.execSync("sleep 0.5");

    if (isDaemonRunning()) {
      return { started: true, running: true };
    }
    return { started: false, running: false, error: "Daemon failed to start after spawn." };
  } catch (err: any) {
    return { started: false, running: false, error: err.message };
  }
}

export function stopDaemon(): boolean {
  try {
    cp.execSync("pkill -f 'artifact-fs daemon'", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Repository Operations Wrapper
// ============================================================================
export interface RepoEntry {
  name: string;
  ref: string;
  mountPath: string;
  remoteUrl: string;
}

export interface RepoStatusInfo {
  name: string;
  state: string;
  head: string;
  ref: string;
  sourceRef: string;
  remoteRefresh: string;
  hydratedBlobs: number;
  hydratedBytes: number;
  overlayDirty: boolean;
  raw: string;
}

export function listConfiguredRepos(): RepoEntry[] {
  ensureDaemonRunning();
  try {
    const out = cp.execSync("artifact-fs list-repos", {
      env: { ...process.env, ARTIFACT_FS_ROOT },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    const lines = out.trim().split("\n").filter((l) => l.trim().length > 0);
    const repos: RepoEntry[] = [];

    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 4) {
        repos.push({
          name: parts[0].trim(),
          ref: parts[1].trim(),
          mountPath: parts[2].trim(),
          remoteUrl: parts[3].trim(),
        });
      }
    }
    return repos;
  } catch {
    return [];
  }
}

export function getRepoStatus(name: string): RepoStatusInfo | null {
  ensureDaemonRunning();
  try {
    const out = cp.execSync(`artifact-fs status --name "${name}"`, {
      env: { ...process.env, ARTIFACT_FS_ROOT },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    // Parse key=value pairs
    const pairs: Record<string, string> = {};
    const tokens = out.split(/\s+/);
    for (const token of tokens) {
      const [k, v] = token.split("=");
      if (k && v !== undefined) {
        pairs[k] = v;
      }
    }

    return {
      name: pairs.repo || name,
      state: pairs.state || "unknown",
      head: pairs.head || "none",
      ref: pairs.ref || "none",
      sourceRef: pairs.source_ref || "none",
      remoteRefresh: pairs.remote_refresh || "none",
      hydratedBlobs: parseInt(pairs.hydrated_blobs || "0", 10),
      hydratedBytes: parseInt(pairs.hydrated_bytes || "0", 10),
      overlayDirty: pairs.overlay_dirty === "true",
      raw: out,
    };
  } catch {
    return null;
  }
}

export function normalizeRemoteUrl(input: string): string {
  let url = input.trim();
  // Handle github shorthand "owner/repo"
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(url)) {
    url = `https://github.com/${url}.git`;
  }
  return url;
}

export function normalizeRef(ref?: string): string {
  if (!ref || ref.trim().length === 0) return "refs/heads/main";
  const r = ref.trim();
  if (r.startsWith("refs/")) return r;
  return `refs/heads/${r}`;
}

export function mountRepo(opts: {
  url: string;
  name?: string;
  ref?: string;
  depth?: number;
  refresh?: string;
}): { success: boolean; name: string; path: string; status?: RepoStatusInfo | null; error?: string } {
  ensureDaemonRunning();

  const remoteUrl = normalizeRemoteUrl(opts.url);
  const repoName =
    opts.name ||
    remoteUrl
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") ||
    "repo";

  let canonicalRef = normalizeRef(opts.ref);
  const depth = opts.depth !== undefined ? opts.depth : 0;
  const refresh = opts.refresh || "30s";

  const runAdd = (refToTry: string) => {
    return cp.execSync(
      `artifact-fs add-repo --name "${repoName}" --remote "${remoteUrl}" --ref "${refToTry}" --depth ${depth} --refresh "${refresh}"`,
      {
        env: { ...process.env, ARTIFACT_FS_ROOT },
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  };

  try {
    runAdd(canonicalRef);
  } catch (err: any) {
    // If user didn't specify ref explicitly and 'main' failed, attempt 'master'
    if (!opts.ref && canonicalRef === "refs/heads/main") {
      try {
        canonicalRef = "refs/heads/master";
        runAdd(canonicalRef);
      } catch (err2: any) {
        return {
          success: false,
          name: repoName,
          path: path.join(MOUNT_ROOT, repoName),
          error: err2.stderr || err2.message || String(err2),
        };
      }
    } else {
      return {
        success: false,
        name: repoName,
        path: path.join(MOUNT_ROOT, repoName),
        error: err.stderr || err.message || String(err),
      };
    }
  }

  const mountPath = path.join(MOUNT_ROOT, repoName);
  const status = getRepoStatus(repoName);

  return {
    success: true,
    name: repoName,
    path: mountPath,
    status,
  };
}

export function unmountOrRemoveRepo(name: string, remove: boolean = true): { success: boolean; message: string } {
  ensureDaemonRunning();
  try {
    const cmd = remove ? `artifact-fs remove-repo --name "${name}"` : `artifact-fs unmount --name "${name}"`;
    const out = cp.execSync(cmd, {
      env: { ...process.env, ARTIFACT_FS_ROOT },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true, message: out.trim() };
  } catch (err: any) {
    return { success: false, message: err.stderr || err.message || String(err) };
  }
}

export function prefetchRepo(name?: string): { success: boolean; message: string } {
  ensureDaemonRunning();
  try {
    const cmd = name ? `artifact-fs prefetch --name "${name}"` : `artifact-fs prefetch`;
    const out = cp.execSync(cmd, {
      env: { ...process.env, ARTIFACT_FS_ROOT },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true, message: out.trim() };
  } catch (err: any) {
    return { success: false, message: err.stderr || err.message || String(err) };
  }
}

// ============================================================================
// UI Renderers
// ============================================================================
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function renderArtifactTable(repos: RepoEntry[]): string {
  const daemonActive = isDaemonRunning();
  const width = 80;
  const hr = "─".repeat(width);
  const doubleHr = "═".repeat(width);

  const lines: string[] = [];
  lines.push("");
  lines.push(`${C.borderActive}╔${doubleHr}╗${C.reset}`);
  lines.push(
    `${C.borderActive}║${C.reset}  ${C.boldCyan}⚡ ARTIFACT-FS: GIT-BACKED ON-DEMAND FUSE REPOSITORIES${C.reset}`.padEnd(
      width + 17
    ) + `${C.borderActive}║${C.reset}`
  );
  lines.push(
    `${C.borderActive}║${C.reset}  ${C.dim}Mount Root: ${MOUNT_ROOT} | Daemon: ${
      daemonActive ? `${C.boldGreen}ONLINE●${C.reset}` : `${C.red}OFFLINE○${C.reset}`
    }`.padEnd(daemonActive ? width + 28 : width + 21) + `${C.borderActive}║${C.reset}`
  );
  lines.push(`${C.border}╠${hr}╣${C.reset}`);

  if (repos.length === 0) {
    lines.push(
      `${C.border}║${C.reset}  ${C.dim}No repositories currently mounted. Use /artifact mount <url>${C.reset}`.padEnd(
        width + 9
      ) + `${C.border}║${C.reset}`
    );
  } else {
    for (const r of repos) {
      const status = getRepoStatus(r.name);
      const stateBadge =
        status?.state === "mounted"
          ? `${C.green}[MOUNTED]${C.reset}`
          : `${C.yellow}[${status?.state?.toUpperCase() || "UNKNOWN"}]${C.reset}`;
      const blobs = status ? `${status.hydratedBlobs} blobs (${formatBytes(status.hydratedBytes)})` : "0 blobs";
      const dirtyBadge = status?.overlayDirty ? ` ${C.magenta}[DIRTY OVERLAY]${C.reset}` : "";

      lines.push(
        `${C.border}║${C.reset}  ${C.bold}${r.name}${C.reset} ${stateBadge}${dirtyBadge} ${C.dim}(${r.ref})${C.reset}`.padEnd(
          width + (status?.overlayDirty ? 38 : 28)
        ) + `${C.border}║${C.reset}`
      );
      lines.push(
        `${C.border}║${C.reset}    ${C.cyan}${r.mountPath}${C.reset} ${C.dim}• Hydrated: ${blobs}${C.reset}`.padEnd(
          width + 19
        ) + `${C.border}║${C.reset}`
      );
      lines.push(
        `${C.border}║${C.reset}    ${C.dim}Remote: ${r.remoteUrl}${C.reset}`.padEnd(width + 9) +
          `${C.border}║${C.reset}`
      );
    }
  }

  lines.push(`${C.borderActive}╚${doubleHr}╝${C.reset}`);
  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// Extension Entry Point
// ============================================================================
export default function (pi: ExtensionAPI) {
  // 1. Tool: artifact_fs_mount
  pi.registerTool({
    name: "artifact_fs_mount",
    label: "artifact_fs_mount",
    description:
      "Instantly mount any remote Git repository via blobless FUSE without cloning. Downloads tree structure in seconds and hydrates file contents on demand when read/edited.",
    parameters: Type.Object({
      url: Type.String({
        description: "Git remote URL (HTTPS/SSH) or GitHub shorthand (e.g. 'cloudflare/artifact-fs' or 'octocat/Hello-World')",
      }),
      name: Type.Optional(
        Type.String({
          description: "Optional local folder alias/name for the mount (defaults to repo name)",
        })
      ),
      ref: Type.Optional(
        Type.String({
          description: "Target branch or ref (e.g. 'main', 'master', 'refs/heads/main')",
        })
      ),
      depth: Type.Optional(
        Type.Number({
          description: "History depth (default: 0 for complete tree history with zero initial blobs)",
        })
      ),
      refresh: Type.Optional(
        Type.String({
          description: "Remote refresh interval (e.g. '30s', '5m', 'never'; default: '30s')",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const res = mountRepo({
        url: params.url,
        name: params.name,
        ref: params.ref,
        depth: params.depth,
        refresh: params.refresh,
      });

      if (!res.success) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: res.error, name: res.name, targetUrl: params.url }, null, 2),
            },
          ],
          isError: true,
          details: { error: res.error },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                repo: res.name,
                mountPath: res.path,
                state: res.status?.state || "mounted",
                head: res.status?.head,
                ref: res.status?.ref,
                hydratedBlobs: res.status?.hydratedBlobs,
                hydratedBytes: res.status?.hydratedBytes,
                instructions: `Repository is mounted instantly at ${res.path}. Standard file tools (read, grep, find, edit) work directly on this path with zero full-clone wait.`,
              },
              null,
              2
            ),
          },
        ],
        details: { mountPath: res.path, name: res.name },
      };
    },
  });

  // 2. Tool: artifact_fs_status
  pi.registerTool({
    name: "artifact_fs_status",
    label: "artifact_fs_status",
    description:
      "Check the status and hydration metrics of mounted ArtifactFS repositories.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: "Optional repository name to check. If omitted, returns all mounted repositories.",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      if (params.name) {
        const st = getRepoStatus(params.name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(st || { error: `Repo "${params.name}" not found.` }, null, 2),
            },
          ],
          details: { status: st },
        };
      }

      const all = listConfiguredRepos();
      const statuses = all.map((r) => ({
        ...r,
        status: getRepoStatus(r.name),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ daemonRunning: isDaemonRunning(), repos: statuses }, null, 2),
          },
        ],
        details: { count: all.length },
      };
    },
  });

  // 3. Tool: artifact_fs_unmount
  pi.registerTool({
    name: "artifact_fs_unmount",
    label: "artifact_fs_unmount",
    description: "Unmount or remove a repository from ArtifactFS.",
    parameters: Type.Object({
      name: Type.String({ description: "Repository name to unmount" }),
      remove: Type.Optional(
        Type.Boolean({
          description: "Whether to permanently remove the repo registration (default: true)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const res = unmountOrRemoveRepo(params.name, params.remove !== false);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
        isError: !res.success,
        details: res,
      };
    },
  });

  // 4. Tool: artifact_fs_prefetch
  pi.registerTool({
    name: "artifact_fs_prefetch",
    label: "artifact_fs_prefetch",
    description: "Trigger background heuristic prefetching of blobs for a mounted repository.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Optional repository name to prefetch. If omitted, prefetches all." })
      ),
    }),
    async execute(_toolCallId, params) {
      const res = prefetchRepo(params.name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
        details: res,
      };
    },
  });

  // 5. Slash Commands: /artifact and /afs
  const commandHandler = async (args: string, ctx: ExtensionContext) => {
    const raw = (args || "").trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const subcmd = parts[0]?.toLowerCase();

    if (!subcmd || subcmd === "list" || subcmd === "ls") {
      const repos = listConfiguredRepos();
      console.log(renderArtifactTable(repos));
      return;
    }

    if (subcmd === "mount" || subcmd === "add") {
      const url = parts[1];
      const name = parts[2];
      const ref = parts[3];

      if (!url) {
        ctx.ui.notify("Usage: /artifact mount <url|owner/repo> [name] [ref]", "warning");
        return;
      }

      ctx.ui.notify(`Mounting ${url} over FUSE...`, "info");
      const res = mountRepo({ url, name, ref });
      if (!res.success) {
        ctx.ui.notify(`Failed to mount: ${res.error}`, "error");
        return;
      }

      ctx.ui.notify(`Mounted "${res.name}" at ${res.path}`, "info");
      const repos = listConfiguredRepos();
      console.log(renderArtifactTable(repos));
      return;
    }

    if (subcmd === "status") {
      const name = parts[1];
      if (name) {
        const st = getRepoStatus(name);
        if (!st) {
          ctx.ui.notify(`Repository "${name}" not found.`, "warning");
          return;
        }
        console.log(`\n${C.boldCyan}Repo:${C.reset} ${st.name} | ${C.green}State:${C.reset} ${st.state}`);
        console.log(`${C.dim}Head:${C.reset} ${st.head} (${st.ref})`);
        console.log(`${C.dim}Hydrated:${C.reset} ${st.hydratedBlobs} blobs (${formatBytes(st.hydratedBytes)})`);
        console.log(`${C.dim}Overlay Dirty:${C.reset} ${st.overlayDirty}\n`);
      } else {
        const repos = listConfiguredRepos();
        console.log(renderArtifactTable(repos));
      }
      return;
    }

    if (subcmd === "unmount" || subcmd === "remove" || subcmd === "rm") {
      const name = parts[1];
      if (!name) {
        ctx.ui.notify("Usage: /artifact remove <name>", "warning");
        return;
      }
      const res = unmountOrRemoveRepo(name, true);
      if (res.success) {
        ctx.ui.notify(`Removed repository "${name}".`, "info");
      } else {
        ctx.ui.notify(`Failed: ${res.message}`, "error");
      }
      return;
    }

    if (subcmd === "daemon") {
      const action = parts[1]?.toLowerCase();
      if (action === "start") {
        const res = ensureDaemonRunning();
        ctx.ui.notify(res.running ? "ArtifactFS daemon is running." : `Error: ${res.error}`, res.running ? "info" : "error");
      } else if (action === "stop") {
        stopDaemon();
        ctx.ui.notify("ArtifactFS daemon stopped.", "info");
      } else {
        const running = isDaemonRunning();
        ctx.ui.notify(`ArtifactFS daemon is ${running ? "ONLINE" : "OFFLINE"}.`, "info");
      }
      return;
    }

    ctx.ui.notify("Unknown subcommand. Try: /artifact [list | mount | status | remove | daemon]", "warning");
  };

  pi.registerCommand("artifact", {
    description: "Manage Git-backed on-demand FUSE mounts via Cloudflare ArtifactFS",
    handler: commandHandler,
  });

  pi.registerCommand("afs", {
    description: "Alias for /artifact",
    handler: commandHandler,
  });
}
