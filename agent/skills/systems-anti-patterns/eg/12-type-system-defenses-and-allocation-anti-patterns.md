# Case 12: Type System Defenses & Allocation Anti-Patterns

## Context & Production Incidents
Observed across high-throughput distributed network engines, microservice routing runtimes, and protocol parsers (Tokio, Actix-Web, Tower, Arrow-DataFusion).

---

## 1. Missing `#[non_exhaustive]` on Public Domain Types & Enums (Semver Fragility)

### The Anti-Pattern
```rust
// BAD: Fully public struct or enum exposed in a public library API without protection
#[derive(Debug, Clone, Serialize)]
pub struct QueryPlanMetadata {
    pub query_id: String,
    pub execution_time_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("I/O failure: {0}")]
    Io(std::io::Error),
    #[error("Parse error: {0}")]
    Parse(String),
}
```

### Why It Breaks
1. **Destructuring Fragility**: Downstream consumers write exhaustive pattern matches:
   ```rust
   let QueryPlanMetadata { query_id, execution_time_ms } = plan;
   ```
2. **Instant Breaking Change**: The moment you add a new metric (e.g. `pub memory_peak_bytes: u64`) or a new error variant (e.g. `EngineError::Timeout`), every downstream consumer's code fails to compile. What should have been a minor backwards-compatible release becomes a major semver breaking release.
3. **Struct Literal Construction**: External consumers can instantiate the struct directly using raw field literals (`QueryPlanMetadata { ... }`), bypassing constructors, default fields, and future invariant checks.

### The Correct Pattern
```rust
// GOOD: Protect public types against breaking expansions
#[non_exhaustive]
#[derive(Debug, Clone, Serialize)]
pub struct QueryPlanMetadata {
    pub query_id: String,
    pub execution_time_ms: u64,
}

#[non_exhaustive]
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("I/O failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("Parse error: {0}")]
    Parse(String),
}
```
* **Struct Invariant**: External consumers must construct via factory methods (`QueryPlanMetadata::new(...)`) and must destructure with wildcard syntax (`let QueryPlanMetadata { query_id, .. } = plan;`).
* **Enum Invariant**: External consumers are forced to provide a catch-all arm (`_ => ...`) in `match` statements, shielding them from compiler breaks when new variants are introduced.

---

## 2. Primitive Obsession vs Strong Newtypes (Zero-Cost Semantic Integrity)

### The Anti-Pattern
```rust
// BAD: Passing naked primitive types across critical domain boundaries
pub fn register_partition(
    table_name: String,
    partition_id: String,
    storage_path: String,
    max_bytes: u64,
) -> Result<(), Error> { ... }

// Caller accidentally swaps partition_id and storage_path:
register_partition(table_name, storage_path, partition_id, max_bytes);
// ❌ Compiles cleanly! Silently corrupts the partition catalog in production.
```

### Why It Breaks
Strings and integers carry zero domain invariants. Passing raw `String`s for entity identifiers, URIs, and resource keys leads to:
1. **Transposition Bugs**: Identifiers with identical underlying types are easily swapped at call sites without any compiler diagnostics.
2. **Repeated Validation Overhead**: Every leaf function re-validates the string (e.g. checking for path traversal, control characters, or URI formatting) because the type system cannot guarantee validation was performed upstream.

### The Correct Pattern
```rust
// GOOD: Zero-cost tuple struct newtypes
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TableName(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StorageUri(pub String);

impl TableName {
    pub fn new(raw: impl Into<String>) -> Result<Self, ValidationError> {
        let name = raw.into();
        if name.is_empty() || name.contains('/') || name.contains("..") {
            return Err(ValidationError::InvalidTableName);
        }
        Ok(Self(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub fn register_partition(
    table: TableName,
    storage_uri: StorageUri,
) -> Result<(), Error> { ... }

// 💥 Compile error: mismatched types! Cannot pass StorageUri where TableName is expected.
```

---

## 3. Silent Discard of Builders & Pure Types (Missing `#[must_use]`)

