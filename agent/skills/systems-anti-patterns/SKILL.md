---
name: systems-anti-patterns
description: Battle-tested systems design anti-pattern scanner and code auditor. Scans codebases for real-world bugs, RFC violations, S3/storage gotchas, async cancellation leaks, error mapping flaws, stream mismanagement, and Go/Rust safety hazards learned from maintainer reviews and production incidents.
---

# Systems Anti-Patterns & Battle-Tested Audit Guide

A comprehensive, zero-fluff playbook of concrete anti-patterns, edge cases, maintainer review feedback (Apache Iceberg, Actix-Web, BanyanDB, OpenDAL, Turso), and RFC compliance rules.

Use this guide whenever reviewing, writing, refactoring, or auditing systems code across **Rust**, **Go**, **TypeScript**, and **Makefiles/CI**.

---

## 1. Cloud Storage & S3 / Object Store Internals

### Rule 1.1: Error Mapping Fidelity (No Misleading Error Kinds)
* **The Pitfall**: Mapping HTTP `401 Unauthorized` or `403 Forbidden` (`object_store::Error::PermissionDenied` / `Unauthenticated`) to `ErrorKind::DataInvalid`.
* **Why it breaks**: Misleads callers into believing the stored Parquet/metadata file is corrupt on disk, triggering data recovery routines instead of alerting on expired AWS IAM credentials or IAM role misconfigurations.
* **The Rule**:
  - `NotFound` $\to$ `ErrorKind::NotFound`
  - `AlreadyExists` $\to$ `ErrorKind::AlreadyExists`
  - `PermissionDenied` / `Unauthenticated` $\to$ `ErrorKind::PermissionDenied` (or preserved with clear context in `ErrorKind::Unexpected`)
  - **Never** convert auth/permission failures into `DataInvalid`.

### Rule 1.2: 0-Byte / Empty File Multipart Upload (`400 MalformedXML`)
* **The Pitfall**: Calling `upload.complete()` with zero parts when a writer is closed without writing any bytes (e.g., creating an empty file `.parquet` or `.touch`).
* **Why it breaks**: AWS S3 Multipart Upload specification requires at least **1 part** (or using single `put_object`). Calling `CompleteMultipartUpload` with `<CompleteMultipartUpload></CompleteMultipartUpload>` (empty part list) causes S3 to reject with `400 MalformedXML`.
* **The Rule**:
  - If `writer.close()` is called and 0 bytes / 0 parts were flushed: handle empty files via direct `put_object` (single-shot PUT) or upload a 0-byte part #1 before calling `complete()`.

### Rule 1.3: S3 Multipart 5 MiB Minimum Part Size Rule
* **The Pitfall**: Flushing chunks smaller than **5 MiB (5,242,880 bytes)** as intermediate multipart upload parts.
* **Why it breaks**: AWS S3 enforces that every part in a multipart upload **except the last part** must be $\ge 5\text{ MiB}$. Emitting smaller parts causes S3 to fail the upload with `EntityTooSmall` during `CompleteMultipartUpload`.
* **The Rule**:
  - Buffer written byte chunks in memory until the buffer reaches $\ge 5\text{ MiB}$.
  - Only the final chunk flushed during `close()` is permitted to be $< 5\text{ MiB}$.

### Rule 1.4: Multipart Upload Resource Leak on Error / Drop
* **The Pitfall**: Holding a `MultipartUpload` session and dropping the writer or returning early on error without calling `abort()`.
* **Why it breaks**: Uploaded parts remain stored in AWS S3 indefinitely, accumulating silent cloud storage billing unless aborted or cleaned by an S3 bucket lifecycle policy.
* **The Rule**:
  - Implement RAII Drop Guards or explicit cleanup on error paths:
    ```rust
    // If writer fails or is dropped before close():
    if let Some(upload) = self.upload.take() {
        tokio::spawn(async move {
            if let Err(e) = upload.abort().await {
                tracing::warn!(error = %e, "failed to abort orphaned multipart upload");
            }
        });
    }
    ```
  - Log abort failures with `tracing::warn!`—**never panic inside `Drop`**.

