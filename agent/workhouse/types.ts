/**
 * pi-workhouse: Domain Models, Types, and IPC Protocols
 */

export interface SessionRecord {
  id: string;
  pid: number;
  name: string;
  role: "workhouse" | "worker";
  cwd: string;
  project: string;
  git_branch: string | null;
  socket_path: string;
  status: "active" | "idle" | "busy" | "offline";
  created_at: number;
  last_heartbeat: number;
  metadata: string | null;
}

export interface MessageRecord {
  id: string;
  channel: string;
  sender_id: string;
  sender_name: string;
  target_id: string | null;
  content: string;
  type: "text" | "direct_task" | "help_request" | "alert";
  metadata: string | null;
  created_at: number;
}

export interface ArtifactRecord {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  mime_type: string | null;
  description: string | null;
  created_at: number;
}

export interface ResourceRecord {
  key: string;
  owner_id: string;
  owner_name: string;
  type: "kv" | "json";
  value: string;
  description: string | null;
  tags: string | null;
  updated_at: number;
  expires_at: number | null;
}

export interface LockRecord {
  name: string;
  holder_id: string;
  holder_name: string;
  acquired_at: number;
  expires_at: number;
}

export interface TaskRecord {
  id: string;
  from_session_id: string;
  from_session_name: string;
  to_session_id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  result: string | null;
  created_at: number;
  updated_at: number;
}

// IPC Frame Protocol
export type WorkhouseFrame =
  | { type: "PING"; sender_id: string; sender_name: string; timestamp: number; directive?: string }
  | {
      type: "PONG";
      responder_id: string;
      responder_name: string;
      role: "workhouse" | "worker";
      pid: number;
      echo_timestamp: number;
      responder_time: number;
    }
  | { type: "REGISTER_WORKER"; session: SessionRecord }
  | { type: "WORKER_JOINED"; session: SessionRecord }
  | { type: "WORKER_LEFT"; session_id: string }
  | { type: "MESSAGE"; message: MessageRecord }
  | {
      type: "DIRECT_TASK";
      from_session_id: string;
      from_session_name: string;
      to_session_id: string;
      taskId: string;
      title: string;
      instruction: string;
      priority?: string;
    }
  | {
      type: "TASK_UPDATE";
      taskId: string;
      status: "in_progress" | "completed" | "failed";
      result?: string;
      from_session_name: string;
    }
  | {
      type: "ARTIFACT_SHARED";
      artifact: ArtifactRecord;
    }
  | {
      type: "RESOURCE_UPDATE";
      key: string;
      owner_name: string;
      action: "set" | "delete";
    }
  | {
      type: "WORKHOUSE_ELECTED";
      new_workhouse: SessionRecord;
    };

// High-Contrast Monochromatic Terminal Palette
export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[38;2;80;210;255m",
  boldCyan: "\x1b[1;38;2;0;225;225m",
  green: "\x1b[38;2;80;230;130m",
  boldGreen: "\x1b[1;38;2;80;230;130m",
  red: "\x1b[38;2;255;85;105m",
  yellow: "\x1b[38;2;255;195;60m",
  boldYellow: "\x1b[1;38;2;255;195;60m",
  purple: "\x1b[38;2;200;120;255m",
  magenta: "\x1b[38;2;255;110;220m",
  gray: "\x1b[38;2;130;145;165m",
  border: "\x1b[38;2;75;105;140m",
  borderActive: "\x1b[38;2;120;170;240m",
  bgHeader: "\x1b[48;2;20;32;52;1;38;2;230;245;255m",
  bgWorkhouse: "\x1b[48;2;15;50;40;1;38;2;120;255;190m",
  bgWorker: "\x1b[48;2;40;30;60;1;38;2;210;190;255m",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatLatency(ms: number): string {
  if (ms < 1.0) return `${C.boldGreen}${ms.toFixed(2)}ms${C.reset}`;
  if (ms < 5.0) return `${C.yellow}${ms.toFixed(2)}ms${C.reset}`;
  return `${C.red}${ms.toFixed(2)}ms${C.reset}`;
}
