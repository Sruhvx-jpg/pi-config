/**
 * pi-workhouse: Modular HTTP Cockpit Server
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  WORKHOUSE_DB_PATH,
  WORKHOUSE_HUB_SOCK,
  WORKHOUSE_UI_PID_PATH,
  getWorkhouseDb,
} from "../db.ts";
import { sendFrameToSocket } from "../ipc.ts";
import type { WorkhouseFrame } from "../types.ts";

export const DEFAULT_PORT = 3000;
const WEB_DIR = path.dirname(new URL(import.meta.url).pathname);

export function getClusterState(db: DatabaseSync) {
  try {
    const sessions = db.prepare("SELECT * FROM sessions ORDER BY role ASC, created_at ASC").all();
    const messages = db.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 100").all();
    const artifacts = db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all();
    const tasks = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50").all();
    const locks = db.prepare("SELECT * FROM locks ORDER BY acquired_at ASC").all();
    const hub = sessions.find((s: any) => s.role === "workhouse") || null;

    return {
      ok: true,
      timestamp: Date.now(),
      hub,
      sessions,
      messages: messages.reverse(),
      artifacts,
      tasks,
      locks,
    };
  } catch (err: any) {
    return { ok: false, error: err.message, sessions: [], messages: [], artifacts: [], tasks: [], locks: [] };
  }
}

export function createWebServer(port = DEFAULT_PORT) {
  const db = getWorkhouseDb();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/") {
      const htmlPath = path.join(WEB_DIR, "index.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }

    if (url.pathname === "/styles.css") {
      const cssPath = path.join(WEB_DIR, "styles.css");
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      fs.createReadStream(cssPath).pipe(res);
      return;
    }

    if (url.pathname === "/app.js") {
      const jsPath = path.join(WEB_DIR, "app.js");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      fs.createReadStream(jsPath).pipe(res);
      return;
    }

    if (url.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getClusterState(db)));
      return;
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          const channel = data.channel || "#general";
          const content = data.message || "";
          const id = "web-" + Date.now();
          const now = Date.now();

          db.prepare(
            "INSERT INTO messages (id, channel, sender_id, sender_name, content, type, created_at) VALUES (?, ?, 'workhouse-ui', 'operator', ?, 'text', ?)"
          ).run(id, channel, content, now);

          // Dispatch frame to central Workhouse socket
          const frame: WorkhouseFrame = {
            type: "MESSAGE",
            message: {
              id,
              channel,
              sender_id: "workhouse-ui",
              sender_name: "operator",
              target_id: null,
              content,
              type: "text",
              metadata: null,
              created_at: now,
            },
          };
          sendFrameToSocket(WORKHOUSE_HUB_SOCK, frame, 400).catch(() => {});

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, id }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (url.pathname.startsWith("/api/artifacts/")) {
      const artName = decodeURIComponent(url.pathname.slice("/api/artifacts/".length));
      const art = db.prepare("SELECT * FROM artifacts WHERE name = ?").get(artName) as any;
      if (!art || !fs.existsSync(art.storage_path)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Artifact not found");
        return;
      }

      const stat = fs.statSync(art.storage_path);
      res.writeHead(200, {
        "Content-Type": art.mime_type || "application/octet-stream",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${path.basename(art.name)}"`,
      });
      fs.createReadStream(art.storage_path).pipe(res);
      return;
    }

    if ((url.pathname === "/api/shutdown" || url.pathname === "/api/close") && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Workhouse cockpit shutting down" }));
      setTimeout(() => {
        try {
          if (fs.existsSync(WORKHOUSE_UI_PID_PATH)) {
            fs.unlinkSync(WORKHOUSE_UI_PID_PATH);
          }
        } catch {}
        server.close();
        if (process.argv[1]?.includes("workhouse") || process.argv[1]?.includes("cli.ts") || process.argv[1]?.includes("server.ts")) {
          process.exit(0);
        }
      }, 100);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return {
    server,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.listen(port, "0.0.0.0", () => {
          try {
            fs.writeFileSync(WORKHOUSE_UI_PID_PATH, String(process.pid), "utf-8");
          } catch {}
          console.log(`◈ PI WORKHOUSE COCKPIT ACTIVE ON PORT ${port}`);
          console.log(`  http://localhost:${port}`);
          resolve();
        });
        server.on("error", reject);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        try {
          if (fs.existsSync(WORKHOUSE_UI_PID_PATH)) {
            fs.unlinkSync(WORKHOUSE_UI_PID_PATH);
          }
        } catch {}
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

export async function stopWorkhouseUi(port = DEFAULT_PORT): Promise<{ ok: boolean; pid?: number; message: string }> {
  let pid: number | null = null;
  if (fs.existsSync(WORKHOUSE_UI_PID_PATH)) {
    try {
      const content = fs.readFileSync(WORKHOUSE_UI_PID_PATH, "utf-8").trim();
      pid = parseInt(content, 10);
    } catch {}
  }

  if (pid && !isNaN(pid)) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGTERM");
      try {
        if (fs.existsSync(WORKHOUSE_UI_PID_PATH)) fs.unlinkSync(WORKHOUSE_UI_PID_PATH);
      } catch {}
      return { ok: true, pid, message: `Stopped Workhouse Web UI (PID ${pid})` };
    } catch {}
  }

  try {
    const res = await fetch(`http://localhost:${port}/api/shutdown`, { method: "POST" });
    if (res.ok) {
      return { ok: true, message: `Workhouse Web UI on port ${port} shut down successfully` };
    }
  } catch {}

  try {
    if (fs.existsSync(WORKHOUSE_UI_PID_PATH)) fs.unlinkSync(WORKHOUSE_UI_PID_PATH);
  } catch {}

  return { ok: false, message: `No active Workhouse UI server found running on port ${port}` };
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const instance = createWebServer(DEFAULT_PORT);
  instance.listen().catch(console.error);
}
