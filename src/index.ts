#!/usr/bin/env node

/**
 * cli-tunnel — Tunnel any CLI app to your phone
 *
 * Usage:
 *   cli-tunnel <command> [args...]                           # quick Cloudflare tunnel (default)
 *   cli-tunnel --local <command> [args...]                   # localhost only, no tunnel
 *   cli-tunnel --cf-tunnel <name> --cf-hostname <host> ...  # named Cloudflare tunnel
 *   cli-tunnel --name myapp <command>                        # named session
 *
 * Examples:
 *   cli-tunnel copilot --yolo
 *   cli-tunnel --name wizard copilot --agent squad
 *   cli-tunnel --cf-tunnel mytunnel --cf-hostname app.example.com copilot
 *   cli-tunnel --local python -i
 *   cli-tunnel --port 4000 node server.js
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import readline from 'node:readline';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'node:os';
import { redactSecrets } from './redact.js';

// F-15: Global error handlers to prevent unclean crashes
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason);
  process.exit(1);
});

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

// ─── Parse args ─────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
${BOLD}cli-tunnel${RESET} — Tunnel any CLI app to your phone

${BOLD}Usage:${RESET}
  cli-tunnel [options] <command> [args...]
  cli-tunnel                              # hub mode — sessions dashboard only

${BOLD}Options:${RESET}
  --local                    Disable tunnel (localhost only)
  --port <n>                 Bridge port (default: random)
  --name <name>              Session name (shown in dashboard)
  --cf-tunnel <name>         Use a named Cloudflare tunnel (requires cloudflared login)
  --cf-hostname <hostname>   Hostname for named tunnel (e.g. myapp.example.com)
  --no-wait                  Skip the press-any-key prompt
  --help, -h                 Show this help

${BOLD}Examples:${RESET}
  cli-tunnel copilot --yolo               # tunnel + run copilot
  cli-tunnel copilot --model claude-sonnet-4 --agent squad
  cli-tunnel k9s                          # tunnel + run k9s
  cli-tunnel python -i                    # tunnel + run python
  cli-tunnel --name wizard copilot        # named session
  cli-tunnel --local copilot --yolo       # localhost only, no cloudflared
  cli-tunnel --cf-tunnel mytunnel --cf-hostname app.example.com copilot
  cli-tunnel                              # hub: see all active sessions

Cloudflare Tunnel (quick mode) is enabled by default. Named tunnels require
--cf-tunnel and --cf-hostname with a Cloudflare account. All flags after the
command name pass through to the underlying app. cli-tunnel's own flags
(--local, --port, --name, --cf-tunnel, --cf-hostname) must come before the command.
`);
  process.exit(0);
}

const hasLocal = args.includes('--local');
const hasTunnel = !hasLocal;
const hasReplay = !args.includes('--no-replay');
const noWait = args.includes('--no-wait');
const portIdx = args.indexOf('--port');
const port = (portIdx !== -1 && args[portIdx + 1]) ? parseInt(args[portIdx + 1]!, 10) : 0;
const nameIdx = args.indexOf('--name');
const sessionName = (nameIdx !== -1 && args[nameIdx + 1]) ? args[nameIdx + 1]! : '';

// Parse cloudflared named-tunnel flags
const cfTunnelIdx = args.indexOf('--cf-tunnel');
const cfTunnelName = (cfTunnelIdx !== -1 && args[cfTunnelIdx + 1]) ? args[cfTunnelIdx + 1]! : '';
const cfHostnameIdx = args.indexOf('--cf-hostname');
const cfHostname = (cfHostnameIdx !== -1 && args[cfHostnameIdx + 1]) ? args[cfHostnameIdx + 1]! : '';
// Named tunnel mode requires both --cf-tunnel and --cf-hostname
const namedTunnel = !!(cfTunnelName && cfHostname);

// Everything that's not our flags is the command
const ourFlags = new Set(['--local', '--tunnel', '--port', '--name', '--no-replay', '--no-wait', '--cf-tunnel', '--cf-hostname']);
const cmdArgs: string[] = [];
let skip = false;
for (let i = 0; i < args.length; i++) {
  if (skip) { skip = false; continue; }
  if (args[i] === '--port' || args[i] === '--name' || args[i] === '--cf-tunnel' || args[i] === '--cf-hostname') { skip = true; continue; }
  if (args[i] === '--local' || args[i] === '--tunnel' || args[i] === '--no-replay' || args[i] === '--no-wait') continue;
  cmdArgs.push(args[i]!);
}

// Hub mode — no command, just show sessions dashboard
const hubMode = cmdArgs.length === 0;

const command = hubMode ? '' : cmdArgs[0]!;
const commandArgs = hubMode ? [] : cmdArgs.slice(1);
const cwd = process.cwd();

// ─── Tunnel helpers ─────────────────────────────────────────
function sanitizeLabel(l: string): string {
  const clean = l.replace(/[^a-zA-Z0-9_\-=]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
  return clean || 'unknown';
}

// F-07: Minimal env for subprocess calls (git, cloudflared) — only PATH and essentials
function getSubprocessEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  const allow = ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'SHELL', 'COMSPEC',
    'SYSTEMROOT', 'WINDIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'APPDATA', 'LOCALAPPDATA',
    'LANG', 'LC_ALL', 'TERM'];
  for (const k of allow) { if (process.env[k]) safe[k] = process.env[k]!; }
  return safe;
}

function getGitInfo(): { repo: string; branch: string } {
  try {
    const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv() }).trim();
    const repo = remote.split('/').pop()?.replace('.git', '') || 'unknown';
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv() }).trim() || 'unknown';
    return { repo, branch };
  } catch {
    return { repo: path.basename(cwd), branch: 'unknown' };
  }
}

// ─── Security: Session token for WebSocket auth ────────────
const sessionToken = crypto.randomUUID();

// ─── Session file registry (IPC via filesystem) ────────────
const sessionsDir = path.join(os.homedir(), '.cli-tunnel', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
let sessionFilePath: string | null = null;

function writeSessionFile(tunnelId: string, tunnelUrl: string, port: number, repo?: string, branch?: string): void {
  sessionFilePath = path.join(sessionsDir, `${tunnelId}.json`);
  const data = JSON.stringify({
    token: sessionToken, name: sessionName || command,
    tunnelId, tunnelUrl, port, hubMode,
    repo: repo || 'unknown',
    branch: branch || 'unknown',
    // Store cfTunnelName so the delete endpoint knows whether to call cloudflared
    cfTunnelName: namedTunnel ? cfTunnelName : undefined,
    machine: os.hostname(), pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(sessionFilePath, data, { mode: 0o600 });
}

function removeSessionFile(): void {
  if (sessionFilePath) { try { fs.unlinkSync(sessionFilePath); } catch {} }
}

function readLocalSessions(): Array<{ token: string; name: string; tunnelId: string; tunnelUrl: string; port: number; hubMode: boolean }> {
  try {
    return fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8')); } catch { return null; } })
      .filter((s): s is any => s !== null && !s.hubMode);
  } catch { return []; }
}

// ─── F-18: Session TTL (4 hours) ───────────────────────────
const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours
const sessionCreatedAt = Date.now();

// ─── F-02: One-time ticket store for WebSocket auth ────────
const tickets = new Map<string, { expires: number }>();

// #30: Ticket GC — clean expired tickets every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tickets) {
    if (t.expires < now) tickets.delete(id);
  }
}, 30000);

// ─── Security: Redact secrets from replay events ────────────

// ─── Bridge server ──────────────────────────────────────────
const connections = new Map<string, WebSocket>();
// Hub relay: WS connections from hub to local sessions (for grid view)
const relayConnections = new Map<number, WebSocket>(); // port → ws to session
let localResizeAt = 0; // Timestamp of last local terminal resize

// #10: Session TTL enforcement — periodically close expired connections
setInterval(() => {
  if (Date.now() - sessionCreatedAt > SESSION_TTL) {
    for (const [id, ws] of connections) {
      ws.close(1000, 'Session expired');
      connections.delete(id);
    }
  }
}, 60000);

// ─── F-8: Per-IP rate limiter ───────────────────────────────
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const ticketRateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, map: Map<string, { count: number; resetAt: number }>, maxRequests: number): boolean {
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || entry.resetAt < now) {
    map.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  entry.count++;
  return entry.count <= maxRequests;
}

// Clean up rate limit maps every 60s
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) { if (entry.resetAt < now) rateLimits.delete(ip); }
  for (const [ip, entry] of ticketRateLimits) { if (entry.resetAt < now) ticketRateLimits.delete(ip); }
}, 60000);

const server = http.createServer(async (req, res) => {
  const clientIp = req.socket.remoteAddress || 'unknown';

  // F-8: Rate limiting for HTTP endpoints
  if (req.url?.startsWith('/api/')) {
    const isTicket = req.url === '/api/auth/ticket';
    if (isTicket) {
      if (!checkRateLimit(clientIp, ticketRateLimits, 10)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
      }
    } else {
      if (!checkRateLimit(clientIp, rateLimits, 30)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
      }
    }
  }
  // F-18: Session expiry check for API routes
  if (!hubMode && req.url?.startsWith('/api/') && Date.now() - sessionCreatedAt > SESSION_TTL) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session expired' }));
    return;
  }

  // F-02: Ticket endpoint — exchange session token for one-time WS ticket
  if (req.url === '/api/auth/ticket' && req.method === 'POST') {
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (auth !== sessionToken) { res.writeHead(401); res.end(); return; }
    const ticket = crypto.randomUUID();
    const expiresAt = Date.now() + 60000;
    tickets.set(ticket, { expires: expiresAt });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ticket, expires: expiresAt }));
    return;
  }

  // F-01: Session token check for all API routes
  if (req.url?.startsWith('/api/')) {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const authToken = req.headers.authorization?.replace('Bearer ', '') || reqUrl.searchParams.get('token');
    if (authToken !== sessionToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // Hub ticket proxy — fetch ticket from local session on behalf of grid client
  // F-03: Only hub mode sessions can use this endpoint (hub token already validated above)
  if (hubMode && req.url?.startsWith('/api/proxy/ticket/') && req.method === 'POST') {
    const ticketPathMatch = req.url?.match(/^\/api\/proxy\/ticket\/(\d+)$/);
    if (!ticketPathMatch) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid port' })); return; }
    const targetPort = parseInt(ticketPathMatch[1], 10);
    if (!Number.isFinite(targetPort) || targetPort < 1 || targetPort > 65535) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid port' })); return;
    }
    // Find token for this port from session files
    const localSessions = readLocalSessions();
    const session = localSessions.find(s => s.port === targetPort);
    if (!session) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
    try {
      const ticketResp = await fetch(`http://127.0.0.1:${targetPort}/api/auth/ticket`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${session.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!ticketResp.ok) throw new Error('Ticket request failed');
      const ticketData = await ticketResp.json() as { ticket: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: ticketData.ticket, port: targetPort }));
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Session unreachable' })); return;
    }
    return;
  }

  // Sessions API — reads session files written by each cli-tunnel process
  // Sessions are discovered via ~/.cli-tunnel/sessions/*.json (filesystem IPC).
  // Cloudflare quick tunnels have no enumeration API, so the filesystem is
  // the source of truth — each process writes its file at startup and removes it on exit.
  if ((req.url === '/api/sessions' || req.url?.startsWith('/api/sessions?')) && req.method === 'GET') {
    try {
      const localMachine = os.hostname();
      // Read all active session files; each file is written at startup and removed on exit
      const allSessions = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8')); }
          catch { return null; }
        })
        .filter((s): s is any => s !== null && !s.hubMode);

      const sessions = allSessions.map((s: any) => {
        const session: any = {
          id: s.tunnelId,
          tunnelId: s.tunnelId,
          name: s.name || 'unnamed',
          repo: s.repo || 'unknown',
          branch: s.branch || 'unknown',
          machine: s.machine || 'unknown',
          // A session is "online" if its file exists — process removes it on clean exit
          online: true,
          port: s.port,
          url: s.tunnelUrl,
          isLocal: s.machine === localMachine,
        };
        // F-05: Never expose raw tokens in API responses — only indicate availability
        if (s.token) session.hasToken = true;
        return session;
      });

      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ sessions }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ sessions: [] }));
    }
    return;
  }

  // Delete session — removes the local session file and optionally cleans up named tunnels
  // Quick tunnels auto-expire when the cloudflared process exits, so only the session
  // file needs to be removed. Named tunnels get an explicit `cloudflared tunnel delete`.
  // Ownership is verified via the session file's machine field (not tunnel labels).
  if (req.url?.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const tunnelId = decodeURIComponent(req.url.replace('/api/sessions/', ''));
    if (!/^[a-zA-Z0-9._-]+$/.test(tunnelId)) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Invalid tunnel ID' }));
      return;
    }

    // Look up the session file to verify ownership
    const sessionFile = path.join(sessionsDir, `${tunnelId}.json`);
    let sessionData: any = null;
    try {
      sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // Only allow deleting sessions that belong to this machine
    if (sessionData.machine !== os.hostname()) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Cannot delete sessions from other machines' }));
      return;
    }

    // Remove the session file so hub stops listing it
    try { fs.unlinkSync(sessionFile); } catch {}

    // For named Cloudflare tunnels: attempt to delete via cloudflared CLI
    // Quick tunnels (trycloudflare.com) don't need explicit deletion — they expire on process exit
    const isNamedTunnel = sessionData.tunnelUrl && !sessionData.tunnelUrl.includes('trycloudflare.com');
    if (isNamedTunnel && sessionData.cfTunnelName) {
      try {
        execFileSync('cloudflared', ['tunnel', 'delete', '-f', sessionData.cfTunnelName], {
          encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv(),
        });
      } catch { /* non-fatal — tunnel may already be gone */ }
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ deleted: true }));
    return;
  }

  // Static files
  const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../remote-ui');
  // #18: Guard against malformed URI encoding
  let decodedUrl: string;
  try {
    // Strip query string before resolving file path
    const urlPath = (req.url || '/').split('?')[0]!;
    decodedUrl = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400); res.end(); return;
  }
  if (decodedUrl.includes('..')) { res.writeHead(400); res.end(); return; }
  let filePath = path.resolve(uiDir, decodedUrl === '/' ? 'index.html' : decodedUrl.replace(/^\//, ''));
  if (!filePath.startsWith(uiDir)) { res.writeHead(403); res.end(); return; }
  // #2: EISDIR guard — check if path is a directory before createReadStream
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    }
  } catch { res.writeHead(404); res.end(); return; }
  const ext = path.extname(filePath);
  const mimes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const securityHeaders: Record<string, string> = {
    'Content-Type': mimes[ext] || 'application/octet-stream',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/ https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/ https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/; connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://*.trycloudflare.com https://*.trycloudflare.com wss://*.cfargotunnel.com https://*.cfargotunnel.com;",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
  res.writeHead(200, securityHeaders);
  // #8: Handle createReadStream errors
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { if (!res.headersSent) { res.writeHead(500); } res.end(); });
  stream.pipe(res);
});

