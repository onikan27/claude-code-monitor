import { flushPendingWrites, updateSession } from '../store/file-store.js';
import type { HookEvent, HookEventName } from '../types/index.js';
import { readJsonFromStdin } from '../utils/stdin.js';
import { buildTranscriptPath } from '../utils/transcript.js';

// Allowed hook event names (whitelist)
/** @internal */
export const VALID_HOOK_EVENTS: ReadonlySet<string> = new Set<HookEventName>([
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'UserPromptSubmit',
]);

/** @internal */
export function isValidHookEventName(name: string): name is HookEventName {
  return VALID_HOOK_EVENTS.has(name);
}

/** @internal */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export async function handleHookEvent(eventName: string, tty?: string): Promise<void> {
  // Validate event name against whitelist
  if (!isValidHookEventName(eventName)) {
    console.error(`Invalid event name: ${eventName}`);
    process.exit(1);
  }

  let rawInput: Record<string, unknown>;
  try {
    rawInput = await readJsonFromStdin<Record<string, unknown>>();
  } catch {
    console.error('Invalid JSON input');
    process.exit(1);
  }

  // Validate required fields
  if (!isNonEmptyString(rawInput.session_id)) {
    console.error('Invalid or missing session_id');
    process.exit(1);
  }

  // Validate optional fields if present
  if (rawInput.cwd !== undefined && typeof rawInput.cwd !== 'string') {
    console.error('Invalid cwd: must be a string');
    process.exit(1);
  }

  if (rawInput.notification_type !== undefined && typeof rawInput.notification_type !== 'string') {
    console.error('Invalid notification_type: must be a string');
    process.exit(1);
  }

  // Get transcript_path: use provided path or build from cwd and session_id
  const cwd = (rawInput.cwd as string) || process.cwd();
  const transcriptPath =
    typeof rawInput.transcript_path === 'string'
      ? rawInput.transcript_path
      : buildTranscriptPath(cwd, rawInput.session_id);

  const event: HookEvent = {
    session_id: rawInput.session_id,
    cwd,
    tty,
    wezterm_pane_id:
      process.env.WEZTERM_PANE && /^\d+$/.test(process.env.WEZTERM_PANE)
        ? process.env.WEZTERM_PANE
        : undefined,
    hook_event_name: eventName,
    notification_type: rawInput.notification_type as string | undefined,
    transcript_path: transcriptPath,
  };

  updateSession(event);

  // Ensure data is written before process exits (hooks are short-lived processes)
  flushPendingWrites();
}
