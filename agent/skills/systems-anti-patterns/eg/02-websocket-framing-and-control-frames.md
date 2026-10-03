# Case 02: WebSocket Framing, Control Frame Limits & Protocol Errors

## Context & Standards
RFC 6455 defines strict limits on WebSocket control frames (Close `0x8`, Ping `0x9`, Pong `0xA`).

### Normative Specifications (RFC 6455)
- **RFC 6455 §5.5 (Control Frames)**:
  ```text
  All control frames MUST have a payload length of 125 bytes or less
  and MUST NOT be fragmented.
  ```
- **RFC 6455 §5.4 (Fragmentation)**:
  ```text
  Control frames (see Section 5.5) MAY be injected in the middle of
  a fragmented message. Control frames themselves MUST NOT be fragmented.
  ```
- **RFC 6455 §7.4.1 (Defined Status Codes)**:
  ```text
  1002 indicates that an endpoint is terminating the connection due
  to a protocol error.
  ```
- **RFC 6455 §7.1.7 (Fail the WebSocket Connection)**:
  Any framing violation of the base protocol is a protocol error, requiring the endpoint to fail the WebSocket connection with status code `1002`.

---

## The Anti-Pattern
```rust
// BAD: Allowing arbitrary payload length or ignoring FIN bit on control frames
if frame.is_control() {
    if frame.payload_len > 1024 { // WRONG: Max is 125 bytes, not arbitrary buffer size
        return Err(Error::FrameTooLarge);
    }
    // BUG: Missing check for frame.fin == true (control frames cannot be fragmented)
}
```

## The Corrected Pattern & Verification Invariant

```rust
// GOOD: Strict RFC 6455 §5.5 & §5.4 enforcement
if opcode.is_control() {
    // 1. Control frame payloads MUST be <= 125 bytes
    if payload_len > 125 {
        return Err(ProtocolError::ControlFrameTooLarge); // fails connection with 1002
    }

    // 2. Control frames MUST NOT be fragmented (FIN bit must be 1)
    if !fin {
        return Err(ProtocolError::ControlFrameFragmented); // fails connection with 1002
    }
}
```
