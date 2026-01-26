import { executeAppleScript } from './applescript.js';
import {
  generateTitleTag,
  isLinux,
  isMacOS,
  isValidTtyPath,
  sanitizeForAppleScript,
  setTtyTitle,
} from './focus.js';
import {
  hasXdotool,
  sendKeystrokeToTerminalLinux,
  sendTextToTerminalLinux,
} from './linux-terminal.js';
import { executeWithTerminalFallback } from './terminal-strategy.js';

/**
 * Maximum text length allowed for sending to terminal.
 * This is a security measure to prevent accidental or malicious large inputs.
 */
const MAX_TEXT_LENGTH = 10000;

/**
 * Validate text input for sending to terminal.
 * @internal
 */
export function validateTextInput(text: string): { valid: boolean; error?: string } {
  if (!text || text.trim().length === 0) {
    return { valid: false, error: 'Text cannot be empty' };
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return { valid: false, error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` };
  }

  return { valid: true };
}

/**
 * Build AppleScript to send text to iTerm2 session by TTY.
 * Uses clipboard and Cmd+V to paste text, then sends Enter key.
 * This approach supports Unicode characters including Japanese.
 */
function buildITerm2SendTextScript(tty: string, text: string): string {
  const safeTty = sanitizeForAppleScript(tty);
  const safeText = sanitizeForAppleScript(text);
  return `
set the clipboard to "${safeText}"
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if tty of aSession is "${safeTty}" then
          select aSession
          select aTab
          tell aWindow to select
          activate
          delay 0.3
          tell application "System Events"
            set frontmost of process "iTerm2" to true
            delay 0.1
            tell process "iTerm2"
              keystroke "v" using command down
              delay 0.1
              keystroke return
            end tell
          end tell
          return true
        end if
      end repeat
    end repeat
  end repeat
  return false
end tell
`;
}

/**
 * Build AppleScript to send text to Terminal.app by TTY.
 * Uses clipboard and Cmd+V to paste text, then sends Enter key.
 * This approach supports Unicode characters including Japanese.
 */
function buildTerminalAppSendTextScript(tty: string, text: string): string {
  const safeTty = sanitizeForAppleScript(tty);
  const safeText = sanitizeForAppleScript(text);
  return `
set the clipboard to "${safeText}"
tell application "Terminal"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      if tty of aTab is "${safeTty}" then
        set selected of aTab to true
        set index of aWindow to 1
        activate
        delay 0.2
        tell application "System Events"
          tell process "Terminal"
            keystroke "v" using command down
            delay 0.1
            keystroke return
          end tell
        end tell
        return true
      end if
    end repeat
  end repeat
  return false
end tell
`;
}

/**
 * Build AppleScript to send text to Ghostty via System Events.
 * Ghostty doesn't support TTY-based targeting, so we send to the active window.
 * Uses clipboard and Cmd+V to paste text, then sends Enter key.
 * This approach supports Unicode characters including Japanese.
 */
function buildGhosttyFocusScript(titleTag: string): string {
  const safeTag = sanitizeForAppleScript(titleTag);
  return `
-- Activate Ghostty first (required when called from Web UI with Ghostty in background)
tell application "Ghostty" to activate
delay 0.1

tell application "System Events"
  if not (exists process "Ghostty") then
    return false
  end if
  tell process "Ghostty"
    try
      set windowMenu to menu "Window" of menu bar 1
      set menuItems to every menu item of windowMenu whose name contains "${safeTag}"
      if (count of menuItems) > 0 then
        -- Ghostty quirk: first click selects the tab, second click brings the window to front
        click item 1 of menuItems
        delay 0.05
        click item 1 of menuItems
        delay 0.05
        -- Raise the correct window (overrides initial activate which may have raised wrong window)
        try
          perform action "AXRaise" of window 1
        end try
        return true
      end if
    end try
  end tell
end tell
return false
`;
}

function buildGhosttySendTextScript(text: string): string {
  const safeText = sanitizeForAppleScript(text);
  return `
set the clipboard to "${safeText}"
delay 0.1
tell application "System Events"
  tell process "Ghostty"
    keystroke "v" using command down
    delay 0.2
    keystroke return
  end tell
end tell
return true
`;
}

function sendTextToITerm2(tty: string, text: string): boolean {
  return executeAppleScript(buildITerm2SendTextScript(tty, text));
}

function sendTextToTerminalApp(tty: string, text: string): boolean {
  return executeAppleScript(buildTerminalAppSendTextScript(tty, text));
}

function sendTextToGhostty(tty: string, text: string): boolean {
  const titleTag = generateTitleTag(tty);

  // Set title tag for window identification
  const titleSet = setTtyTitle(tty, titleTag);

  if (titleSet) {
    // Wait for title to propagate to Window menu
    const waitScript = 'delay 0.2';
    executeAppleScript(waitScript);
  }

  // Focus the target tab first using Window menu
  const focusScript = buildGhosttyFocusScript(titleTag);
  executeAppleScript(focusScript);

  // Clear title to let shell restore it
  if (titleSet) {
    setTtyTitle(tty, '');
  }

  // Now send text to the focused tab
  return executeAppleScript(buildGhosttySendTextScript(text));
}

// ============================================
// Direct Keystroke Functions (for permission prompts)
// ============================================

/**
 * Build AppleScript to send a single keystroke to iTerm2 session by TTY.
 * Used for permission prompts that expect single key input (y/n/a).
 */
function buildITerm2KeystrokeScript(
  tty: string,
  key: string,
  useControl = false,
  useKeyCode?: number
): string {
  const safeTty = sanitizeForAppleScript(tty);
  const safeKey = sanitizeForAppleScript(key);
  const modifiers = useControl ? ' using control down' : '';
  const keystrokeCmd =
    useKeyCode !== undefined ? `key code ${useKeyCode}` : `keystroke "${safeKey}"${modifiers}`;
  return `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if tty of aSession is "${safeTty}" then
          select aSession
          select aTab
          tell aWindow to select
          activate
          delay 0.2
          tell application "System Events"
            set frontmost of process "iTerm2" to true
            delay 0.1
            tell process "iTerm2"
              ${keystrokeCmd}
            end tell
          end tell
          return true
        end if
      end repeat
    end repeat
  end repeat
  return false
end tell
`;
}

/**
 * Build AppleScript to send a single keystroke to Terminal.app by TTY.
 */
function buildTerminalAppKeystrokeScript(
  tty: string,
  key: string,
  useControl = false,
  useKeyCode?: number
): string {
  const safeTty = sanitizeForAppleScript(tty);
  const safeKey = sanitizeForAppleScript(key);
  const modifiers = useControl ? ' using control down' : '';
  const keystrokeCmd =
    useKeyCode !== undefined ? `key code ${useKeyCode}` : `keystroke "${safeKey}"${modifiers}`;
  return `
tell application "Terminal"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      if tty of aTab is "${safeTty}" then
        set selected of aTab to true
        set index of aWindow to 1
        activate
        delay 0.2
        tell application "System Events"
          tell process "Terminal"
            ${keystrokeCmd}
          end tell
        end tell
        return true
      end if
    end repeat
  end repeat
  return false
end tell
`;
}

/**
 * Build AppleScript to send a single keystroke to Ghostty.
 */
function buildGhosttyKeystrokeScript(key: string, useControl = false, useKeyCode?: number): string {
  const safeKey = sanitizeForAppleScript(key);
  const modifiers = useControl ? ' using control down' : '';
  const keystrokeCmd =
    useKeyCode !== undefined ? `key code ${useKeyCode}` : `keystroke "${safeKey}"${modifiers}`;
  return `
delay 0.1
tell application "System Events"
  tell process "Ghostty"
    ${keystrokeCmd}
  end tell
end tell
return true
`;
}

function sendKeystrokeToITerm2(
  tty: string,
  key: string,
  useControl = false,
  useKeyCode?: number
): boolean {
  return executeAppleScript(buildITerm2KeystrokeScript(tty, key, useControl, useKeyCode));
}

function sendKeystrokeToTerminalApp(
  tty: string,
  key: string,
  useControl = false,
  useKeyCode?: number
): boolean {
  return executeAppleScript(buildTerminalAppKeystrokeScript(tty, key, useControl, useKeyCode));
}

function sendKeystrokeToGhostty(
  tty: string,
  key: string,
  useControl = false,
  useKeyCode?: number
): boolean {
  const titleTag = generateTitleTag(tty);

  // Set title tag for window identification
  const titleSet = setTtyTitle(tty, titleTag);

  if (titleSet) {
    // Wait for title to propagate to Window menu
    const waitScript = 'delay 0.2';
    executeAppleScript(waitScript);
  }

  // Focus the target tab first using Window menu
  const focusScript = buildGhosttyFocusScript(titleTag);
  executeAppleScript(focusScript);

  // Clear title to let shell restore it
  if (titleSet) {
    setTtyTitle(tty, '');
  }

  // Now send keystroke to the focused tab
  return executeAppleScript(buildGhosttyKeystrokeScript(key, useControl, useKeyCode));
}

/**
 * Send text to a terminal session and execute it (press Enter).
 * On macOS: Tries iTerm2, Terminal.app, and Ghostty in order.
 * On Linux: Uses xdotool if available.
 *
 * @param tty - The TTY path of the target terminal session
 * @param text - The text to send to the terminal
 * @returns Result object with success status and optional error message
 *
 * @remarks
 * - macOS: Uses AppleScript for iTerm2, Terminal.app, and Ghostty
 * - Linux: Uses xdotool (must be installed)
 * - For iTerm2 and Terminal.app, targets specific TTY
 * - For Ghostty, sends to the active window (TTY targeting not supported)
 * - System Events usage for Ghostty may require accessibility permissions
 */
export function sendTextToTerminal(
  tty: string,
  text: string
): { success: boolean; error?: string } {
  if (!isValidTtyPath(tty)) {
    return { success: false, error: 'Invalid TTY path' };
  }

  const validation = validateTextInput(text);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  if (isMacOS()) {
    const success = executeWithTerminalFallback({
      iTerm2: () => sendTextToITerm2(tty, text),
      terminalApp: () => sendTextToTerminalApp(tty, text),
      ghostty: () => sendTextToGhostty(tty, text),
    });

    return success
      ? { success: true }
      : { success: false, error: 'Could not send text to any terminal' };
  }

  if (isLinux()) {
    if (!hasXdotool()) {
      return {
        success: false,
        error: 'xdotool is required on Linux. Install with: sudo apt install xdotool',
      };
    }
    const success = sendTextToTerminalLinux(tty, text);
    return success
      ? { success: true }
      : { success: false, error: 'Could not send text to terminal' };
  }

  return { success: false, error: 'This feature is only available on macOS and Linux' };
}

/**
 * Allowed keys for permission prompt responses.
 */
const ALLOWED_KEYS = new Set([
  'y',
  'n',
  'a',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'escape',
]);

/**
 * macOS key code for Escape key.
 */
const ESCAPE_KEY_CODE = 53;

/**
 * Send a single keystroke to a terminal session.
 * Used for responding to permission prompts (y/n/a), Ctrl+C to abort, or Escape to cancel.
 *
 * @param tty - The TTY path of the target terminal session
 * @param key - Single character key to send (y, n, a, 1-9, escape, etc.)
 * @param useControl - If true, send with Control modifier (for Ctrl+C)
 * @returns Result object with success status
 */
export function sendKeystrokeToTerminal(
  tty: string,
  key: string,
  useControl = false
): { success: boolean; error?: string } {
  if (!isValidTtyPath(tty)) {
    return { success: false, error: 'Invalid TTY path' };
  }

  const lowerKey = key.toLowerCase();
  const isEscapeKey = lowerKey === 'escape';

  // Validate key input (escape is special, others must be single character)
  if (!isEscapeKey && (!key || key.length !== 1)) {
    return { success: false, error: 'Key must be a single character or "escape"' };
  }

  // Only allow specific keys for security
  if (!useControl && !ALLOWED_KEYS.has(lowerKey)) {
    return { success: false, error: 'Invalid key. Allowed: y, n, a, 1-9, escape' };
  }

  // For Ctrl+C, only allow 'c'
  if (useControl && lowerKey !== 'c') {
    return { success: false, error: 'Only Ctrl+C is supported' };
  }

  if (isMacOS()) {
    // Determine if we need to use key code (for Escape key)
    const useKeyCode = isEscapeKey ? ESCAPE_KEY_CODE : undefined;

    const success = executeWithTerminalFallback({
      iTerm2: () => sendKeystrokeToITerm2(tty, key, useControl, useKeyCode),
      terminalApp: () => sendKeystrokeToTerminalApp(tty, key, useControl, useKeyCode),
      ghostty: () => sendKeystrokeToGhostty(tty, key, useControl, useKeyCode),
    });

    return success
      ? { success: true }
      : { success: false, error: 'Could not send keystroke to any terminal' };
  }

  if (isLinux()) {
    if (!hasXdotool()) {
      return {
        success: false,
        error: 'xdotool is required on Linux. Install with: sudo apt install xdotool',
      };
    }
    const success = sendKeystrokeToTerminalLinux(tty, key, useControl);
    return success
      ? { success: true }
      : { success: false, error: 'Could not send keystroke to terminal' };
  }

  return { success: false, error: 'This feature is only available on macOS and Linux' };
}
