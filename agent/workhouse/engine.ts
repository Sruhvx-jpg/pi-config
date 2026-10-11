/**
 * pi-workhouse: Core Central Workhouse Cluster Engine
 */

import { DatabaseSync } from "node:sqlite";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  WORKHOUSE_HUB_SOCK,
  WORKHOUSE_SOCKETS_DIR,
  getWorkhouseDb,
  ensureDirectories,
} from "./db.ts";
import {
  isPidAlive,
  detectGitBranch,
  sendFrameToSocket,
} from "./ipc.ts";
import { ArtifactDepot } from "./artifacts.ts";
import type {
  SessionRecord,
  MessageRecord,
  ArtifactRecord,
  ResourceRecord,
  LockRecord,
  TaskRecord,
  WorkhouseFrame,
} from "./types.ts";

export interface ExtensionContextAdapter {
  hasUI: boolean;
  ui: {
    notify: (msg: string, type: "info" | "warning" | "error") => void;
    setStatus: (id: string, text: string) => void;
  };
  sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
}

export class WorkhouseEngine {
  public sessionId: string;
  public sessionName: string;
  public role: "workhouse" | "worker" = "worker";
  public pid: number;
  public cwd: string;
  public project: string;
  public gitBranch: string | null;
  public socketPath: string;

  private server: net.Server | null = null;
  private hubServer: net.Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private db: DatabaseSync;
  private artifacts: ArtifactDepot;
  private extContext: ExtensionContextAdapter | null = null;
  private piApi: any = null;
  private unreadCount = 0;
  private isShuttingDown = false;

  constructor() {
    this.pid = process.pid;
    this.cwd = process.cwd();
    this.project = path.basename(this.cwd) || "root";
    this.gitBranch = detectGitBranch(this.cwd);

    const randomSuffix = crypto.randomBytes(3).toString("hex");
    this.sessionId = `pi-${this.pid}-${randomSuffix}`;
    this.sessionName = `${this.project}#${this.pid}`;

    ensureDirectories();
    this.socketPath = path.join(WORKHOUSE_SOCKETS_DIR, `${this.sessionId}.sock`);
    this.db = getWorkhouseDb();
    this.artifacts = new ArtifactDepot(this.db);
  }

  public setPi(pi: any): void {
    this.piApi = pi;
  }

  public setContext(ctx: ExtensionContextAdapter): void {
    this.extContext = ctx;
    this.updateStatusBadge();
  }

  // --------------------------------------------------------------------------
  // Startup & Automatic Workhouse Connection / Promotion
  // --------------------------------------------------------------------------
  public async start(): Promise<void> {
    if (fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }

    await this.startPrivateSocketServer();

    const workhouseAlive = await this.probeWorkhouseHub();

    if (workhouseAlive) {
      this.role = "worker";
      this.registerInDatabase();
      await this.registerWithWorkhouse();
    } else {
      const promoted = await this.tryPromoteToWorkhouse();
      if (!promoted) {
        this.role = "worker";
        this.registerInDatabase();
        await this.registerWithWorkhouse();
      }
    }

    this.reapDeadPeers();

    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, 8000);
    this.heartbeatTimer.unref();

    this.updateStatusBadge();

