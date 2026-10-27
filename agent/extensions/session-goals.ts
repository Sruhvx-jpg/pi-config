/**
 * Session Goals Extension for Pi
 *
 * A minimal tool for the assistant to keep track of session goals:
 * - KV Store: K is done or not ("not_done" | "done"), V is the goal.
 * - Strictly tied to the session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

let nextId = 1;
const store = {
  not_done: [] as { id: number; goal: string }[],
  done: [] as { id: number; goal: string }[],
};

function reset(): void {
  store.not_done = [];
  store.done = [];
  nextId = 1;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => reset());
  pi.on("session_shutdown", async () => reset());

  pi.registerTool({
    name: "goals",
    label: "Goals",
    description: "Track session goals. KV store where key is 'not_done' | 'done' and value is the goal.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"),
        Type.Literal("mark_done"),
        Type.Literal("mark_not_done"),
        Type.Literal("list"),
        Type.Literal("remove"),
      ]),
      goal: Type.Optional(Type.String({ description: "The goal text" })),
      id: Type.Optional(Type.Number({ description: "Goal ID to update or remove" })),
    }),

    async execute(_toolCallId, params) {
      switch (params.action) {
        case "add": {
          if (!params.goal) {
            return { content: [{ type: "text", text: "Error: goal text required" }] };
          }
          const item = { id: nextId++, goal: params.goal.trim() };
          store.not_done.push(item);
          return {
            content: [{ type: "text", text: `Tracked goal #${item.id} in [not_done]: "${item.goal}"` }],
            details: { ...store },
          };
        }

        case "mark_done": {
          if (params.id === undefined) {
            return { content: [{ type: "text", text: "Error: goal id required" }] };
          }
          const idx = store.not_done.findIndex((g) => g.id === params.id);
          if (idx === -1) {
            return { content: [{ type: "text", text: `Goal #${params.id} not found in [not_done]` }] };
          }
          const [item] = store.not_done.splice(idx, 1);
          store.done.push(item);
          return {
            content: [{ type: "text", text: `Moved goal #${item.id} to [done]: "${item.goal}"` }],
            details: { ...store },
          };
        }

        case "mark_not_done": {
          if (params.id === undefined) {
            return { content: [{ type: "text", text: "Error: goal id required" }] };
          }
          const idx = store.done.findIndex((g) => g.id === params.id);
          if (idx === -1) {
            return { content: [{ type: "text", text: `Goal #${params.id} not found in [done]` }] };
          }
          const [item] = store.done.splice(idx, 1);
          store.not_done.push(item);
          return {
            content: [{ type: "text", text: `Moved goal #${item.id} back to [not_done]: "${item.goal}"` }],
            details: { ...store },
          };
        }

        case "remove": {
          if (params.id === undefined) {
            return { content: [{ type: "text", text: "Error: goal id required" }] };
          }
          for (const key of ["not_done", "done"] as const) {
            const idx = store[key].findIndex((g) => g.id === params.id);
            if (idx !== -1) {
              const [item] = store[key].splice(idx, 1);
              return {
                content: [{ type: "text", text: `Removed goal #${item.id}: "${item.goal}"` }],
                details: { ...store },
              };
            }
          }
          return { content: [{ type: "text", text: `Goal #${params.id} not found` }] };
        }

        case "list":
        default: {
          const lines = [
            `Session Goals:`,
            `  not_done: ${store.not_done.length ? store.not_done.map((g) => `#${g.id} "${g.goal}"`).join(", ") : "(empty)"}`,
            `  done:     ${store.done.length ? store.done.map((g) => `#${g.id} "${g.goal}"`).join(", ") : "(empty)"}`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { ...store },
          };
        }
      }
    },
  });
}
