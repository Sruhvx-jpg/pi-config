# Case 09: MIME Multipart Streaming Parser Boundaries Across TCP Chunks

## Context & Standards
RFC 7578 / RFC 2046 MIME multipart streaming parsers (e.g. `actix-multipart`).

### The Problem
When streaming large file uploads over TCP, boundary markers (e.g. `\r\n--boundary_xyz\r\n`) frequently split across arbitrary packet/chunk boundaries:
- Chunk 1: `...data_bytes...\r\n--bound`
- Chunk 2: `ary_xyz\r\nContent-Disposition:...`

If the parser searches for the boundary using a naive byte search per-chunk without maintaining a lookahead ring buffer:
1. It misses the boundary and treats `--bound` as part of the binary body payload.
2. Or it truncates the buffer prematurely and hangs waiting for the rest of the stream.

---

## The Anti-Pattern
```rust
// BAD: Searching for boundary only within the currently received chunk
fn process_chunk(chunk: &[u8], boundary: &[u8]) {
    if let Some(pos) = find_subsequence(chunk, boundary) {
        // BUG: Misses boundary if split across chunk boundaries!
    }
}
```

## The Corrected Pattern & Verification Invariant

```rust
// GOOD: Maintain a lookahead search window of at least (boundary.len() + 4) bytes
// across stream chunks before yielding payload bytes to the consumer.
fn poll_next_field(
    buffer: &mut BytesMut,
    boundary: &[u8],
) -> Poll<Option<Result<Field, MultipartError>>> {
    let min_lookahead = boundary.len() + 6; // \r\n-- + boundary + --\r\n
    if buffer.len() < min_lookahead {
        // Need more data from upstream TCP stream before deciding
        return Poll::Pending;
    }
    // Search across buffered bytes
    match find_boundary(buffer, boundary) {
        BoundaryResult::Found(pos) => {
            let data = buffer.split_to(pos);
            Poll::Ready(Some(Ok(data)))
        }
        BoundaryResult::Partial => {
            // Retain the trailing min_lookahead bytes in buffer, yield the rest
            let yieldable = buffer.len() - min_lookahead;
            let data = buffer.split_to(yieldable);
            Poll::Ready(Some(Ok(data)))
        }
        BoundaryResult::NotFound => {
            // Safely yield safe prefix
            let yieldable = buffer.len() - min_lookahead;
            let data = buffer.split_to(yieldable);
            Poll::Ready(Some(Ok(data)))
        }
    }
}
```