const wss = new WebSocketServer({
  server,
  maxPayload: 1048576,
  verifyClient: (info: { req: http.IncomingMessage }) => {

    // F-18: Session expiry
    if (Date.now() - sessionCreatedAt > SESSION_TTL) return false;
    // F-3: Validate origin when present (Cloudflare proxies may strip it)
    // Allow localhost, Cloudflare quick tunnel domains, and named tunnel hostnames
    const origin = info.req.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const host = originUrl.hostname;
        const isLocalhost = host === 'localhost' || host === '127.0.0.1';
        const isQuickTunnel = host.endsWith('.trycloudflare.com');
        // Named tunnels use cfargotunnel.com internally, or the user's custom hostname
        const isNamedTunnel = host.endsWith('.cfargotunnel.com') || (cfHostname !== '' && host === cfHostname);
        if (!isLocalhost && !isQuickTunnel && !isNamedTunnel) {
          return false;
        }
      } catch { return false; }
    }
    const url = new URL(info.req.url!, `http://${info.req.headers.host}`);
    // F-02: Accept one-time ticket (only auth method for WS)
    const ticket = url.searchParams.get('ticket');
    if (ticket && tickets.has(ticket)) {
      const t = tickets.get(ticket)!;
      tickets.delete(ticket); // Single use
      return t.expires > Date.now();
    }
    return false;
  },
});

