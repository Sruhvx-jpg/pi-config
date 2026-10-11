/**
 * pi-workhouse: Dedicated Big-Resource Artifact Depot
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { WORKHOUSE_ARTIFACTS_DIR } from "./db.ts";
import type { ArtifactRecord } from "./types.ts";

export class ArtifactDepot {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  public share(
    sourcePath: string,
    ownerId: string,
    ownerName: string,
    cwd: string,
    artifactName?: string,
    description?: string
  ): ArtifactRecord {
    const absPath = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.resolve(cwd, sourcePath);

    if (!fs.existsSync(absPath)) {
      throw new Error(`File does not exist: ${absPath}`);
    }

    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${absPath}`);
    }

    const fileBuffer = fs.readFileSync(absPath);
    const hash = crypto
      .createHash("sha256")
      .update(fileBuffer)
      .digest("hex");

    const baseName = path.basename(absPath);
    const resolvedName = (artifactName || baseName).trim();
    const destFileName = `${hash.slice(0, 16)}_${baseName}`;
    const storagePath = path.join(WORKHOUSE_ARTIFACTS_DIR, destFileName);

    fs.writeFileSync(storagePath, fileBuffer);

    const artifactId = `art-${Date.now()}-${hash.slice(0, 8)}`;
    const now = Date.now();

    const record: ArtifactRecord = {
      id: artifactId,
      name: resolvedName,
      owner_id: ownerId,
      owner_name: ownerName,
      size_bytes: stat.size,
      sha256: hash,
      storage_path: storagePath,
      mime_type: path.extname(baseName) || "application/octet-stream",
      description: description || `Shared by ${ownerName}`,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT OR REPLACE INTO artifacts (id, name, owner_id, owner_name, size_bytes, sha256, storage_path, mime_type, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.name,
        record.owner_id,
        record.owner_name,
        record.size_bytes,
        record.sha256,
        record.storage_path,
        record.mime_type,
        record.description,
        record.created_at
      );

    return record;
  }

  public get(nameOrId: string): ArtifactRecord | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE name = ? OR id = ?")
      .get(nameOrId, nameOrId) as unknown as ArtifactRecord | undefined;
    return row || null;
  }

  public list(): ArtifactRecord[] {
    return this.db
      .prepare("SELECT * FROM artifacts ORDER BY created_at DESC")
      .all() as unknown as ArtifactRecord[];
  }

  public fetch(
    nameOrId: string,
    cwd: string,
    targetDestination?: string
  ): { targetPath: string; bytesWritten: number; originalName: string; sha256: string } {
    const record = this.get(nameOrId);
    if (!record) {
      throw new Error(`Artifact not found: ${nameOrId}`);
    }

    if (!fs.existsSync(record.storage_path)) {
      throw new Error(`Storage file missing at: ${record.storage_path}`);
    }

    const target = targetDestination
      ? path.isAbsolute(targetDestination)
        ? targetDestination
        : path.resolve(cwd, targetDestination)
      : path.resolve(cwd, record.name);

    fs.copyFileSync(record.storage_path, target);

    return {
      targetPath: target,
      bytesWritten: record.size_bytes,
      originalName: record.name,
      sha256: record.sha256,
    };
  }

  public delete(nameOrId: string): boolean {
    const record = this.get(nameOrId);
    if (!record) return false;

    if (fs.existsSync(record.storage_path)) {
      try {
        fs.unlinkSync(record.storage_path);
      } catch {}
    }

    const res = this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(record.id);
    return res.changes > 0;
  }
}
