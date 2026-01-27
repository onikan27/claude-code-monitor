import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import qrcode from 'qrcode-terminal';
import { type WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_SERVER_PORT } from '../constants.js';
import { clearSessions, getSessions, getStorePath } from '../store/file-store.js';
import type { Session } from '../types/index.js';
import { focusSession } from '../utils/focus.js';
import { getLocalIP, getTailscaleIP } from '../utils/network.js';
import { sendKeystrokeToTerminal, sendTextToTerminal } from '../utils/send-text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_PORT_ATTEMPTS = 10;

/**
 * Check if a port is available on the specified host.
 */
function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => {
      server.close(); // Ensure server is closed on error
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, host);
  });
}

/**
 * Find an available port starting from the given port on the specified host.
 * Tries up to MAX_PORT_ATTEMPTS ports.
 */
async function findAvailablePort(startPort: number, host: string): Promise<number> {
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port, host)) {
      return port;
    }
  }
  throw new Error(
    `No available port found in range ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1}`
  );
}

/**
 * Generate a random authentication token.
 */
function generateAuthToken(): string {
  return randomBytes(32).toString('hex');
}

interface WebSocketMessage {
  type: 'sessions' | 'focus' | 'sendText' | 'sendKeystroke' | 'clearSessions';
  sessionId?: string;
  text?: string;
  key?: string;
  useControl?: boolean;
}

interface BroadcastMessage {
  type: 'sessions';
  data: Session[];
}

// WebSocket.OPEN constant (avoid magic number)
const WEBSOCKET_OPEN = 1;

/**
 * Patterns for dangerous shell commands that should be blocked.
 * These commands can cause irreversible damage to the system.
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /rm\s+(-rf?|--recursive)/i, // Recursive file deletion
  /sudo\s+rm/i, // Sudo remove
  /mkfs/i, // Format filesystem
  /dd\s+if=/i, // Disk dump (can overwrite disks)
  />\s*\/dev\//i, // Write to device files
  /chmod\s+777/i, // Overly permissive permissions
  /curl.*\|\s*(ba)?sh/i, // Pipe curl to shell
  /wget.*\|\s*(ba)?sh/i, // Pipe wget to shell
];

/**
 * Check if a command text contains dangerous patterns.
 * Returns the matched pattern description if dangerous, undefined otherwise.
 */
