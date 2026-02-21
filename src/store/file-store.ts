import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WRITE_DEBOUNCE_MS } from '../constants.js';
import type { HookEvent, Session, SessionStatus, StoreData } from '../types/index.js';
import { getLastAssistantMessage } from '../utils/transcript.js';
import { isTtyAlive } from '../utils/tty-cache.js';

// Re-export for backward compatibility
export { isTtyAlive } from '../utils/tty-cache.js';

const STORE_DIR = join(homedir(), '.claude-monitor');
const STORE_FILE = join(STORE_DIR, 'sessions.json');
const SETTINGS_FILE = join(STORE_DIR, 'settings.json');

export interface Settings {
  qrCodeVisible: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  qrCodeVisible: false,
};

// In-memory cache for batched writes
let cachedStore: StoreData | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function ensureStoreDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  }
}

function getEmptyStoreData(): StoreData {
  return {
    sessions: {},
    updated_at: new Date().toISOString(),
  };
}

export function readStore(): StoreData {
  if (cachedStore) {
    return cachedStore;
  }

  ensureStoreDir();
  if (!existsSync(STORE_FILE)) {
    return getEmptyStoreData();
  }
  try {
    const content = readFileSync(STORE_FILE, 'utf-8');
    return JSON.parse(content) as StoreData;
  } catch {
    return getEmptyStoreData();
  }
}

function flushWrite(): void {
  if (cachedStore) {
    try {
      ensureStoreDir();
      cachedStore.updated_at = new Date().toISOString();
      writeFileSync(STORE_FILE, JSON.stringify(cachedStore), { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // Silently ignore write errors to avoid crashing the hook process
      // Data loss is acceptable as session data is ephemeral
    } finally {
      cachedStore = null;
      writeTimer = null;
    }
  } else {
    writeTimer = null;
  }
}

export function writeStore(data: StoreData): void {
  cachedStore = data;

  // Cancel previous timer and schedule new write
  if (writeTimer) {
    clearTimeout(writeTimer);
  }
  writeTimer = setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
}

/** Immediately flush any pending writes (useful for testing and cleanup) */
export function flushPendingWrites(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    flushWrite();
  }
}

/** Reset the in-memory cache (useful for testing) */
export function resetStoreCache(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  cachedStore = null;
}

/** @internal */
export function getSessionKey(sessionId: string, tty?: string): string {
  return tty ? `${sessionId}:${tty}` : sessionId;
}

/** @internal */
export function removeOldSessionsOnSameTty(
  sessions: Record<string, Session>,
  newSessionId: string,
  tty: string
): void {
  for (const [key, session] of Object.entries(sessions)) {
    if (session.tty === tty && session.session_id !== newSessionId) {
      delete sessions[key];
    }
  }
}

/** @internal */
export function determineStatus(event: HookEvent, currentStatus?: SessionStatus): SessionStatus {
  // Explicit stop event
  if (event.hook_event_name === 'Stop') {
    return 'stopped';
  }

  // UserPromptSubmit starts a new operation, so resume even if stopped
  if (event.hook_event_name === 'UserPromptSubmit') {
    return 'running';
  }

  // Keep stopped state (don't resume except for UserPromptSubmit)
  if (currentStatus === 'stopped') {
    return 'stopped';
  }

  // Active operation event
  if (event.hook_event_name === 'PreToolUse') {
    return 'running';
  }

  // Waiting for permission prompt
  const isPermissionPrompt =
    event.hook_event_name === 'Notification' && event.notification_type === 'permission_prompt';
  if (isPermissionPrompt) {
    return 'waiting_input';
  }

  // Default: running for other events (PostToolUse, etc.)
  return 'running';
}

export function updateSession(event: HookEvent): Session {
  const store = readStore();
  const key = getSessionKey(event.session_id, event.tty);
  const now = new Date().toISOString();

  // Remove old session if a different session exists on the same TTY
  // (e.g., when a new session starts after /clear)
  if (event.tty) {
    removeOldSessionsOnSameTty(store.sessions, event.session_id, event.tty);
  }

  const existing = store.sessions[key];

  // Get latest assistant message from transcript
  const assistantMessage = event.transcript_path
    ? getLastAssistantMessage(event.transcript_path)
    : undefined;
  const lastMessage = assistantMessage ?? existing?.lastMessage;

  const session: Session = {
    session_id: event.session_id,
    cwd: event.cwd,
    tty: event.tty ?? existing?.tty,
    wezterm_pane_id: event.wezterm_pane_id ?? existing?.wezterm_pane_id,
    status: determineStatus(event, existing?.status),
    created_at: existing?.created_at ?? now,
    updated_at: now,
    lastMessage,
  };

  store.sessions[key] = session;
  writeStore(store);

  return session;
}

export function getSessions(): Session[] {
  const store = readStore();

  let hasChanges = false;
  for (const [key, session] of Object.entries(store.sessions)) {
    const isTtyStillAlive = isTtyAlive(session.tty);

    // Only remove sessions when TTY no longer exists
    if (!isTtyStillAlive) {
      delete store.sessions[key];
      hasChanges = true;
    }
  }

  if (hasChanges) {
    writeStore(store);
  }

  return Object.values(store.sessions).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

export function getSession(sessionId: string, tty?: string): Session | undefined {
  const store = readStore();
  const key = getSessionKey(sessionId, tty);
  return store.sessions[key];
}

export function removeSession(sessionId: string, tty?: string): void {
  const store = readStore();
  const key = getSessionKey(sessionId, tty);
  delete store.sessions[key];
  writeStore(store);
}

export function clearSessions(): void {
  writeStore(getEmptyStoreData());
}

export function getStorePath(): string {
  return STORE_FILE;
}

export function readSettings(): Settings {
  ensureStoreDir();
  if (!existsSync(SETTINGS_FILE)) {
    return DEFAULT_SETTINGS;
  }
  try {
    const content = readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(settings: Settings): void {
  ensureStoreDir();
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // Silently ignore write errors
  }
}
