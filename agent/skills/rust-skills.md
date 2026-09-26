---
name: rust-skills
description: AI-powered Rust systems engineering & meta-cognition framework. Triggers on: Rust ownership, borrows, lifetimes (E0382, E0597, E0506), smart pointers (Arc, Rc, Box), zero-cost abstractions, type-state pattern, async/concurrency, unsafe/FFI, performance, and domain architecture.
---

# Rust Skills (Local Repository & Capability Index)

- **Local Root**: `~/.local/share/rust-skills/skills`
- **Canonical Upstream**: `https://github.com/actionbook/rust-skills`

Skills are loaded locally on demand from `~/.local/share/rust-skills/skills/<topic>/SKILL.md`. This provides instantaneous local guidance while keeping agent context windows fast and zero-bloat.

---

## 1. Core Language Mechanics (Layer 1)

| Topic | Focus & Compiler Error Triggers | Local Path |
|---|---|---|
| `m01-ownership` | Ownership, borrows, lifetimes, moves (`E0382`, `E0597`, `E0506`, `E0507`, `E0515`, `E0716`, `E0106`) | `skills/m01-ownership/SKILL.md` |
| `m02-resource` | Smart pointers, RAII, Drop, heap allocation (`Box`, `Rc`, `Arc`, `Weak`, `RefCell`, `Cell`) | `skills/m02-resource/SKILL.md` |
| `m03-mutability` | Mutability, interior mutability, borrow conflicts (`E0596`, `E0499`, `E0502`, `Mutex`, `RwLock`) | `skills/m03-mutability/SKILL.md` |
| `m04-zero-cost` | Generics, traits, monomorphization, static vs dynamic dispatch (`E0277`, `E0308`, `E0599`, `impl Trait`, `dyn`) | `skills/m04-zero-cost/SKILL.md` |
| `m05-type-driven` | Type-state pattern, PhantomData, newtype, sealed traits, zero-sized types (ZST) | `skills/m05-type-driven/SKILL.md` |
| `m06-error-handling` | Result, Option, error propagation, `?`, custom errors, panic vs Result (`thiserror`, `anyhow`) | `skills/m06-error-handling/SKILL.md` |
| `m07-concurrency` | Multithreading, async/await, actors, channels, `Send`/`Sync` bounds (`tokio`, `mpsc`, deadlocks) | `skills/m07-concurrency/SKILL.md` |
| `unsafe-checker` | Unsafe review, raw pointers, FFI, transmute, memory layout, UB, soundness, `#[repr(C)]` | `skills/unsafe-checker/SKILL.md` |

---

## 2. Architecture & Design Patterns (Layer 2 & 3)

| Topic | Focus & Design Patterns | Local Path |
|---|---|---|
| `m09-domain` | Domain-driven design (DDD), entities, value objects, aggregates, invariants | `skills/m09-domain/SKILL.md` |
| `m10-performance` | Benchmarking, profiling, flamegraphs, criterion, allocation minimization, cache, SIMD | `skills/m10-performance/SKILL.md` |
| `m11-ecosystem` | Crate selection, Cargo workspaces, feature flags, C/Python FFI (`PyO3`, `bindgen`, `wasm`) | `skills/m11-ecosystem/SKILL.md` |
| `m12-lifecycle` | Connection pools, lazy initialization, scope guards, cleanup on error (`OnceLock`, `Lazy`) | `skills/m12-lifecycle/SKILL.md` |
| `m13-domain-error` | Domain error hierarchies, circuit breakers, retry strategies, transient vs permanent errors | `skills/m13-domain-error/SKILL.md` |
| `m14-mental-model` | Intuition and memory layout models for borrow checker, transitions from Java/Python | `skills/m14-mental-model/SKILL.md` |
| `m15-anti-pattern` | Detecting anti-patterns (clone-everywhere, unwrap in prod, fighting the borrow checker) | `skills/m15-anti-pattern/SKILL.md` |
| `coding-guidelines` | Ninting, naming conventions, rustfmt, clippy, code review checklists | `skills/coding-guidelines/SKILL.md` |

---

## 3. Domain Architectures

| Domain | Ecosystem & Key Technologies | Local Path |
|---|---|---|
| `domain-web` | Web services, HTTP, REST, WebSocket (`actix-web`, `axum`, `tower`, `hyper`, `reqwest`) | `skills/domain-web/SKILL.md` |
| `domain-cloud-native` | Kubernetes, containers, gRPC, microservices, tracing, metrics (`tonic`, `tracing`) | `skills/domain-cloud-native/SKILL.md` |
| `domain-embedded` | `no_std`, bare metal, microcontrollers, interrupts, DMA (`embassy`, `cortex-m`, `RTIC`) | `skills/domain-embedded/SKILL.md` |
| `domain-cli` | Command-line apps, TUIs, argument parsing (`clap`, `ratatui`, `crossterm`, `indicatif`) | `skills/domain-cli/SKILL.md` |
| `domain-fintech` | Financial ledgers, high-precision decimals, currency transactions, exchange rates | `skills/domain-fintech/SKILL.md` |
| `domain-iot` | Edge telemetry, MQTT, sensor networks, actuators, gateways | `skills/domain-iot/SKILL.md` |
| `domain-ml` | Machine learning, neural network inference, tensor operations (`burn`, `candle`, `ndarray`) | `skills/domain-ml/SKILL.md` |

---

## 4. Code Intelligence & Tooling

| Tool | Capability | Local Path |
|---|---|---|
| `rust-code-navigator` | Navigate code, definitions, and references via LSP | `skills/rust-code-navigator/SKILL.md` |
| `rust-call-graph` | Visualize function call hierarchies and caller/callee trees | `skills/rust-call-graph/SKILL.md` |
| `rust-symbol-analyzer` | Project symbol structure analysis (structs, traits, enums) | `skills/rust-symbol-analyzer/SKILL.md` |
| `rust-trait-explorer` | Trait implementation inspection and discovery | `skills/rust-trait-explorer/SKILL.md` |
| `rust-deps-visualizer` | Dependency graph ASCII visualization | `skills/rust-deps-visualizer/SKILL.md` |
| `rust-refactor-helper` | Safe symbol renaming, function extraction, and refactoring | `skills/rust-refactor-helper/SKILL.md` |
| `rust-learner` | Crate version lookup, Rust edition updates, changelogs, docs.rs | `skills/rust-learner/SKILL.md` |

---

## Usage Workflow

When working on a specific Rust challenge (e.g. lifetime issues or concurrency), resolve the skill file locally using the `read` tool:
```
path: ~/.local/share/rust-skills/skills/<topic>/SKILL.md
```
Follow the architectural guidelines and design questions outlined in each module.
