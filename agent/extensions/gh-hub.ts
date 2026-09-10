/**
 * gh-hub Extension for Pi
 *
 * Unified GitHub Hub for managing Pull Requests and Drafts.
 * Shortcut: Alt+g
 * Command: /gh or /pr
 *
 * Features:
 * 1. Browse all active PRs and Drafts across repositories (gh search prs --author "@me")
 *    - Detailed picker with [DRAFT] vs [OPEN] tags, repo, #, and title.
 *    - Actions: Open in browser, view details, checkout branch, copy URL.
 * 2. Draft / Create PR from current branch
 *    - Select draft mode vs ready for review.
 *    - Interactive title and body input.
 *    - Automatically hits the 2-Option Review Gate.
 * 3. Current Repo PR Status (gh pr status)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as cp from "node:child_process";

interface GitHubPR {
  number: number;
  title: string;
  isDraft: boolean;
  url: string;
  updatedAt: string;
  repository: {
    name: string;
    nameWithOwner: string;
  };
}

/**
 * Runs a command synchronously and returns stdout.
 */
function runCommand(cmd: string, cwd?: string): string {
  try {
    return cp.execSync(cmd, {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr ? err.stderr.toString().trim() : "";
    throw new Error(stderr || err.message || "Command failed");
  }
}

/**
 * Opens a URL using the system's default browser.
 */
function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      cp.spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      cp.spawn("start", [url], { shell: true, detached: true, stdio: "ignore" }).unref();
    } else {
      cp.spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Fallback: try gh browse
    try {
      cp.spawn("gh", ["browse", url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // Ignore failure
    }
  }
}

/**
 * Copies text to system clipboard.
 */
function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      cp.execSync("pbcopy", { input: text });
      return true;
    }
    if (process.env.WAYLAND_DISPLAY) {
      cp.execSync("wl-copy", { input: text });
      return true;
    }
    cp.execSync("xclip -selection clipboard", { input: text });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches user's open PRs and drafts from GitHub CLI.
 */
function fetchMyPRs(): GitHubPR[] {
  const cmd = `gh search prs --author "@me" --state open --json number,title,repository,isDraft,url,updatedAt`;
  const output = runCommand(cmd);
  if (!output) return [];
  return JSON.parse(output) as GitHubPR[];
}

/**
 * Handles browsing PRs and drafts.
 */
async function handleBrowsePRs(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  ctx.ui.notify("Fetching your PRs and drafts from GitHub...", "info");

  let prs: GitHubPR[] = [];
  try {
    prs = fetchMyPRs();
  } catch (err: any) {
    ctx.ui.notify(`Failed to fetch PRs: ${err.message}`, "error");
    return;
  }

  if (prs.length === 0) {
    ctx.ui.notify("No open PRs or drafts found under your account (@me).", "info");
    return;
  }

  const options = prs.map((pr) => {
    const tag = pr.isDraft ? "[DRAFT]" : "[OPEN] ";
    const repo = pr.repository ? pr.repository.nameWithOwner : "unknown";
    return `${tag} ${repo}#${pr.number}: ${pr.title}`;
  });

  const choice = await ctx.ui.select(
    `⚡ Select a PR or Draft to inspect (${prs.length} active):`,
    options
  );

  if (!choice) return;

  const selectedIndex = options.indexOf(choice);
  if (selectedIndex === -1) return;

  const pr = prs[selectedIndex];
  const repo = pr.repository ? pr.repository.nameWithOwner : "";

  const action = await ctx.ui.select(
    `PR #${pr.number} (${pr.isDraft ? "DRAFT" : "OPEN"}): ${pr.title}\nRepository: ${repo}\nURL: ${pr.url}\n\nSelect action:`,
    [
      "1. Open in Browser",
      "2. View Details & CI Checks",
      "3. Checkout Branch Locally",
      "4. Copy URL to Clipboard",
    ]
  );

  if (!action) return;

  if (action.startsWith("1.")) {
    openBrowser(pr.url);
    ctx.ui.notify(`Opened ${pr.url} in browser.`, "info");
    return;
  }

  if (action.startsWith("2.")) {
    try {
      const details = runCommand(`gh pr view ${pr.number} -R ${repo}`);
      const checks = runCommand(`gh pr checks ${pr.number} -R ${repo} || true`);
      const fullView = `${details}\n\n=== CI CHECKS ===\n${checks || "No checks reported"}`;
      ctx.ui.notify(fullView.slice(0, 500) + (fullView.length > 500 ? "\n..." : ""), "info");
    } catch (err: any) {
      ctx.ui.notify(`Error fetching details: ${err.message}`, "error");
    }
    return;
  }

  if (action.startsWith("3.")) {
    try {
      const out = runCommand(`gh pr checkout ${pr.number} -R ${repo}`);
      ctx.ui.notify(`Checked out branch: ${out || "Success"}`, "info");
    } catch (err: any) {
      ctx.ui.notify(`Checkout failed: ${err.message}`, "error");
    }
    return;
  }

  if (action.startsWith("4.")) {
    const ok = copyToClipboard(pr.url);
    if (ok) {
      ctx.ui.notify(`Copied to clipboard: ${pr.url}`, "info");
    } else {
      ctx.ui.notify(`URL: ${pr.url}`, "info");
    }
  }
}

/**
 * Handles creating a PR or Draft PR from the current branch.
 */
async function handleCreatePR(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  // Verify git repo
  try {
    runCommand("git rev-parse --is-inside-work-tree");
  } catch {
    ctx.ui.notify("Current directory is not inside a git repository.", "warning");
    return;
  }

  const currentBranch = runCommand("git branch --show-current");
  if (!currentBranch || currentBranch === "main" || currentBranch === "master") {
    ctx.ui.notify(`Cannot create PR from base branch '${currentBranch}'. Checkout a feature branch first.`, "warning");
    return;
  }

  // Check last commit message for default title
  let defaultTitle = "";
  try {
    defaultTitle = runCommand("git log -1 --pretty=%s");
  } catch {
    defaultTitle = currentBranch;
  }

  const modeChoice = await ctx.ui.select(
    `Create Pull Request for branch '${currentBranch}':`,
    [
      "1. Create as DRAFT PR (--draft)",
      "2. Create as Ready for Review PR",
    ]
  );

  if (!modeChoice) return;
  const isDraft = modeChoice.startsWith("1.");

  const titleInput = await ctx.ui.input("PR Title:", defaultTitle);
  if (!titleInput || !titleInput.trim()) {
    ctx.ui.notify("PR creation aborted: title cannot be empty.", "warning");
    return;
  }

  const bodyInput = await ctx.ui.input("PR Description (keep concise):", "");
  const draftFlag = isDraft ? "--draft" : "";
  const safeTitle = titleInput.trim().replace(/"/g, '\\"');
  const safeBody = (bodyInput || "").trim().replace(/"/g, '\\"');

  const cmd = `gh pr create ${draftFlag} --title "${safeTitle}" --body "${safeBody}"`;

  ctx.ui.notify(`Executing: ${cmd}`, "info");

  try {
    const out = runCommand(cmd);
    ctx.ui.notify(`✓ PR created successfully:\n${out}`, "info");
  } catch (err: any) {
    ctx.ui.notify(`PR creation failed: ${err.message}`, "error");
  }
}

/**
 * Handles showing current repository PR status.
 */
async function handleRepoStatus(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    runCommand("git rev-parse --is-inside-work-tree");
  } catch {
    ctx.ui.notify("Current directory is not inside a git repository.", "warning");
    return;
  }

  try {
    const status = runCommand("gh pr status");
    ctx.ui.notify(`⚡ Current Repo PR Status:\n${status}`, "info");
  } catch (err: any) {
    ctx.ui.notify(`Failed to get status: ${err.message}`, "error");
  }
}

/**
 * Main launcher dialog for Unified GitHub Hub.
 */
async function openGitHubHub(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const action = await ctx.ui.select(
    "⚡ [GitHub PR & Draft Hub] (Alt+g | /gh)",
    [
      "1. Browse My PRs & Drafts",
      "2. Draft / Create PR from Current Branch",
      "3. Current Repo PR Status",
    ]
  );

  if (!action) return;

  if (action.startsWith("1.")) {
    await handleBrowsePRs(ctx);
  } else if (action.startsWith("2.")) {
    await handleCreatePR(ctx);
  } else if (action.startsWith("3.")) {
    await handleRepoStatus(ctx);
  }
}

export default function ghHubExtension(pi: ExtensionAPI) {
  // 1. Register shortcut Alt+g
  pi.registerShortcut("alt+g", {
    description: "GitHub PR & Draft Hub (browse, draft, view)",
    handler: async (ctx) => {
      await openGitHubHub(ctx);
    },
  });

  // 2. Register commands /gh and /pr
  pi.registerCommand("gh", {
    description: "Open GitHub PR & Draft Hub (/gh, /gh browse, /gh create, /gh status)",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim().toLowerCase();
      if (trimmed === "browse" || trimmed === "prs" || trimmed === "drafts") {
        await handleBrowsePRs(ctx);
      } else if (trimmed === "create" || trimmed === "draft") {
        await handleCreatePR(ctx);
      } else if (trimmed === "status") {
        await handleRepoStatus(ctx);
      } else {
        await openGitHubHub(ctx);
      }
    },
  });

  pi.registerCommand("pr", {
    description: "Alias for /gh",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim().toLowerCase();
      if (trimmed === "browse" || trimmed === "prs" || trimmed === "drafts") {
        await handleBrowsePRs(ctx);
      } else if (trimmed === "create" || trimmed === "draft") {
        await handleCreatePR(ctx);
      } else if (trimmed === "status") {
        await handleRepoStatus(ctx);
      } else {
        await openGitHubHub(ctx);
      }
    },
  });
}
