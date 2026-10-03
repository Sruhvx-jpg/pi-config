# Case 01: RFC Verification, Multi-Spec Cross-Referencing & Hallucination Prevention

## Context & Incident
In protocol implementations (HTTP, WebSockets, H2), LLMs and authors frequently summarize rules from memory into synthetic quotation marks, attributing statements to the wrong sections or inventing clauses.

**Real-world Incident (Actix-Web PR #4295)**:
- The PR description claimed:
  > *RFC 6455 §4.4: "If the server doesn't support the requested version, the server MUST send an HTTP response with a status code 426 Upgrade Required that includes a `Sec-WebSocket-Version` header field indicating the version(s)..."*
- **The Reality**: That quote was completely fabricated. §4.4 only provides guidance and informal examples using `400 Bad Request`.
- **The True Mandate**: RFC 6455 §4.2.2 Step 4 explicitly suggests `426 Upgrade Required` (`such as 426 Upgrade Required`), and RFC 9110 §15.5.22 defines `426 Upgrade Required` and mandates sending the `Upgrade` and `Connection: Upgrade` headers.

---

## The Anti-Pattern
```markdown
<!-- BAD: Synthesizing quotes or citing an isolated section in a vacuum -->
According to RFC 6455 §4.4:
"The server MUST return 426 Upgrade Required with Sec-WebSocket-Version."
```

## The Corrected Pattern & Verification Invariant

### 1. Cross-Reference Multiple Governing RFCs
- **RFC 6455 §4.2.2 Step 4 (`/version/`)**:
  ```text
  If this version does not match a version understood by the server, the
  server MUST abort the WebSocket handshake described in this section and
  instead send an appropriate HTTP error code (such as 426 Upgrade Required)
  and a |Sec-WebSocket-Version| header field indicating the version(s) the
  server is capable of understanding.
  ```
- **RFC 9110 §15.5.22 (HTTP Semantics — 426 Upgrade Required)**:
  ```text
  The 426 (Upgrade Required) status code indicates that the server
  refuses to perform the request using the current protocol but might
  be willing to do so after the client upgrades to a different
  protocol. The server MUST send an Upgrade header field in a 426
  response to indicate the required protocol(s) (Section 7.8).
  ```

### 2. Implementation Invariant
When rejecting unsupported WebSocket versions:
1. Return `426 Upgrade Required`.
2. Insert `Sec-WebSocket-Version: 13`.
3. Insert `Upgrade: websocket`.
4. Set `Connection: Upgrade`.
5. Reject obsolete draft versions (e.g. hybi-07, hybi-08) during the handshake rather than accepting them when only RFC 6455 framing is implemented.

```rust
HandshakeError::UnsupportedVersion => {
    #[allow(clippy::declare_interior_mutable_const)]
    const HV_13: HeaderValue = HeaderValue::from_static("13");
    #[allow(clippy::declare_interior_mutable_const)]
    const HV_WEBSOCKET: HeaderValue = HeaderValue::from_static("websocket");
    let mut res = Response::new(StatusCode::UPGRADE_REQUIRED);
    res.head_mut().set_connection_type(ConnectionType::Upgrade);
    res.headers_mut().insert(header::UPGRADE, HV_WEBSOCKET);
    res.headers_mut().insert(header::SEC_WEBSOCKET_VERSION, HV_13);
    res.head_mut().reason = Some("Unsupported WebSocket version");
    res
}
```
