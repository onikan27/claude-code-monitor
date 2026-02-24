import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CLAUDE_DIR = '.claude';

/**
 * Get the Claude config directory path.
 * Respects CLAUDE_CONFIG_DIR env variable, falls back to ~/.claude/
 */
export function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), DEFAULT_CLAUDE_DIR);
}