### The Anti-Pattern
```rust
// BAD: Builder type and pure constructors lack #[must_use]
pub struct RequestBuilder {
    headers: HeaderMap,
    body: Option<Bytes>,
}

impl RequestBuilder {
    pub fn new() -> Self { ... }
    pub fn header(mut self, k: HeaderName, v: HeaderValue) -> Self { ... }
    pub fn finish(self) -> Request { ... }
}

// In application code:
let mut builder = RequestBuilder::new();
builder.header(header::ACCEPT, HeaderValue::from_static("application/json")); // ❌ Builder dropped!
// The method took self by value and returned a new builder, but the caller discarded it.
```

### Why It Breaks
In Rust, functions and methods that return a modified value, a newly constructed builder, or an error instance produce values that do nothing unless consumed:
1. **Chaining Discards**: Calling `.header(...)` on a builder without reassigning or chaining silently drops the configured builder.
2. **Unreturned Errors**: Constructing `ApiError::bad_request(...)` without returning or sending it produces an unused value with zero compiler warning.

### The Correct Pattern
```rust
// GOOD: Annotate builders and pure constructors with #[must_use]
#[must_use = "builders do nothing unless .finish() or .body() is called"]
pub struct RequestBuilder { ... }

impl RequestBuilder {
    #[must_use = "this returns the modified builder without modifying the original in-place"]
    pub fn header(mut self, k: HeaderName, v: HeaderValue) -> Self { ... }
}

impl ApiError {
    #[must_use = "constructing an error does nothing unless returned or converted into a response"]
    pub fn bad_request(message: impl Into<String>) -> Self { ... }
}
```

---

## 4. Bare `.unwrap()` Without Invariant Documentation (The Lazy Crash Anti-Pattern)

### The Anti-Pattern
```rust
// BAD: Unwrapping an Option/Result without documenting why it cannot fail
let fallback_response = Response::builder()
    .status(StatusCode::INTERNAL_SERVER_ERROR)
    .body(Bytes::from(r#"{"error":"Internal Error"}"#))
    .unwrap();
```

### Why It Breaks
1. **Zero Context in Stack Traces**: When a panic occurs in production, `unwrap()` outputs `called Option::unwrap() on a None value` with a bare line number. It provides zero insight into what engineering assumption or invariant failed.
2. **Hidden Refactoring Fragility**: If another engineer later alters the input to the builder (e.g. passing an unvalidated dynamic status code or malformed header), the code panics without explaining the original safety contract.

### The Correct Pattern
```rust
// GOOD: Use .expect() with an explicit, assertable engineering invariant
let fallback_response = Response::builder()
    .status(StatusCode::INTERNAL_SERVER_ERROR)
    .body(Bytes::from(r#"{"error":"Internal Error"}"#))
    .expect("static fallback response template contains only valid status and body invariants");
```

---

## 5. Double Indirection on Static Shared Collections (`Arc<Vec<T>>` vs `Arc<[T]>`)

### The Anti-Pattern
```rust
// BAD: Double pointer indirection for an immutable, shared collection
pub struct Dispatcher {
    targets: Arc<Vec<TargetServer>>,
}
```

### Why It Breaks
1. **Two Heap Pointer Hops**: A `Vec<T>` allocates a 24-byte header `(ptr, capacity, len)` on the heap. Wrapping it in `Arc` forces:
   $$\text{Arc Pointer} \longrightarrow \text{Vec Header on Heap} \longrightarrow \text{Contiguous Elements Buffer}$$
2. **Wasted Memory**: The `capacity` field in `Vec` is useless overhead once the collection is shared and immutable across threads.

### The Correct Pattern
```rust
// GOOD: Flatten into a boxed slice inside Arc
pub struct Dispatcher {
    targets: Arc<[TargetServer]>,
}

impl Dispatcher {
    pub fn new(targets: Vec<TargetServer>) -> Self {
        Self {
            // Converts Vec<T> into Box<[T]> and then Arc<[T]> in a single contiguous allocation
            targets: targets.into(),
        }
    }
}
```
* **Performance Gain**: Saves 8 bytes of unused capacity overhead and eliminates an entire memory pointer indirection on every element access.
