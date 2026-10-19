---
name: engine-trimming
description: Universal systems downsizing and engine trimming pipeline. Safely audits, classifies, prunes, and extracts in-process cores from any bloated upstream open-source repository—databases, HTTP frameworks, distributed engines, storage layers, or protocol parsers (Rust, Go, TypeScript, C/C++)—without breaking build graphs, core algorithms, or wire schemas.
---

# Universal Systems Engine Trimming & Downsizing Pipeline

A deterministic, re-executable standard operating procedure for auditing, extracting, and pruning any upstream open-source project—**databases, HTTP frameworks, storage engines, protocol parsers, or networking layers**—into a lean, embedded in-process core.

---

## When to Trigger
* Whenever asked to: "trim this repo", "downsize this engine", "strip the bloat", "vendor and trim", "extract the core engine", "run engine trimming", or "streamline this upstream codebase".
* Applicable to:
  * **Databases & Vector Stores** (Chroma, Banyandb, RocksDB, SQLite, Iceberg, Redis)
  * **HTTP & Web Frameworks** (Axum, Actix, Gin, Fiber, Express, Fastify)
  * **Networking & RPC Engines** (Tonic, gRPC, Libp2p, NATS, WireGuard)
  * **Storage & File Formats** (Apache Arrow, Parquet, Blockstore, LevelDB)
  * **ML & Compute Runtimes** (Candle, ONNX, llama.cpp, SimSIMD)

---

## 🚨 MANDATORY HUMAN ACCEPTANCE GATE (ZERO AUTONOMOUS PRUNING)
> **NON-NEGOTIABLE CORE POLICY**: 
> **WITHOUT EXPLICIT HUMAN ACCEPTANCE, NOTHING IS ALLOWED TO BE PRUNED.**
>
> 1. The assistant is **STRICTLY FORBIDDEN** from autonomously deleting directories, removing workspace members, or pruning code based on its own assumptions.
> 2. The assistant **MUST ALWAYS** invoke the interactive **`ask_user_question`** tool with a multi-tab questionnaire or individual checkboxes listing every identified dead-weight component.
> 3. **The Human Ticks the Cuts**: Only items that the human operator explicitly selects/ticks for removal are authorized to be touched. Any component marked "Keep" or left unconfirmed **MUST remain 100% intact**.
> 4. If any ambiguity or unexpected dependency arises during pruning, pause immediately and re-prompt the human via `ask_user_question`.

---

## The 4 Upstream Trimming Archetypes

Before cutting, identify which archetype the target project belongs to:

| Archetype | What Stays (Core Engine) | What Gets Pruned (Upstream Overhead) |
| :--- | :--- | :--- |
| **1. Database & Storage Engines** | HNSW/B-Tree/LSM indexes, physical block formats (Arrow/Parquet), local disk persistence, in-process commit logs. | Distributed coordinators (Raft/Postgres), cloud queues (S3/Kafka), multi-tenant billing meters, cluster gossip (`memberlist`), Spanner/cloud drivers. |
| **2. HTTP & Web Frameworks** | Core routing trie, connection state machines, HTTP parser, essential extractors/middleware. | Heavy template engines, multi-part form upload handlers, legacy cookie parsers, unused TLS backends, auxiliary CLI tools. |
| **3. Networking & Protocol Engines** | Framing decoders, byte stream serializers, cryptographic verification, direct socket listeners. | Multi-protocol proxies, cloud service discovery, metrics scrapers, load balancer hooks. |
| **4. ML & Math Runtimes** | Hardware SIMD kernels (AVX2/NEON), quantization math, tensor buffers, model inference loops. | Multi-gigabyte model weights, vendor cloud API wrappers (OpenAI, Bedrock, Anthropic), Python bridge bindings (PyO3). |

---

## The 5-Phase Universal Execution Pipeline

### Phase 1: Deep Component Classification & Audit
Map and classify every upstream module across four strict boundaries:

