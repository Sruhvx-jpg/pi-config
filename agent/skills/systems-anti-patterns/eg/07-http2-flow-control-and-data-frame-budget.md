# Case 07: HTTP/2 Flow Control, DATA Frame Budget & Stream Window Starvation

## Context & Standards
RFC 9113 (HTTP/2) specifies per-stream and connection-level flow control windows.

### Normative Specifications (RFC 9113 §5.2 & §6.9)
- **RFC 9113 §5.2 (Flow Control)**:
  ```text
  Flow control is directional with overall control provided by the receiver.
  A receiver MAY choose to set any window size that it desires for each
  stream and for the overall connection.
  ```
- **RFC 9113 §6.9.1 (The Flow-Control Window)**:
  ```text
  A sender MUST NOT send a flow-controlled frame with a length that exceeds
  the space available in either of the flow-control windows advertised by
  the receiver.
  ```

---

## The Anti-Pattern
```rust
// BAD: Allocating frame budget only against stream window without checking connection window
let stream_window = stream.available_window();
let frame_size = std::cmp::min(data.len(), stream_window);
// BUG: If connection_window < frame_size, sending this DATA frame causes FLOW_CONTROL_ERROR (connection termination)!
```

## The Corrected Pattern & Verification Invariant

```rust
// GOOD: Frame budget MUST be bounded by MIN(stream_window, connection_window, max_frame_size)
let available_budget = std::cmp::min(
    stream.available_window(),
    connection.available_window(),
);
let max_frame_size = peer_settings.max_frame_size();
let sendable_bytes = std::cmp::min(data.len(), std::cmp::min(available_budget, max_frame_size));

if sendable_bytes > 0 {
    stream.consume_window(sendable_bytes);
    connection.consume_window(sendable_bytes);
    send_data_frame(stream.id(), &data[..sendable_bytes]);
}
```
