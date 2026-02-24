import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeConfigDir } from './claude-config.js';

/**
 * Build transcript file path from cwd and session_id.
 * Claude Code stores transcripts at {claude-config-dir}/projects/{encoded-cwd}/{session_id}.jsonl
 */
export function buildTranscriptPath(cwd: string, sessionId: string): string {
  // Encode cwd: replace / and . with - (including leading /)
  const encodedCwd = cwd.replace(/[/.]/g, '-');
  return join(getClaudeConfigDir(), 'projects', encodedCwd, `${sessionId}.jsonl`);
}

interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Get the last assistant text message from a transcript file.
 */
export function getLastAssistantMessage(transcriptPath: string): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Read from end to find last text message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.content) {
          const contentBlocks = entry.message.content as ContentBlock[];

          for (const block of contentBlocks) {
            if (block.type === 'text' && block.text) {
              return block.text;
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  } catch {
    // Ignore file read errors
  }

  return undefined;
}
