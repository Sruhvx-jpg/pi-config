# Case 03: S3 Cloud Storage, Multipart Upload Invariants & Error Mapping Fidelity

## Context & Battle-Tested Maintainer Reviews
Observed across Apache Iceberg Rust, OpenDAL, and AWS S3 SDK integrations.

---

## 1. Error Mapping Fidelity: Auth Errors $\ne$ `DataInvalid`

### The Anti-Pattern
```rust
// BAD: Converting HTTP 401/403 or permission denied into DataInvalid
match err {
    object_store::Error::PermissionDenied { .. } => {
        Error::new(ErrorKind::DataInvalid, "failed to read manifest")
    }
}
```
* **Why it breaks**: Misleads database query engines into assuming the stored Parquet/metadata file on disk is corrupt, triggering data recovery or corruption alerts instead of notifying operators about expired AWS IAM credentials or IAM role misconfigurations.

### The Correct Pattern
```rust
// GOOD: Preserve permission and authentication errors
match err {
    object_store::Error::NotFound { .. } => Error::new(ErrorKind::NotFound, err),
    object_store::Error::AlreadyExists { .. } => Error::new(ErrorKind::AlreadyExists, err),
    object_store::Error::PermissionDenied { .. } | object_store::Error::Unauthenticated { .. } => {
        Error::new(ErrorKind::PermissionDenied, err)
    }
    _ => Error::new(ErrorKind::Unexpected, err),
}
```

---

## 2. 0-Byte / Empty File Multipart Upload (`400 MalformedXML`)

### The Pitfall
Calling `CompleteMultipartUpload` with zero parts when an empty file is closed without writing any bytes.
* **Why it breaks**: AWS S3 Multipart Upload specification requires $\ge 1$ part. An empty `<CompleteMultipartUpload></CompleteMultipartUpload>` payload triggers `400 MalformedXML`.

### The Correct Pattern
```rust
pub async fn close(&mut self) -> Result<()> {
    if self.uploaded_parts.is_empty() && self.buffer.is_empty() {
        // Upload a 0-byte part or fallback to direct put_object
        self.upload_empty_part().await?;
    }
    self.complete_multipart().await
}
```

---

## 3. S3 Multipart 5 MiB Minimum Part Size Rule

### The Pitfall
Emitting intermediate multipart parts smaller than **5 MiB (5,242,880 bytes)**.
* **Why it breaks**: S3 rejects complete multipart upload requests with `EntityTooSmall` if any part other than the final part is $< 5\text{ MiB}$.

### The Correct Pattern
- Buffer stream chunks in memory until $\ge 5\text{ MiB}$.
- Only flush intermediate parts when buffer $\ge 5\text{ MiB}$.
- Allow the final chunk during `close()` to be $< 5\text{ MiB}$.

---

## 4. Multipart Upload Orphan Leak & RAII Abort Guards

### The Pitfall
Dropping an in-flight `MultipartUpload` without calling `abort()` on error.
* **Why it breaks**: Orphaned parts remain in AWS S3 indefinitely, accumulating silent cloud storage billing.

### The Correct Pattern
```rust
// RAII drop cleanup:
if let Some(upload) = self.upload.take() {
    tokio::spawn(async move {
        if let Err(e) = upload.abort().await {
            tracing::warn!(error = %e, "failed to abort orphaned multipart upload");
        }
    });
}
```