function isDangerousCommand(text: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Find a session by session ID.
 */
function findSessionById(sessionId: string): Session | undefined {
  const sessions = getSessions();
  return sessions.find((s) => s.session_id === sessionId);
}

/**
 * Handle focus command from WebSocket client.
 */
function handleFocusCommand(ws: WebSocket, sessionId: string): void {
  const session = findSessionById(sessionId);
  if (!session?.tty) {
    ws.send(
      JSON.stringify({
        type: 'focusResult',
        success: false,
        error: 'Session not found or no TTY',
      })
    );
    return;
  }
  const success = focusSession(session.tty);
  ws.send(JSON.stringify({ type: 'focusResult', success }));
}

/**
 * Handle sendText command from WebSocket client.
 * Validates input and blocks dangerous commands before execution.
 */
function handleSendTextCommand(ws: WebSocket, sessionId: string, text: string): void {
  // Block dangerous commands at server level
  if (isDangerousCommand(text)) {
    ws.send(
      JSON.stringify({
        type: 'sendTextResult',
        success: false,
        error: 'Dangerous command blocked for security',
      })
    );
    return;
  }

  const session = findSessionById(sessionId);
  if (!session?.tty) {
    ws.send(JSON.stringify({ type: 'sendTextResult', success: false, error: 'Session not found' }));
    return;
  }
  const result = sendTextToTerminal(session.tty, text);
  ws.send(JSON.stringify({ type: 'sendTextResult', ...result }));
}

/**
 * Handle sendKeystroke command from WebSocket client.
 * Used for permission prompt responses (y/n/a) and Ctrl+C.
 */
function handleSendKeystrokeCommand(
  ws: WebSocket,
  sessionId: string,
  key: string,
  useControl = false
): void {
  const session = findSessionById(sessionId);
  if (!session?.tty) {
    ws.send(
      JSON.stringify({ type: 'sendKeystrokeResult', success: false, error: 'Session not found' })
    );
    return;
  }
  const result = sendKeystrokeToTerminal(session.tty, key, useControl);
  ws.send(JSON.stringify({ type: 'sendKeystrokeResult', ...result }));
}

/**
 * Handle clearSessions command from WebSocket client.
 */
function handleClearSessionsCommand(ws: WebSocket): void {
  try {
    clearSessions();
    ws.send(JSON.stringify({ type: 'clearSessionsResult', success: true }));
  } catch {
    ws.send(
      JSON.stringify({
        type: 'clearSessionsResult',
        success: false,
        error: 'Failed to clear sessions',
      })
    );
  }
}

/**
 * Handle incoming WebSocket message from client.
 * Processes focus, sendText, and clearSessions commands.
 */
function handleWebSocketMessage(ws: WebSocket, data: Buffer): void {
  let message: WebSocketMessage;
  try {
    message = JSON.parse(data.toString()) as WebSocketMessage;
  } catch {
    return; // Ignore invalid messages
  }

  if (message.type === 'focus' && message.sessionId) {
    handleFocusCommand(ws, message.sessionId);
    return;
  }

  if (message.type === 'sendText' && message.sessionId && message.text) {
    handleSendTextCommand(ws, message.sessionId, message.text);
    return;
  }

  if (message.type === 'sendKeystroke' && message.sessionId && message.key) {
    handleSendKeystrokeCommand(ws, message.sessionId, message.key, message.useControl ?? false);
    return;
  }

  if (message.type === 'clearSessions') {
    handleClearSessionsCommand(ws);
  }
}

/**
 * Broadcast message to all connected WebSocket clients.
 */
function broadcastToClients(wss: WebSocketServer, message: BroadcastMessage): void {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WEBSOCKET_OPEN) {
      client.send(data);
    }
  }
}

/**
 * Send current sessions to a WebSocket client.
 */
function sendSessionsToClient(ws: WebSocket): void {
  const sessions = getSessions();
  ws.send(JSON.stringify({ type: 'sessions', data: sessions }));
}

/**
 * Setup WebSocket connection handlers.
 */
function setupWebSocketHandlers(wss: WebSocketServer, validToken: string): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `ws://${req.headers.host}`);
    const requestToken = url.searchParams.get('token');

    if (requestToken !== validToken) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    sendSessionsToClient(ws);
    ws.on('message', (data: Buffer) => handleWebSocketMessage(ws, data));

    // Handle client connection errors to prevent process crashes
    ws.on('error', (error) => {
      // Log error but don't crash - client disconnections are expected
      console.error('WebSocket client error:', error.message);
    });
  });
}

export interface ServerOptions {
  port?: number;
  preferTailscale?: boolean;
}

export interface ServerInfo {
  url: string;
  qrCode: string;
  token: string;
  port: number;
  ip: string;
  tailscaleIP: string | null;
  localIP: string;
  stop: () => void;
}

interface ResolvedAddresses {
  ip: string;
  localIP: string;
  tailscaleIP: string | null;
}

/**
 * Resolve server IP address based on preference.
 * If preferTailscale is true, attempts to use Tailscale IP, falling back to local IP.
 */
function resolveServerIP(preferTailscale: boolean): ResolvedAddresses {
  const localIP = getLocalIP();
  const tailscaleIP = preferTailscale ? getTailscaleIP() : null;
  return {
    ip: tailscaleIP ?? localIP,
    localIP,
    tailscaleIP,
  };
}

function generateQRCode(text: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (qrCode: string) => {
      resolve(qrCode);
    });
  });
}

function getContentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.js')) return 'application/javascript';
  return 'text/plain';
}

