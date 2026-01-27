import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

/**
 * Validate that all octets are valid IPv4 values (0-255, not NaN).
 */
function isValidIPv4Octets(parts: number[]): boolean {
  return parts.every((p) => !Number.isNaN(p) && p >= 0 && p <= 255);
}

/**
 * Tailscale CGNAT range: 100.64.0.0/10
 * This covers 100.64.0.0 - 100.127.255.255
 */
export function isTailscaleIP(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (!isValidIPv4Octets(parts)) return false;
  // 100.64.0.0/10 means first octet is 100, second octet is 64-127
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/**
 * Get Tailscale IP using the CLI command.
 * Tries both the CLI binary and the App Store version path.
 */
export function getTailscaleIPFromCLI(): string | null {
  const paths = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

  for (const path of paths) {
    try {
      const ip = execFileSync(path, ['ip', '-4'], {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      // Validate that the returned IP is actually in Tailscale CGNAT range
      if (ip && isTailscaleIP(ip)) return ip;
    } catch {
      // Tailscale CLI not available at this path - try next
    }
  }

  return null;
}

/**
 * Get Tailscale IP from network interfaces.
 * Fallback when CLI is not available.
 */
export function getTailscaleIPFromInterfaces(): string | null {
  const interfaces = networkInterfaces();
  const allAddresses = Object.values(interfaces)
    .flat()
    .filter((info): info is NonNullable<typeof info> => info != null);

  const tailscaleAddr = allAddresses.find(
    (info) => info.family === 'IPv4' && isTailscaleIP(info.address)
  );

  return tailscaleAddr?.address ?? null;
}

/**
 * Get Tailscale IP address.
 * Prefers CLI result, falls back to network interfaces.
 */
export function getTailscaleIP(): string | null {
  return getTailscaleIPFromCLI() ?? getTailscaleIPFromInterfaces();
}

/**
 * Get local IP address (excluding Tailscale addresses).
 */
export function getLocalIP(): string {
  const interfaces = networkInterfaces();
  const allAddresses = Object.values(interfaces)
    .flat()
    .filter((info): info is NonNullable<typeof info> => info != null);

  const externalIPv4 = allAddresses.find(
    (info) => info.family === 'IPv4' && !info.internal && !isTailscaleIP(info.address)
  );

  return externalIPv4?.address ?? 'localhost';
}

export interface NetworkAddresses {
  local: string;
  tailscale: string | null;
}

/**
 * Get all relevant network addresses.
 */
export function getNetworkAddresses(): NetworkAddresses {
  return {
    local: getLocalIP(),
    tailscale: getTailscaleIP(),
  };
}