// ─── Security: Audit log for remote PTY input ──────────────
const auditDir = path.join(os.homedir(), '.cli-tunnel', 'audit');
fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
const auditLogPath = path.join(auditDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
const auditLog = fs.createWriteStream(auditLogPath, { flags: 'a', mode: 0o600 });
auditLog.on('error', (err) => { console.error('Audit log error:', err.message); });

// R-01: WebSocketServer error handler — prevents process crash on WSS-level errors
wss.on('error', (err) => {
  console.error('[wss] WebSocketServer error:', err.message);
});

wss.on('connection', (ws, req) => {
  // F-10: Connection cap (global + per-IP)
  if (connections.size >= 5) {
    ws.close(1013, 'Max connections reached');
    return;
  }
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  let perIpCount = 0;
  for (const [, c] of connections) {
    if ((c as any)._remoteAddress === remoteAddress) perIpCount++;
  }
  if (perIpCount >= 2) {
    ws.close(1013, 'Max connections per IP reached');
    return;
  }
  const id = crypto.randomUUID();
  (ws as any)._remoteAddress = remoteAddress;
  connections.set(id, ws);

  // R-02: Per-connection error handler to prevent unhandled crash
  ws.on('error', (err) => { console.error('[ws] Connection error:', err.message); });

  // Send replay buffer to late-joining clients (catch up on PTY state)
  if (!hubMode && replayBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'pty', data: replayBuffer }));
  }

  // F-13: Per-connection WS message rate limiter (100 msg/sec)
  let wsMessageCount = 0;
  let wsMessageResetAt = Date.now() + 1000;

  // F-10: WS ping/pong heartbeat
  (ws as any)._isAlive = true;
  ws.on('pong', () => { (ws as any)._isAlive = true; });

  ws.on('message', async (data) => {
    // F-13: Enforce WS message rate limit (100 msg/sec)
    const now = Date.now();
    if (now > wsMessageResetAt) { wsMessageCount = 0; wsMessageResetAt = now + 1000; }
    wsMessageCount++;
    if (wsMessageCount > 100) {
      auditLog.write(JSON.stringify({ ts: new Date().toISOString(), src: remoteAddress, type: 'rejected', reason: 'ws-rate-limit' }) + '\n');
      return;
    }
    const raw = data.toString();
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'pty_input' && ptyProcess) {
        // R-03: Validate msg.data is a string before writing to PTY
        if (typeof msg.data !== 'string') {
          auditLog.write(JSON.stringify({ ts: new Date().toISOString(), src: remoteAddress, type: 'rejected', reason: 'invalid-data-type', dataType: typeof msg.data }) + '\n');
        } else {
          auditLog.write(JSON.stringify({ ts: new Date().toISOString(), src: remoteAddress, type: 'pty_input', data: redactSecrets(msg.data) }) + '\n');
          ptyProcess.write(msg.data);
        }
      }
      // pty_resize from remote clients is ignored — PTY stays at local terminal size
      // The phone's xterm.js handles display via its own viewport/scrolling
      if (msg.type === 'pty_resize') {
        // Only log, don't resize — prevents breaking local terminal layout
      }
      // Grid relay: hub proxies PTY data between phone and local sessions
      if (hubMode && msg.type === 'grid_connect') {
        const port = Number(msg.port);
        if (!Number.isFinite(port) || port < 1 || port > 65535) return;

        const localSessions = readLocalSessions();
        const session = localSessions.find(s => s.port === port);
        if (!session) return;

        try {
          const ticketResp = await fetch(`http://127.0.0.1:${port}/api/auth/ticket`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${session.token}` },
            signal: AbortSignal.timeout(3000),
          });
          if (!ticketResp.ok) return;
          const { ticket } = await ticketResp.json() as { ticket: string };

          const sessionWs = new WebSocket(`ws://127.0.0.1:${port}?ticket=${encodeURIComponent(ticket)}`, {
            headers: { origin: `http://127.0.0.1:${port}` },
          });

          sessionWs.on('open', () => {
            relayConnections.set(port, sessionWs);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'grid_connected', port }));
            }
          });

          sessionWs.on('message', (sData) => {
            try {
              const parsed = JSON.parse(sData.toString());
              if (parsed.type === 'pty' && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'grid_pty', port, data: parsed.data }));
              }
            } catch {}
          });

          sessionWs.on('close', () => {
            relayConnections.delete(port);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'grid_disconnected', port }));
            }
          });

          sessionWs.on('error', () => {
            relayConnections.delete(port);
          });
        } catch {}
      }

      if (hubMode && msg.type === 'grid_input') {
        const port = Number(msg.port);
        const relay = relayConnections.get(port);
        if (relay && relay.readyState === WebSocket.OPEN) {
          relay.send(JSON.stringify({ type: 'pty_input', data: msg.data }));
        }
      }
    } catch {
      // #3: Log but do NOT write to PTY — only structured pty_input messages allowed
      auditLog.write(JSON.stringify({ ts: new Date().toISOString(), type: 'rejected', reason: 'non-json', length: raw.length }) + '\n');
    }
  });

  ws.on('close', () => {
    connections.delete(id);
    // Close all relay connections when hub client disconnects
    for (const [port, relay] of relayConnections) {
      relay.close();
    }
    relayConnections.clear();
  });
});