function serveStatic(req: IncomingMessage, res: ServerResponse, validToken: string): void {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const requestToken = url.searchParams.get('token');
  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;

  // Allow static library files without token (they contain no sensitive data)
  const isPublicLibrary = filePath.startsWith('/lib/') && filePath.endsWith('.js');

  if (!isPublicLibrary && requestToken !== validToken) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized - Invalid or missing token');
    return;
  }

  const publicDir = resolve(__dirname, '../../public');

  // Prevent directory traversal
  // Remove leading slashes and normalize to prevent absolute path injection
  const safePath = normalize(filePath)
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^\/+/, '');
  const fullPath = resolve(publicDir, safePath);

  // Verify the resolved path is within publicDir
  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    res.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

interface ServerComponents {
  server: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  watcher: ReturnType<typeof chokidar.watch>;
}

/**
 * Create server components (HTTP server, WebSocket server, file watcher).
 * Shared by createMobileServer and startServer.
 */
function createServerComponents(token: string): ServerComponents {
  const server = createServer((req, res) => serveStatic(req, res, token));
  const wss = new WebSocketServer({ server });
  setupWebSocketHandlers(wss, token);

  const storePath = getStorePath();
  const watcher = chokidar.watch(storePath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on('change', () => {
    const sessions = getSessions();
    broadcastToClients(wss, { type: 'sessions', data: sessions });
  });

  return { server, wss, watcher };
}

/**
 * Stop all server components.
 * Terminates all WebSocket clients before closing to prevent hanging.
 */
function stopServerComponents({ watcher, wss, server }: ServerComponents): void {
  // Close file watcher (async but we don't wait - acceptable for shutdown)
  void watcher.close();

  // Terminate all WebSocket clients before closing server
  for (const client of wss.clients) {
    client.terminate();
  }

  wss.close();
  server.close();
}

export async function createMobileServer(options: ServerOptions = {}): Promise<ServerInfo> {
  const { port = DEFAULT_SERVER_PORT, preferTailscale = false } = options;
  const { ip, localIP, tailscaleIP } = resolveServerIP(preferTailscale);

  const actualPort = await findAvailablePort(port, ip);
  const token = generateAuthToken();
  const url = `http://${ip}:${actualPort}?token=${token}`;
  const qrCode = await generateQRCode(url);

  const components = createServerComponents(token);

  await new Promise<void>((resolve) => {
    components.server.listen(actualPort, ip, resolve);
  });

  return {
    url,
    qrCode,
    token,
    port: actualPort,
    ip,
    tailscaleIP,
    localIP,
    stop: () => stopServerComponents(components),
  };
}

// CLI standalone mode
export async function startServer(options: ServerOptions = {}): Promise<void> {
  const { port = DEFAULT_SERVER_PORT, preferTailscale = false } = options;
  const { ip, tailscaleIP } = resolveServerIP(preferTailscale);

  const actualPort = await findAvailablePort(port, ip);
  const token = generateAuthToken();
  const url = `http://${ip}:${actualPort}?token=${token}`;

  const components = createServerComponents(token);

  components.server.listen(actualPort, ip, () => {
    console.log('\n  Claude Code Monitor - Mobile Web Interface\n');
    console.log(`  Server running at: ${url}\n`);
    if (actualPort !== port) {
      console.log(`  (Port ${port} was in use, using ${actualPort} instead)\n`);
    }
    if (tailscaleIP) {
      console.log(`  Tailscale: ${tailscaleIP} (accessible from anywhere in your Tailnet)\n`);
    }
    console.log('  Scan this QR code with your phone:\n');
    qrcode.generate(url, { small: true });
    console.log('\n  Press Ctrl+C to stop the server.\n');
  });

  // Graceful shutdown handler for both SIGINT (Ctrl+C) and SIGTERM (Docker/K8s)
  const shutdown = () => {
    console.log('\n  Shutting down...');
    stopServerComponents(components);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
