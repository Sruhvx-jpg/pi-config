/**
 * launch-server Extension for Pi
 *
 * Ultra-fast dynamic project finder, inspector, verifier, and background dev-server launcher.
 * Powered by Rust fd + cURL verification in milliseconds.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cp from "node:child_process";

const HOME = os.homedir();
const FD_BIN = path.join(HOME, ".pi/agent/bin/fd");
const DEFAULT_ROOTS = [
  path.join(HOME, "Documents/programming"),
  process.cwd(),
];

const WEB_KEYWORDS = new Set(["web", "landing", "page", "frontend", "ui", "client", "app", "site"]);
const API_KEYWORDS = new Set(["api", "server", "backend", "core", "service"]);
const CLI_KEYWORDS = new Set(["cli", "tool", "cmd"]);

export interface ProjectProof {
  type: "node" | "go" | "rust";
  dir: string;
  name: string;
  framework: string;
  runner: string;
  command: string;
  port: number;
  scripts: Record<string, string>;
  lockfile?: string;
}

export interface Candidate {
  dir: string;
  score: number;
  proof: ProjectProof;
}

export interface LaunchResult {
  confirmed: boolean;
  status: "running" | "failed" | "cancelled";
  url?: string;
  port?: number;
  httpStatus?: number;
  pid?: number;
  directory?: string;
  command?: string;
  framework?: string;
  alreadyRunning?: boolean;
  verification?: string;
  elapsedMs?: number;
  logPath?: string;
  error?: string;
}

export function findCandidates(query: string, rootDirs: string[] = DEFAULT_ROOTS): Candidate[] {
  const qTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const subjectTokens = qTokens.filter(t => !WEB_KEYWORDS.has(t) && !API_KEYWORDS.has(t) && !CLI_KEYWORDS.has(t));
  const wantsWeb = qTokens.some(t => WEB_KEYWORDS.has(t));
  const wantsApi = qTokens.some(t => API_KEYWORDS.has(t));
  const wantsCli = qTokens.some(t => CLI_KEYWORDS.has(t));

  const projectDirs = new Set<string>();

  for (const root of rootDirs) {
    if (!fs.existsSync(root)) continue;
    try {
      const fdCmd = fs.existsSync(FD_BIN) ? FD_BIN : "fd";
      const args = [
        "-t", "f",
        "(package\\.json|go\\.mod|Cargo\\.toml)",
        root,
        "-E", "node_modules",
        "-E", "target",
        "-E", "dist",
        "-E", ".git",
        "-E", ".next",
        "-E", "volumes",
        "-E", ".cache"
      ];
      const output = cp.execFileSync(fdCmd, args, { encoding: "utf8", timeout: 3000 });
      for (const file of output.trim().split("\n")) {
        if (file) projectDirs.add(path.dirname(file));
      }
    } catch {
      scanFallback(root, projectDirs, 0);
    }
  }

  const scored: Candidate[] = [];
  for (const dir of projectDirs) {
    const score = scoreDirectory(dir, qTokens, subjectTokens, wantsWeb, wantsApi, wantsCli);
    if (score > 0) {
      const proof = inspectProof(dir);
      if (proof) {
        scored.push({ dir, score, proof });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function scanFallback(dir: string, outSet: Set<string>, depth: number) {
  if (depth > 3) return;
  const ignored = new Set(["node_modules", ".git", "target", "dist", ".next", "volumes", ".cache"]);
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "package.json" || e.name === "go.mod" || e.name === "Cargo.toml") {
        outSet.add(dir);
      }
      if (e.isDirectory() && !ignored.has(e.name) && !e.name.startsWith(".")) {
        scanFallback(path.join(dir, e.name), outSet, depth + 1);
      }
    }
  } catch {}
}

function scoreDirectory(
  dirPath: string,
  qTokens: string[],
  subjectTokens: string[],
  wantsWeb: boolean,
  wantsApi: boolean,
  wantsCli: boolean
): number {
  const norm = dirPath.toLowerCase();
  const base = path.basename(dirPath).toLowerCase();

  // If subject token provided (e.g. "amoeba"), dir MUST contain it
  if (subjectTokens.length > 0) {
    const matchesAll = subjectTokens.every(st => norm.includes(st));
    if (!matchesAll) return 0;
  }

  let score = 100;

  if (wantsWeb) {
    if (base === "web" || base === "frontend" || base === "landing" || base === "client") score += 80;
    else if (norm.includes("/web") || norm.includes("/frontend") || norm.includes("/landing")) score += 50;
  }
  if (wantsApi) {
    if (base === "api" || base === "server" || base === "backend") score += 80;
    else if (norm.includes("/api") || norm.includes("/server") || norm.includes("/backend")) score += 50;
  }
  if (wantsCli) {
    if (base === "cli") score += 80;
    else if (norm.includes("/cli")) score += 50;
  }

  for (const token of qTokens) {
    if (base === token) score += 30;
    else if (base.includes(token)) score += 15;
    else if (norm.includes(token)) score += 10;
  }

  return score;
}

export function inspectProof(dir: string): ProjectProof | null {
  const pkgPath = path.join(dir, "package.json");
  const goPath = path.join(dir, "go.mod");
  const cargoPath = path.join(dir, "Cargo.toml");

  if (fs.existsSync(pkgPath)) {
    let pkg: any = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch {}

    const hasBun = fs.existsSync(path.join(dir, "bun.lock")) || fs.existsSync(path.join(dir, "bun.lockb"));
    const hasPnpm = fs.existsSync(path.join(dir, "pnpm-lock.yaml"));
    const hasYarn = fs.existsSync(path.join(dir, "yarn.lock"));

    let runner = "npm";
    if (hasBun) runner = "bun";
    else if (hasPnpm) runner = "pnpm";
    else if (hasYarn) runner = "yarn";

    let devCommand = "";
    if (pkg.scripts?.dev) devCommand = `${runner} run dev`;
    else if (pkg.scripts?.start) devCommand = `${runner} start`;
    else if (pkg.scripts?.serve) devCommand = `${runner} run serve`;
    else devCommand = `${runner} start`;

    let framework = "Node.js";
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (allDeps["next"]) framework = `Next.js ${String(allDeps["next"]).replace(/[\^~]/, "")}`;
    else if (allDeps["vite"]) {
      if (allDeps["react"]) framework = "Vite + React";
      else if (allDeps["vue"]) framework = "Vite + Vue";
      else framework = "Vite";
    }

    let port = 3000;
    // Check dev script explicit port first
    const scriptText = (pkg.scripts?.dev || "") + " " + (pkg.scripts?.start || "");
    const sMatch = scriptText.match(/(?:--port|-p|PORT=)\s*(\d+)/);
    if (sMatch) {
      port = parseInt(sMatch[1], 10);
    } else {
      // Check vite config
      for (const ext of [".ts", ".js", ".mjs", ".cjs"]) {
        const vPath = path.join(dir, `vite.config${ext}`);
        if (fs.existsSync(vPath)) {
          const content = fs.readFileSync(vPath, "utf8");
          const match = content.match(/port:\s*(\d+)/);
          if (match) {
            port = parseInt(match[1], 10);
            break;
          }
        }
      }
    }

    return {
      type: "node",
      dir,
      name: pkg.name || path.basename(dir),
      framework,
      runner,
      command: devCommand,
      port,
      scripts: pkg.scripts || {},
      lockfile: hasBun ? "bun.lock" : hasPnpm ? "pnpm-lock.yaml" : hasYarn ? "yarn.lock" : "package-lock.json"
    };
  }

  if (fs.existsSync(goPath)) {
    const modContent = fs.readFileSync(goPath, "utf8");
    let framework = "Go HTTP";
    if (modContent.includes("github.com/gofiber/fiber")) framework = "Go Fiber";
    else if (modContent.includes("github.com/gin-gonic/gin")) framework = "Go Gin";

    let port = 8080;
    const mainGoPath = path.join(dir, "main.go");
    if (fs.existsSync(mainGoPath)) {
      const mainContent = fs.readFileSync(mainGoPath, "utf8");
      const pMatch = mainContent.match(/(?:defaultPort\s*=\s*|:)(\d{4,5})/);
      if (pMatch) port = parseInt(pMatch[1], 10);
    }

    return {
      type: "go",
      dir,
      name: path.basename(dir),
      framework,
      runner: "go",
      command: "go run main.go",
      port,
      scripts: {},
      lockfile: "go.sum"
    };
  }

  if (fs.existsSync(cargoPath)) {
    const cargoContent = fs.readFileSync(cargoPath, "utf8");
    let framework = "Rust (Cargo)";
    if (cargoContent.includes("actix-web")) framework = "Rust (Actix Web)";
    else if (cargoContent.includes("axum")) framework = "Rust (Axum)";

    return {
      type: "rust",
      dir,
      name: path.basename(dir),
      framework,
      runner: "cargo",
      command: "cargo run",
      port: 8080,
      scripts: {},
      lockfile: "Cargo.lock"
    };
  }

  return null;
}

function checkPortListening(port: number): number | null {
  try {
    const out = cp.execSync(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/`, { timeout: 800 });
    const code = parseInt(out.toString().trim(), 10);
    return code > 0 ? code : null;
  } catch {
    return null;
  }
}

function verifyCurl(port: number, timeoutMs = 7000, logPath?: string): Promise<{ ok: boolean; status?: number; timeMs: number; finalPort: number; error?: string }> {
  const startTime = Date.now();
  let currentPort = port;

  return new Promise((resolve) => {
    const check = () => {
      // Dynamic port extraction from runtime logs if available
      if (logPath && fs.existsSync(logPath)) {
        try {
          const logChunk = fs.readFileSync(logPath, "utf8");
          const portMatches = logChunk.match(/(?:addr=:|port=|Local:\s*http:\/\/[^:]+:|listening on [^\d]*:?)(\d{4,5})/i);
          if (portMatches && portMatches[1]) {
            const detected = parseInt(portMatches[1], 10);
            if (!isNaN(detected) && detected > 0) {
              currentPort = detected;
            }
          }
        } catch {}
      }

      cp.exec(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${currentPort}/`, (err, stdout) => {
        const code = parseInt(stdout.trim(), 10);
        if (!isNaN(code) && code > 0) {
          return resolve({ ok: true, status: code, timeMs: Date.now() - startTime, finalPort: currentPort });
        }
        if (Date.now() - startTime > timeoutMs) {
          return resolve({ ok: false, timeMs: Date.now() - startTime, finalPort: currentPort, error: `Timeout waiting for http://localhost:${currentPort}` });
        }
        setTimeout(check, 120);
      });
    };
    check();
  });
}

export async function executeLaunch(proof: ProjectProof): Promise<LaunchResult> {
  const activeCode = checkPortListening(proof.port);
  if (activeCode) {
    return {
      confirmed: true,
      status: "running",
      alreadyRunning: true,
      url: `http://localhost:${proof.port}`,
      port: proof.port,
      httpStatus: activeCode,
      directory: proof.dir,
      command: proof.command,
      framework: proof.framework,
      verification: `Server already listening on port ${proof.port} with HTTP ${activeCode}`
    };
  }

  const logPath = `/tmp/server-${proof.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`;
  const logFd = fs.openSync(logPath, "w");

  const [cmd, ...args] = proof.command.split(" ");
  const child = cp.spawn(cmd, args, {
    cwd: proof.dir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, FORCE_COLOR: "1" }
  });
  child.unref();

  const verify = await verifyCurl(proof.port, 7000, logPath);
  if (!verify.ok) {
    let tailLogs = "";
    try {
      const logs = fs.readFileSync(logPath, "utf8");
      tailLogs = logs.split("\n").slice(-15).join("\n");
    } catch {}
    return {
      confirmed: true,
      status: "failed",
      port: verify.finalPort,
      directory: proof.dir,
      command: proof.command,
      framework: proof.framework,
      logPath,
      error: `Server process spawned (PID: ${child.pid}) but failed curl verification on port ${verify.finalPort}.\nLogs:\n${tailLogs}`
    };
  }

  return {
    confirmed: true,
    status: "running",
    alreadyRunning: false,
    pid: child.pid,
    url: `http://localhost:${verify.finalPort}`,
    port: verify.finalPort,
    httpStatus: verify.status,
    elapsedMs: verify.timeMs,
    directory: proof.dir,
    command: proof.command,
    framework: proof.framework,
    logPath,
    verification: `cURL verified HTTP ${verify.status} in ${verify.timeMs}ms`
  };
}

export default function launchServerExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "launch_dev_server",
    label: "Launch Dev Server",
    description: "Dynamically find a project directory by query, present concrete proof (framework, command, port, scripts) for confirmation, launch the dev server detached in background, verify with cURL, and return confirmation status flag.",
    promptSnippet: "Dynamically find, confirm with proof, launch, and curl-verify any dev server or backend",
    promptGuidelines: [
      "Use launch_dev_server when the user asks to start, run, or spin up any web app, landing page, API server, or dev environment."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query or project description (e.g. 'web landing page', 'api server', 'frontend app')" }),
      root_dir: Type.Optional(Type.String({ description: "Search root directory (default: ~/Documents/programming)" })),
      target_dir: Type.Optional(Type.String({ description: "Direct directory path if already confirmed" })),
      confirmed: Type.Optional(Type.Boolean({ description: "Whether user has already confirmed launching this target" }))
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      let currentQuery = params.query;
      const roots = params.root_dir ? [params.root_dir] : DEFAULT_ROOTS;

      while (true) {
        let proof: ProjectProof | null = null;

        if (params.target_dir && fs.existsSync(params.target_dir)) {
          proof = inspectProof(params.target_dir);
        }

        if (!proof) {
          const candidates = findCandidates(currentQuery, roots);
          if (candidates.length === 0) {
            if (ctx.hasUI) {
              const retry = await ctx.ui.input(`No project found for "${currentQuery}". Refine query or path:`, "");
              if (retry && retry.trim()) {
                currentQuery = retry.trim();
                continue;
              }
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  confirmed: false,
                  status: "failed",
                  message: `No matching runnable projects found for "${currentQuery}"`
                }, null, 2)
              }]
            };
          }
          proof = candidates[0].proof;
        }

        const proofSummary = [
          `Target Directory: ${proof.dir}`,
          `Framework:        ${proof.framework}`,
          `Runner Command:   ${proof.command}`,
          `Target Port:      ${proof.port}`,
          `Lockfile:         ${proof.lockfile || "none"}`,
          proof.scripts.dev ? `Dev Script:       ${proof.scripts.dev}` : ""
        ].filter(Boolean).join("\n");

        // Confirmation step
        let proceed = params.confirmed === true;

        if (!proceed && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            `Launch Server: ${proof.name}?`,
            `Confirm starting dev server with details:\n\n${proofSummary}`
          );

          if (ok) {
            proceed = true;
          } else {
            // User rejected this candidate -> Ask to search again
            const nextQuery = await ctx.ui.input(
              "Search again - Enter directory name or refined query:",
              ""
            );
            if (nextQuery && nextQuery.trim()) {
              currentQuery = nextQuery.trim();
              params.target_dir = undefined;
              continue;
            } else {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    confirmed: false,
                    status: "cancelled",
                    message: "User declined directory confirmation"
                  }, null, 2)
                }]
              };
            }
          }
        } else if (!proceed && !ctx.hasUI) {
          // In non-interactive mode, return candidate proof for confirmation
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                confirmed: false,
                requires_confirmation: true,
                proof,
                message: "Target located. Confirm directory and parameters to launch server."
              }, null, 2)
            }]
          };
        }

        if (proceed) {
          if (ctx.hasUI) {
            ctx.ui.notify(`Spawning ${proof.command} in ${proof.dir}...`, "info");
          }

          const result = await executeLaunch(proof);

          if (ctx.hasUI) {
            if (result.status === "running") {
              ctx.ui.notify(`Server live on ${result.url} (${result.verification})`, "info");
            } else {
              ctx.ui.notify(`Failed to launch server: ${result.error}`, "error");
            }
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2)
            }]
          };
        }
      }
    },

    renderCall(args, theme) {
      const q = args.query || args.target_dir || "dev server";
      return new Text(
        theme.fg("toolTitle", theme.bold("launch_dev_server ")) +
        theme.fg("muted", `query: "${q}"`),
        0, 0
      );
    },

    renderResult(result, _options, theme) {
      try {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        const data = JSON.parse(text);
        if (data.status === "running") {
          return new Text(
            theme.fg("success", `✔ Server Active: `) +
            theme.bold(data.url || `http://localhost:${data.port}`) +
            theme.fg("muted", ` (${data.verification || "cURL 200 OK"})`),
            0, 0
          );
        } else if (data.status === "cancelled") {
          return new Text(theme.fg("warning", "✖ Server launch cancelled by user"), 0, 0);
        } else if (data.requires_confirmation) {
          return new Text(
            theme.fg("accent", "Target located: ") +
            theme.bold(data.proof?.dir || "") +
            theme.fg("muted", ` [${data.proof?.framework}]`),
            0, 0
          );
        } else {
          return new Text(theme.fg("error", `✖ Failed: ${data.error || data.message}`), 0, 0);
        }
      } catch {
        return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
      }
    }
  });

  // Also register a slash command /spin
  pi.registerCommand("spin", {
    description: "Find, confirm, and launch dev server in seconds: /spin <query>",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      if (!query) {
        ctx.ui.notify("Usage: /spin <project name / search query>", "warning");
        return;
      }
      ctx.ui.notify(`Searching projects for "${query}"...`, "info");
      const candidates = findCandidates(query);
      if (candidates.length === 0) {
        ctx.ui.notify(`No projects found for "${query}"`, "error");
        return;
      }
      const proof = candidates[0].proof;
      const ok = await ctx.ui.confirm(
        `Launch Server: ${proof.name}?`,
        `Target:    ${proof.dir}\nFramework: ${proof.framework}\nCommand:   ${proof.command}\nPort:      ${proof.port}`
      );
      if (!ok) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }
      ctx.ui.notify(`Launching ${proof.command}...`, "info");
      const res = await executeLaunch(proof);
      if (res.status === "running") {
        ctx.ui.notify(`Server live on ${res.url}! (${res.verification})`, "info");
      } else {
        ctx.ui.notify(`Launch failed: ${res.error}`, "error");
      }
    }
  });
}