1. **Execution & Process Boundary**:
   * *In-Process Core*: Kept. Runs in memory/disk inside the host application process.
   * *Server Daemons*: Pruned. Multi-node workers, Kubernetes controllers, cluster gossip, HTTP/gRPC server entrypoints.
2. **Model & Runtime Independence**:
   * *Algorithm Core*: Kept. Pure data structures, memory layout, indexing, and math.
   * *Vendor & Model SDKs*: Pruned. Heavy third-party ML runtimes, API wrappers, and sample apps.
3. **Physical Storage Medium**:
   * *Local Storage*: Kept. Local disk directory abstraction, memory-mapped files (`mmap`), local SQLite/blockfiles.
   * *Distributed Cloud Queues*: Pruned. S3 task queues, remote Spanner/DynamoDB drivers.
4. **Durability vs. Telemetry ("The Log Trap")**:
   * *Database Write-Ahead Log (WAL)*: **NEVER DELETE**. `log` / `wal` in a database is the append-only commit log for write durability (`in_memory_log`, `sqlite_log`).
   * *Application Telemetry*: Pruned. Cloud billing meters (`metering`), chaos engineering (`faults`), or heavy OTel exporter daemons.

*Interactive Confirmation Gate*: The assistant MUST NEVER begin file deletions directly. It MUST formulate an interactive questionnaire using the `ask_user_question` tool, presenting each candidate component with "Prune (Recommended)" vs "Keep" options, waiting for the human operator to tick the approved cuts before executing any deletions.

---

### Phase 2: Manifest Decoupling & Dev-Dependency Sanitization
Do not rely on recursive directory deletion alone. Sanitize the workspace build graph:

1. **Workspace Root (`Cargo.toml` / `go.work` / `pnpm-workspace.yaml`)**:
   * Remove deleted crates/packages from `members`.
   * Remove deleted crate path pointers from `[workspace.dependencies]`.
2. **Hidden Dev-Dependency Grep**:
   * Upstream crates frequently import sibling crates under `[dev-dependencies]` for testing or benchmarking (e.g. `index` importing `benchmark`).
   * Search all surviving crates:
     ```sh
     grep -rn "<pruned-crate-name>" <surviving-crates>/Cargo.toml
     ```
   * Strip orphaned `[dev-dependencies]` before invoking the compiler.

---

### Phase 3: Wire Schema & Codegen Protection
**Never delete `.proto`, `.fbs` (Flatbuffers), or schema files blindly.**

1. Upstream database engines often distribute query execution plan messages across auxiliary proto files rather than keeping them solely in `core.proto`.
2. Inspect the crate's `build.rs` or schema codegen script to identify exactly which schema files are needed to synthesize internal domain types.
3. Keep required wire schemas intact until internal type conversions are decoupled from gRPC serialization.

---

### Phase 4: Progressive Multi-Tier Verification
Execute compiler passes in three strict, sequential stages:

```sh
# Stage 1: Verify the primary modified target crate
cargo check -p <target-crate>  # or: go build ./<target-pkg>

# Stage 2: Execute unit tests to ensure runtime logic & math hold
cargo test -p <target-crate>   # or: go test ./<target-pkg>

# Stage 3: Verify full workspace resolution across all surviving members
cargo check --workspace        # or: go vet ./...
```
*Rule*: If any stage fails, fix the dependency or restore the required type before proceeding to the next phase.

---

### Phase 5: Monorepo Integration & Git Hygiene
1. **Remove Nested `.git/`**: Delete the upstream `.git` directory so the trimmed engine integrates natively as a regular package/crate in the parent monorepo.
2. **Run Monorepo Typechecks**:
   * For TypeScript: `pnpm run check-types`
   * For Go: `go vet ./...`
3. **Verify License Provenance**: Keep upstream `LICENSE` files intact in the package root to comply with Apache 2.0 / MIT terms.
4. **Disclaimers**: Add explicit attribution in `README.md` and `package.json` stating the engine is cloned and trimmed for downstream use, not created from scratch.
5. **Atomic Commit**: Commit with a clear, conventional commit message (e.g., `feat(engine): trim upstream cloud daemons and decouple in-process core`).
