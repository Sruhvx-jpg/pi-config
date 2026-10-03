# Case 06: HTTP/1.1 Request Smuggling, Host Header & Transfer-Encoding Final Chunked

## Context & Standards
RFC 9112 (HTTP/1.1) defines critical invariants to prevent HTTP Request Smuggling (HRS) and Host Header Injection vulnerabilities.

### Normative Specifications (RFC 9112 & RFC 9110)
- **RFC 9112 §6.3 (Transfer-Encoding)**:
  ```text
  If a Transfer-Encoding header field is present in a request and the
  chunked transfer coding is not the final encoding, the message body
  length cannot be determined reliably; the server MUST respond with
  the 400 (Bad Request) status code and then close the connection.
  ```
- **RFC 9112 §7.1 (Host Header Validation)**:
  ```text
  A client MUST send a Host header field in all HTTP/1.1 request
  messages... A server MUST respond with a 400 (Bad Request) status code
  to any HTTP/1.1 request message that lacks a Host header field and to
  any request message that contains more than one Host header field or
  a Host header field with an invalid field value.
  ```
- **RFC 9112 §7.1 / Chunk Extension Parsing**:
  Empty chunk sizes (`\r\n` without hex digits) or invalid hex sizes MUST be rejected immediately with `400 Bad Request`.

---

## The Anti-Pattern
```rust
// BAD: Ignoring duplicate Host headers or accepting non-final chunked encoding
let host_count = req.headers().get_all(header::HOST).count();
if host_count == 0 && req.version() == Version::HTTP_11 {
    // Missing: what if host_count > 1? Request smuggling vulnerability!
}

if let Some(te) = req.headers().get(header::TRANSFER_ENCODING) {
    if te.to_str().unwrap().contains("chunked") {
        // BUG: "gzip, chunked, gzip" contains "chunked", but chunked is NOT final!
        parse_chunked();
    }
}
```

## The Corrected Pattern & Verification Invariant

```rust
// GOOD: Strict RFC 9112 §7.1 and §6.3 enforcement
// 1. Host Header: Exactly one Host header required in HTTP/1.1
if req.version() == Version::HTTP_11 {
    let mut host_iter = req.headers().get_all(header::HOST);
    match (host_iter.next(), host_iter.next()) {
        (None, _) => return Err(ParseError::MissingHostHeader), // 400
        (Some(_), Some(_)) => return Err(ParseError::DuplicateHostHeader), // 400
        (Some(host), None) => validate_host_value(host)?,
    }
}

// 2. Transfer-Encoding: Chunked MUST be the last coding
if let Some(te_values) = req.headers().get_all(header::TRANSFER_ENCODING).last() {
    let encodings: Vec<_> = te_values.to_str()?.split(',').map(|s| s.trim()).collect();
    if let Some(&last) = encodings.last() {
        if !last.eq_ignore_ascii_case("chunked") {
            return Err(ParseError::ChunkedNotFinal); // 400 + Close
        }
    }
}
```
