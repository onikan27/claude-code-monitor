import { afterEach, describe, expect, it } from 'vitest';
import { sendTextToTerminal, validateTextInput } from '../src/utils/send-text.js';

describe('send-text', () => {
  describe('validateTextInput', () => {
    it('should reject empty string', () => {
      const result = validateTextInput('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Text cannot be empty');
    });

    it('should reject whitespace-only string', () => {
      const result = validateTextInput('   ');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Text cannot be empty');
    });

    it('should reject string with only newlines', () => {
      const result = validateTextInput('\n\n');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Text cannot be empty');
    });

    it('should accept valid text', () => {
      const result = validateTextInput('echo hello');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept text with leading/trailing spaces', () => {
      const result = validateTextInput('  npm run build  ');
      expect(result.valid).toBe(true);
    });

    it('should accept multiline text', () => {
      const result = validateTextInput('line1\nline2\nline3');
      expect(result.valid).toBe(true);
    });

    it('should reject text exceeding maximum length', () => {
      const longText = 'a'.repeat(10001);
      const result = validateTextInput(longText);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length');
    });

    it('should accept text at exactly maximum length', () => {
      const maxText = 'a'.repeat(10000);
      const result = validateTextInput(maxText);
      expect(result.valid).toBe(true);
    });

    it('should accept text with special characters', () => {
      const result = validateTextInput('echo "hello world" | grep hello');
      expect(result.valid).toBe(true);
    });

    it('should accept text with unicode characters', () => {
      const result = validateTextInput('echo "こんにちは"');
      expect(result.valid).toBe(true);
    });
  });

  describe('sendTextToTerminal', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
      });
    });

    it('should return error for unsupported platform', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
      });
      const result = sendTextToTerminal('/dev/pts/0', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('This feature is only available on macOS and Linux');
    });

    it('should return error when xdotool is not available on Linux', () => {
      // This test simulates Linux behavior where xdotool may not be installed
      // When running on actual Linux without xdotool, it will return an error
      if (process.platform === 'linux') {
        const result = sendTextToTerminal('/dev/pts/0', 'test');
        expect(result.success).toBe(false);
        // Either xdotool is not installed or focus failed
        expect(result.error).toBeDefined();
      }
    });

    it('should return error for invalid tty path', () => {
      // This validation now happens on both macOS and Linux
      const result = sendTextToTerminal('/invalid/path', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid TTY path');
    });

    it('should return error for empty text', () => {
      // Text validation happens before platform-specific code
      const ttyPath = process.platform === 'darwin' ? '/dev/ttys001' : '/dev/pts/0';
      const result = sendTextToTerminal(ttyPath, '');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Text cannot be empty');
    });

    it('should return error for text exceeding max length', () => {
      // Text validation happens before platform-specific code
      const ttyPath = process.platform === 'darwin' ? '/dev/ttys001' : '/dev/pts/0';
      const longText = 'a'.repeat(10001);
      const result = sendTextToTerminal(ttyPath, longText);
      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds maximum length');
    });
  });
});