### Rule 1.5: Writer State Machine Guards
* **The Pitfall**: Calling `write()` after `close()` or calling `close()` twice corrupting state, panicking, or firing duplicate network calls.
* **The Rule**:
  - Model writer state explicitly (`Open`, `Closing`, `Closed`, `Failed`) or take the inner writer/upload handle via `.take()`.
  - Calling `write()` after `close()` must return `Err(ErrorKind::Unexpected)`.
  - Calling `close()` on an already closed writer must be a safe, idempotent no-op `Ok(())`.

### Rule 1.6: S3 URL & Path Parsing (Leading Slashes & Percent Encoding)
* **The Pitfall**:
  1. Using `url.path()` directly without trimming leading `/` $\to$ S3 key becomes `//my-folder/file.parquet` instead of `my-folder/file.parquet`. S3 treats leading slashes as a literal empty folder key.
  2. Double-decoding percent-encoded paths (e.g., `path%20with%20spaces` decoded twice or broken).
* **The Rule**:
  - Always `url.path().trim_start_matches('/')`.
  - Parse bucket and key in a single helper (`parse_s3_url`) returning a structured `StoreAndPath { bucket, path, scheme }` to avoid repeated string slicing across calls.

---

## 2. Streams, Concurrency & Async Safety

### Rule 2.1: Lazy Stream Execution & Uncollected Result Streams
* **The Pitfall**: Calling methods like `store.delete_stream(stream)` (which return `Stream<Item = Result<Path>>`) and dropping or failing to drive the stream to completion.
* **Why it breaks**: In Rust `futures::Stream`, streams are lazy. If the stream is not polled/collected, **no HTTP DELETE requests are dispatched**, or errors are silently discarded.
* **The Rule**:
  - Always consume and drive result streams:
    ```rust
    let results = store.delete_stream(location_stream);
    results.try_for_each(|res| async move {
        res.map(|_| ())
    }).await?;
    ```

### Rule 2.2: Stream Grouping Panics (`.expect()` / `.unwrap()` on Map)
* **The Pitfall**: Calling `stores.remove(&bucket).expect("store must exist")` inside stream batch loops.
* **The Rule**:
  - Streams are external inputs. Never assume a key exists in a cache or store map.
  - Use fallible lookups: `stores.get(&bucket).ok_or_else(|| Error::new(ErrorKind::Unexpected, "missing store for bucket"))`.

### Rule 2.3: Unbounded In-Memory Stream Buffering (`.collect::<Vec<_>>()`)
* **The Pitfall**: Collecting an unbounded stream (e.g., 500,000 table manifest paths) into a `Vec<String>` before processing.
* **Why it breaks**: Blows up heap memory, kills async streaming backpressure, and turns a streaming pipeline into an OOM vulnerability.
* **The Rule**:
  - Process streams in bounded chunks using `stream.chunks(batch_size)` or `ready_chunks` with `try_for_each_concurrent(concurrency_limit, ...)`.

### Rule 2.4: Unbounded Tokio Task Spawning
* **The Pitfall**: Calling `tokio::spawn` inside a high-throughput loop without backpressure.
* **The Rule**:
  - Always bound task concurrency using `tokio::sync::Semaphore` or stream adapters like `buffer_unordered(max_concurrent)`.

