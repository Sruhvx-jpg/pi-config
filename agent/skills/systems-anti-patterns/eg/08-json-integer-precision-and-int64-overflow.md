# Case 08: JSON Integer Precision Truncation (IEEE 754 vs Go / Rust `int64`)

## Context & Incident
Observed in cross-language SDKs (Go SDK, JavaScript TUI harness, Rust serde).

### The Problem
JSON specification (RFC 8259) does not differentiate floats from integers. Standard JavaScript / JSON runtimes parse numbers as IEEE 754 double-precision floats (`Number`), which only have **53 bits of mantissa precision** (safe integer range: $[-2^{53}+1, 2^{53}-1]$, or $\pm 9,007,199,254,740,991$).

When Go or Rust services emit raw 64-bit integers (e.g. database snowflakes, timestamps in nanoseconds, unix timestamps $> 2^{53}-1$):
- JavaScript decodes `9007199254740993` $\to$ `9007199254740992` (silent bit truncation / ID corruption).

---

## The Anti-Pattern
```go
// BAD: Emitting 64-bit IDs/nanoseconds directly as raw JSON numbers
type Event struct {
    ID        int64 `json:"id"`        // BUG: Loses precision in JS/web clients
    Timestamp int64 `json:"timestamp"` // BUG: Nanoseconds exceed 2^53-1
}
```

## The Corrected Pattern & Verification Invariant

```go
// GOOD: Encode 64-bit integer IDs as strings or string-tagged fields
type Event struct {
    ID        int64 `json:"id,string"` // Emits "9007199254740993"
    Timestamp int64 `json:"timestamp,string"`
}
```

In Rust `serde`:
```rust
#[derive(Serialize, Deserialize)]
struct Event {
    #[serde(with = "serde_as_string")]
    id: i64,
}
```
