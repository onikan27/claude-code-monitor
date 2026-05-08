// Hook event types
export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'UserPromptSubmit';

// Event received from hooks (for internal processing)
export interface HookEvent {
  session_id: string;
  cwd: string;
  tty?: string;
  hook_event_name: HookEventName;
  notification_type?: string;
  transcript_path?: string;
}

// Session status
export type SessionStatus = 'running' | 'waiting_input' | 'stopped';

// Session information (minimal)
export interface Session {
  session_id: string;
  cwd: string;
  tty?: string;
  pid?: number;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  lastMessage?: string;
}

// File store data structure
export interface StoreData {
  sessions: Record<string, Session>;
  updated_at: string;
}