### Rule 2.5: Server Cancellation & Socket Leak
* **The Pitfall**: Checking boolean flags like `if self.stopping` during cancellation rather than checking actual handles (`if let Some(h) = self.accept_handle.take()`).
* **Why it breaks**: If graceful shutdown is interrupted or server is dropped, listener sockets remain bound to the OS port, preventing daemon restarts (Actix #966).
* **The Rule**:
  - Always guard resource cleanup on the actual resource handle, not lifecycle state flags.
  - Close bound raw TCP listener sockets immediately upon cancellation.

---

## 3. Protocol & Networking Audits (Dynamic Parallel RFC Discovery & Audit)

Whenever auditing, reviewing, or writing networking, parser, framing, or protocol code:
1. **Dynamic RFC Discovery Engine**: Autonomously identify and resolve the complete set of governing IETF RFCs, updates, obsoletions, and extensions directly from the codebase context (wire protocols, framing bytes, handshake tokens, header definitions, docstrings, and protocol state machines). Do not rely on static lists—dynamically determine every primary and referenced RFC.
2. **Parallel Spec Scan**: Retrieve and scan the raw normative spec text (ABNF grammar definitions, `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` clauses, status/close code registries) directly alongside the code implementation.
3. **Cross-Check Invariants**:
   - Verify parser tokens against raw ABNF grammar (whitespace `OWS`/`BWS`, delimiters, CRLF `\r\n`).
   - Verify field ordering and forbidden frame/header rules directly from the spec text.
   - Verify state machine transitions and error triggers against normative clauses before asserting compliance.

---

## 4. API & Auth Error Propagation

### Rule 4.1: Authentication Failure Swallowing (Distinguish 401/403 vs 5xx)
* **The Pitfall**: Collapsing all API auth verification errors into `null` or 401.
* **The Rule**:
  - Return `null` / `401 Unauthorized` / `403 Forbidden` **only** for explicit credential rejections (invalid key / revoked token).
  - Propagate upstream network blips, 5xx internal errors, and database timeouts as 500/503 errors so clients can retry.

---

## 5. Memory, Allocations & Safety

### Rule 5.1: Panic During Unwinding & Custom Allocators
* **The Pitfall**: Calling `panic!()` inside `Drop` implementations or custom memory allocators.
* **Why it breaks**: Formatting error strings during panic unwinding triggers heap allocation. If the allocator is corrupted, formatting causes a double-panic and instant process crash.
* **The Rule**:
  - Zero panics in `Drop`.
  - If a low-level allocator encounters unrecoverable corruption, call `std::process::abort()` directly.

### Rule 5.2: Zero-Copy Byte Slicing
* **The Pitfall**: Calling `.to_vec()` or copying byte slices when passing buffers down storage/network pipelines.
* **The Rule**:
  - Use `bytes::Bytes` / `BytesMut` for cheap reference-counted slicing (`bytes.slice(start..end)`).

---

## 6. Go Systems Idioms (Line of Sight)

### Rule 6.1: Pure Left-Margin Guard Clauses (Zero `else` After `err != nil`)
* **The Pitfall**:
  ```go
  // BAD: Nested happy path
  val, err := doSomething()
  if err != nil {
      log.Error(err)
  } else {
      process(val)
  }
  ```
* **The Rule**:
  ```go
  // GOOD: Left-margin line of sight
  val, err := doSomething()
  if err != nil {
      return fmt.Errorf("doSomething: %w", err)
  }
  process(val)
  ```

### Rule 6.2: Zero Mock Route Pollution
* **The Pitfall**: Generating mock CRUD routes, fake user models, or dummy endpoints in baseline skeletons.
* **The Rule**:
  - Production scaffolds must contain only the minimal baseline skeleton (config, router wiring, telemetry). Zero fake sample endpoints.

### Rule 6.3: Double Expansion & Re-Interpolation Pitfall (Opaque Secret Invariant)
* **The Pitfall**: Running an interpolation engine (e.g. `setting.ExpandVar` for `$__file{}`, `$__env{}`) and then blindly piping the expanded string into a secondary general-purpose expander (e.g. `os.ExpandEnv(expanded)`).
* **Why it breaks**: If a resolved secret (password, API key, JWT) contains literal `$` characters (e.g. `Pa$sw0rd`), the secondary expansion pass interprets `$sw0rd` as an empty environment variable and silently truncates the secret to `Pa`.
* **The Rule**:
  - Treat resolved expansion output as **opaque literals**.
  - Never run a second expansion pass over the output of a prior resolver.
  - If bare variables (`$VAR`) must be supported alongside braced expanders (`$__file{}`), skip the secondary expander whenever the first pass successfully resolved a variable.

### Rule 6.4: Unchecked Indexing After BOM / Whitespace Stripping
* **The Pitfall**: Calling `StripBOMFromBytes(data)` or `bytes.TrimSpace(data)` and immediately indexing `cleanData[0]` to inspect headers or magic bytes.
* **Why it breaks**: Empty files or BOM-only files (`0xEF, 0xBB, 0xBF`) return `[]byte{}` with length 0. Unconditionally indexing `cleanData[0]` triggers an immediate runtime panic `index out of range [0] with length 0`, crash-looping daemons and sync workers.
* **The Rule**:
  - Always guard slice indexing after stripping or decoding:
    ```go
    cleanData := StripBOMFromBytes(data)
    if len(cleanData) == 0 {
        return nil, ErrEmptyOrInvalidPayload
    }
    ```

### Rule 6.5: Database Row Iteration Error Propagation (`rows.Err()` & `defer rows.Close()`)
* **The Pitfall**: Iterating database cursors (`for rows.Next()`) without checking `rows.Err()` after the loop.
* **Why it breaks**: In Go `database/sql` and ORMs (xorm, gorm), `rows.Next()` returns `false` on both clean EOF **and** connection drops / cursor failures mid-query. Omitting `rows.Err()` causes functions to silently return truncated, partial data with a `nil` error.
* **The Rule**:
  - Always pair `defer rows.Close()` with an explicit `rows.Err()` check immediately after the loop:
    ```go
    rows, err := db.QueryContext(ctx, query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    for rows.Next() {
        if err := rows.Scan(&item); err != nil {
            return nil, err
        }
        items = append(items, item)
    }
    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("row iteration failed: %w", err)
    }
    return items, nil
    ```

### Rule 6.6: Deferred Cleanup for Stream / Compression Writers (`pgzip` Leak)
* **The Pitfall**: Instantiating background-spawned stream writers (e.g. `pgzip.NewWriter(w)` which allocates channel workers per block) and calling `w.Close()` sequentially without `defer`, or wrapping requests that have no body (`HEAD`, `OPTIONS`).
* **Why it breaks**: Handler panics, client resets (`ECONNRESET`), or bodyless HTTP methods bypass sequential `Close()` calls. Block listener goroutines remain blocked on channels indefinitely, permanently leaking ~2MiB heap buffers per request until OOM.
* **The Rule**:
  - Always guarantee `Close()` via `defer func() { _ = w.Close() }()`.
  - Skip body-compression wrappers entirely for methods without response bodies (`HEAD`, `OPTIONS`).

---

## 7. Build, CI & Workspace Hygiene

### Rule 7.1: Makefile Dependency Gate Order
* **The Pitfall**: Makefile targets like `make lint` running tools before verifying or compiling the tool binaries (e.g. running `buf lint` when `bin/buf` does not exist).
* **The Rule**:
  - Declare explicit file target prerequisites: `lint: $(BIN_DIR)/buf` so Make builds/downloads tool dependencies prior to execution.

### Rule 7.2: Workspace Dependency Hoisting
* **The Pitfall**: Member crates hardcoding different minor versions of a core dependency (e.g. `object_store = "0.12"` in a subcrate while workspace uses `0.13.2`).
* **The Rule**:
  - Hoist shared dependencies to root `Cargo.toml` under `[workspace.dependencies]` and reference them in subcrates via `<crate>.workspace = true`.

---

## 8. Dynamic Multi-Dimensional Systems Audit Methodology

The scan suite directs the agent to perform an autonomous, multi-dimensional audit tailored dynamically to the target codebase without hardcoded assumptions. Audit across all five foundational systems layers:

### Layer 0: Autonomous Specification & Domain Discovery
* **Action**: Dynamically resolve all governing specifications, protocol standards, IETF RFCs, storage contracts, and data format definitions by inspecting wire framing, headers, APIs, and dependencies.
* **Scope**: Identify every applicable RFC (network/framing), cloud storage contract (S3/GCS/Azure), OS API model (epoll/kqueue/io_uring/signals), and serialization standard (UTF-8, Parquet, Protobuf).

### Layer 1: Protocol & Specification Invariant Matrix
* **Normative Clause Extraction**: Map every `MUST`, `MUST NOT`, `REQUIRED`, `SHALL NOT` clause directly to code branches. Mark missing rejections as spec violations.
* **ABNF & Framing Strictness**: Check exact delimiters, forbidden control characters, whitespace stripping, and smuggling/desync vectors.
* **Multiplicity & Conflicts**: Verify illegal duplicate headers/frames and mutually exclusive fields are rejected.
* **Version Partitioning**: Ensure deprecated features are barred and newer features are version-gated.
* **Error Fidelity**: Verify exact specification-mandated response codes and transport teardown semantics.

### Layer 2: Concurrency, Cancellation & Async Safety
* **Async Cancellation Safety**: Audit all `.await` points to verify state remains consistent if futures are dropped mid-execution. Prevent orphaned network/file descriptors and dangling locks.
* **Backpressure & Buffer Bounds**: Detect unbounded queues (`VecDeque`, unbounded mpsc), unconstrained `tokio::spawn` loops, and lazy streams dropped without consumption.
* **Reactor Thread Hygiene**: Verify no blocking CPU/disk operations stall async event loops.

### Layer 3: Memory Safety, Bit Widths & State Machines
* **Architecture & Bit-Width Invariants**: Flag 64-bit to 32-bit truncations (`u64 as usize`), integer overflows in slice indexing or capacity allocations, and bitmask sign extensions.
* **Zero-Copy & Heap Churn**: Audit buffer lifetimes, reference-counted byte slicing (`bytes::Bytes`), and hot-loop allocations.
* **State Machine Invariants**: Check guards against double-close, read/write after termination, out-of-order frame sequences, and illegal re-entry.
* **Drop & Panic Invariants**: Guarantee infallible `Drop` implementations and clean aborts on low-level memory corruption.

### Layer 4: Error Mapping, Security & Resource Bounds
* **Error Semantics**: Prevent misleading error kinds (e.g., auth failures mapped to data invalid).
* **Resource Exhaustion (DoS)**: Guard against huge memory pre-allocations from untrusted frame length headers, uncompressed payload bombs, and unbounded timeouts.
* **Boundary Validation**: Enforce strict validation on nonces, hashes, UTF-8 strings, and stripped prefixes before parsing payloads.

---

## Comprehensive Systems Audit Checklist

- [ ] **Autonomous Spec Discovery**: Are all governing RFCs, protocol standards, and storage contracts resolved?
- [ ] **Normative Spec Branches**: Are all `MUST` / `MUST NOT` constraints mapped to explicit error branches?
- [ ] **Framing & ABNF Strictness**: Are strict delimiters, whitespace rules, and forbidden octets enforced?
- [ ] **Cancellation Safety**: Are sockets, handles, and locks safely cleaned up if async futures are cancelled?
- [ ] **Backpressure & Queues**: Are all channels, streams, and internal queues strictly bounded?
- [ ] **Bit-Width & Truncation**: Are 64-bit lengths safely converted to `usize` without 32-bit overflow?
- [ ] **State Machine Soundness**: Are duplicate close calls, out-of-sequence events, and re-entry guarded?
- [ ] **Error Mapping Fidelity**: Are error variants preserved with exact semantic meaning and spec status codes?
- [ ] **Unbounded Buffering**: Is stream collection bounded (`chunks`/`ready_chunks`) instead of `.collect::<Vec<_>>()`?
- [ ] **Resource Limits (DoS)**: Are max frame sizes, payload allocations, and timeouts strictly enforced before processing?
- [ ] **Infallible Drop**: Are all `Drop` implementations panic-free with non-blocking logging?
