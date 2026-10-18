# Case 11: LLM Tool-Call Cryptographic Signatures & HTTP Premature Abort Hazards

## Context & Incidents
Observed in AI agent harness streaming implementations, multi-turn LLM agent loops, and Node.js SSE servers (Google Antigravity Code Assist, Gemini 3.x, Express.js).

---

## 1. Premature Streaming Abort via `req.on("close")`

### The Anti-Pattern
```typescript
// BAD: Listening to `req.on("close")` in an HTTP POST streaming handler
const abortController = new AbortController();

req.on("close", () => {
  if (!res.writableEnded) {
    abortController.abort(); // BUG: Aborts immediately within 1ms!
  }
});

await engine.run({ prompt, signal: abortController.signal });
```

### Why It Breaks
In Node.js `http.IncomingMessage`, the `"close"` event on `req` is emitted as soon as the client finishes uploading its request body stream (e.g. the JSON POST payload).
When `req.on("close")` fires:
1. `res.writableEnded` is still `false` because the response has just begun.
2. `abortController.abort()` is invoked immediately on every single valid request.
3. The underlying agent loop cancels execution before the first LLM token or tool call can settle, leading to blank or stalled responses.

### The Correct Pattern
```typescript
// GOOD: Monitor the response stream lifecycle or socket drop
const abortController = new AbortController();

res.on("close", () => {
  // Only abort if the client dropped the connection before the response finished
  if (!res.writableFinished) {
    abortController.abort();
  }
});

await engine.run({ prompt, signal: abortController.signal });
```

---

## 2. Dropping Provider Tool-Call Cryptographic Signatures (`thoughtSignature`)

### The Anti-Pattern
```typescript
// BAD: Stripping metadata when saving assistant tool calls to transcript
for (const part of candidate.content.parts) {
  if (part.functionCall) {
    messages.push({
      role: "assistant",
      content: [{
        type: "toolCall",
        name: part.functionCall.name,
        arguments: part.functionCall.args,
        // BUG: Dropped part.thoughtSignature!
      }],
    });
  }
}

// On Turn 2, functionCall is re-sent without thoughtSignature:
// -> Google API fails with HTTP 400: "Function call is missing a thought_signature"
```

### Why It Breaks
Advanced reasoning models (such as Google Gemini 3.x / Antigravity Code Assist) embed a cryptographic `thoughtSignature` inside each `functionCall` part during tool generation.
When the tool finishes and the agent loop submits Turn 2 (assistant `functionCall` + user `functionResponse`):
1. The provider verifies that the model's tool invocation matches the exact signature minted during reasoning.
2. If the signature was dropped from the transcript, the provider rejects the continuation turn with `HTTP 400: Function call is missing a thought_signature in functionCall parts`.
3. The agent executes the tool, but the next synthesis turn is rejected, leaving the conversation permanently stalled.

### The Correct Pattern
```typescript
// GOOD: Preserve thoughtSignature and id across transcript turns
for (const part of candidate.content.parts) {
  if (part.functionCall) {
    messages.push({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: part.functionCall.id || generateId(),
        name: part.functionCall.name,
        arguments: part.functionCall.args,
        thoughtSignature: part.thoughtSignature, // PRESERVED
      }],
    });
  }
}

// When formatting contents for Turn 2:
parts.push({
  functionCall: {
    name: block.name,
    args: block.arguments,
    ...(block.id ? { id: block.id } : {}),
  },
  ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
});
```

---

## 3. Strict Gemini Role Alternation & Turn Merging

### The Anti-Pattern
```typescript
// BAD: Emitting consecutive turns with the same role
contents.push({ role: "user", parts: [{ functionResponse: { name: "toolA", ... } }] });
contents.push({ role: "user", parts: [{ functionResponse: { name: "toolB", ... } }] });
// -> Provider rejects with HTTP 400 (Consecutive User Turns)
```

### The Correct Pattern
```typescript
// GOOD: Merge consecutive turns with identical roles
function mergeConsecutiveTurns(contents: Array<{ role: "user" | "model"; parts: any[] }>) {
  const merged: Array<{ role: "user" | "model"; parts: any[] }> = [];
  for (const turn of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.parts.push(...turn.parts);
    } else {
      merged.push({ role: turn.role, parts: [...turn.parts] });
    }
  }
  return merged;
}
```
