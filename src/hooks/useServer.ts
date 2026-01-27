import { useEffect, useState } from 'react';
import { DEFAULT_SERVER_PORT } from '../constants.js';
import { createMobileServer, type ServerInfo } from '../server/index.js';

export interface UseServerOptions {
  port?: number;
  preferTailscale?: boolean;
}

export interface UseServerResult {
  url: string | null;
  qrCode: string | null;
  port: number | null;
  ip: string | null;
  tailscaleIP: string | null;
  localIP: string | null;
  loading: boolean;
  error: Error | null;
}

export function useServer(options: UseServerOptions = {}): UseServerResult {
  const { port = DEFAULT_SERVER_PORT, preferTailscale = false } = options;

  const [url, setUrl] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [actualPort, setActualPort] = useState<number | null>(null);
  const [ip, setIp] = useState<string | null>(null);
  const [tailscaleIP, setTailscaleIP] = useState<string | null>(null);
  const [localIP, setLocalIP] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Use a ref-like object to track server across async boundaries
    // This prevents race condition where cleanup runs before async completes
    const serverRef: { current: ServerInfo | null } = { current: null };
    let isMounted = true;

    async function startServer() {
      try {
        const info = await createMobileServer({ port, preferTailscale });
        if (isMounted) {
          serverRef.current = info;
          setUrl(info.url);
          setQrCode(info.qrCode);
          setActualPort(info.port);
          setIp(info.ip);
          setTailscaleIP(info.tailscaleIP);
          setLocalIP(info.localIP);
          setLoading(false);
        } else {
          // Component unmounted during async operation - stop server immediately
          info.stop();
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error('Failed to start server'));
          setLoading(false);
        }
      }
    }

    startServer();

    return () => {
      isMounted = false;
      if (serverRef.current) {
        serverRef.current.stop();
      }
    };
  }, [port, preferTailscale]);

  return { url, qrCode, port: actualPort, ip, tailscaleIP, localIP, loading, error };
}
