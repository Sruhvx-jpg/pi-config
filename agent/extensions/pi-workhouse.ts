/**
 * pi-workhouse: Pi Extension Adapter
 *
 * Automatically wires Pi sessions to the central Workhouse:
 * - Exactly ONE session acts as the central WORKHOUSE Hub.
 * - All other sessions automatically connect as WORKERS.
 * - Automatic failover & leader succession.
 * - Tools for agents to communicate, direct, request help, share artifacts, and coordinate locks.
 * - Slash commands for human operator to observe and interact with the cluster.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getWorkhouseEngine,
  WorkhouseEngine,
} from "../workhouse/engine.ts";
import {
  C,
  formatBytes,
  formatLatency,
  type SessionRecord,
} from "../workhouse/types.ts";
import {
  createWebServer,
  stopWorkhouseUi,
  DEFAULT_PORT,
} from "../workhouse/web/server.ts";

let activeWebServer: ReturnType<typeof createWebServer> | null = null;

async function renderWorkhouseDashboard(
  engine: WorkhouseEngine,
  _ctx: ExtensionCommandContext
): Promise<string> {
  const peersWithPing = await engine.pingAllSessions();
  const artifacts = engine.listArtifacts();
  const resources = engine.listResources();
  const locks = engine.listLocks();
  const tasks = engine.listTasks();
  const recentFeed = engine.getFeed(8).reverse();

  const lines: string[] = [];
  lines.push(
    `${C.boldCyan}╔════════════════════════════════════════════════════════════════════════════════╗${C.reset}`
  );
  lines.push(
    `${C.boldCyan}║${C.bgHeader} 🏛️ PI WORKHOUSE — CENTRAL COLLABORATION HOUSE & AGENT CONTROL DECK             ${C.reset}${C.boldCyan}║${C.reset}`
  );
  lines.push(
    `${C.boldCyan}╚════════════════════════════════════════════════════════════════════════════════╝${C.reset}`
  );

  const isHub = engine.role === "workhouse";
  const roleBadge = isHub
    ? `${C.bgWorkhouse} [ROLE: CENTRAL WORKHOUSE HUB] ${C.reset}`
    : `${C.bgWorker} [ROLE: WORKER SATELLITE] ${C.reset}`;

  lines.push(` ${C.boldGreen}● THIS SESSION:${C.reset} ${C.boldCyan}${engine.sessionName}${C.reset} ${roleBadge}`);
  lines.push(
    `   ${C.dim}PID:${C.reset} ${engine.pid} | ${C.dim}Dir:${C.reset} ${C.cyan}${engine.cwd}${C.reset} ${engine.gitBranch ? `${C.dim}[branch: ${C.yellow}${engine.gitBranch}${C.dim}]${C.reset}` : ""}`
  );
  lines.push(
    `   ${C.dim}Web UI:${C.reset} ${C.bold}http://localhost:3000${C.reset}`
  );
  lines.push("");

  // Connected Cluster Sessions
  lines.push(
    ` ${C.boldYellow}CONNECTED AGENT SESSIONS (${peersWithPing.length}):${C.reset}`
  );
  if (peersWithPing.length === 0) {
    lines.push(
      `   ${C.dim}No other sessions active. Other Pi sessions will auto-connect here.${C.reset}`
    );
  } else {
    lines.push(
      `   ${C.border}┌──────────────────────┬───────────┬───────┬────────────────────────────┬─────────────┬──────────┐${C.reset}`
    );
    lines.push(
      `   ${C.border}│${C.reset} ${C.bold}SESSION NAME        ${C.border}│${C.reset} ${C.bold}ROLE      ${C.border}│${C.reset} ${C.bold}PID  ${C.border}│${C.reset} ${C.bold}PROJECT / CWD             ${C.border}│${C.reset} ${C.bold}GIT BRANCH  ${C.border}│${C.reset} ${C.bold}LATENCY  ${C.border}│${C.reset}`
    );
    lines.push(
      `   ${C.border}├──────────────────────┼───────────┼───────┼────────────────────────────┼─────────────┼──────────┤${C.reset}`
    );

    for (const item of peersWithPing) {
      const p = item.peer;
      const nameCol = p.name.padEnd(20).slice(0, 20);
      const roleCol = (p.role === "workhouse" ? `${C.boldGreen}WORKHOUSE${C.reset}` : `${C.purple}WORKER${C.reset}   `).padEnd(19).slice(0, 19);
      const pidCol = String(p.pid).padEnd(5).slice(0, 5);
      const projCol = p.project.padEnd(26).slice(0, 26);
      const branchCol = (p.git_branch || "-").padEnd(11).slice(0, 11);
      const latCol = item.ok
        ? formatLatency(item.latencyMs).padEnd(16).slice(0, 16)
        : `${C.red}OFFLINE${C.reset} `;

      lines.push(
        `   ${C.border}│${C.reset} ${C.cyan}${nameCol}${C.reset}${C.border}│${C.reset} ${roleCol}${C.border}│${C.reset} ${pidCol}${C.border}│${C.reset} ${projCol}${C.border}│${C.reset} ${C.yellow}${branchCol}${C.reset}${C.border}│${C.reset} ${latCol}${C.border}│${C.reset}`
      );
    }
    lines.push(
      `   ${C.border}└──────────────────────┴───────────┴───────┴────────────────────────────┴─────────────┴──────────┘${C.reset}`
    );
  }
  lines.push("");

  // Shared Big Resources: ARTIFACTS
  lines.push(` ${C.boldYellow}SHARED ARTIFACTS DEPOT (${artifacts.length}):${C.reset}`);
  if (artifacts.length === 0) {
    lines.push(
      `   ${C.dim}No artifacts shared yet. Use /wh share <filepath> [name] to share big resources.${C.reset}`
    );
  } else {
    lines.push(
      `   ${C.border}┌────────────────────────────┬───────────┬──────────────┬──────────────────────┬────────────────────────────┐${C.reset}`
    );
    lines.push(
      `   ${C.border}│${C.reset} ${C.bold}ARTIFACT NAME              ${C.border}│${C.reset} ${C.bold}SIZE      ${C.border}│${C.reset} ${C.bold}SHA256 (PREFIX)${C.border}│${C.reset} ${C.bold}OWNER AGENT          ${C.border}│${C.reset} ${C.bold}DESCRIPTION                ${C.border}│${C.reset}`
    );
    lines.push(
      `   ${C.border}├────────────────────────────┼───────────┼──────────────┼──────────────────────┼────────────────────────────┤${C.reset}`
    );
    for (const a of artifacts.slice(0, 5)) {
      const nameCol = a.name.padEnd(26).slice(0, 26);
      const sizeCol = formatBytes(a.size_bytes).padEnd(9).slice(0, 9);
      const hashCol = a.sha256.slice(0, 12).padEnd(12);
      const ownerCol = a.owner_name.padEnd(20).slice(0, 20);
      const descCol = (a.description || "-").padEnd(26).slice(0, 26);
      lines.push(
        `   ${C.border}│${C.reset} ${C.boldCyan}${nameCol}${C.reset}${C.border}│${C.reset} ${C.green}${sizeCol}${C.reset}${C.border}│${C.reset} ${C.dim}${hashCol}${C.reset}${C.border}│${C.reset} ${C.yellow}${ownerCol}${C.reset}${C.border}│${C.reset} ${descCol}${C.border}│${C.reset}`
      );
    }
    lines.push(
      `   ${C.border}└────────────────────────────┴───────────┴──────────────┴──────────────────────┴────────────────────────────┘${C.reset}`
    );
    if (artifacts.length > 5) {
      lines.push(
        `   ${C.dim}... and ${artifacts.length - 5} more artifacts. View all with /wh artifacts${C.reset}`
      );
    }
  }
  lines.push("");

  // Directed Tasks
  if (tasks.length > 0) {
    lines.push(` ${C.boldYellow}DIRECTED TASKS (${tasks.length}):${C.reset}`);
    for (const t of tasks.slice(0, 4)) {
      const statusColor =
        t.status === "completed"
          ? C.boldGreen
          : t.status === "in_progress"
          ? C.boldYellow
          : C.cyan;
      lines.push(
        `   🎯 [${statusColor}${t.status.toUpperCase()}${C.reset}] ${C.boldCyan}${t.title}${C.reset} (${t.from_session_name} -> ${t.to_session_id})`
      );
    }
    lines.push("");
  }

  // Active Locks
  if (locks.length > 0) {
    lines.push(` ${C.boldYellow}ACTIVE COORDINATION LOCKS (${locks.length}):${C.reset}`);
    const now = Date.now();
    for (const l of locks) {
      const rem = Math.max(0, Math.ceil((l.expires_at - now) / 1000));
      lines.push(
        `   🔒 ${C.boldCyan}'${l.name}'${C.reset} -> Held by ${C.yellow}${l.holder_name}${C.reset} ${C.dim}(expires in ${rem}s)${C.reset}`
      );
    }
    lines.push("");
  }

  // Live Agent Conversation Feed
  lines.push(` ${C.boldYellow}LIVE AGENT CONVERSATION FEED:${C.reset}`);
  if (recentFeed.length === 0) {
    lines.push(`   ${C.dim}No agent communications yet.${C.reset}`);
  } else {
    for (const m of recentFeed) {
      const timeStr = new Date(m.created_at).toLocaleTimeString();
      const isSelf = m.sender_id === engine.sessionId;
      const senderTag = isSelf
        ? `${C.boldGreen}<${m.sender_name}>${C.reset}`
        : `${C.boldCyan}<${m.sender_name}>${C.reset}`;
      const chanTag = `${C.magenta}[${m.channel}]${C.reset}`;
      lines.push(`   ${C.dim}[${timeStr}]${C.reset} ${chanTag} ${senderTag} ${m.content}`);
    }
  }

  lines.push("");
  lines.push(
    ` ${C.dim}Observability: /wh feed | /wh artifacts | /wh tasks | /wh peers${C.reset}`
  );
  lines.push(
    ` ${C.dim}Actions:       /wh chat <msg> | /wh direct <peer> <inst> | /wh share <file> | /wh help <q>${C.reset}`
  );

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  const engine = getWorkhouseEngine();
  engine.setPi(pi);

  pi.on("session_start", async (_event, ctx) => {
    engine.setContext(ctx);
    await engine.start();
  });

  pi.on("agent_end", async (event) => {
    const assistantMsgs = event.messages.filter((m: any) => m.role === "assistant");
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    let replyText = "";
    if (lastAssistant) {
      if (typeof lastAssistant.content === "string") {
        replyText = lastAssistant.content;
      } else if (Array.isArray(lastAssistant.content)) {
        replyText = lastAssistant.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }
    }
    if (replyText) {
      engine.onAgentTurnCompleted(replyText);
    }
  });

  pi.on("session_shutdown", async () => {
    if (activeWebServer) {
      try {
        await activeWebServer.close();
      } catch {}
      activeWebServer = null;
    }
    engine.stop();
  });

  // --------------------------------------------------------------------------
  // Agent Tools
  // --------------------------------------------------------------------------

  // Tool 1: workhouse_peers
  pi.registerTool({
    name: "workhouse_peers",
    label: "Workhouse Peers",
    description:
      "Inspect all concurrent Pi sessions connected to the Workhouse, check roles (Workhouse Hub vs Worker), directories, projects, git branches, or measure round-trip ping latency.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("list"), Type.Literal("ping")], {
          description: "'list' (default) to list peers, 'ping' to measure latency or direct an agent via ping",
        })
      ),
      target: Type.Optional(
        Type.String({
          description: "Specific session name or ID to ping. If omitted, pings all sessions / hub.",
        })
      ),
      directive: Type.Optional(
        Type.String({
          description: "Optional task or instruction to dispatch to the pinged peer, waking up its agent to execute work immediately.",
        })
      ),
    }),
    async execute(_id, params) {
      const action = params.action || "list";

      if (action === "ping") {
        if (params.target) {
          const peer = engine.findPeer(params.target);
          if (!peer) {
            return {
              content: [{ type: "text", text: `✖ Peer not found matching: "${params.target}"` }],
              details: { ok: false },
            };
          }
          const res = await engine.pingPeer(peer, params.directive);
          const directedNote = params.directive ? `\n🎯 Dispatched directive: "${params.directive}"` : "";
          return {
            content: [
              {
                type: "text",
                text: res.ok
                  ? `⚡ PING ${peer.name} (${peer.role}, PID ${peer.pid}): ${res.latencyMs}ms | CWD: ${peer.cwd}${directedNote}`
                  : `✖ PING ${peer.name} failed: ${res.error}`,
              },
            ],
            details: { peer, ...res },
          };
        }

        const results = await engine.pingAllSessions();
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No other active Pi sessions connected to Workhouse." }],
            details: { count: 0, sessions: [] },
          };
        }

        const lines = ["⚡ WORKHOUSE PING RESULTS:"];
        for (const r of results) {
          const status = r.ok ? `${r.latencyMs}ms` : `FAILED (${r.error})`;
          lines.push(`● ${r.peer.name} [${r.peer.role}] (PID ${r.peer.pid}, ${r.peer.project}) -> ${status}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { results },
        };
      }

      const peers = engine.getActivePeers();
      const hub = engine.getWorkhouseRecord();
      const summary = {
        currentSession: {
          id: engine.sessionId,
          name: engine.sessionName,
          role: engine.role,
          pid: engine.pid,
          cwd: engine.cwd,
          project: engine.project,
          gitBranch: engine.gitBranch,
        },
        centralHub: hub ? { id: hub.id, name: hub.name, pid: hub.pid, cwd: hub.cwd } : null,
        peerCount: peers.length,
        peers: peers.map((p) => ({
          id: p.id,
          name: p.name,
          role: p.role,
          pid: p.pid,
          cwd: p.cwd,
          project: p.project,
          gitBranch: p.git_branch,
          lastHeartbeat: new Date(p.last_heartbeat).toISOString(),
        })),
      };

      const lines = [
        `🏛️ Pi Workhouse Cluster (${peers.length + 1} active session${peers.length === 0 ? "" : "s"}):`,
      ];
      lines.push(`● THIS SESSION: ${engine.sessionName} [ROLE: ${engine.role.toUpperCase()}] (PID ${engine.pid})`);
      if (hub && hub.id !== engine.sessionId) {
        lines.push(`● CENTRAL WORKHOUSE: ${hub.name} (PID ${hub.pid}) @ ${hub.cwd}`);
      }
      for (const p of peers) {
        if (p.id !== hub?.id) {
          lines.push(`● WORKER: ${p.name} (PID ${p.pid}) -> ${p.project} [${p.git_branch || "no git"}] @ ${p.cwd}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: summary,
      };
    },
  });

  // Tool 2: workhouse_chat
  pi.registerTool({
    name: "workhouse_chat",
    label: "Workhouse Chat",
    description:
      "Communicate with other Pi sessions: post to channels (#general, #help, #tasks), send direct messages to peers, request peer help, or read history.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("send"), Type.Literal("read"), Type.Literal("help")],
        { description: "'send' to post message/DM, 'read' to read history, 'help' to broadcast a help request" }
      ),
      channel: Type.Optional(
        Type.String({ description: "Channel name (#general, #help, #tasks, default: '#general')" })
      ),
      target: Type.Optional(
        Type.String({ description: "Target session name or ID (for direct messages)" })
      ),
      message: Type.Optional(
        Type.String({ description: "Message text or help request to send" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max number of messages to read (default: 20)" })
      ),
    }),
    async execute(_id, params) {
      if (params.action === "help") {
        if (!params.message) {
          throw new Error("Message parameter is required for 'help' action");
        }
        const rec = await engine.requestHelp(params.message);
        return {
          content: [{ type: "text", text: `🚨 Broadcasted help request across all Workhouse sessions: "${params.message}"` }],
          details: rec,
        };
      }

      if (params.action === "read") {
        const chanOrPeer = params.target || params.channel || "#general";
        const msgs = engine.getMessages(chanOrPeer, params.limit || 20);
        const formatted = msgs.reverse().map((m) => {
          const time = new Date(m.created_at).toLocaleTimeString();
          return `[${time}] <${m.sender_name}>: ${m.content}`;
        });

        return {
          content: [
            {
              type: "text",
              text: formatted.length > 0 ? formatted.join("\n") : `No messages found in ${chanOrPeer}`,
            },
          ],
          details: { count: msgs.length, messages: msgs },
        };
      }

      if (!params.message) {
        throw new Error("Message parameter is required for 'send'");
      }

      let targetId: string | null = null;
      let targetName = "";
      if (params.target) {
        const peer = engine.findPeer(params.target);
        if (!peer) {
          throw new Error(`Target session not found: ${params.target}`);
        }
        targetId = peer.id;
        targetName = peer.name;
      }

      const chan = params.channel || "#general";
      const rec = await engine.postMessage(chan, params.message, targetId);

      return {
        content: [
          {
            type: "text",
            text: targetId
              ? `📩 Sent direct message to ${targetName}: "${params.message}"`
              : `💬 Posted to ${rec.channel}: "${params.message}"`,
          },
        ],
        details: { messageId: rec.id, channel: rec.channel, target: targetName },
      };
    },
  });

  // Tool 3: workhouse_direct
  pi.registerTool({
    name: "workhouse_direct",
    label: "Workhouse Direct",
    description:
      "Direct another concurrent Pi session agent to execute a task, monitor it, and receive its completed reply in return.",
    parameters: Type.Object({
      target: Type.String({ description: "Target session name or ID to direct" }),
      title: Type.String({ description: "Short descriptive title of the task" }),
      instruction: Type.String({ description: "Full prompt instruction and context for the target agent" }),
      priority: Type.Optional(
        Type.Union([Type.Literal("normal"), Type.Literal("high"), Type.Literal("urgent")], {
          description: "Task priority level (default: 'normal')",
        })
      ),
      wait_for_reply: Type.Optional(
        Type.Boolean({
          description: "Whether to wait and receive the agent's completed reply in return (default: true).",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Max seconds to wait for the agent to finish and reply (default: 90).",
        })
      ),
    }),
    async execute(_id, params) {
      const peer = engine.findPeer(params.target);
      if (!peer) {
        throw new Error(`Target session not found: ${params.target}`);
      }

      const shouldWait = params.wait_for_reply !== false;

      if (shouldWait) {
        const timeoutMs = (params.timeout_seconds || 90) * 1000;
        const res = await engine.askPeer(peer, params.title, params.instruction, timeoutMs);

        if (res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `📩 Received reply from agent ${peer.name} (PID ${peer.pid}) [Task: "${params.title}" | Took ${(res.durationMs / 1000).toFixed(1)}s]:\n\n${res.reply}`,
              },
            ],
            details: res,
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `⏳ Directed task "${params.title}" dispatched to ${peer.name}, but awaiting reply timed out (${params.timeout_seconds || 90}s). The agent may still be executing. Check status with workhouse_tasks.`,
              },
            ],
            details: res,
          };
        }
      }

      const task = await engine.directTask(peer, params.title, params.instruction, params.priority || "normal");

      return {
        content: [
          {
            type: "text",
            text: `🎯 Dispatched directed task to agent ${peer.name} (PID ${peer.pid})!\nTask ID: ${task.id}\nTitle: "${task.title}"`,
          },
        ],
        details: task,
      };
    },
  });

  // Tool 4: workhouse_tasks
  pi.registerTool({
    name: "workhouse_tasks",
    label: "Workhouse Tasks",
    description:
      "List, track, or update directed tasks across concurrent Pi sessions in the Workhouse.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("update")],
        { description: "'list' to view tasks, 'update' to report progress/completion" }
      ),
      taskId: Type.Optional(Type.String({ description: "Task ID to update" })),
      status: Type.Optional(
        Type.Union(
          [Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("failed")],
          { description: "New status for the task" }
        )
      ),
      result: Type.Optional(Type.String({ description: "Execution result or output summary" })),
      filter: Type.Optional(Type.String({ description: "Filter tasks by status (for list)" })),
    }),
    async execute(_id, params) {
      if (params.action === "update") {
        if (!params.taskId || !params.status) {
          throw new Error("'taskId' and 'status' are required for 'update'");
        }
        const ok = engine.updateTaskStatus(params.taskId, params.status, params.result);
        return {
          content: [
            {
              type: "text",
              text: ok ? `✅ Updated task ${params.taskId} -> ${params.status}` : `✖ Task not found: ${params.taskId}`,
            },
          ],
          details: { updated: ok },
        };
      }

      const tasks = engine.listTasks(params.filter);
      const lines = [`🎯 Workhouse Directed Tasks (${tasks.length}):`];
      for (const t of tasks) {
        lines.push(`● [${t.status.toUpperCase()}] "${t.title}" (${t.from_session_name} -> ${t.to_session_id}) [ID: ${t.id}]`);
        if (t.result) lines.push(`  Result: ${t.result}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: tasks.length, tasks },
      };
    },
  });

  // Tool 5: workhouse_artifacts (Dedicated for Big Resources)
  pi.registerTool({
    name: "workhouse_artifacts",
    label: "Workhouse Artifacts",
    description:
      "Share and exchange large resources (files, datasets, binaries, diffs, build outputs) across concurrent Pi sessions.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("share"), Type.Literal("list"), Type.Literal("fetch"), Type.Literal("inspect")],
        { description: "Artifact operation" }
      ),
      file_path: Type.Optional(
        Type.String({ description: "Local file path to share (for 'share') or destination path to write (for 'fetch')" })
      ),
      name: Type.Optional(
        Type.String({ description: "Artifact name / alias (for 'share', 'fetch', or 'inspect')" })
      ),
      description: Type.Optional(
        Type.String({ description: "Short description of the artifact" })
      ),
    }),
    async execute(_id, params) {
      switch (params.action) {
        case "share": {
          if (!params.file_path) {
            throw new Error("'file_path' is required for sharing an artifact");
          }
          const rec = engine.shareArtifact(params.file_path, params.name, params.description);
          return {
            content: [
              {
                type: "text",
                text: `📦 Shared artifact "${rec.name}" (${formatBytes(rec.size_bytes)}) to Workhouse depot! SHA256: ${rec.sha256.slice(0, 16)}...`,
              },
            ],
            details: rec,
          };
        }

        case "list": {
          const list = engine.listArtifacts();
          const lines = [`📦 Workhouse Shared Artifacts (${list.length}):`];
          for (const a of list) {
            lines.push(`● "${a.name}" (${formatBytes(a.size_bytes)}) [owner: ${a.owner_name}] sha256:${a.sha256.slice(0, 10)}...${a.description ? ` - ${a.description}` : ""}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { count: list.length, artifacts: list },
          };
        }

        case "fetch": {
          if (!params.name) {
            throw new Error("'name' of the artifact is required for 'fetch'");
          }
          const res = engine.fetchArtifact(params.name, params.file_path);
          return {
            content: [
              {
                type: "text",
                text: `📥 Fetched artifact "${res.originalName}" (${formatBytes(res.bytesWritten)}) to: ${res.targetPath}`,
              },
            ],
            details: res,
          };
        }

        case "inspect": {
          if (!params.name) {
            throw new Error("'name' of the artifact is required for 'inspect'");
          }
          const art = engine.getArtifact(params.name);
          if (!art) {
            return {
              content: [{ type: "text", text: `✖ Artifact not found: "${params.name}"` }],
              details: { found: false },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `📦 Artifact "${art.name}":\nSize: ${formatBytes(art.size_bytes)} (${art.size_bytes} bytes)\nOwner: ${art.owner_name}\nSHA256: ${art.sha256}\nStorage: ${art.storage_path}\nDescription: ${art.description || "none"}`,
              },
            ],
            details: art,
          };
        }
      }
    },
  });

  // Tool 6: workhouse_resources (Lightweight KV & Mutex Locks)
  pi.registerTool({
    name: "workhouse_resources",
    label: "Workhouse Resources",
    description:
      "Lightweight shared key-value blackboard and distributed coordination locks across Pi sessions.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("set"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("delete"),
          Type.Literal("acquire_lock"),
          Type.Literal("release_lock"),
        ],
        { description: "Resource operation to perform" }
      ),
      key: Type.Optional(Type.String({ description: "Resource key name" })),
      value: Type.Optional(Type.String({ description: "String or JSON serialized value to store" })),
      description: Type.Optional(Type.String({ description: "Optional description of the resource" })),
      tags: Type.Optional(Type.String({ description: "Comma-separated tags for filtering" })),
      ttl_seconds: Type.Optional(Type.Number({ description: "TTL in seconds for ephemeral KV or locks" })),
      lock_name: Type.Optional(Type.String({ description: "Named mutex lock to acquire or release" })),
    }),
    async execute(_id, params) {
      switch (params.action) {
        case "set": {
          if (!params.key || params.value === undefined) {
            throw new Error("'key' and 'value' are required for 'set'");
          }
          const rec = engine.setResource(params.key, params.value, "kv", params.description, params.tags, params.ttl_seconds);
          return {
            content: [{ type: "text", text: `📦 Set Workhouse resource "${rec.key}" = "${rec.value.slice(0, 80)}"` }],
            details: rec,
          };
        }

        case "get": {
          if (!params.key) throw new Error("'key' is required for 'get'");
          const rec = engine.getResource(params.key);
          if (!rec) {
            return {
              content: [{ type: "text", text: `✖ Resource not found: "${params.key}"` }],
              details: { found: false },
            };
          }
          return {
            content: [{ type: "text", text: `📦 Resource "${rec.key}" (${rec.type}, owner: ${rec.owner_name}):\n${rec.value}` }],
            details: rec,
          };
        }

        case "list": {
          const recs = engine.listResources(params.tags);
          const lines = [`📦 Workhouse KV Blackboard (${recs.length}):`];
          for (const r of recs) {
            lines.push(`● [${r.type.toUpperCase()}] "${r.key}" (owner: ${r.owner_name})${r.description ? ` - ${r.description}` : ""}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { count: recs.length, resources: recs },
          };
        }

        case "delete": {
          if (!params.key) throw new Error("'key' is required for 'delete'");
          const ok = engine.deleteResource(params.key);
          return {
            content: [{ type: "text", text: ok ? `🗑️ Deleted resource "${params.key}"` : `✖ Resource not found: "${params.key}"` }],
            details: { deleted: ok },
          };
        }

        case "acquire_lock": {
          const name = params.lock_name || params.key;
          if (!name) throw new Error("'lock_name' is required for 'acquire_lock'");
          const res = engine.acquireLock(name, params.ttl_seconds || 60);
          return {
            content: [
              {
                type: "text",
                text: res.ok
                  ? `🔒 Successfully acquired lock "${name}" for ${res.remainingSec}s`
                  : `✖ Lock "${name}" held by ${res.holder} (${res.remainingSec}s remaining)`,
              },
            ],
            details: res,
          };
        }

        case "release_lock": {
          const name = params.lock_name || params.key;
          if (!name) throw new Error("'lock_name' is required for 'release_lock'");
          const ok = engine.releaseLock(name);
          return {
            content: [{ type: "text", text: ok ? `🔓 Released lock "${name}"` : `✖ Cannot release lock "${name}"` }],
            details: { released: ok },
          };
        }
      }
    },
  });

  // Tool 7: workhouse_monitor
  pi.registerTool({
    name: "workhouse_monitor",
    label: "Workhouse Monitor",
    description:
      "Monitor all connected Pi worker agents in real-time: active tasks, execution status, latencies, and latest replies.",
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({ description: "Specific peer to monitor (or omit for entire cluster)" })
      ),
    }),
    async execute(_id, _params) {
      const tasks = engine.listTasks();
      const pings = await engine.pingAllSessions();

      const lines = [`📊 WORKHOUSE AGENT MONITOR:`];
      for (const p of pings) {
        const peerTasks = tasks.filter((t) => t.to_session_id === p.peer.id || t.to_session_id === p.peer.name);
        const inProgress = peerTasks.filter((t) => t.status === "in_progress");
        const completed = peerTasks.filter((t) => t.status === "completed");
        const status = p.ok ? `${p.latencyMs}ms` : "OFFLINE";

        lines.push(`● ${p.peer.name} [${p.peer.role}] (PID ${p.peer.pid}) -> Latency: ${status}`);
        lines.push(`   Active Tasks (${inProgress.length}): ${inProgress.map((t) => `"${t.title}"`).join(", ") || "Idle"}`);
        lines.push(`   Completed Tasks (${completed.length})`);
        if (completed.length > 0) {
          const last = completed[0];
          lines.push(`   Latest Reply: "${last.result ? last.result.slice(0, 120) : "done"}..."`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { pings, tasks },
      };
    },
  });

  // --------------------------------------------------------------------------
  // Slash Commands
  // --------------------------------------------------------------------------
  const handleWorkhouseCommand = async (
    rawArgs: string,
    ctx: ExtensionCommandContext
  ) => {
    const parts = (rawArgs || "").trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() || "";
    const rest = parts.slice(1).join(" ");

    if (!sub) {
      const dashboard = await renderWorkhouseDashboard(engine, ctx);
      ctx.ui.notify("🏛️ Pi Workhouse Control Deck", "info");
      if (ctx.hasUI) {
        console.log("\n" + dashboard + "\n");
      }
      return;
    }

    switch (sub) {
      case "ui": {
        if (parts[1] === "stop" || parts[1] === "close") {
          if (activeWebServer) {
            try {
              await activeWebServer.close();
            } catch {}
            activeWebServer = null;
            ctx.ui.notify("🏛️ Workhouse Web UI stopped.", "info");
            return;
          }
          const port = parts[2] ? parseInt(parts[2], 10) : DEFAULT_PORT;
          const res = await stopWorkhouseUi(port);
          ctx.ui.notify(res.ok ? `🏛️ ${res.message}` : `⚠️ ${res.message}`, res.ok ? "info" : "warning");
          return;
        }

        const port = parts[1] ? parseInt(parts[1], 10) : DEFAULT_PORT;
        if (activeWebServer) {
          ctx.ui.notify(`🏛️ Workhouse Web UI is already running at http://localhost:${port}. Use /wh ui stop to close it.`, "warning");
          return;
        }
        try {
          activeWebServer = createWebServer(port);
          await activeWebServer.listen();
          ctx.ui.notify(`🏛️ Workhouse Web UI active at http://localhost:${port}`, "info");
        } catch (err: any) {
          activeWebServer = null;
          ctx.ui.notify(`⚠️ Failed to start Workhouse Web UI: ${err.message}`, "error");
        }
        return;
      }

      case "stop":
      case "close": {
        if (activeWebServer) {
          try {
            await activeWebServer.close();
          } catch {}
          activeWebServer = null;
          ctx.ui.notify("🏛️ Workhouse Web UI stopped.", "info");
          return;
        }
        const port = parts[1] ? parseInt(parts[1], 10) : DEFAULT_PORT;
        const res = await stopWorkhouseUi(port);
        ctx.ui.notify(res.ok ? `🏛️ ${res.message}` : `⚠️ ${res.message}`, res.ok ? "info" : "warning");
        return;
      }

      case "feed":
      case "watch": {
        const limit = parts[1] ? parseInt(parts[1], 10) : 25;
        const feed = engine.getFeed(limit).reverse();
        if (feed.length === 0) {
          ctx.ui.notify("No agent communications in feed yet.", "info");
          return;
        }
        const lines = [`${C.boldYellow}📡 Live Agent Communication Feed (${feed.length} events):${C.reset}`];
        for (const m of feed) {
          const time = new Date(m.created_at).toLocaleTimeString();
          const chan = `${C.magenta}[${m.channel}]${C.reset}`;
          const isSelf = m.sender_id === engine.sessionId;
          const sender = isSelf ? `${C.boldGreen}<${m.sender_name}>${C.reset}` : `${C.boldCyan}<${m.sender_name}>${C.reset}`;
          lines.push(` [${time}] ${chan} ${sender} ${m.content}`);
        }
        console.log("\n" + lines.join("\n") + "\n");
        return;
      }

      case "artifacts": {
        const list = engine.listArtifacts();
        if (list.length === 0) {
          ctx.ui.notify("No shared artifacts in Workhouse depot.", "info");
          return;
        }
        const lines = [`${C.boldYellow}📦 Shared Workhouse Artifacts (${list.length}):${C.reset}`];
        for (const a of list) {
          lines.push(` ● ${C.boldCyan}${a.name.padEnd(24)}${C.reset} ${C.green}${formatBytes(a.size_bytes).padEnd(9)}${C.reset} sha256:${a.sha256.slice(0, 10)}... (owner: ${a.owner_name})`);
        }
        console.log("\n" + lines.join("\n") + "\n");
        return;
      }

      case "artifact": {
        const name = parts[1];
        if (!name) {
          ctx.ui.notify("Usage: /wh artifact <name>", "warning");
          return;
        }
        const a = engine.getArtifact(name);
        if (!a) {
          ctx.ui.notify(`✖ Artifact not found: "${name}"`, "error");
          return;
        }
        console.log(
          `\n${C.boldCyan}[Artifact: ${a.name}]${C.reset}\nSize: ${formatBytes(a.size_bytes)} (${a.size_bytes} bytes)\nOwner: ${a.owner_name}\nSHA256: ${a.sha256}\nStorage: ${a.storage_path}\nDescription: ${a.description || "none"}\n`
        );
        return;
      }

      case "share": {
        const filePath = parts[1];
        const name = parts[2];
        const desc = parts.slice(3).join(" ") || undefined;
        if (!filePath) {
          ctx.ui.notify("Usage: /wh share <filePath> [name] [description]", "warning");
          return;
        }
        try {
          const rec = engine.shareArtifact(filePath, name, desc);
          ctx.ui.notify(`📦 Artifact "${rec.name}" (${formatBytes(rec.size_bytes)}) shared to Workhouse depot!`, "info");
        } catch (err: any) {
          ctx.ui.notify(`✖ Share failed: ${err.message}`, "error");
        }
        return;
      }

      case "fetch": {
        const name = parts[1];
        const dest = parts[2];
        if (!name) {
          ctx.ui.notify("Usage: /wh fetch <artifactName> [destPath]", "warning");
          return;
        }
        try {
          const res = engine.fetchArtifact(name, dest);
          ctx.ui.notify(`📥 Fetched artifact "${res.originalName}" to ${res.targetPath}!`, "info");
        } catch (err: any) {
          ctx.ui.notify(`✖ Fetch failed: ${err.message}`, "error");
        }
        return;
      }

      case "peers":
      case "list": {
        const peers = engine.getActivePeers();
        const hub = engine.getWorkhouseRecord();
        const lines = [`${C.boldYellow}🏛️ Connected Workhouse Sessions (${peers.length + 1}):${C.reset}`];
        lines.push(`● THIS SESSION: ${C.boldCyan}${engine.sessionName}${C.reset} [ROLE: ${engine.role.toUpperCase()}] (PID ${engine.pid})`);
        if (hub && hub.id !== engine.sessionId) {
          lines.push(`● CENTRAL WORKHOUSE: ${C.boldGreen}${hub.name}${C.reset} (PID ${hub.pid}) @ ${hub.cwd}`);
        }
        for (const p of peers) {
          if (p.id !== hub?.id) {
            lines.push(`● WORKER: ${C.cyan}${p.name}${C.reset} (PID ${p.pid}) -> ${p.project} [${p.git_branch || "no git"}] @ ${p.cwd}`);
          }
        }
        console.log("\n" + lines.join("\n") + "\n");
        return;
      }

      case "ping": {
        const target = parts[1];
        const directive = parts.slice(2).join(" ");
        if (target) {
          const peer = engine.findPeer(target);
          if (!peer) {
            ctx.ui.notify(`✖ Peer not found: "${target}"`, "error");
            return;
          }
          const res = await engine.pingPeer(peer, directive || undefined);
          if (res.ok) {
            const extra = directive ? " | 🎯 Directive dispatched & agent woken up!" : "";
            ctx.ui.notify(`⚡ PING ${peer.name} [${peer.role}]: ${res.latencyMs}ms${extra}`, "info");
          } else {
            ctx.ui.notify(`✖ PING failed: ${res.error}`, "error");
          }
        } else {
          const results = await engine.pingAllSessions();
          if (results.length === 0) {
            ctx.ui.notify("No other active sessions online to ping.", "warning");
            return;
          }
          const lines = [`${C.boldYellow}⚡ Workhouse Cluster Ping Latencies:${C.reset}`];
          for (const r of results) {
            const status = r.ok ? formatLatency(r.latencyMs) : `${C.red}FAILED (${r.error})${C.reset}`;
            lines.push(`● ${C.cyan}${r.peer.name}${C.reset} [${r.peer.role}] (PID ${r.peer.pid}) -> ${status}`);
          }
          console.log("\n" + lines.join("\n") + "\n");
        }
        return;
      }

      case "chat":
      case "post": {
        if (!rest) {
          ctx.ui.notify("Usage: /wh chat <message>", "warning");
          return;
        }
        await engine.postMessage("#general", rest);
        ctx.ui.notify(`💬 Broadcast to #general: "${rest}"`, "info");
        return;
      }

      case "send":
      case "dm": {
        const target = parts[1];
        const msg = parts.slice(2).join(" ");
        if (!target || !msg) {
          ctx.ui.notify("Usage: /wh send <peer> <message>", "warning");
          return;
        }
        const peer = engine.findPeer(target);
        if (!peer) {
          ctx.ui.notify(`✖ Peer not found: "${target}"`, "error");
          return;
        }
        await engine.postMessage("#general", msg, peer.id);
        ctx.ui.notify(`📩 DM sent to ${peer.name}: "${msg}"`, "info");
        return;
      }

      case "direct": {
        const target = parts[1];
        const instruction = parts.slice(2).join(" ");
        if (!target || !instruction) {
          ctx.ui.notify("Usage: /wh direct <peer> <instruction>", "warning");
          return;
        }
        const peer = engine.findPeer(target);
        if (!peer) {
          ctx.ui.notify(`✖ Peer not found: "${target}"`, "error");
          return;
        }
        const title = instruction.slice(0, 40);
        const task = await engine.directTask(peer, title, instruction);
        ctx.ui.notify(`🎯 Directed task to ${peer.name}! (Task ID: ${task.id})`, "info");
        return;
      }

      case "help":
      case "ask": {
        if (!rest) {
          ctx.ui.notify("Usage: /wh help <question>", "warning");
          return;
        }
        await engine.requestHelp(rest);
        ctx.ui.notify(`🚨 Help request broadcasted across all sessions!`, "info");
        return;
      }

      case "tasks": {
        const filter = parts[1];
        const list = engine.listTasks(filter);
        if (list.length === 0) {
          ctx.ui.notify("No directed tasks found.", "info");
          return;
        }
        const lines = [`${C.boldYellow}Workhouse Tasks (${list.length}):${C.reset}`];
        for (const t of list) {
          lines.push(`● [${t.status.toUpperCase()}] "${t.title}" (${t.from_session_name} -> ${t.to_session_id})`);
          if (t.result) lines.push(`   Result: ${t.result}`);
        }
        console.log("\n" + lines.join("\n") + "\n");
        return;
      }

      case "set": {
        const key = parts[1];
        const val = parts.slice(2).join(" ");
        if (!key || !val) {
          ctx.ui.notify("Usage: /wh set <key> <value>", "warning");
          return;
        }
        engine.setResource(key, val);
        ctx.ui.notify(`📦 Resource saved: ${key} = ${val}`, "info");
        return;
      }

      case "get": {
        const key = parts[1];
        if (!key) {
          ctx.ui.notify("Usage: /wh get <key>", "warning");
          return;
        }
        const rec = engine.getResource(key);
        if (!rec) {
          ctx.ui.notify(`✖ Resource not found: "${key}"`, "error");
          return;
        }
        console.log(`\n${C.boldCyan}[Resource: ${rec.key}]${C.reset} (${rec.type}, owner: ${rec.owner_name})\n${rec.value}\n`);
        return;
      }

      case "resources": {
        const filter = parts[1];
        const list = engine.listResources(filter);
        if (list.length === 0) {
          ctx.ui.notify("No shared KV resources found.", "info");
          return;
        }
        const lines = [`${C.boldYellow}Workhouse KV Blackboard (${list.length}):${C.reset}`];
        for (const r of list) {
          lines.push(`● [${r.type.toUpperCase()}] ${C.boldCyan}${r.key}${C.reset} (owner: ${r.owner_name}) = ${r.value.slice(0, 60)}`);
        }
        console.log("\n" + lines.join("\n") + "\n");
        return;
      }

      case "lock": {
        const lockName = parts[1];
        const ttl = parts[2] ? parseInt(parts[2], 10) : 60;
        if (!lockName) {
          ctx.ui.notify("Usage: /wh lock <name> [ttl_seconds]", "warning");
          return;
        }
        const res = engine.acquireLock(lockName, ttl);
        if (res.ok) {
          ctx.ui.notify(`🔒 Lock "${lockName}" acquired for ${res.remainingSec}s!`, "info");
        } else {
          ctx.ui.notify(`✖ Lock held by ${res.holder} (${res.remainingSec}s remaining)`, "warning");
        }
        return;
      }

      case "unlock": {
        const lockName = parts[1];
        if (!lockName) {
          ctx.ui.notify("Usage: /wh unlock <name>", "warning");
          return;
        }
        const ok = engine.releaseLock(lockName);
        if (ok) {
          ctx.ui.notify(`🔓 Lock "${lockName}" released.`, "info");
        } else {
          ctx.ui.notify(`✖ Cannot release lock (not held by self).`, "error");
        }
        return;
      }

      case "clear": {
        engine.reapDeadPeers();
        ctx.ui.notify("🧹 Cleaned up stale sessions and expired locks.", "info");
        return;
      }

      default: {
        ctx.ui.notify(`Unknown subcommand: "${sub}". Try /wh, /wh feed, /wh artifacts, /wh direct, /wh help, /wh ui, /wh stop`, "warning");
      }
    }
  };

  pi.registerCommand("workhouse", {
    description: "Pi Workhouse: central house for sessions to communicate, direct, help, and share artifacts",
    handler: handleWorkhouseCommand,
  });

  pi.registerCommand("wh", {
    description: "Alias for /workhouse",
    handler: handleWorkhouseCommand,
  });

  pi.registerCommand("mesh", {
    description: "Alias for /workhouse",
    handler: handleWorkhouseCommand,
  });

  pi.registerCommand("space", {
    description: "Alias for /workhouse",
    handler: handleWorkhouseCommand,
  });
}
