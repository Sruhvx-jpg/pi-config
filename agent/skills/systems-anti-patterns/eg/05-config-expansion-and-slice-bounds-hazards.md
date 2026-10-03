# Case 05: Config Interpolation & Slice Indexing Invariants (Go & Systems)

## Context & Battle-Tested Maintainer Reviews
Observed across Grafana plugins, BanyanDB, and Go systems services.

---

## 1. Double Expansion & Secret Truncation (Opaque Secret Invariant)

### The Anti-Pattern
```go
// BAD: Blindly piping resolved secrets into a secondary expansion pass
func ResolveConfig(raw string) string {
    expanded := customResolver.Expand(raw) // e.g. resolves "$__file{/etc/secret}" to "P@$$w0rd"
    return os.ExpandEnv(expanded)          // BUG: interprets "$w0rd" as empty env var -> truncates to "P@"!
}
```
* **Why it breaks**: If a resolved secret (password, API token, private key) contains literal `$` characters, passing it into `os.ExpandEnv` interprets `$variable` as an environment variable, corrupting and truncating the secret.

### The Correct Pattern
```go
// GOOD: Treat resolved expansion output as opaque literals
func ResolveConfig(raw string) string {
    if isCustomTemplate(raw) {
        return customResolver.Expand(raw) // Do not run a second expansion pass!
    }
    return os.ExpandEnv(raw)
}
```

---

## 2. Unchecked Slice Indexing After Trimming / BOM Stripping

### The Anti-Pattern
```go
// BAD: Unconditionally indexing index 0 after stripping
cleanData := StripBOMFromBytes(data)
if cleanData[0] == '{' { // CRASH: panic: index out of range [0] with length 0
    return parseJSON(cleanData)
}
```
* **Why it breaks**: Empty files or BOM-only files (`0xEF, 0xBB, 0xBF`) return an empty byte slice `[]byte{}` with length 0. Indexing `cleanData[0]` crashes the process immediately.

### The Correct Pattern
```go
// GOOD: Always check len > 0 before indexing
cleanData := StripBOMFromBytes(data)
if len(cleanData) == 0 {
    return nil, ErrEmptyPayload
}
if cleanData[0] == '{' {
    return parseJSON(cleanData)
}
```

---

## 3. Database Row Cursor Iteration (`rows.Err()`)

### The Anti-Pattern
```go
// BAD: Exiting loop without checking rows.Err()
for rows.Next() {
    // scan item...
}
return items, nil // BUG: Silent partial data on network drop mid-query
```
* **Why it breaks**: `rows.Next()` returns `false` on both clean EOF and abnormal cursor/connection errors.

### The Correct Pattern
```go
// GOOD: Always check rows.Err() and defer rows.Close()
defer rows.Close()
for rows.Next() {
    // scan item...
}
if err := rows.Err(); err != nil {
    return nil, fmt.Errorf("cursor error: %w", err)
}
return items, nil
```
