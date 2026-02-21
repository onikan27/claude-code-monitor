/**
 * Terminal operation strategies for macOS.
 * Provides a unified interface to execute operations across different terminal apps.
 */

export interface TerminalOperations {
  iTerm2: () => boolean;
  terminalApp: () => boolean;
  ghostty: () => boolean;
  wezterm: () => boolean;
}

/**
 * Execute terminal operation with fallback strategy.
 * Default order: iTerm2 → Terminal.app → Ghostty → WezTerm.
 * When preferWezTerm is true, WezTerm is tried first (useful when a pane ID signals the session is in WezTerm).
 *
 * @param operations - Terminal-specific operation functions
 * @param options - Optional configuration
 * @returns true if any terminal operation succeeded, false otherwise
 */
export function executeWithTerminalFallback(
  operations: TerminalOperations,
  options?: { preferWezTerm?: boolean }
): boolean {
  const strategies = options?.preferWezTerm
    ? [operations.wezterm, operations.iTerm2, operations.terminalApp, operations.ghostty]
    : [operations.iTerm2, operations.terminalApp, operations.ghostty, operations.wezterm];
  return strategies.some((op) => op());
}
