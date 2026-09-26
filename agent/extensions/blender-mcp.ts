/**
 * Blender MCP Extension for Pi
 *
 * Direct live bridge to Blender via TCP socket (127.0.0.1:9876).
 * Allows executing arbitrary bpy scripts, inspecting scene trees, and grabbing viewport captures.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9876;

interface BlenderResponse {
  status: "success" | "error";
  result?: any;
  message?: string;
  traceback?: string;
}

/**
 * Send JSON command to Blender socket and await response.
 */
function sendBlenderCommand(
  command: Record<string, any>,
  timeoutMs = 15000,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT
): Promise<BlenderResponse> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let responseData = "";
    let isSettled = false;

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        client.destroy();
        reject(new Error(`Timeout waiting for Blender response (${timeoutMs}ms). Is Blender MCP server running?`));
      }
    }, timeoutMs);

    client.connect(port, host, () => {
      client.write(JSON.stringify(command));
    });

    client.on("data", (chunk) => {
      responseData += chunk.toString("utf-8");
      try {
        const parsed = JSON.parse(responseData);
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          client.end();
          resolve(parsed);
        }
      } catch {
        // Chunked JSON data, keep buffering
      }
    });

    client.on("error", (err: any) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        if (err.code === "ECONNREFUSED") {
          reject(
            new Error(
              `Cannot connect to Blender on ${host}:${port}. Make sure Blender is running and 'Start MCP Server' was clicked in the sidebar (N).`
            )
          );
        } else {
          reject(err);
        }
      }
    });

    client.on("close", () => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        if (responseData.trim()) {
          try {
            resolve(JSON.parse(responseData));
          } catch {
            reject(new Error(`Incomplete JSON response from Blender: ${responseData}`));
          }
        } else {
          reject(new Error("Blender closed connection without sending a response."));
        }
      }
    });
  });
}

export default function (pi: ExtensionAPI) {
  // 1. Tool: Execute Python Code in Blender
  pi.registerTool({
    name: "blender_exec",
    description: "Execute Python (bpy) code inside the running Blender session in real-time.",
    parameters: Type.Object({
      code: Type.String({
        description: "Python code to execute inside Blender (bpy).",
      }),
    }),
    async execute(_id, params) {
      try {
        const res = await sendBlenderCommand({
          type: "execute_code",
          params: { code: params.code },
        }, 60000);

        if (res.status === "error") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Blender Error: ${res.message || "Unknown error"}\n\n${res.traceback || ""}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: typeof res.result === "string" ? res.result : JSON.stringify(res.result ?? res, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Blender Connection Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  });

  // 2. Tool: Get Scene Info
  pi.registerTool({
    name: "blender_get_scene",
    description: "Inspect the current active Blender scene: objects, collections, materials, cameras, lights.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const res = await sendBlenderCommand({
          type: "get_scene_info",
          params: {},
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(res.result ?? res, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Blender Connection Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  });

  // 3. Tool: Viewport Screenshot
  pi.registerTool({
    name: "blender_screenshot",
    description: "Capture a screenshot of the active Blender 3D viewport.",
    parameters: Type.Object({
      max_size: Type.Optional(Type.Number({ description: "Max dimension in pixels (default: 800)" })),
    }),
    async execute(_id, params) {
      try {
        const res = await sendBlenderCommand({
          type: "get_viewport_screenshot",
          params: { max_size: params.max_size || 800 },
        });

        if (res.status === "error") {
          return {
            content: [{ type: "text" as const, text: `Screenshot failed: ${res.message}` }],
            isError: true,
          };
        }

        const outPath = res.result?.filepath || res.result?.path || res.result;
        return {
          content: [
            {
              type: "text" as const,
              text: `Viewport screenshot captured: ${typeof outPath === "string" ? outPath : JSON.stringify(outPath)}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Blender Connection Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  });

  // 4. Command: /blender status/ping
  pi.registerCommand("blender", {
    description: "Manage Blender MCP bridge connection",
    handler: async (subcmd: string, ctx: ExtensionContext) => {
      const cmd = (subcmd || "status").trim().toLowerCase();
      if (cmd === "ping" || cmd === "status") {
        try {
          const res = await sendBlenderCommand({ type: "get_scene_info", params: {} }, 3000);
          ctx.ui.notify("Blender MCP Connected! Scene query successful.", "info");
        } catch (err: any) {
          ctx.ui.notify(`Blender MCP Offline: ${err.message}`, "error");
        }
      } else {
        ctx.ui.notify("Usage: /blender [status|ping]", "warning");
      }
    },
  });
}
