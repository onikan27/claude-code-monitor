import { execSync, spawnSync } from 'node:child_process';
import { isValidTtyPath } from './focus.js';

/**
 * Check if a command exists on the system.
 * @internal
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if xdotool is available.
 * @internal
 */
export function hasXdotool(): boolean {
  return commandExists('xdotool');
}

/**
 * Check if wmctrl is available.
 * @internal
 */
export function hasWmctrl(): boolean {
  return commandExists('wmctrl');
}

/**
 * Get the PID of the process controlling a TTY.
 * @internal
 */
function getTtyPid(tty: string): number | null {
  try {
    // Use fuser to find processes using the TTY
    const result = spawnSync('fuser', [tty], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // fuser outputs PIDs to stderr
    const output = (result.stderr || result.stdout || '').trim();
    const pids = output.split(/\s+/).filter((p) => /^\d+$/.test(p));
    if (pids.length > 0) {
      return parseInt(pids[0], 10);
    }
  } catch {
    // fuser not available or failed
  }
  return null;
}

/**
 * Get window ID(s) associated with a PID using wmctrl.
 * @internal
 */
function getWindowIdByPid(pid: number): string | null {
  if (!hasWmctrl()) return null;

  try {
    const result = execSync('wmctrl -lp', { encoding: 'utf-8' });
    const lines = result.split('\n');
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        const winId = parts[0];
        const winPid = parseInt(parts[2], 10);
        if (winPid === pid) {
          return winId;
        }
      }
    }
  } catch {
    // wmctrl failed
  }
  return null;
}

/**
 * Get window ID using xdotool search by PID.
 * @internal
 */
function getWindowIdByPidXdotool(pid: number): string | null {
  if (!hasXdotool()) return null;

  try {
    const result = execSync(`xdotool search --pid ${pid}`, {
      encoding: 'utf-8',
    }).trim();
    const windowIds = result.split('\n').filter((id) => id.length > 0);
    if (windowIds.length > 0) {
      return windowIds[0];
    }
  } catch {
    // xdotool search failed
  }
  return null;
}

/**
 * Focus a window by its window ID using xdotool.
 * @internal
 */
function focusWindowXdotool(windowId: string): boolean {
  if (!hasXdotool()) return false;

  try {
    execSync(`xdotool windowactivate ${windowId}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Focus a window by its window ID using wmctrl.
 * @internal
 */
function focusWindowWmctrl(windowId: string): boolean {
  if (!hasWmctrl()) return false;

  try {
    execSync(`wmctrl -i -a ${windowId}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Focus the terminal session associated with a TTY on Linux.
 * Requires xdotool or wmctrl to be installed.
 *
 * @param tty - The TTY path (e.g., /dev/pts/0)
 * @returns true if focus was successful, false otherwise
 */
export function focusSessionLinux(tty: string): boolean {
  if (!isValidTtyPath(tty)) return false;

  // Get the PID controlling this TTY
  const pid = getTtyPid(tty);
  if (!pid) return false;

  // Try xdotool first (more widely available)
  let windowId = getWindowIdByPidXdotool(pid);
  if (windowId) {
    if (focusWindowXdotool(windowId)) return true;
  }

  // Fall back to wmctrl
  windowId = getWindowIdByPid(pid);
  if (windowId) {
    if (focusWindowWmctrl(windowId)) return true;
    if (focusWindowXdotool(windowId)) return true;
  }

  return false;
}

/**
 * Send text to a terminal session on Linux using xdotool.
 * Focuses the window and types the text followed by Enter.
 *
 * @param tty - The TTY path (e.g., /dev/pts/0)
 * @param text - The text to send
 * @returns true if successful, false otherwise
 */
export function sendTextToTerminalLinux(tty: string, text: string): boolean {
  if (!hasXdotool()) return false;
  if (!isValidTtyPath(tty)) return false;

  // Focus the window first
  if (!focusSessionLinux(tty)) return false;

  try {
    // Small delay to ensure window is focused
    execSync('sleep 0.1', { stdio: 'pipe' });

    // Type the text and press Enter
    // Use --clearmodifiers to handle any held keys
    execSync(`xdotool type --clearmodifiers -- "${text.replace(/"/g, '\\"')}"`, {
      stdio: 'pipe',
    });
    execSync('xdotool key Return', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a single keystroke to a terminal session on Linux using xdotool.
 *
 * @param tty - The TTY path (e.g., /dev/pts/0)
 * @param key - The key to send (e.g., 'y', 'n', 'Return', 'Escape')
 * @param useControl - Whether to hold Ctrl while pressing the key
 * @returns true if successful, false otherwise
 */
export function sendKeystrokeToTerminalLinux(
  tty: string,
  key: string,
  useControl = false
): boolean {
  if (!hasXdotool()) return false;
  if (!isValidTtyPath(tty)) return false;

  // Focus the window first
  if (!focusSessionLinux(tty)) return false;

  try {
    // Small delay to ensure window is focused
    execSync('sleep 0.1', { stdio: 'pipe' });

    // Map common key names
    let xdotoolKey = key;
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'escape') {
      xdotoolKey = 'Escape';
    } else if (key.length === 1) {
      xdotoolKey = key;
    }

    // Build the command
    const cmd = useControl
      ? `xdotool key --clearmodifiers ctrl+${xdotoolKey}`
      : `xdotool key --clearmodifiers ${xdotoolKey}`;

    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of supported terminal emulators on Linux.
 */
export function getSupportedTerminalsLinux(): string[] {
  const terminals: string[] = [];
  if (hasXdotool()) {
    terminals.push('Any terminal (via xdotool)');
  }
  if (hasWmctrl()) {
    terminals.push('Any terminal (via wmctrl)');
  }
  return terminals;
}

/**
 * Check if Linux terminal focus is available.
 * Returns true if at least one of xdotool or wmctrl is installed.
 */
export function isLinuxFocusAvailable(): boolean {
  return hasXdotool() || hasWmctrl();
}
