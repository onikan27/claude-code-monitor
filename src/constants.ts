/**
 * Shared constants for claude-code-monitor
 */

/** Package name used for npx commands */
export const PACKAGE_NAME = 'claude-code-monitor';

/** TTY cache TTL in milliseconds (30 seconds) */
export const TTY_CACHE_TTL_MS = 30_000;

/** Maximum number of entries in TTY cache */
export const MAX_TTY_CACHE_SIZE = 100;

/** Debounce delay for useSessions updates in milliseconds */
export const SESSION_UPDATE_DEBOUNCE_MS = 150;

/** Debounce delay for JSON file writes in milliseconds */
export const WRITE_DEBOUNCE_MS = 100;

/** Periodic refresh interval for timeout detection in milliseconds (60 seconds) */
export const SESSION_REFRESH_INTERVAL_MS = 60_000;

/**
 * QRコード表示に必要な最小ターミナル高さ
 * Header(1) + Sessions(3) + Shortcuts(2) + WebUI with QR(16) = 22行
 */
export const MIN_TERMINAL_HEIGHT_FOR_QR = 22;

/** Hook event types supported by Claude Code */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
] as const;

/** Default port for mobile web server */
export const DEFAULT_SERVER_PORT = 3456;
