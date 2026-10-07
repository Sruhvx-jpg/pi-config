/**
 * embedding-gemma Extension for Pi
 *
 * Local high-speed vector embeddings and semantic search powered by Google's EmbeddingGemma
 * via Ollama (768-dimensional shared vector space, 8K context, MRL truncation).
 *
 * Tools:
 * - `embed_text`: Generate 768-dim embeddings for strings or lists with Matryoshka truncation.
 * - `semantic_similarity`: Calculate cosine similarity and rank texts against a query.
 *
 * Command:
 * - `/embed <text>` | `/embed compare <text1> vs <text2>` | `/embed status`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.EMBEDDING_MODEL || "embeddinggemma";

// ============================================================================
// Math & Vector Utilities (Zero-Dependency)
// ============================================================================

function l2Norm(vec: number[]): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

function normalizeL2(vec: number[]): number[] {
  const norm = l2Norm(vec);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function applyMRLTruncation(vec: number[], targetDim?: number): number[] {
  if (!targetDim || targetDim >= vec.length) return vec;
  return normalizeL2(vec.slice(0, targetDim));
}

// ============================================================================
// Ollama Client
// ============================================================================

async function fetchEmbeddings(input: string | string[], model = DEFAULT_MODEL): Promise<number[][]> {
  const resp = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Ollama API error (${resp.status}): ${errorText}`);
  }

  const data = (await resp.json()) as { embeddings: number[][] };
  if (!data.embeddings || data.embeddings.length === 0) {
    throw new Error("Ollama returned empty embeddings response");
  }
  return data.embeddings;
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 1. Tool: embed_text
  pi.registerTool({
    name: "embed_text",
    label: "embed_text",
    description:
      "Generate 768-dimensional vector embeddings for text using Google's local EmbeddingGemma model with optional MRL dimension truncation (512, 256, 128).",
    parameters: Type.Object({
      input: Type.Union([
        Type.String({ description: "Single text string to embed" }),
        Type.Array(Type.String(), { description: "Array of text strings to embed in batch" }),
      ]),
      truncate_dimensions: Type.Optional(
        Type.Number({
          description: "Optional Matryoshka truncation dimension (e.g. 512, 256, 128). Default: 768 (full)",
        })
      ),
      return_full_vectors: Type.Optional(
        Type.Boolean({
          description: "Whether to return the complete raw float array in response (default: false to conserve context)",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const inputs = Array.isArray(params.input) ? params.input : [params.input];
      const startTime = Date.now();
      const rawEmbeddings = await fetchEmbeddings(inputs);
      const elapsedMs = Date.now() - startTime;

      const processed = rawEmbeddings.map((vec) =>
        applyMRLTruncation(vec, params.truncate_dimensions)
      );

      const resultPayload = {
        model: DEFAULT_MODEL,
        totalItems: processed.length,
        dimensions: processed[0].length,
        truncated: Boolean(params.truncate_dimensions && params.truncate_dimensions < rawEmbeddings[0].length),
        elapsedMs,
        items: processed.map((vec, idx) => ({
          index: idx,
          textSnippet: inputs[idx].length > 80 ? `${inputs[idx].slice(0, 80)}...` : inputs[idx],
          l2Norm: parseFloat(l2Norm(vec).toFixed(4)),
          sample: vec.slice(0, 5).map((v) => parseFloat(v.toFixed(5))),
          vector: params.return_full_vectors ? vec : undefined,
        })),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(resultPayload, null, 2),
          },
        ],
        details: { count: processed.length, dimensions: processed[0].length },
      };
    },
  });

  // 2. Tool: semantic_similarity
  pi.registerTool({
    name: "semantic_similarity",
    label: "semantic_similarity",
    description:
      "Compute semantic cosine similarity scores between text queries and target candidates using local EmbeddingGemma.",
    parameters: Type.Object({
      query: Type.String({ description: "The baseline query text" }),
      targets: Type.Array(Type.String(), { description: "Array of candidate texts to rank against the query" }),
      top_k: Type.Optional(Type.Number({ description: "Number of top results to return (default: all)" })),
    }),
    async execute(_toolCallId, params) {
      const allTexts = [params.query, ...params.targets];
      const startTime = Date.now();
      const embeddings = await fetchEmbeddings(allTexts);
      const elapsedMs = Date.now() - startTime;

      const queryVec = embeddings[0];
      const targetVecs = embeddings.slice(1);

      const scored = targetVecs.map((vec, idx) => {
        const score = cosineSimilarity(queryVec, vec);
        return {
          target: params.targets[idx],
          similarity: parseFloat(score.toFixed(4)),
          matchPercentage: `${(Math.max(0, score) * 100).toFixed(1)}%`,
        };
      });

      scored.sort((a, b) => b.similarity - a.similarity);
      const topResults = params.top_k ? scored.slice(0, params.top_k) : scored;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                model: DEFAULT_MODEL,
                query: params.query,
                candidatesScored: scored.length,
                elapsedMs,
                rankings: topResults,
              },
              null,
              2
            ),
          },
        ],
        details: { topScore: topResults[0]?.similarity ?? 0 },
      };
    },
  });

  // 3. Slash Command: /embed
  pi.registerCommand("embed", {
    description: "Generate embeddings or compare semantic similarity via local EmbeddingGemma",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();

      if (!raw || raw === "status") {
        try {
          const resp = await fetch(`${OLLAMA_HOST}/api/tags`);
          if (!resp.ok) throw new Error(`Ollama returned status ${resp.status}`);
          const data = (await resp.json()) as { models: Array<{ name: string; size: number }> };
          const hasModel = data.models?.some((m) => m.name.includes("embeddinggemma"));

          ctx.ui.notify(
            hasModel
              ? `⚡ EmbeddingGemma is ACTIVE on ${OLLAMA_HOST} (768-dim space)`
              : `⚠️ Ollama active, but model '${DEFAULT_MODEL}' not found. Run 'ollama pull embeddinggemma'`,
            hasModel ? "info" : "warning"
          );
        } catch (err: any) {
          ctx.ui.notify(`✖ Cannot connect to Ollama at ${OLLAMA_HOST}: ${err.message}`, "error");
        }
        return;
      }

      if (raw.startsWith("compare ") && raw.includes(" vs ")) {
        const parts = raw.replace(/^compare\s+/, "").split(/\s+vs\s+/);
        if (parts.length >= 2) {
          const textA = parts[0].trim();
          const textB = parts[1].trim();
          try {
            const [vecA, vecB] = await fetchEmbeddings([textA, textB]);
            const sim = cosineSimilarity(vecA, vecB);
            const scorePct = (Math.max(0, sim) * 100).toFixed(1);
            ctx.ui.notify(
              `Cosine Similarity: ${(sim).toFixed(4)} (${scorePct}% match)\nA: "${textA.slice(0, 30)}..."\nB: "${textB.slice(0, 30)}..."`,
              "info"
            );
          } catch (err: any) {
            ctx.ui.notify(`✖ Similarity computation failed: ${err.message}`, "error");
          }
          return;
        }
      }

      try {
        const [vec] = await fetchEmbeddings([raw]);
        ctx.ui.notify(
          `✔ Generated 768-dim vector (Norm: ${l2Norm(vec).toFixed(3)})\nSample: [${vec.slice(0, 4).map((v) => v.toFixed(3)).join(", ")}...]`,
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(`✖ Embed failed: ${err.message}`, "error");
      }
    },
  });
}
