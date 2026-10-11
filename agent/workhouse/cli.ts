/**
 * pi-workhouse: Standalone CLI Terminal Interface
 */

import { getWorkhouseDb, WORKHOUSE_HUB_SOCK } from "./db.ts";
import { sendFrameToSocket } from "./ipc.ts";
import { ArtifactDepot } from "./artifacts.ts";
import { C, formatBytes, formatLatency } from "./types.ts";
import { createWebServer, DEFAULT_PORT } from "./web/server.ts";

const args = process.argv.slice(2);
const cmd = args[0]?.toLowerCase() || "status";

async function main() {
  const db = getWorkhouseDb();
  const artifacts = new ArtifactDepot(db);

  switch (cmd) {
    case "status":
    case "peers": {
      const sessions = db.prepare("SELECT * FROM sessions ORDER BY role ASC, created_at ASC").all() as any[];
      console.log(`\n${C.boldCyan}🏛️  PI WORKHOUSE CLUSTER (${sessions.length} sessions):${C.reset}`);
      if (sessions.length === 0) {
        console.log(` ${C.dim}No active sessions. Start Pi to auto-connect.${C.reset}\n`);
        return;
      }
      for (const s of sessions) {
        const role = s.role === "workhouse" ? `${C.boldGreen}[WORKHOUSE HUB]${C.reset}` : `${C.purple}[WORKER]${C.reset}       `;
        console.log(` ● ${role} ${C.boldCyan}${s.name.padEnd(20)}${C.reset} (PID ${s.pid}) -> ${s.project} [${s.git_branch || "no-git"}] @ ${s.cwd}`);
      }
      console.log("");
      break;
    }

    case "ping": {
      const target = args[1];
      if (target) {
        const row = db.prepare("SELECT * FROM sessions WHERE name = ? OR id = ?").get(target, target) as any;
        if (!row) {
          console.error(`Session not found: ${target}`);
          process.exit(1);
        }
        const t0 = performance.now();
        const res = await sendFrameToSocket(row.socket_path, { type: "PING", sender_id: "cli", sender_name: "cli", timestamp: Date.now() });
        const lat = (performance.now() - t0).toFixed(2);
        if (res.ok) {
          console.log(`⚡ PING ${row.name} [${row.role}]: ${C.boldGreen}${lat}ms${C.reset} (PONG from PID ${row.pid})`);
        } else {
          console.log(`✖ PING ${row.name} failed: ${res.error}`);
        }
      } else {
        const t0 = performance.now();
        const res = await sendFrameToSocket(WORKHOUSE_HUB_SOCK, { type: "PING", sender_id: "cli", sender_name: "cli", timestamp: Date.now() });
        const lat = (performance.now() - t0).toFixed(2);
        if (res.ok) {
          console.log(`⚡ PING Central Workhouse: ${C.boldGreen}${lat}ms${C.reset} (PONG from PID ${(res.response as any)?.pid})`);
        } else {
          console.log(`✖ Central Workhouse unreachable: ${res.error}`);
        }
      }
      break;
    }

    case "chat": {
      const msg = args.slice(1).join(" ");
      if (!msg) {
        console.error("Usage: pi-workhouse chat <message>");
        process.exit(1);
      }
      const id = `cli-${Date.now()}`;
      const now = Date.now();
      db.prepare("INSERT INTO messages (id, channel, sender_id, sender_name, content, type, created_at) VALUES (?, '#general', 'cli', 'operator', ?, 'text', ?)")
        .run(id, msg, now);
      sendFrameToSocket(WORKHOUSE_HUB_SOCK, {
        type: "MESSAGE",
        message: { id, channel: "#general", sender_id: "cli", sender_name: "operator", target_id: null, content: msg, type: "text", metadata: null, created_at: now }
      }).catch(() => {});
      console.log(`💬 Broadcasted to #general: "${msg}"`);
      break;
    }

    case "artifacts": {
      const list = artifacts.list();
      console.log(`\n${C.boldYellow}📦 Shared Workhouse Artifacts (${list.length}):${C.reset}`);
      if (list.length === 0) {
        console.log(` ${C.dim}No artifacts shared yet. Use pi-workhouse share <path>${C.reset}\n`);
        return;
      }
      for (const a of list) {
        console.log(` ● ${C.boldCyan}${a.name.padEnd(24)}${C.reset} ${C.green}${formatBytes(a.size_bytes).padEnd(9)}${C.reset} sha256:${a.sha256.slice(0, 10)}... (owner: ${a.owner_name})`);
      }
      console.log("");
      break;
    }

    case "share": {
      const file = args[1];
      const alias = args[2];
      const desc = args.slice(3).join(" ") || undefined;
      if (!file) {
        console.error("Usage: pi-workhouse share <file_path> [alias] [description]");
        process.exit(1);
      }
      const rec = artifacts.share(file, "cli", "operator", process.cwd(), alias, desc);
      console.log(`📦 Shared artifact "${rec.name}" (${formatBytes(rec.size_bytes)}) to Workhouse depot!`);
      break;
    }

    case "fetch": {
      const name = args[1];
      const dest = args[2];
      if (!name) {
        console.error("Usage: pi-workhouse fetch <artifact_name> [dest_path]");
        process.exit(1);
      }
      const res = artifacts.fetch(name, process.cwd(), dest);
      console.log(`📥 Fetched artifact "${res.originalName}" (${formatBytes(res.bytesWritten)}) to: ${res.targetPath}`);
      break;
    }

    case "tasks": {
      const tasks = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50").all() as any[];
      console.log(`\n${C.boldYellow}🎯 Workhouse Tasks (${tasks.length}):${C.reset}`);
      for (const t of tasks) {
        console.log(` ● [${t.status.toUpperCase()}] ${C.boldCyan}${t.title}${C.reset} (${t.from_session_name} -> ${t.to_session_id})`);
      }
      console.log("");
      break;
    }

    case "ui": {
      const port = args[1] ? parseInt(args[1], 10) : DEFAULT_PORT;
      const web = createWebServer(port);
      await web.listen();
      break;
    }

    default: {
      console.log("Usage: pi-workhouse [status|peers|ping|chat|artifacts|share|fetch|tasks|ui]");
      break;
    }
  }
}

main().catch(console.error);