    const shutdown = () => this.stop();
    process.once("exit", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  public async probeWorkhouseHub(): Promise<boolean> {
    if (!fs.existsSync(WORKHOUSE_HUB_SOCK)) return false;

    const res = await sendFrameToSocket(
      WORKHOUSE_HUB_SOCK,
      {
        type: "PING",
        sender_id: this.sessionId,
        sender_name: this.sessionName,
        timestamp: Date.now(),
      },
      350
    );

    if (res.ok && res.response?.type === "PONG") {
      const pong = res.response;
      if (pong.responder_id !== this.sessionId && isPidAlive(pong.pid)) {
        return true;
      }
    }

    return false;
  }

  public async tryPromoteToWorkhouse(): Promise<boolean> {
    const now = Date.now();
    const leaseMs = 30000;

    const currentLock = this.db
      .prepare("SELECT * FROM locks WHERE name = 'central_workhouse_leader'")
      .get() as LockRecord | undefined;

    if (
      currentLock &&
      currentLock.expires_at > now &&
      currentLock.holder_id !== this.sessionId
    ) {
      const holderSession = this.db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(currentLock.holder_id) as SessionRecord | undefined;

      if (holderSession && isPidAlive(holderSession.pid)) {
        return false;
      }
    }

    this.db
      .prepare(
        "INSERT OR REPLACE INTO locks (name, holder_id, holder_name, acquired_at, expires_at) VALUES ('central_workhouse_leader', ?, ?, ?, ?)"
      )
      .run(this.sessionId, this.sessionName, now, now + leaseMs);

    if (fs.existsSync(WORKHOUSE_HUB_SOCK)) {
      try {
        fs.unlinkSync(WORKHOUSE_HUB_SOCK);
      } catch {}
    }

    try {
      await this.startHubSocketServer();
      this.role = "workhouse";
      this.registerInDatabase();

      await this.broadcastFrame({
        type: "WORKHOUSE_ELECTED",
        new_workhouse: this.toRecord(),
      });

      if (this.extContext?.hasUI) {
        this.extContext.ui.notify(
          `🏛️ Promoted to Central Workhouse Hub! (PID ${this.pid})`,
          "info"
        );
      }
      this.updateStatusBadge();
      return true;
    } catch {
      this.db
        .prepare(
          "DELETE FROM locks WHERE name = 'central_workhouse_leader' AND holder_id = ?"
        )
        .run(this.sessionId);
      return false;
    }
  }

  private registerInDatabase(): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions 
        (id, pid, name, role, cwd, project, git_branch, socket_path, status, created_at, last_heartbeat, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        this.sessionId,
        this.pid,
        this.sessionName,
        this.role,
        this.cwd,
        this.project,
        this.gitBranch,
        this.socketPath,
        now,
        now,
        JSON.stringify({ arch: os.arch(), platform: os.platform() })
      );
  }

  private async registerWithWorkhouse(): Promise<void> {
    const frame: WorkhouseFrame = {
      type: "REGISTER_WORKER",
      session: this.toRecord(),
    };
    await sendFrameToSocket(WORKHOUSE_HUB_SOCK, frame, 1000);
    if (this.extContext?.hasUI) {
      const hub = this.getWorkhouseRecord();
      const hubName = hub ? hub.name : "Hub";
      this.extContext.ui.notify(
        `🏛️ Connected to Central Workhouse [${hubName}]!`,
        "info"
      );
    }
    this.updateStatusBadge();
  }

  public toRecord(): SessionRecord {
    return {
      id: this.sessionId,
      pid: this.pid,
      name: this.sessionName,
      role: this.role,
      cwd: this.cwd,
      project: this.project,
      git_branch: this.gitBranch,
      socket_path: this.socketPath,
      status: "active",
      created_at: Date.now(),
      last_heartbeat: Date.now(),
      metadata: null,
    };
  }

