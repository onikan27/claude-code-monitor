import { execFileSync } from 'node:child_process';
import { accessSync, constants, writeFileSync } from 'node:fs';
import { executeAppleScript } from './applescript.js';
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

/**
 * Cached result of WezTerm CLI availability check.
 * @internal
 */
let wezTermCliAvailable: boolean | null = null;

/**
 * Check if the `wezterm` CLI binary is available on PATH.
 * Result is cached after first invocation.
 */
export function hasWezTermCli(): boolean {
  if (wezTermCliAvailable !== null) return wezTermCliAvailable;
  try {
    execFileSync('wezterm', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    wezTermCliAvailable = true;
  } catch {
    wezTermCliAvailable = false;
  }
  return wezTermCliAvailable;
}

/**
 * Execute a WezTerm CLI command and return trimmed stdout, or null on failure.
 */
export function execWezTermCli(args: string[]): string | null {
  try {
    return execFileSync('wezterm', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();
  } catch {
    return null;
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
tell application "System Events"
  if not (exists process "Ghostty") then return false
end tell
tell application "Ghostty" to activate
return true
`;
}

function buildGhosttyFocusByTitleScript(titleTag: string): string {
  const safeTag = sanitizeForAppleScript(titleTag);
  return `
tell application "System Events"
  if not (exists process "Ghostty") then
    return false
  end if
end tell
tell application "Ghostty" to activate
delay 0.1

tell application "System Events"
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

function buildWezTermActivateScript(): string {
  return `
tell application "System Events"
  if not (exists process "wezterm-gui") then return false
end tell
tell application "WezTerm" to activate
return true
`;
}

function buildWezTermFocusByTitleScript(titleTag: string): string {
  const safeTag = sanitizeForAppleScript(titleTag);
  return `
tell application "System Events"
  if not (exists process "wezterm-gui") then
    return false
  end if
end tell
tell application "WezTerm" to activate
delay 0.1

tell application "System Events"
  tell process "wezterm-gui"
    try
      set windowMenu to menu "Window" of menu bar 1
      set menuItems to every menu item of windowMenu whose name contains "${safeTag}"
      if (count of menuItems) > 0 then
        click item 1 of menuItems
        delay 0.05
        click item 1 of menuItems
        delay 0.05
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

function focusWezTermViaCli(weztermPaneId: string): boolean {
  const listOutput = execWezTermCli(['cli', 'list', '--format', 'json']);
  if (!listOutput) return false;
  try {
    const panes = JSON.parse(listOutput) as unknown;
    if (!Array.isArray(panes)) return false;
    const paneIdNum = Number(weztermPaneId);
    if (!Number.isSafeInteger(paneIdNum)) return false;
    const pane = panes.find(
      (p: Record<string, unknown>) => typeof p?.pane_id === 'number' && p.pane_id === paneIdNum
    ) as { pane_id: number; tab_id: number; window_title?: string } | undefined;
    if (!pane) return false;
    // CLI activate-tab/pane switches focus within WezTerm
    execWezTermCli([
      'cli',
      'activate-tab',
      '--tab-id',
      String(pane.tab_id),
      '--pane-id',
      weztermPaneId,
    ]);
    execWezTermCli(['cli', 'activate-pane', '--pane-id', weztermPaneId]);
    // After CLI activates the pane, we need to raise the correct WezTerm window.
    // Find all panes in the same window to get the window_id, then match by
    // checking each System Events window's title against any tab title in that window.
    const targetWindowId = (pane as Record<string, unknown>).window_id;
    const windowPanes =
      typeof targetWindowId === 'number'
        ? (panes as Array<Record<string, unknown>>).filter(
            (p) => p.window_id === targetWindowId && typeof p.title === 'string'
          )
        : [];
    // Build list of possible window title matches (any tab title in the target window)
    const titleHints = windowPanes.map((p) => String(p.title)).filter((t) => t.length > 0);

    // Try each hint to find and raise the right System Events window
    for (const hint of titleHints) {
      const safeHint = sanitizeForAppleScript(hint);
      const raised = executeAppleScript(`
tell application "System Events"
  if not (exists process "wezterm-gui") then return false
  tell process "wezterm-gui"
    repeat with w in every window
      if name of w contains "${safeHint}" then
        perform action "AXRaise" of w
        return true
      end if
    end repeat
  end tell
end tell
return false
`);
      if (raised) {
        executeAppleScript('tell application "WezTerm" to activate');
        return true;
      }
    }

    // Fallback: just activate WezTerm (CLI already switched the right tab/pane)
    executeAppleScript(buildWezTermActivateScript());
    return true;
  } catch {
    return false;
  }
}

function focusWezTerm(tty: string, weztermPaneId?: string): boolean {
  // CLI path: precise pane targeting when binary and pane ID are available
  if (hasWezTermCli() && weztermPaneId && focusWezTermViaCli(weztermPaneId)) {
    return true;
  }

  // AppleScript fallback: title-tag + Window menu (same pattern as Ghostty)
  const titleTag = generateTitleTag(tty);
  const titleSet = setTtyTitle(tty, titleTag);

  if (titleSet) {
    const waitScript = 'delay 0.2';
    executeAppleScript(waitScript);
  }

  const success = executeAppleScript(buildWezTermFocusByTitleScript(titleTag));

  if (titleSet) {
    setTtyTitle(tty, '');
  }

  if (success) return true;

  // Last resort: just activate WezTerm without specific pane focus
  return executeAppleScript(buildWezTermActivateScript());
}

export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

export function focusSession(tty: string, weztermPaneId?: string): boolean {
  if (!isMacOS()) return false;
  if (!isValidTtyPath(tty)) return false;

  return executeWithTerminalFallback(
    {
      iTerm2: () => focusITerm2(tty),
      terminalApp: () => focusTerminalApp(tty),
      ghostty: () => focusGhostty(tty),
      wezterm: () => focusWezTerm(tty, weztermPaneId),
    },
    { preferWezTerm: !!weztermPaneId }
  );
}

export function getSupportedTerminals(): string[] {
  return ['iTerm2', 'Terminal.app', 'Ghostty', 'WezTerm'];
}
