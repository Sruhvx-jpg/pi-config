# Case 10: TLS Handshake Timeouts, Slowloris & Corrupted Certificate Rejection

## Context & Standards
Observed in `actix-tls`, `tokio-rustls`, and `openssl`.

### The Problem
1. **TLS Handshake Slowloris**: If a client opens a TCP connection and never sends a `ClientHello` (or sends 1 byte every 30 seconds), server worker threads/tasks remain pinned indefinitely unless an explicit handshake deadline/timeout is enforced.
2. **Corrupted Certificate Panic / Swallow**: If a server loads a malformed DER/PEM cert or receives a corrupted certificate chain from an SNI peer, unhandled errors can panic the acceptor or log misleading errors.

---

## The Anti-Pattern
```rust
// BAD: Awaiting TLS handshake without a timeout guard
let tls_stream = acceptor.accept(tcp_stream).await?; // BUG: Hangs forever on stalled client!
```

## The Corrected Pattern & Verification Invariant

```rust
// GOOD: Enforce strict TLS handshake timeout with proper error mapping
let handshake_timeout = Duration::from_secs(5);
let tls_stream = tokio::time::timeout(handshake_timeout, acceptor.accept(tcp_stream))
    .await
    .map_err(|_| TlsError::HandshakeTimeout)? // 408 / connection close
    .map_err(TlsError::from)?;
```