  // --------------------------------------------------------------------------
  // Socket Transport Listeners
  // --------------------------------------------------------------------------
  private startPrivateSocketServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.wireSocketStream(socket);
      });
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  private startHubSocketServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.hubServer = net.createServer((socket) => {
        this.wireSocketStream(socket);
      });
      this.hubServer.on("error", reject);
      this.hubServer.listen(WORKHOUSE_HUB_SOCK, () => resolve());
    });
  }

  private wireSocketStream(socket: net.Socket): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          this.handleIncomingFrame(socket, line);
        }
      }
    });
    socket.on("error", () => {});
  }

  private handleIncomingFrame(socket: net.Socket, raw: string): void {
    let frame: WorkhouseFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    switch (frame.type) {
      case "PING": {
        const pong: WorkhouseFrame = {
          type: "PONG",
          responder_id: this.sessionId,
          responder_name: this.sessionName,
          role: this.role,
          pid: this.pid,
          echo_timestamp: frame.timestamp,
          responder_time: Date.now(),
        };

        // If ping carries a directive, immediately wake up and prompt the agent!
        if (frame.directive) {
          if (this.extContext?.hasUI) {
            this.extContext.ui.notify(
              `⚡ [Workhouse Ping Directive from ${frame.sender_name}]: "${frame.directive.slice(0, 60)}..."`,
              "info"
            );
          }

          const promptText = `[WORKHOUSE PING DIRECTIVE FROM ${frame.sender_name.toUpperCase()}]:
${frame.directive}

Please execute this task now and report your findings to the Workhouse via workhouse_chat or workhouse_tasks.`;

          if (this.piApi) {
            try {
              const isIdle = this.extContext ? this.extContext.isIdle() : true;
              if (isIdle) {
                this.piApi.sendUserMessage(promptText);
              } else {
                this.piApi.sendUserMessage(promptText, { deliverAs: "followUp" });
              }
            } catch (err: any) {
              console.error("[Workhouse] Failed to trigger agent turn from ping directive:", err);
            }
          }
        }

        try {
          socket.write(JSON.stringify(pong) + "\n");
        } catch {}
        break;
      }

      case "REGISTER_WORKER": {
        if (this.role === "workhouse") {
          const w = frame.session;
          this.db
            .prepare(
              `INSERT OR REPLACE INTO sessions 
              (id, pid, name, role, cwd, project, git_branch, socket_path, status, created_at, last_heartbeat, metadata)
              VALUES (?, ?, ?, 'worker', ?, ?, ?, ?, 'active', ?, ?, ?)`
            )
            .run(
              w.id,
              w.pid,
              w.name,
              w.cwd,
              w.project,
              w.git_branch,
              w.socket_path,
              w.created_at,
              Date.now(),
              w.metadata
            );

          this.broadcastFrame({
            type: "WORKER_JOINED",
            session: w,
          }).catch(() => {});

          if (this.extContext?.hasUI) {
            this.extContext.ui.notify(
              `🏛️ [Workhouse] Worker joined: ${w.name} (${w.project})`,
              "info"
            );
          }
          this.updateStatusBadge();
        }
        break;
      }

      case "WORKER_JOINED": {
        if (frame.session.id !== this.sessionId) {
          if (this.extContext?.hasUI) {
            this.extContext.ui.notify(
              `⚡ [Workhouse] Peer joined: ${frame.session.name} (${frame.session.project})`,
              "info"
            );
          }
          this.updateStatusBadge();
        }
        break;
      }

      case "WORKER_LEFT": {
        this.updateStatusBadge();
        break;
      }

      case "WORKHOUSE_ELECTED": {
        if (frame.new_workhouse.id !== this.sessionId) {
          this.role = "worker";
          if (this.extContext?.hasUI) {
            this.extContext.ui.notify(
              `🏛️ New Workhouse elected: ${frame.new_workhouse.name} (PID ${frame.new_workhouse.pid})`,
              "info"
            );
          }
          this.updateStatusBadge();
        }
        break;
      }

      case "MESSAGE": {
        const msg = frame.message;
        this.unreadCount++;
        if (this.extContext?.hasUI) {
          const isDM = msg.target_id === this.sessionId;
          let prefix = `💬 [Workhouse ${msg.channel}] ${msg.sender_name}:`;
          if (isDM) prefix = `📩 [Workhouse DM from ${msg.sender_name}]:`;
          if (msg.channel === "#help")
            prefix = `🚨 [Workhouse Help Request from ${msg.sender_name}]:`;
          this.extContext.ui.notify(`${prefix} ${msg.content}`, "info");
        }
        this.updateStatusBadge();
        break;
      }

      case "DIRECT_TASK": {
        if (frame.to_session_id === this.sessionId) {
          if (this.extContext?.hasUI) {
            this.extContext.ui.notify(
              `🎯 [Workhouse Task from ${frame.from_session_name}]: "${frame.title}"`,
              "info"
            );
          }

          this.db
            .prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?")
            .run(Date.now(), frame.taskId);

          const promptText = `[WORKHOUSE TASK DIRECTED BY ${frame.from_session_name.toUpperCase()}]:
Title: ${frame.title}
Instruction: ${frame.instruction}
Task ID: ${frame.taskId}

Execute this task and report back using workhouse_tasks(action: 'update', taskId: '${frame.taskId}', status: 'completed', result: '...') or /wh chat.`;

          if (this.piApi) {
            try {
              const isIdle = this.extContext ? this.extContext.isIdle() : true;
              if (isIdle) {
                this.piApi.sendUserMessage(promptText);
              } else {
                this.piApi.sendUserMessage(promptText, { deliverAs: "followUp" });
              }
            } catch (err: any) {
              console.error("[Workhouse] Error triggering user message:", err);
            }
          }

          try {
            socket.write(
              JSON.stringify({ ok: true, taskId: frame.taskId, status: "accepted" }) +
                "\n"
            );
          } catch {}
        }
        break;
      }

      case "TASK_UPDATE": {
        if (this.extContext?.hasUI) {
          this.extContext.ui.notify(
            `✅ [Workhouse Task] ${frame.from_session_name} updated task ${frame.taskId} -> ${frame.status}`,
            "info"
          );
        }
        break;
      }

      case "ARTIFACT_SHARED": {
        if (this.extContext?.hasUI) {
          const art = frame.artifact;
          this.extContext.ui.notify(
            `📦 [Workhouse Artifact] ${art.owner_name} shared "${art.name}"`,
            "info"
          );
        }
        break;
      }

      case "RESOURCE_UPDATE": {
        if (this.extContext?.hasUI) {
          this.extContext.ui.notify(
            `📦 [Workhouse] ${frame.owner_name} ${frame.action} resource "${frame.key}"`,
            "info"
          );
        }
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Heartbeat & Watchdog (Failover / Leader Succession)
  // --------------------------------------------------------------------------
  public async heartbeat(): Promise<void> {
    if (this.isShuttingDown) return;
    const now = Date.now();

    try {
      this.db
        .prepare(
          "UPDATE sessions SET last_heartbeat = ?, status = 'active' WHERE id = ?"
        )
        .run(now, this.sessionId);

      if (this.role === "workhouse") {
        this.db
          .prepare(
            "UPDATE locks SET expires_at = ? WHERE name = 'central_workhouse_leader' AND holder_id = ?"
          )
          .run(now + 30000, this.sessionId);
      } else {
        const hubAlive = await this.probeWorkhouseHub();
        if (!hubAlive) {
          await this.tryPromoteToWorkhouse();
        }
      }

      this.reapDeadPeers();
      this.updateStatusBadge();
    } catch {}
  }

  public reapDeadPeers(): void {
    try {
      const now = Date.now();
      const rows = this.db
        .prepare("SELECT * FROM sessions WHERE id != ?")
        .all(this.sessionId) as unknown as SessionRecord[];

      for (const row of rows) {
        const alive = isPidAlive(row.pid);
        const expired = now - row.last_heartbeat > 45000;
        if (!alive || expired) {
          this.db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
          this.db.prepare("DELETE FROM locks WHERE holder_id = ?").run(row.id);
          if (fs.existsSync(row.socket_path)) {
            try {
              fs.unlinkSync(row.socket_path);
            } catch {}
          }
        }
      }

      this.db.prepare("DELETE FROM locks WHERE expires_at < ?").run(now);
      this.db
        .prepare(
          "DELETE FROM resources WHERE expires_at IS NOT NULL AND expires_at < ?"
        )
        .run(now);
    } catch {}
  }

  public updateStatusBadge(): void {
    if (!this.extContext?.hasUI) return;
    try {
      const peers = this.getActivePeers();
      const peerCount = peers.length;
      const unreadStr = this.unreadCount > 0 ? ` (${this.unreadCount} unread)` : "";

      if (this.role === "workhouse") {
        this.extContext.ui.setStatus(
          "workhouse",
          `🏛️ WORKHOUSE (HUB) [${peerCount} worker${peerCount === 1 ? "" : "s"}${unreadStr}]`
        );
      } else {
        const hub = this.getWorkhouseRecord();
        const hubName = hub ? hub.name : "Hub";
        this.extContext.ui.setStatus(
          "workhouse",
          `🏛️ WORKER -> ${hubName} [${peerCount + 1} sessions${unreadStr}]`
        );
      }
    } catch {}
  }

  // --------------------------------------------------------------------------
  // Discovery & Queries
  // --------------------------------------------------------------------------
  public getWorkhouseRecord(): SessionRecord | null {
    this.reapDeadPeers();
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE role = 'workhouse' ORDER BY last_heartbeat DESC LIMIT 1")
      .get() as unknown as SessionRecord | undefined;
    return row || null;
  }

  public getActivePeers(): SessionRecord[] {
    this.reapDeadPeers();
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE id != ? AND status = 'active' ORDER BY role ASC, last_heartbeat DESC"
      )
      .all(this.sessionId) as unknown as SessionRecord[];
  }

  public getAllSessions(): SessionRecord[] {
    this.reapDeadPeers();
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY role ASC, created_at ASC")
      .all() as unknown as SessionRecord[];
  }

  public findPeer(query: string): SessionRecord | null {
    const q = query.trim().toLowerCase();
    const peers = this.getActivePeers();
    const byId = peers.find((p) => p.id.toLowerCase() === q);
    if (byId) return byId;
    const byName = peers.find((p) => p.name.toLowerCase() === q);
    if (byName) return byName;
    const fuzzy = peers.find(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.project.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
    );
    return fuzzy || null;
  }

  public async broadcastFrame(frame: WorkhouseFrame): Promise<number> {
    const peers = this.getActivePeers();
    let count = 0;
    await Promise.allSettled(
      peers.map(async (peer) => {
        const res = await sendFrameToSocket(peer.socket_path, frame, 600);
        if (res.ok) count++;
      })
    );
    return count;
  }

  public async sendFrameToPeer(
    peer: SessionRecord,
    frame: WorkhouseFrame
  ): Promise<{ ok: boolean; response?: WorkhouseFrame; error?: string }> {
    return sendFrameToSocket(peer.socket_path, frame, 1200);
  }

  // --------------------------------------------------------------------------
  // Ping
  // --------------------------------------------------------------------------
  public async pingPeer(
    peer: SessionRecord,
    directive?: string
  ): Promise<{ ok: boolean; latencyMs: number; error?: string; directed?: boolean }> {
    const t0 = performance.now();
    const pingFrame: WorkhouseFrame = {
      type: "PING",
      sender_id: this.sessionId,
      sender_name: this.sessionName,
      timestamp: Date.now(),
      directive,
    };

    const res = await sendFrameToSocket(peer.socket_path, pingFrame, 1500);
    const latencyMs = Number((performance.now() - t0).toFixed(2));

    if (res.ok && res.response?.type === "PONG") {
      return { ok: true, latencyMs, directed: Boolean(directive) };
    }
    return { ok: false, latencyMs, error: res.error || "No pong received" };
  }

  public async pingWorkhouse(): Promise<{
    ok: boolean;
    hub?: SessionRecord;
    latencyMs: number;
    error?: string;
  }> {
    const hub = this.getWorkhouseRecord();
    if (!hub) {
      return { ok: false, latencyMs: 0, error: "No active Workhouse detected" };
    }
    const res = await this.pingPeer(hub);
    return { ...res, hub };
  }

  public async pingAllSessions(): Promise<
    Array<{
      peer: SessionRecord;
      ok: boolean;
      latencyMs: number;
      error?: string;
    }>
  > {
    const peers = this.getActivePeers();
    return Promise.all(
      peers.map(async (peer) => {
        const res = await this.pingPeer(peer);
        return { peer, ...res };
      })
    );
  }

  // --------------------------------------------------------------------------
  // Communicate & Chat
  // --------------------------------------------------------------------------
  public async postMessage(
    channel: string,
    content: string,
    targetId: string | null = null,
    type: "text" | "direct_task" | "help_request" | "alert" = "text"
  ): Promise<MessageRecord> {
    const id = `msg-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const now = Date.now();
    const cleanChannel = channel.startsWith("#") ? channel : `#${channel}`;

    const rec: MessageRecord = {
      id,
      channel: cleanChannel,
      sender_id: this.sessionId,
      sender_name: this.sessionName,
      target_id: targetId,
      content,
      type,
      metadata: null,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, channel, sender_id, sender_name, target_id, content, type, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.channel,
        rec.sender_id,
        rec.sender_name,
        rec.target_id,
        rec.content,
        rec.type,
        rec.metadata,
        rec.created_at
      );

    const frame: WorkhouseFrame = { type: "MESSAGE", message: rec };

    if (targetId) {
      const targetPeer = this.findPeer(targetId);
      if (targetPeer) {
        await this.sendFrameToPeer(targetPeer, frame);
      }
    } else {
      await this.broadcastFrame(frame);
    }

    return rec;
  }

  public getMessages(channelOrPeer?: string, limit = 30): MessageRecord[] {
    if (!channelOrPeer || channelOrPeer.startsWith("#")) {
      const chan = channelOrPeer
        ? channelOrPeer.startsWith("#")
          ? channelOrPeer
          : `#${channelOrPeer}`
        : "#general";
      return this.db
        .prepare(
          "SELECT * FROM messages WHERE channel = ? AND target_id IS NULL ORDER BY created_at DESC LIMIT ?"
        )
        .all(chan, limit) as unknown as MessageRecord[];
    }

    const peer = this.findPeer(channelOrPeer);
    const peerId = peer ? peer.id : channelOrPeer;
    return this.db
      .prepare(
        `SELECT * FROM messages 
        WHERE (sender_id = ? AND target_id = ?) OR (sender_id = ? AND target_id = ?)
        ORDER BY created_at DESC LIMIT ?`
      )
      .all(this.sessionId, peerId, peerId, this.sessionId, limit) as unknown as MessageRecord[];
  }

  public getFeed(limit = 25): MessageRecord[] {
    return this.db
      .prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as MessageRecord[];
  }

  // --------------------------------------------------------------------------
  // Direct Tasks
  // --------------------------------------------------------------------------
  public async directTask(
    targetPeer: SessionRecord,
    title: string,
    instruction: string,
    priority = "normal"
  ): Promise<TaskRecord> {
    const taskId = `task-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const now = Date.now();

    const task: TaskRecord = {
      id: taskId,
      from_session_id: this.sessionId,
      from_session_name: this.sessionName,
      to_session_id: targetPeer.id,
      title,
      description: instruction,
      status: "pending",
      result: null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO tasks (id, from_session_id, from_session_name, to_session_id, title, description, status, result, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`
      )
      .run(
        task.id,
        task.from_session_id,
        task.from_session_name,
        task.to_session_id,
        task.title,
        task.description,
        now,
        now
      );

    await this.postMessage(
      "#tasks",
      `🎯 [Direct Task] ${this.sessionName} -> ${targetPeer.name}: "${title}"`,
      null,
      "direct_task"
    );

    const frame: WorkhouseFrame = {
      type: "DIRECT_TASK",
      from_session_id: this.sessionId,
      from_session_name: this.sessionName,
      to_session_id: targetPeer.id,
      taskId,
      title,
      instruction,
      priority,
    };

    await this.sendFrameToPeer(targetPeer, frame);
    return task;
  }

  public updateTaskStatus(
    taskId: string,
    status: "in_progress" | "completed" | "failed",
    result?: string
  ): boolean {
    const now = Date.now();
    const res = this.db
      .prepare(
        "UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?"
      )
      .run(status, result || null, now, taskId);

    if (res.changes > 0) {
      this.broadcastFrame({
        type: "TASK_UPDATE",
        taskId,
        status,
        result,
        from_session_name: this.sessionName,
      }).catch(() => {});
      return true;
    }
    return false;
  }

  public listTasks(statusFilter?: string): TaskRecord[] {
    if (statusFilter) {
      return this.db
        .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC")
        .all(statusFilter) as unknown as TaskRecord[];
    }
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50")
      .all() as unknown as TaskRecord[];
  }

  public async requestHelp(question: string): Promise<MessageRecord> {
    return this.postMessage(
      "#help",
      `🚨 [HELP REQUEST] ${question}`,
      null,
      "help_request"
    );
  }

  // --------------------------------------------------------------------------
  // Artifacts Delegation
  // --------------------------------------------------------------------------
  public shareArtifact(sourcePath: string, name?: string, description?: string): ArtifactRecord {
    const record = this.artifacts.share(sourcePath, this.sessionId, this.sessionName, this.cwd, name, description);
    this.broadcastFrame({
      type: "ARTIFACT_SHARED",
      artifact: record,
    }).catch(() => {});
    return record;
  }

  public fetchArtifact(nameOrId: string, destPath?: string) {
    return this.artifacts.fetch(nameOrId, this.cwd, destPath);
  }

  public listArtifacts(): ArtifactRecord[] {
    return this.artifacts.list();
  }

  public getArtifact(nameOrId: string): ArtifactRecord | null {
    return this.artifacts.get(nameOrId);
  }

  // --------------------------------------------------------------------------
  // KV Resources & Mutex Locks
  // --------------------------------------------------------------------------
  public setResource(
    key: string,
    value: string,
    type: "kv" | "json" = "kv",
    description: string | null = null,
    tags: string | null = null,
    ttlSeconds?: number
  ): ResourceRecord {
    const now = Date.now();
    const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO resources (key, owner_id, owner_name, type, value, description, tags, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        key,
        this.sessionId,
        this.sessionName,
        type,
        value,
        description,
        tags,
        now,
        expiresAt
      );

    const rec: ResourceRecord = {
      key,
      owner_id: this.sessionId,
      owner_name: this.sessionName,
      type,
      value,
      description,
      tags,
      updated_at: now,
      expires_at: expiresAt,
    };

    this.broadcastFrame({
      type: "RESOURCE_UPDATE",
      key,
      owner_name: this.sessionName,
      action: "set",
    }).catch(() => {});

    return rec;
  }

  public getResource(key: string): ResourceRecord | null {
    this.reapDeadPeers();
    const row = this.db
      .prepare("SELECT * FROM resources WHERE key = ?")
      .get(key) as unknown as ResourceRecord | undefined;
    return row || null;
  }

  public listResources(tagFilter?: string): ResourceRecord[] {
    this.reapDeadPeers();
    const rows = this.db
      .prepare("SELECT * FROM resources ORDER BY updated_at DESC")
      .all() as unknown as ResourceRecord[];
    if (!tagFilter) return rows;
    const filter = tagFilter.toLowerCase();
    return rows.filter(
      (r) =>
        r.tags?.toLowerCase().includes(filter) ||
        r.key.toLowerCase().includes(filter)
    );
  }

  public deleteResource(key: string): boolean {
    const res = this.db.prepare("DELETE FROM resources WHERE key = ?").run(key);
    const deleted = res.changes > 0;
    if (deleted) {
      this.broadcastFrame({
        type: "RESOURCE_UPDATE",
        key,
        owner_name: this.sessionName,
        action: "delete",
      }).catch(() => {});
    }
    return deleted;
  }

  public acquireLock(
    lockName: string,
    ttlSeconds = 60
  ): { ok: boolean; holder: string; remainingSec?: number } {
    this.reapDeadPeers();
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    const existing = this.db
      .prepare("SELECT * FROM locks WHERE name = ?")
      .get(lockName) as unknown as LockRecord | undefined;

    if (existing && existing.expires_at > now) {
      if (existing.holder_id === this.sessionId) {
        this.db
          .prepare("UPDATE locks SET expires_at = ? WHERE name = ?")
          .run(expiresAt, lockName);
        return { ok: true, holder: this.sessionName, remainingSec: ttlSeconds };
      }
      const rem = Math.ceil((existing.expires_at - now) / 1000);
      return { ok: false, holder: existing.holder_name, remainingSec: rem };
    }

    this.db
      .prepare(
        "INSERT OR REPLACE INTO locks (name, holder_id, holder_name, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(lockName, this.sessionId, this.sessionName, now, expiresAt);

    return { ok: true, holder: this.sessionName, remainingSec: ttlSeconds };
  }

  public releaseLock(lockName: string): boolean {
    const existing = this.db
      .prepare("SELECT * FROM locks WHERE name = ?")
      .get(lockName) as unknown as LockRecord | undefined;
    if (!existing) return true;

    if (existing.holder_id !== this.sessionId) {
      return false;
    }

    this.db.prepare("DELETE FROM locks WHERE name = ?").run(lockName);
    return true;
  }

  public listLocks(): LockRecord[] {
    this.reapDeadPeers();
    const now = Date.now();
    return this.db
      .prepare("SELECT * FROM locks WHERE expires_at > ? ORDER BY acquired_at ASC")
      .all(now) as unknown as LockRecord[];
  }

  // --------------------------------------------------------------------------
  // Shutdown
  // --------------------------------------------------------------------------
  public stop(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    try {
      this.db.prepare("DELETE FROM locks WHERE holder_id = ?").run(this.sessionId);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(this.sessionId);
    } catch {}

    try {
      this.broadcastFrame({
        type: "WORKER_LEFT",
        session_id: this.sessionId,
      });
    } catch {}

    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }

    if (this.hubServer) {
      try {
        this.hubServer.close();
      } catch {}
      this.hubServer = null;
    }

    if (fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }

    if (this.role === "workhouse" && fs.existsSync(WORKHOUSE_HUB_SOCK)) {
      try {
        fs.unlinkSync(WORKHOUSE_HUB_SOCK);
      } catch {}
    }
  }

  public rename(newName: string): void {
    const clean = newName.trim();
    if (!clean) return;
    this.sessionName = clean;
    this.db
      .prepare("UPDATE sessions SET name = ? WHERE id = ?")
      .run(this.sessionName, this.sessionId);
    this.updateStatusBadge();
  }
}

let globalWorkhouseEngine: WorkhouseEngine | null = null;

export function getWorkhouseEngine(): WorkhouseEngine {
  if (!globalWorkhouseEngine) {
    globalWorkhouseEngine = new WorkhouseEngine();
  }
  return globalWorkhouseEngine;
}
