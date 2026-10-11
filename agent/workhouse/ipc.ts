/**
 * pi-workhouse: Unix Domain Socket IPC & Process Health Transport
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as cp from "node:child_process";
import type { WorkhouseFrame } from "./types.ts";

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

export function detectGitBranch(dir: string): string | null {
  try {
    const out = cp.execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function sendFrameToSocket(
  socketPath: string,
  frame: WorkhouseFrame,
  timeoutMs = 800
): Promise<{ ok: boolean; response?: WorkhouseFrame; error?: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      return resolve({ ok: false, error: "Socket file does not exist" });
    }

    const client = net.createConnection({ path: socketPath });
    let resolved = false;
    let buffer = "";

    const finish = (result: {
      ok: boolean;
      response?: WorkhouseFrame;
      error?: string;
    }) => {
      if (resolved) return;
      resolved = true;
      try {
        client.destroy();
      } catch {}
      resolve(result);
    };

    client.setTimeout(timeoutMs, () => {
      finish({ ok: false, error: "Timeout waiting for peer response" });
    });

    client.on("connect", () => {
      try {
        client.write(JSON.stringify(frame) + "\n");
        // One-way notification frames do not block on responses
        if (
          frame.type === "WORKER_JOINED" ||
          frame.type === "WORKER_LEFT" ||
          frame.type === "WORKHOUSE_ELECTED" ||
          frame.type === "ARTIFACT_SHARED" ||
          frame.type === "RESOURCE_UPDATE"
        ) {
          finish({ ok: true });
        }
      } catch (err: any) {
        finish({ ok: false, error: err.message });
      }
    });

    client.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        try {
          const resp = JSON.parse(line) as WorkhouseFrame;
          finish({ ok: true, response: resp });
        } catch {
          finish({ ok: false, error: "Invalid JSON response" });
        }
      }
    });

    client.on("error", (err: any) => {
      finish({ ok: false, error: err.code || err.message });
    });

    client.on("end", () => {
      if (!resolved) {
        finish({ ok: true });
      }
    });
  });
}
