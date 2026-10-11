/**
 * pi-workhouse: SQLite WAL Database Layer & Persistence Engine
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  SessionRecord,
  MessageRecord,
  ArtifactRecord,
  ResourceRecord,
  LockRecord,
  TaskRecord,
} from "./types.ts";

export const WORKHOUSE_DIR = path.join(os.homedir(), ".pi", "agent", "workhouse");
export const WORKHOUSE_DATA_DIR = path.join(WORKHOUSE_DIR, "data");
export const WORKHOUSE_DB_PATH = path.join(WORKHOUSE_DATA_DIR, "workhouse.db");
export const WORKHOUSE_HUB_SOCK = path.join(WORKHOUSE_DATA_DIR, "workhouse.sock");
export const WORKHOUSE_SOCKETS_DIR = path.join(WORKHOUSE_DATA_DIR, "sockets");
export const WORKHOUSE_ARTIFACTS_DIR = path.join(WORKHOUSE_DATA_DIR, "artifacts");

export function ensureDirectories(): void {
  fs.mkdirSync(WORKHOUSE_DIR, { recursive: true });
  fs.mkdirSync(WORKHOUSE_DATA_DIR, { recursive: true });
  fs.mkdirSync(WORKHOUSE_SOCKETS_DIR, { recursive: true });
  fs.mkdirSync(WORKHOUSE_ARTIFACTS_DIR, { recursive: true });
}

let dbInstance: DatabaseSync | null = null;

export function getWorkhouseDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  ensureDirectories();

  const db = new DatabaseSync(WORKHOUSE_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      cwd TEXT NOT NULL,
      project TEXT NOT NULL,
      git_branch TEXT,
      socket_path TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      target_id TEXT,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      owner_id TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT,
      description TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resources (
      key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS locks (
      name TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL,
      holder_name TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      from_session_id TEXT NOT NULL,
      from_session_name TEXT NOT NULL,
      to_session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wh_messages_channel ON messages(channel, created_at);
    CREATE INDEX IF NOT EXISTS idx_wh_messages_target ON messages(target_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_wh_tasks_target ON tasks(to_session_id, status);
    CREATE INDEX IF NOT EXISTS idx_wh_artifacts_name ON artifacts(name);
  `);

  dbInstance = db;
  return db;
}
