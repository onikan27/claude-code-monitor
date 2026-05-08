import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
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
const LOCK_DIR = join(STORE_DIR, '.lock');
const LOCK_MAX_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_STALE_MS = 5_000;

export interface Settings {
  qrCodeVisible: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  qrCodeVisible: false,
};

// In-memory cache for batched writes
let cachedStore: StoreData | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      mkdirSync(LOCK_DIR);
      return true;
    } catch {
      // Check for stale lock (e.g., process crashed while holding it)
      try {
        const stat = readFileSync(join(LOCK_DIR, '.pid'), 'utf-8');
        const lockAge = Date.now() - parseInt(stat, 10);
        if (lockAge > LOCK_STALE_MS) {
          releaseLock();
          continue;
        }
      } catch {
        // No .pid file or unreadable — check dir age via retry exhaustion
      }
      const end = Date.now() + LOCK_RETRY_DELAY_MS;
      while (Date.now() < end) {
        // spin wait
      }
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    rmdirSync(LOCK_DIR, { recursive: true });
  } catch {
    // Already released
  }
}

function withLock<T>(fn: () => T): T {
  const locked = acquireLock();
  if (locked) {
    try {
      writeFileSync(join(LOCK_DIR, '.pid'), String(Date.now()), 'utf-8');
    } catch {
      // Best effort
    }
  }
  try {
    return fn();
  } finally {
    if (locked) {
      releaseLock();
    }
  }
}

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

  // PreToolUse means active work (including subagents) — resume even if stopped
  if (event.hook_event_name === 'PreToolUse') {
    return 'running';
  }

  // Keep stopped state for other events (PostToolUse, non-permission Notification)
  if (currentStatus === 'stopped') {
    return 'stopped';
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
  // Pre-compute transcript outside the lock to minimize lock hold time
  const assistantMessage = event.transcript_path
    ? getLastAssistantMessage(event.transcript_path)
    : undefined;

  return withLock(() => {
    // Read fresh from disk inside the lock to avoid stale data
    const prevCache = cachedStore;
    cachedStore = null;
    const store = readStore();

    const key = getSessionKey(event.session_id, event.tty);
    const now = new Date().toISOString();

    if (event.tty) {
      removeOldSessionsOnSameTty(store.sessions, event.session_id, event.tty);
    }

    const existing = store.sessions[key];
    const lastMessage = assistantMessage ?? existing?.lastMessage;

    const session: Session = {
      session_id: event.session_id,
      cwd: event.cwd,
      tty: event.tty ?? existing?.tty,
      pid: event.pid ?? existing?.pid,
      status: determineStatus(event, existing?.status),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      lastMessage,
    };

    store.sessions[key] = session;

    // Write synchronously inside the lock — bypass debounce
    try {
      ensureStoreDir();
      store.updated_at = now;
      writeFileSync(STORE_FILE, JSON.stringify(store), { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // Restore previous cache on failure
      cachedStore = prevCache;
    }

    return session;
  });
}

export function getSessions(): Session[] {
  const store = readStore();

  let hasChanges = false;
  for (const [key, session] of Object.entries(store.sessions)) {
    const isTtyStillAlive = isTtyAlive(session.tty);

    // Remove sessions when TTY no longer exists
    if (!isTtyStillAlive) {
      delete store.sessions[key];
      hasChanges = true;
      continue;
    }

    // Remove sessions whose Claude Code process has exited
    if (session.pid && !isProcessAlive(session.pid)) {
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
