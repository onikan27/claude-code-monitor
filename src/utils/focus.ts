import { accessSync, constants, writeFileSync } from 'node:fs';
import { executeAppleScript } from './applescript.js';
import {
  focusSessionLinux,
  getSupportedTerminalsLinux,
  isLinuxFocusAvailable,
} from './linux-terminal.js';
import { executeWithTerminalFallback } from './terminal-strategy.js';

/**
 * Sanitize a string for safe use in AppleScript.
 * Escapes backslashes, double quotes, control characters, and AppleScript special chars.
 * @internal
 */
export function sanitizeForAppleScript(str: string): string {
  return str
    .replace(/\\/g, '\\\\') // Backslash (must be first)
    .replace(/"/g, '\\"') // Double quote
    .replace(/\n/g, '\\n') // Newline
    .replace(/\r/g, '\\r') // Carriage return
    .replace(/\t/g, '\\t') // Tab
    .replace(/\$/g, '\\$') // Dollar sign (variable reference in some contexts)
    .replace(/`/g, '\\`'); // Backtick
}

/**
 * TTY path pattern for validation.
 * Matches:
 *   - macOS: /dev/ttys000, /dev/tty000
 *   - Linux: /dev/pts/0
 * @internal
 */
const TTY_PATH_PATTERN = /^\/dev\/(ttys?\d+|pts\/\d+)$/;

/**
 * Validate TTY path format.
 * @internal
 */
export function isValidTtyPath(tty: string): boolean {
  return TTY_PATH_PATTERN.test(tty);
}

/**
 * Generate a title tag for a TTY path.
 * Used to identify terminal windows/tabs by their title.
 * @example generateTitleTag('/dev/ttys001') => 'ccm:ttys001'
 * @example generateTitleTag('/dev/pts/0') => 'ccm:pts-0'
 * @internal
 */
export function generateTitleTag(tty: string): string {
  const match = tty.match(/\/dev\/(ttys?\d+|pts\/\d+)$/);
  if (!match) return '';
  const ttyId = match[1].replace('/', '-');
  return `ccm:${ttyId}`;
}

/**
 * Generate an OSC (Operating System Command) escape sequence to set terminal title.
 * OSC 0 sets both icon name and window title.
 * @internal
 */
export function generateOscTitleSequence(title: string): string {
  return `\x1b]0;${title}\x07`;
}

/**
 * Set the terminal title by writing an OSC sequence to the TTY.
 * Returns true if successful, false if the TTY is not writable.
 * @internal
 */
export function setTtyTitle(tty: string, title: string): boolean {
  if (!isValidTtyPath(tty)) return false;
  try {
    accessSync(tty, constants.W_OK);
    writeFileSync(tty, generateOscTitleSequence(title));
    return true;
  } catch {
    return false;
  }
}

function buildITerm2Script(tty: string): string {
  const safeTty = sanitizeForAppleScript(tty);
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
          return true
        end if
      end repeat
    end repeat
  end repeat
  return false
end tell
`;
}

function buildTerminalAppScript(tty: string): string {
  const safeTty = sanitizeForAppleScript(tty);
  return `
tell application "Terminal"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      if tty of aTab is "${safeTty}" then
        set selected of aTab to true
        set index of aWindow to 1
        activate
        return true
      end if
    end repeat
  end repeat
  return false
end tell
`;
}

function buildGhosttyScript(): string {
  return `
tell application "Ghostty"
  activate
end tell
return true
`;
}

function buildGhosttyFocusByTitleScript(titleTag: string): string {
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
    -- Search Window menu for the title tag (uses "name" attribute, not "title")
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

function focusITerm2(tty: string): boolean {
  return executeAppleScript(buildITerm2Script(tty));
}

function focusTerminalApp(tty: string): boolean {
  return executeAppleScript(buildTerminalAppScript(tty));
}

function focusGhostty(tty: string): boolean {
  const titleTag = generateTitleTag(tty);

  // Set title tag for window identification
  const titleSet = setTtyTitle(tty, titleTag);

  if (titleSet) {
    // Wait for title to propagate to Window menu
    const waitScript = 'delay 0.2';
    executeAppleScript(waitScript);
  }

  // Try to focus by searching Window menu for the title tag
  const success = executeAppleScript(buildGhosttyFocusByTitleScript(titleTag));

  // Clear title to let shell restore it
  if (titleSet) {
    setTtyTitle(tty, '');
  }

  if (success) return true;

  // Fallback: activate Ghostty without specific window focus
  return executeAppleScript(buildGhosttyScript());
}

export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

export function isLinux(): boolean {
  return process.platform === 'linux';
}

export function focusSession(tty: string): boolean {
  if (!isValidTtyPath(tty)) return false;

  if (isMacOS()) {
    return executeWithTerminalFallback({
      iTerm2: () => focusITerm2(tty),
      terminalApp: () => focusTerminalApp(tty),
      ghostty: () => focusGhostty(tty),
    });
  }

  if (isLinux()) {
    return focusSessionLinux(tty);
  }

  return false;
}

export function getSupportedTerminals(): string[] {
  if (isMacOS()) {
    return ['iTerm2', 'Terminal.app', 'Ghostty'];
  }
  if (isLinux()) {
    return getSupportedTerminalsLinux();
  }
  return [];
}

export function isFocusAvailable(): boolean {
  if (isMacOS()) {
    return true; // AppleScript is always available on macOS
  }
  if (isLinux()) {
    return isLinuxFocusAvailable();
  }
  return false;
}
