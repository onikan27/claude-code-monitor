import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the module
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}));

// Import after mocking
import {
  getLocalIP,
  getNetworkAddresses,
  getTailscaleIP,
  getTailscaleIPFromCLI,
  getTailscaleIPFromInterfaces,
  isTailscaleIP,
} from '../src/utils/network.js';

describe('network utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('isTailscaleIP', () => {
    it('should return true for Tailscale CGNAT range start (100.64.0.0)', () => {
      expect(isTailscaleIP('100.64.0.0')).toBe(true);
    });

    it('should return true for Tailscale CGNAT range middle (100.100.100.100)', () => {
      expect(isTailscaleIP('100.100.100.100')).toBe(true);
    });

    it('should return true for Tailscale CGNAT range end (100.127.255.255)', () => {
      expect(isTailscaleIP('100.127.255.255')).toBe(true);
    });

    it('should return false for addresses just below Tailscale range (100.63.255.255)', () => {
      expect(isTailscaleIP('100.63.255.255')).toBe(false);
    });

    it('should return false for addresses just above Tailscale range (100.128.0.0)', () => {
      expect(isTailscaleIP('100.128.0.0')).toBe(false);
    });

    it('should return false for regular private IP 192.168.x.x', () => {
      expect(isTailscaleIP('192.168.1.1')).toBe(false);
    });

    it('should return false for regular private IP 10.x.x.x', () => {
      expect(isTailscaleIP('10.0.0.1')).toBe(false);
    });

    it('should return false for regular private IP 172.16.x.x', () => {
      expect(isTailscaleIP('172.16.0.1')).toBe(false);
    });

    it('should return false for localhost', () => {
      expect(isTailscaleIP('127.0.0.1')).toBe(false);
    });

    it('should return false for public IP', () => {
      expect(isTailscaleIP('8.8.8.8')).toBe(false);
    });

    // Edge cases for input validation
    it('should return false for invalid IP format', () => {
      expect(isTailscaleIP('not.an.ip')).toBe(false);
      expect(isTailscaleIP('')).toBe(false);
      expect(isTailscaleIP('100.64')).toBe(false);
      expect(isTailscaleIP('100.64.0')).toBe(false);
      expect(isTailscaleIP('100.64.0.1.extra')).toBe(false);
    });

    it('should return false for non-numeric octets', () => {
      expect(isTailscaleIP('100.abc.0.1')).toBe(false);
      expect(isTailscaleIP('abc.64.0.1')).toBe(false);
    });

    it('should return false for out-of-range octets', () => {
      expect(isTailscaleIP('100.64.0.256')).toBe(false);
      expect(isTailscaleIP('100.64.-1.0')).toBe(false);
      expect(isTailscaleIP('256.64.0.1')).toBe(false);
    });
  });

  describe('getTailscaleIPFromCLI', () => {
    it('should return IP from tailscale CLI command', () => {
      vi.mocked(execFileSync).mockReturnValue('100.100.100.100\n');

      const result = getTailscaleIPFromCLI();

      expect(result).toBe('100.100.100.100');
      expect(execFileSync).toHaveBeenCalledWith(
        'tailscale',
        ['ip', '-4'],
        expect.objectContaining({
          encoding: 'utf-8',
          timeout: 2000,
        })
      );
    });

    it('should try App Store path if CLI command fails', () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('command not found');
        })
        .mockReturnValueOnce('100.64.1.1\n');

      const result = getTailscaleIPFromCLI();

      expect(result).toBe('100.64.1.1');
      expect(execFileSync).toHaveBeenCalledTimes(2);
      expect(execFileSync).toHaveBeenNthCalledWith(
        2,
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        ['ip', '-4'],
        expect.any(Object)
      );
    });

    it('should return null if all paths fail', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('command not found');
      });

      const result = getTailscaleIPFromCLI();

      expect(result).toBeNull();
    });

    it('should return null for empty output', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      const result = getTailscaleIPFromCLI();

      expect(result).toBeNull();
    });

    it('should return null for non-Tailscale IP from CLI (security validation)', () => {
      // Simulate malicious or unexpected CLI output
      vi.mocked(execFileSync).mockReturnValue('192.168.1.100\n');

      const result = getTailscaleIPFromCLI();

      expect(result).toBeNull();
    });

    it('should return null for invalid IP format from CLI', () => {
      vi.mocked(execFileSync).mockReturnValue('invalid-output\n');

      const result = getTailscaleIPFromCLI();

      expect(result).toBeNull();
    });
  });

  describe('getTailscaleIPFromInterfaces', () => {
    it('should find Tailscale IP from network interfaces', () => {
      vi.mocked(networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
        utun3: [
          {
            address: '100.100.50.25',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
      });

      const result = getTailscaleIPFromInterfaces();

      expect(result).toBe('100.100.50.25');
    });

    it('should return null if no Tailscale interface found', () => {
      vi.mocked(networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
        lo0: [
          { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: '' },
        ],
      });

      const result = getTailscaleIPFromInterfaces();

      expect(result).toBeNull();
    });

    it('should ignore IPv6 addresses', () => {
      vi.mocked(networkInterfaces).mockReturnValue({
        utun3: [
          {
            address: 'fd7a:115c:a1e0::1',
            family: 'IPv6',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
            scopeid: 0,
          },
        ],
      });

      const result = getTailscaleIPFromInterfaces();

      expect(result).toBeNull();
    });
  });

  describe('getTailscaleIP', () => {
    it('should prefer CLI result over interfaces', () => {
      vi.mocked(execFileSync).mockReturnValue('100.64.0.1\n');
      vi.mocked(networkInterfaces).mockReturnValue({
        utun3: [
          {
            address: '100.100.50.25',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
      });

      const result = getTailscaleIP();

      expect(result).toBe('100.64.0.1');
    });

    it('should fallback to interfaces if CLI fails', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('command not found');
      });
      vi.mocked(networkInterfaces).mockReturnValue({
        utun3: [
          {
            address: '100.100.50.25',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
      });

      const result = getTailscaleIP();

      expect(result).toBe('100.100.50.25');
    });

    it('should return null if both methods fail', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('command not found');
      });
      vi.mocked(networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
      });

      const result = getTailscaleIP();

      expect(result).toBeNull();
    });
  });

  describe('getLocalIP', () => {
    it('should return first external IPv4 address', () => {
      vi.mocked(networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
        lo0: [
          { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: '' },
        ],
      });

      const result = getLocalIP();

      expect(result).toBe('192.168.1.100');
    });

    it('should exclude Tailscale IP from local IP', () => {
      vi.mocked(networkInterfaces).mockReturnValue({
        utun3: [
          {
            address: '100.100.50.25',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
        en0: [
          {
            address: '192.168.1.100',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
      });

      const result = getLocalIP();

      expect(result).toBe('192.168.1.100');
    });

    it('should return localhost if no external address found', () => {
      vi.mocked(networkInterfaces).mockReturnValue({
        lo0: [
          { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: '' },
        ],
      });

      const result = getLocalIP();

      expect(result).toBe('localhost');
    });

    it('should ignore IPv6 addresses', () => {
      vi.mocked(networkInterfaces).mockReturnValue({
        en0: [
          {
            address: 'fe80::1',
            family: 'IPv6',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
            scopeid: 0,
          },
        ],
      });

      const result = getLocalIP();

      expect(result).toBe('localhost');
    });
  });

  describe('getNetworkAddresses', () => {
    it('should return both local and tailscale addresses', () => {
      vi.mocked(execFileSync).mockReturnValue('100.64.0.1\n');
      vi.mocked(networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
      });

      const result = getNetworkAddresses();

      expect(result).toEqual({
        local: '192.168.1.100',
        tailscale: '100.64.0.1',
      });
    });

    it('should return null for tailscale if not available', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('command not found');
      });
      vi.mocked(networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: '',
          },
        ],
      });

      const result = getNetworkAddresses();

      expect(result).toEqual({
        local: '192.168.1.100',
        tailscale: null,
      });
    });
  });
});
