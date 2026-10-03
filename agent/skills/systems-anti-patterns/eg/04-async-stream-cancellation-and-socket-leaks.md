# Case 04: Async Streams, Cancellation Safety & Socket Leak Prevention

## Context & Incidents
Observed in async networking frameworks (Actix-Net, Tokio, Hyper, Actix-Web #966).

---

## 1. Lazy Stream Execution & Uncollected Result Streams

### The Anti-Pattern
```rust
// BAD: Dropping a stream without driving it to completion
let delete_stream = store.delete_stream(paths_stream);
// delete_stream dropped here -> NO HTTP requests are dispatched!
```
* **Why it breaks**: In Rust `futures::Stream`, streams are lazy state machines. If the stream is not polled or collected, no work happens.

### The Correct Pattern
```rust
// GOOD: Drive result stream to completion with proper error propagation
let delete_stream = store.delete_stream(paths_stream);
delete_stream.try_for_each(|res| async move {
    res.map(|_| ())
}).await?;
```

---

## 2. Server Cancellation & Socket Leak (Actix #966)

### The Anti-Pattern
```rust
// BAD: Checking a boolean flag during cancellation
impl Server {
    pub fn cancel(&mut self) {
        if self.stopping {
            return;
        }
        self.stopping = true;
        // BUG: TCP listener sockets remain bound to the OS port
    }
}
```
* **Why it breaks**: If graceful shutdown is interrupted or the server object is dropped, the OS port remains bound in `LISTEN` state, preventing restarts with `EADDRINUSE`.

### The Correct Pattern
```rust
// GOOD: Guard resource cleanup on the actual resource handle via .take()
impl Server {
    pub fn cancel(&mut self) {
        if let Some(handles) = self.listeners.take() {
            for listener in handles {
                drop(listener); // closes raw OS socket immediately
            }
        }
    }
}
```
