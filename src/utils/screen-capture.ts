import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { generateTitleTag, sanitizeForAppleScript, setTtyTitle } from './focus.js';

const execFileAsync = promisify(execFile);

/**
 * Check if running on macOS.
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * Window bounds (position and size).
 */
interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Capture a region of the screen and return the image as a Base64-encoded PNG.
 * Uses macOS screencapture command with the -R flag to capture a specific region.
 *
 * @param bounds - The region to capture (x, y, width, height)
 * @returns Base64-encoded PNG string if successful, null otherwise
 */
async function captureRegion(bounds: WindowBounds): Promise<string | null> {
  if (!isMacOS()) {
    return null;
  }

  const tempPath = `/tmp/ccm-capture-${randomUUID()}.png`;
  const region = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;

  try {
    // screencapture -R x,y,width,height -x <path>
    // -R: capture specific region
    // -x: no sound
    await execFileAsync('screencapture', ['-R', region, '-x', tempPath], {
      encoding: 'utf-8',
      timeout: 10000,
    });

    // Read the captured image file
    const imageBuffer = await readFile(tempPath);

    // Clean up temp file
    await unlink(tempPath).catch(() => {
      // Ignore cleanup errors
    });

    // Convert to Base64
    return imageBuffer.toString('base64');
  } catch {
    // Clean up temp file on error
    await unlink(tempPath).catch(() => {
      // Ignore cleanup errors
    });
    return null;
  }
}

/**
 * TTY path pattern for validation.
 * Matches:
 *   - macOS: /dev/ttys000, /dev/tty000
 *   - Linux: /dev/pts/0
 */
const TTY_PATH_PATTERN = /^\/dev\/(ttys?\d+|pts\/\d+)$/;

/**
 * Validate TTY path format.
 */
function isValidTtyPath(tty: string): boolean {
  return TTY_PATH_PATTERN.test(tty);
}

/**
 * Execute an AppleScript and return the result as a string.
 * @internal
 */