// F-10: WS heartbeat — ping every 2 minutes, close unresponsive connections
// Longer interval prevents killing phone connections that go to background briefly
setInterval(() => {
  for (const [id, ws] of connections) {
    if ((ws as any)._isAlive === false) {
      ws.terminate();
      connections.delete(id);
      continue;
    }
    (ws as any)._isAlive = false;
    ws.ping();
  }
}, 120000);

// Rolling replay buffer for late-joining clients (grid panels, reconnects)
let replayBuffer = '';

function broadcast(data: string): void {
  const redacted = redactSecrets(data);
  const msg = JSON.stringify({ type: 'pty', data: redacted });
  // Append to replay buffer (rolling, max 256KB)
  replayBuffer += redacted;
  if (replayBuffer.length > 262144) replayBuffer = replayBuffer.slice(-262144);
  for (const [, ws] of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─── Start bridge ───────────────────────────────────────────
let ptyProcess: any = null;

async function main() {
  const actualPort = await new Promise<number>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' ? addr!.port : port);
    });
    server.on('error', reject);
  });

  const { repo, branch } = getGitInfo();
  const machine = os.hostname();
  const displayName = sessionName || command;

  console.log(`\n${BOLD}cli-tunnel${RESET} ${DIM}v1.1.0${RESET}\n`);
  if (hubMode) {
    console.log(`  ${BOLD}📋 Hub Mode${RESET} — sessions dashboard`);
    console.log(`  ${DIM}Port:${RESET}     ${actualPort}`);
    console.log(`  ${DIM}Local URL:${RESET} http://127.0.0.1:${actualPort}?token=${sessionToken}&hub=1`);
    console.log(`  ${YELLOW}⚠ Token in URL — do not share this URL in screen recordings or public channels${RESET}\n`);
  } else {
    console.log(`  ${DIM}Command:${RESET}  ${command} ${commandArgs.join(' ')}`);
    console.log(`  ${DIM}Name:${RESET}     ${displayName}`);
    console.log(`  ${DIM}Port:${RESET}     ${actualPort}`);
    console.log(`  ${DIM}Audit log:${RESET} ${auditLogPath}`);
    console.log(`  ${DIM}Local URL:${RESET} http://127.0.0.1:${actualPort}?token=${sessionToken}`);
    console.log(`  ${YELLOW}⚠ Token in URL — do not share this URL in screen recordings or public channels${RESET}`);
    console.log(`  ${DIM}Session expires:${RESET} ${new Date(sessionCreatedAt + SESSION_TTL).toLocaleTimeString()}`);
  }

  // ─── Tunnel setup (Cloudflare Tunnels) ──────────────────────
  if (hasTunnel) {
    // Check if cloudflared is installed; offer to install if missing
    let cloudflaredInstalled = false;
    try {
      execFileSync('cloudflared', ['--version'], { stdio: 'pipe', env: getSubprocessEnv() });
      cloudflaredInstalled = true;
    } catch {
      console.log(`\n  ${YELLOW}⚠ cloudflared CLI not found!${RESET}\n`);
      let installCmd = '';
      if (process.platform === 'win32') {
        installCmd = 'winget install --id Cloudflare.cloudflared';
      } else if (process.platform === 'darwin') {
        installCmd = 'brew install cloudflared';
      } else {
        // Linux: download binary directly from latest GitHub release
        installCmd = 'curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared';
      }
      const answer = await askUser(`  Would you like to install it now? (${GREEN}${installCmd}${RESET}) [Y/n] `);
      if (answer === '' || answer === 'y' || answer === 'yes') {
        console.log(`\n  ${DIM}Installing cloudflared...${RESET}\n`);
        try {
          // Use shell:true for the Linux pipe-based command
          const needsShell = installCmd.includes('&&') || installCmd.includes('|');
          const installProc = spawn(
            needsShell ? installCmd : installCmd.split(' ')[0]!,
            needsShell ? [] : installCmd.split(' ').slice(1),
            { stdio: 'inherit', shell: needsShell, env: getSubprocessEnv() }
          );
          await new Promise<void>((resolve, reject) => {
            installProc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Install exited with code ${code}`)));
            installProc.on('error', reject);
          });
          // Refresh PATH on Windows — winget updates the registry but current process has stale PATH
          if (process.platform === 'win32') {
            try {
              const userPath = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv() });
              const sysPath = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv() });
              const extractPath = (out: string) => out.split('\n').find(l => l.includes('REG_'))?.split('REG_EXPAND_SZ')[1]?.trim() || out.split('\n').find(l => l.includes('REG_'))?.split('REG_SZ')[1]?.trim() || '';
              process.env.PATH = `${extractPath(userPath)};${extractPath(sysPath)}`;
            } catch { /* keep existing PATH */ }
          }
          execFileSync('cloudflared', ['--version'], { stdio: 'pipe', env: getSubprocessEnv() });
          console.log(`\n  ${GREEN}✓${RESET} cloudflared installed successfully!\n`);
          cloudflaredInstalled = true;
        } catch (err) {
          console.log(`\n  ${YELLOW}⚠${RESET} Installation failed: ${(err as Error).message}`);
          console.log(`  ${DIM}You can install it manually: ${installCmd}${RESET}\n`);
          console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
        }
      } else {
        console.log(`\n  ${DIM}More info: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/${RESET}`);
        console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
      }
    }

    // Named tunnels require a Cloudflare account — check for cert.pem login credential
    if (cloudflaredInstalled && namedTunnel) {
      const certPath = path.join(os.homedir(), '.cloudflared', 'cert.pem');
      if (!fs.existsSync(certPath)) {
        console.log(`\n  ${YELLOW}⚠ cloudflared not authenticated (no cert.pem found).${RESET}\n`);
        const loginAnswer = await askUser(`  Would you like to log in now? [Y/n] `);
        if (loginAnswer === '' || loginAnswer === 'y' || loginAnswer === 'yes') {
          try {
            const loginProc = spawn('cloudflared', ['tunnel', 'login'], { stdio: 'inherit', env: getSubprocessEnv() });
            await new Promise<void>((resolve, reject) => {
              loginProc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Login exited with code ${code}`)));
              loginProc.on('error', reject);
            });
            console.log(`\n  ${GREEN}✓${RESET} Logged in successfully!\n`);
          } catch {
            console.log(`\n  ${YELLOW}⚠${RESET} Login failed. Run manually: ${GREEN}cloudflared tunnel login${RESET}\n`);
            console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
            cloudflaredInstalled = false;
          }
        } else {
          console.log(`\n  ${DIM}Run this once to log in: ${GREEN}cloudflared tunnel login${RESET}`);
          console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
          cloudflaredInstalled = false;
        }
      }
    }

    if (cloudflaredInstalled) {
      try {
        let hostProc: ReturnType<typeof spawn>;
        let tunnelId: string;
        let tunnelUrl: string;

        if (namedTunnel) {
          // ── Named tunnel mode ────────────────────────────────
          // Create the tunnel if it doesn't already exist (idempotent)
          let namedTunnelUuid = '';
          try {
            const createOut = execFileSync('cloudflared', ['tunnel', 'create', cfTunnelName], {
              encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv(),
            });
            // Parse UUID from output like: "Created tunnel my-tunnel with id abc-123"
            const uuidMatch = createOut.match(/with id ([a-f0-9-]{36})/i);
            namedTunnelUuid = uuidMatch ? uuidMatch[1]! : cfTunnelName;
          } catch (err) {
            // "already exists" is fine — look up its UUID
            const errMsg = (err as any).stderr?.toString() || (err as Error).message || '';
            if (!errMsg.includes('already exist')) throw err;
            try {
              const listOut = execFileSync('cloudflared', ['tunnel', 'list', '-o', 'json'], {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv(),
              });
              const tunnels = JSON.parse(listOut) as Array<{ id: string; name: string }>;
              const existing = tunnels.find(t => t.name === cfTunnelName);
              namedTunnelUuid = existing?.id || cfTunnelName;
            } catch { namedTunnelUuid = cfTunnelName; }
          }

          // Route DNS: create a CNAME pointing cfHostname → <uuid>.cfargotunnel.com
          // This is idempotent — cloudflared will update if already exists
          try {
            execFileSync('cloudflared', ['tunnel', 'route', 'dns', cfTunnelName, cfHostname], {
              stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv(),
            });
          } catch {
            // DNS route failures are non-fatal — may already exist or DNS propagation pending
            console.log(`  ${YELLOW}⚠${RESET} DNS route setup failed (may already exist — continuing)\n`);
          }

          tunnelId = namedTunnelUuid;
          tunnelUrl = `https://${cfHostname}`;

          // Start the named tunnel host process, forwarding local port
          hostProc = spawn('cloudflared', [
            'tunnel', '--url', `http://127.0.0.1:${actualPort}`, 'run', cfTunnelName,
          ], { stdio: 'pipe', detached: false, env: getSubprocessEnv() });

          // Named tunnels: wait for the host process to confirm connectivity
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Tunnel timeout')), 30000);
            let output = '';
            // cloudflared logs to stderr
            hostProc.stderr?.on('data', (d: Buffer) => {
              output += d.toString();
              // Registered connection indicates the tunnel is live
              if (output.includes('Registered tunnel connection') || output.includes('Connected to')) {
                clearTimeout(timeout);
                resolve();
              }
            });
            hostProc.on('error', (e) => { clearTimeout(timeout); reject(e); });
          });
        } else {
          // ── Quick tunnel mode (default, no account needed) ────
          // A single `cloudflared tunnel --url` command handles everything:
          // it contacts trycloudflare.com, gets an ephemeral URL, and starts hosting
          hostProc = spawn('cloudflared', [
            'tunnel', '--url', `http://127.0.0.1:${actualPort}`,
          ], { stdio: 'pipe', detached: false, env: getSubprocessEnv() });

          // Extract the trycloudflare.com URL from cloudflared's stderr log output
          tunnelUrl = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Tunnel timeout — cloudflared did not emit a URL within 20s')), 20000);
            let output = '';
            // cloudflared writes all log output to stderr (not stdout)
            hostProc.stderr?.on('data', (d: Buffer) => {
              output += d.toString();
              const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
              if (match) { clearTimeout(timeout); resolve(match[0]!); }
            });
            hostProc.on('error', (e) => { clearTimeout(timeout); reject(e); });
          });

          // Use the subdomain portion as the stable session ID
          const subdomain = tunnelUrl.replace('https://', '').replace('.trycloudflare.com', '');
          tunnelId = subdomain;
        }

        const tunnelUrlWithToken = `${tunnelUrl}?token=${sessionToken}${hubMode ? '&hub=1' : ''}`;
        console.log(`  ${GREEN}✓${RESET} Tunnel: ${BOLD}${tunnelUrlWithToken}${RESET}`);
        console.log(`  ${YELLOW}⚠ Token in URL — do not share in screen recordings or public channels${RESET}\n`);

        // Write session file for hub discovery
        writeSessionFile(tunnelId, tunnelUrl, actualPort, repo, branch);

        try {
          // @ts-ignore
          const qr = (await import('qrcode-terminal')) as any;
          qr.default.generate(tunnelUrlWithToken, { small: true }, (code: string) => console.log(code));
        } catch {}

        // Cleanup on exit:
        // Quick tunnels: kill the process — they disappear automatically
        // Named tunnels: kill the process; leave the tunnel registered for reuse
        process.on('SIGINT', () => {
          removeSessionFile();
          hostProc.kill();
          // Named tunnels: the tunnel registration persists — only the host process is stopped
        });
        process.on('exit', () => {
          removeSessionFile();
          hostProc.kill();
        });
      } catch (err) {
        const errMsg = (err as Error).message || '';
        console.log(`  ${YELLOW}⚠${RESET} Tunnel failed: ${errMsg}\n`);
        console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
      }
    } // end if (cloudflaredInstalled)
  }

  // Write session file for local-only sessions (no tunnel) so hub can discover them
  if (!hasTunnel && !hubMode && !sessionFilePath) {
    const localId = `local-${actualPort}`;
    writeSessionFile(localId, `http://127.0.0.1:${actualPort}`, actualPort, repo, branch);
    process.on('SIGINT', () => { removeSessionFile(); });
    process.on('exit', () => { removeSessionFile(); });
  }

  if (hubMode) {
    // Hub mode — just serve the sessions dashboard, no PTY
    console.log(`  ${GREEN}✓${RESET} Hub running — open in browser to see all sessions\n`);
    console.log(`  ${DIM}Press Ctrl+C to stop.${RESET}\n`);
    process.on('SIGINT', () => { server.close(); process.exit(0); });
    // Keep process alive
    await new Promise(() => {});
  }

  // Wait for user to scan QR / copy URL before starting the CLI tool
  if (hasTunnel && !noWait) {
    console.log(`  ${BOLD}Press any key to start ${command}...${RESET}`);
    await new Promise<void>((resolve) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => resolve());
    });
    // Don't pause or reset raw mode — we'll set it up properly for PTY below
  }

  console.log(`  ${DIM}Starting ${command}...${RESET}\n`);

  // Clear screen before PTY takes over — prevents overlap with banner/QR output
  process.stdout.write('\x1b[2J\x1b[H');

  // Spawn PTY
  const nodePty = await import('node-pty');
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;

  // Resolve command path for node-pty on Windows
  let resolvedCmd = command;
  if (process.platform === 'win32') {
    try {
      const wherePaths = execFileSync('where', [command], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getSubprocessEnv() }).trim().split('\n');
      // Prefer .exe or .cmd over .ps1 for node-pty compatibility
      const exePath = wherePaths.find(p => p.trim().endsWith('.exe')) || wherePaths.find(p => p.trim().endsWith('.cmd'));
      if (exePath) {
        resolvedCmd = exePath.trim();
      } else {
        // For .ps1 scripts, wrap with powershell
        resolvedCmd = 'powershell';
        commandArgs.unshift('-File', wherePaths[0]!.trim());
      }
    } catch { /* use as-is */ }
  }

  // F-07: Security — filter dangerous environment variables for PTY
  // Blocklist approach: pass everything except known dangerous vars and secrets
  const DANGEROUS_VARS = new Set(['NODE_OPTIONS', 'NODE_REPL_HISTORY', 'NODE_EXTRA_CA_CERTS',
    'NODE_PATH', 'NODE_REDIRECT_WARNINGS', 'NODE_PENDING_DEPRECATION',
    'UV_THREADPOOL_SIZE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
    'SSH_AUTH_SOCK', 'GPG_TTY',
    'PYTHONPATH', 'PYTHONSTARTUP', 'BASH_ENV', 'BASH_FUNC', 'JAVA_TOOL_OPTIONS', 'JAVA_OPTIONS', '_JAVA_OPTIONS',
    'PROMPT_COMMAND', 'ENV', 'ZDOTDIR', 'PERL5OPT', 'RUBYOPT',
    // F-04: Additional dangerous vars missed by original blocklist
    'DATABASE_URL', 'REDIS_URL', 'MONGODB_URI', 'MONGO_URL',
    'SLACK_WEBHOOK_URL', 'SLACK_TOKEN', 'SLACK_BOT_TOKEN',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'HISTFILE', 'HISTFILESIZE', 'LESSHISTFILE',
    'GCP_SERVICE_ACCOUNT', 'GOOGLE_APPLICATION_CREDENTIALS',
    'AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
    'SENDGRID_API_KEY', 'TWILIO_AUTH_TOKEN', 'STRIPE_SECRET_KEY',
    'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN']);
  const sensitivePattern = /token|secret|key|password|credential|api_key|private_key|access_key|connection_string|auth|kubeconfig|docker_host|docker_config|passwd|dsn|webhook/i;

  const safeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !DANGEROUS_VARS.has(k) && !sensitivePattern.test(k)) {
      safeEnv[k] = v;
    }
  }

  ptyProcess = nodePty.spawn(resolvedCmd, commandArgs, {
    name: 'xterm-256color',
    cols, rows, cwd,
    env: safeEnv,
  });

  // Register data handler immediately so no PTY output is lost
  ptyProcess.onData((data: string) => {
    process.stdout.write(data);
    broadcast(data);
  });

  // Detect CSPRNG crash (rare Node.js + PTY issue) and show helpful message
  let earlyExitCode: number | null = null;
  const earlyExitCheck = new Promise<void>((resolve) => {
    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      earlyExitCode = exitCode;
      resolve();
    });
    setTimeout(resolve, 2000);
  });

  await earlyExitCheck;
  if (earlyExitCode !== null) {
    if (earlyExitCode === 134 || earlyExitCode === 3221226505) {
      const nodeVer = process.version;
      console.log(`  ${YELLOW}⚠${RESET} The command crashed (CSPRNG assertion failure).`);
      console.log(`  This is a known issue with Node.js ${nodeVer} + PTY on Windows.`);
      console.log(`  ${BOLD}Fix:${RESET} Install Node.js 22 LTS: ${GREEN}nvm install 22${RESET} or ${GREEN}winget install OpenJS.NodeJS.LTS${RESET}\n`);
      process.exit(1);
    } else {
      console.log(`\n${DIM}Process exited (code ${earlyExitCode}).${RESET}`);
      server.close();
      process.exit(earlyExitCode);
    }
  }

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    console.log(`\n${DIM}Process exited (code ${exitCode}).${RESET}`);
    ptyProcess = null;
    server.close();
    process.exit(exitCode);
  });

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data: Buffer) => { if (ptyProcess) ptyProcess.write(data.toString()); });
  process.stdout.on('resize', () => { localResizeAt = Date.now(); const c = process.stdout.columns || 120; const r = process.stdout.rows || 30; if (ptyProcess) ptyProcess.resize(c, r); });
}

main().catch((err) => { console.error(err); process.exit(1); });
