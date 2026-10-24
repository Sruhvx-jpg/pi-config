# Agent Log: HTTP/3 for Actix Web
## Log 1: Architecture, Core Components & Feasibility Audit

### 1. Context & Upstream Status
* **Issue**: `actix/actix-web#309` (`Support for QUIC/HTTP3 protocol`, labeled `C-feature, D-hard`).
* **Milestone Status**: Added to `actix-web v5.0` by `@JohnTitor` on Feb 9, but officially **demilestoned (removed)** by `@robjtede` on Sept 25.
* **Maintainer Stance**: Rob explicitly stated: *"I'd rather you didn't. It's not going to be at all simple, requiring a lot of reworking of all the crates... I don't expect this feature to make it into v5."*

---

### 2. Core Concepts & Definitions
* **HTTP/3 (RFC 9114)**: Runs over **QUIC (RFC 9000)**, not raw UDP. QUIC handles TLS 1.3 encryption (RFC 9001), packet ACKs, congestion control, and connection migration in user space.
* **`hyperium/h3` Crate**: Pre-1.0 experimental (`v0.0.8`). Only handles HTTP/3 wire framing and QPACK (RFC 9204). It does NOT handle UDP sockets directly; it requires a QUIC transport engine (`quinn` or `s2n-quic`).
* **Demuxing (Demultiplexing)**: Sorting mixed incoming packets off a single UDP socket and routing them to their specific client connection state by Connection ID (CID). In Rust, this is performed by `quinn::Endpoint`, not Actix.
* **Protocol Negotiation**:
  * **HTTPS (TLS)**: Uses **ALPN (RFC 7301)** during the TLS handshake. Client sends supported versions; server picks mutual match (`h2` preferred, fallback to `http/1.1`). Handled automatically in `actix-http/src/service.rs`.
  * **Plaintext TCP (`h2c`)**: "HTTP/2 Cleartext". Actix sniffs the first 12 bytes via `io.peek()` matching `b"PRI * HTTP/2"` (RFC 9113 §3.4). Called *"h2c if you're lucky"* because browsers reject it and middlebox proxies corrupt binary frames on port 80.
* **HTTP/3 Discovery**: H3 cannot use TCP ALPN because it is UDP. Clients discover H3 via TCP first through the `Alt-Svc: h3=":443"; ma=86400` header (RFC 7838 / RFC 9114 §3.1.1) or DNS HTTPS records (RFC 9460).

---

### 3. Actix Ecosystem Surgery Required
Why H3 cannot be a simple drop-in feature or single internal crate:

#### A. `actix-server` (Inside `actix-net` Workspace)
* Currently only knows stream listeners:
  ```rust
  pub(crate) enum MioListener {
      Tcp(MioTcpListener),
      Uds(MioUnixListener),
  }
  ```
* Loop relies strictly on `.accept()`. UDP has no connections and no `.accept()`.
* **The `SO_REUSEPORT` Trap**: Kernel hashes UDP packets by `(src_ip, src_port, dst_ip, dst_port)`. If a mobile client switches Wi-Fi to 5G (connection migration), the packet hashes to a different worker thread, breaking the connection. Solving this requires attaching custom eBPF packet-steering filters to the socket.

#### B. `actix-http` (Inside `actix-web` Workspace)
* Assumes 1 connection = 1 byte stream (`AsyncRead + AsyncWrite`).
* QUIC connection = 1 UDP session multiplexing dozens of independent concurrent streams dynamically.
* Requires a new `src/h3/` engine, QPACK header decoding instead of HPACK, and mapping QUIC recv streams into `actix_http::Payload`.

#### C. Base Architecture: Why It Is Not Unified Into One Component
Actix is deliberately decomposed into strict layers (avoiding the God Object anti-pattern):
1. **`actix-server`**: Generic OS socket engine (TCP/UDS polling, worker thread pooling). Knows nothing about HTTP.
2. **`actix-http`**: Byte/frame parser (H1/H2 wire state machines). Knows nothing about worker thread spawning.
3. **`actix-web`**: Application framework (routing, extractors, middleware).
* Uses compile-time generic traits (`ServerServiceFactory<Stream>`) for zero runtime branch overhead, keeping Actix at peak benchmark speeds.

---

### 4. Explicit Binding Requirement
Because TCP and UDP are distinct kernel sockets, H3 can never be implicitly bound by `.bind()`.
`HttpServer` supports chaining multiple listeners:
```rust
HttpServer::new(|| App::new()...)
    .bind(("0.0.0.0", 8080))?          // TCP (H1/H2)
    .bind_rustls("0.0.0.0:8443", tls)?  // TCP + TLS
    .bind_h3("0.0.0.0:8443", tls)?     // UDP + QUIC (Hypothetical explicit H3)
    .run()
```

---

### 5. Implementation Strategy
* **Internal Crate (`actix/actix-web`)**: Dead on arrival for v5. Maintainers explicitly rejected it to focus on stability.
* **External Prototype (`actix-h3` in personal repo)**: The viable path. Run an independent `quinn` UDP loop and dispatch incoming HTTP/3 requests into `actix_service::Service::call()` against an `actix_web::App`. Prove the architecture and benchmark it before pitching upstream.

---

### 6. User Understanding Profile
* **Systems Level**: High-level understanding of protocol differences; learned the distinction between transport (QUIC/UDP) and application framing (H3/QPACK).
* **Core Takeaways**:
  * Status codes and HTTP semantics do not change across HTTP versions (RFC 9110).
  * Actix is modularly layered for zero-cost abstractions; not a monolithic configurable listener.
  * H3 requires explicit UDP socket binding.
