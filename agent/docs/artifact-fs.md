# ArtifactFS Integration Guide

Cloudflare **ArtifactFS** is a Git-backed **FUSE (Filesystem in Userspace)** driver designed to eliminate repository clone latency for AI coding agents, sandboxes, and ephemeral environments.

---

## 1. Why ArtifactFS?

| Feature | Standard `git clone` | ArtifactFS FUSE Mount |
| :--- | :--- | :--- |
| **Startup Latency** | Minutes (downloads GBs of history + full blobs) | **< 1-2 seconds** (fetches only commit/tree metadata) |
| **Bandwidth** | 100% of repo blobs downloaded upfront | **< 1%** (streams only accessed files on demand) |
| **Working Tree** | Local files written to disk | **Instant FUSE mount** with directory tree in userspace |
| **File Reads** | Local disk I/O | **Transparent blocking fetch** on first read (`git cat-file`) |
| **Modifications** | Direct disk mutations | **SQLite Writable Overlay** (isolated without dirtying git base) |

---

## 2. Architecture & Lifecycle

```
[ Git Remote (GitHub/GitLab) ]
             |
             v  (Blobless metadata transfer: --filter=blob:none)
[ ArtifactFS Daemon (~/.local/share/artifact-fs) ]
             |
             v  (Kernel FUSE Mount: ~/.local/share/artifact-fs/mnt/<repo>)
[ Merged Working Tree (Read Blobs + SQLite Writable Overlay) ]
             |
             +-----------------------------------+
             |                                   |
             v                                   v
[ Assistant File Tools (read, grep, edit) ]   [ Terminal / User Shell ]
```

1. **One-Shot Registration (`artifact-fs add-repo`)**:
   - Fetches commits, trees, and refs without blobs.
   - Indexes directory structure into an internal SQLite snapshot database.
2. **On-Demand Hydration**:
   - Reading an unhydrated file triggers a synchronous blob download via `git cat-file --batch`.
   - Background hydrator goroutines prefetch high-priority files (manifests, package files, entry points).
3. **Writable Overlay Layer**:
   - Modifications, file creates, and deletions are saved to a localized SQLite overlay store (`internal/overlay`), presenting a standard writable directory to the OS.

---

## 3. Installation & Dependencies

### System Requirements
- **FUSE 3**: `/dev/fuse` read/write access and `/usr/bin/fusermount3`.
- **Go 1.26+**: Runtime compiler.

### Binary Installation
```bash
# 1. Install ArtifactFS from Cloudflare upstream
go install github.com/cloudflare/artifact-fs/cmd/artifact-fs@latest

# 2. Symlink or verify on PATH
ln -sf ~/go/bin/artifact-fs ~/.local/bin/artifact-fs
which artifact-fs
```

---

## 4. Pi Extension Architecture (`~/.pi/agent/extensions/artifact-fs.ts`)

The Pi extension wraps the ArtifactFS CLI and daemon, exposing native agent tools and interactive slash commands.

### Agent Tools
- `artifact_fs_mount`:
  - **Parameters**:
    - `url` *(string, required)*: Remote Git URL or shorthand (e.g. `cloudflare/artifact-fs`, `torvalds/linux`).
    - `name` *(string, optional)*: Local mount folder alias.
    - `ref` *(string, optional)*: Target branch/ref (defaults to `refs/heads/main` with `master` fallback).
    - `depth` *(number, optional)*: History depth (default: 0).
    - `refresh` *(string, optional)*: Remote refresh interval (default: `30s`).
  - **Returns**: `{ success: true, repo, mountPath, state, head, hydratedBlobs, hydratedBytes }`.
- `artifact_fs_status`:
  - **Parameters**: `name` *(string, optional)*. Inspects mount status, head commit, and blob hydration metrics.
- `artifact_fs_unmount`:
  - **Parameters**: `name` *(string, required)*, `remove` *(boolean, optional, default: true)*. Unmounts and tears down mount points.
- `artifact_fs_prefetch`:
  - **Parameters**: `name` *(string, optional)*. Triggers heuristic prefetching.

### Interactive Slash Commands
- `/artifact` or `/afs` — Display cyberpunk status table of all mounted repos.
- `/artifact mount <url|owner/repo> [name] [ref]` — Mount a repository on the fly.
- `/artifact status [name]` — Detailed hydration stats for a specific mount.
- `/artifact remove <name>` — Unmount and remove repository registration.
- `/artifact daemon [start|stop|status]` — Manage daemon lifecycle.

---

## 5. Storage Paths

| Path | Purpose |
| :--- | :--- |
| `/tmp/artifact-fs` | Default root state directory (`ARTIFACT_FS_ROOT`). Stores SQLite snapshots & overlay DBs. |
| `/tmp/artifact-fs/mnt` | Default FUSE mount root directory where repos are exposed. |
| `/tmp/artifact-fs/daemon.log` | Background daemon log. |