function executeAppleScriptWithResult(script: string): string | null {
  try {
    const result = execFileSync('osascript', ['-e', script], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();
    return result;
  } catch {
    return null;
  }
}

/**
 * Parse window bounds from AppleScript result.
 * AppleScript returns "x, y, width, height" format.
 * @internal
 */
function parseWindowBounds(result: string): WindowBounds | null {
  const parts = result.split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return null;
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/**
 * Build AppleScript to find iTerm2 window bounds by TTY.
 * Returns "x, y, width, height" format.
 * @internal
 */
function buildITerm2WindowBoundsScript(tty: string): string {
  const safeTty = sanitizeForAppleScript(tty);
  return `
tell application "System Events"
  if not (exists process "iTerm2") then return ""
end tell

tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if tty of aSession is "${safeTty}" then
          tell application "System Events"
            tell process "iTerm2"
              set windowList to windows
              repeat with sysWindow in windowList
                try
                  set pos to position of sysWindow
                  set sz to size of sysWindow
                  return (item 1 of pos as text) & ", " & (item 2 of pos as text) & ", " & (item 1 of sz as text) & ", " & (item 2 of sz as text)
                end try
              end repeat
            end tell
          end tell
        end if
      end repeat
    end repeat
  end repeat
end tell
return ""
`;
}

/**
 * Build AppleScript to find Terminal.app window bounds by TTY.
 * Returns "x, y, width, height" format.
 * @internal
 */
function buildTerminalAppWindowBoundsScript(tty: string): string {
  const safeTty = sanitizeForAppleScript(tty);
  return `
tell application "System Events"
  if not (exists process "Terminal") then return ""
end tell

tell application "Terminal"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      if tty of aTab is "${safeTty}" then
        set windowId to id of aWindow
        tell application "System Events"
          tell process "Terminal"
            repeat with sysWindow in windows
              try
                set pos to position of sysWindow
                set sz to size of sysWindow
                return (item 1 of pos as text) & ", " & (item 2 of pos as text) & ", " & (item 1 of sz as text) & ", " & (item 2 of sz as text)
              end try
            end repeat
          end tell
        end tell
      end if
    end repeat
  end repeat
end tell
return ""
`;
}

/**
 * Build AppleScript to find Ghostty window bounds by TTY (using title tag).
 * Returns "x, y, width, height" format.
 * @internal
 */
function buildGhosttyWindowBoundsScript(titleTag: string): string {
  const safeTag = sanitizeForAppleScript(titleTag);
  return `
tell application "System Events"
  if not (exists process "Ghostty") then return ""
  tell process "Ghostty"
    repeat with sysWindow in windows
      try
        set windowTitle to name of sysWindow
        if windowTitle contains "${safeTag}" then
          set pos to position of sysWindow
          set sz to size of sysWindow
          return (item 1 of pos as text) & ", " & (item 2 of pos as text) & ", " & (item 1 of sz as text) & ", " & (item 2 of sz as text)
        end if
      end try
    end repeat
    -- Fallback: return first window
    if (count of windows) > 0 then
      set sysWindow to window 1
      set pos to position of sysWindow
      set sz to size of sysWindow
      return (item 1 of pos as text) & ", " & (item 2 of pos as text) & ", " & (item 1 of sz as text) & ", " & (item 2 of sz as text)
    end if
  end tell
end tell
return ""
`;
}

/**
 * Build AppleScript to find WezTerm window bounds by TTY (using title tag).
 * Returns "x, y, width, height" format.
 * @internal
 */
function buildWezTermWindowBoundsScript(titleTag: string): string {
  const safeTag = sanitizeForAppleScript(titleTag);
  return `
tell application "System Events"
  if not (exists process "wezterm-gui") then return ""
  tell process "wezterm-gui"
    repeat with sysWindow in windows
      try
        set windowTitle to name of sysWindow
        if windowTitle contains "${safeTag}" then
          set pos to position of sysWindow
          set sz to size of sysWindow
          return (item 1 of pos as text) & ", " & (item 2 of pos as text) & ", " & (item 1 of sz as text) & ", " & (item 2 of sz as text)
        end if
      end try
    end repeat
    if (count of windows) > 0 then
      set sysWindow to window 1
      set pos to position of sysWindow
      set sz to size of sysWindow
      return (item 1 of pos as text) & ", " & (item 2 of pos as text) & ", " & (item 1 of sz as text) & ", " & (item 2 of sz as text)
    end if
  end tell
end tell
return ""
`;
}

/**
 * Capture iTerm2 window by TTY using region capture.
 * @internal
 */
async function captureITerm2(tty: string): Promise<string | null> {
  const script = buildITerm2WindowBoundsScript(tty);
  const result = executeAppleScriptWithResult(script);
  if (!result) return null;
  const bounds = parseWindowBounds(result);
  if (!bounds) return null;
  return await captureRegion(bounds);
}

/**
 * Capture Terminal.app window by TTY using region capture.
 * @internal
 */
async function captureTerminalApp(tty: string): Promise<string | null> {
  const script = buildTerminalAppWindowBoundsScript(tty);
  const result = executeAppleScriptWithResult(script);
  if (!result) return null;
  const bounds = parseWindowBounds(result);
  if (!bounds) return null;
  return await captureRegion(bounds);
}

/**
 * Capture Ghostty window by TTY using region capture.
 * @internal
 */
async function captureGhostty(tty: string): Promise<string | null> {
  const titleTag = generateTitleTag(tty);

  // Set title tag for window identification
  const titleSet = setTtyTitle(tty, titleTag);

  if (titleSet) {
    // Wait for title to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const script = buildGhosttyWindowBoundsScript(titleTag);
  const result = executeAppleScriptWithResult(script);

  // Clear title to let shell restore it
  if (titleSet) {
    setTtyTitle(tty, '');
  }

  if (!result) return null;
  const bounds = parseWindowBounds(result);
  if (!bounds) return null;
  return await captureRegion(bounds);
}

/**
 * Capture WezTerm window by TTY using region capture.
 * @internal
 */
async function captureWezTerm(tty: string): Promise<string | null> {
  const titleTag = generateTitleTag(tty);

  // Set title tag for window identification
  const titleSet = setTtyTitle(tty, titleTag);

  if (titleSet) {
    // Wait for title to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const script = buildWezTermWindowBoundsScript(titleTag);
  const result = executeAppleScriptWithResult(script);

  // Clear title to let shell restore it
  if (titleSet) {
    setTtyTitle(tty, '');
  }

  if (!result) return null;
  const bounds = parseWindowBounds(result);
  if (!bounds) return null;
  return await captureRegion(bounds);
}

/**
 * Capture the terminal window associated with a TTY.
 * Identifies the correct terminal by matching TTY, then captures that specific window.
 *
 * @param tty - The TTY path (e.g., "/dev/ttys001")
 * @returns Base64-encoded PNG string if successful, null otherwise
 */
export async function captureTerminalScreen(tty: string): Promise<string | null> {
  if (!isMacOS()) {
    return null;
  }

  if (!tty || !isValidTtyPath(tty)) {
    return null;
  }

  // Try each terminal application using TTY-based identification
  // (same pattern as focus.ts)
  const result1 = await captureITerm2(tty);
  if (result1) return result1;

  const result2 = await captureTerminalApp(tty);
  if (result2) return result2;

  const result3 = await captureGhostty(tty);
  if (result3) return result3;

  const result4 = await captureWezTerm(tty);
  if (result4) return result4;

  return null;
}
