'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');
const { PvpHub } = require('./pvp');
const { PartyHub } = require('./party');
const { Ranking } = require('./ranking');
const { MAX_MSG_BYTES } = require('./protocol');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..'); // game folder (index.html, css/, js/)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Only the client's own files are served (never the server folder, .git, etc.).
function resolveStatic(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const rel = path.posix.normalize(p).replace(/^\/+/, '');
  const ok = rel === 'index.html' || rel.startsWith('css/') || rel.startsWith('js/');
  if (!ok || rel.includes('..')) return null;
  const file = path.join(CLIENT_ROOT, rel);
  return file.startsWith(CLIENT_ROOT + path.sep) ? file : null;
}

function createServer({
  port = 8080,
  host = '127.0.0.1',
  serveClient = true,
  allowedOrigins = null,     // e.g. ['https://you.itch.io']; null = any origin (local dev)
  room = new Room(),
  log = console.log,
  hub = new PvpHub({ room, log }),
  party = new PartyHub({ log }),
} = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, room: room.name, players: room.size, pvp: hub.stats, party: party.stats }));
      return;
    }
    if (!serveClient || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404); res.end('Not found'); return;
    }
    let file;
    try { file = resolveStatic(req.url); } catch { file = null; }
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_MSG_BYTES,
    verifyClient: ({ origin }) => !allowedOrigins || (origin && allowedOrigins.includes(origin)),
  });

  wss.on('connection', (ws, req) => {
    if (!room.canJoin()) { ws.close(1013, 'room full'); return; }
    const p = room.join(ws);
    log(`+ ${p.id} joined (${room.size} connected) from ${req.socket.remoteAddress}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // simple flood guard: >150 msgs in one second is dropped; 3 bad seconds in a row disconnects
    // (a live pvp fight sends ~40 msgs/s: inputs 30Hz + state 10Hz)
    let winStart = Date.now(), count = 0, bad = 0;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - winStart >= 1000) { bad = count > 150 ? bad + 1 : 0; winStart = now; count = 0; if (bad >= 3) { ws.close(1008, 'rate limit'); return; } }
      if (++count > 150) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg.t === 'string' && msg.t.startsWith('pvp_')) { hub.handle(ws, msg); return; }
      if (typeof msg.t === 'string' && msg.t.startsWith('pty_')) { party.handle(ws, msg); return; }
      if (ws.pvpBusy && (msg.t === 'state' || msg.t === 'join')) return; // queued / in a pvp match: stay hidden from the plaza
      room.handle(ws, msg);
    });

    ws.on('close', () => {
      hub.onClose(ws);
      party.onClose(ws);
      room.leave(ws);
      log(`- ${p.id} left (${room.size} connected)`);
    });
    ws.on('error', () => {});
  });

  // drop dead connections (closed laptop lids, dropped wifi) that never sent a close frame
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);
  hb.unref();

  room.start();

  return {
    server, wss, room, hub, party,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address()));
    }),
    close: () => new Promise((resolve) => {
      clearInterval(hb);
      hub.shutdown();
      party.shutdown();
      room.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  // local dev: only this PC. On a hosting service (PORT or NODE_ENV=production is set) listen on all interfaces.
  const host = process.env.HOST || (process.env.PORT || process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) : null;
  // ranked ladder file; on hosts with a disk wipe on redeploy the ladder simply restarts (set DATA_DIR to a persistent path)
  const room = new Room();
  const ranking = new Ranking({ file: path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'ranking.json') });
  const app = createServer({ port, host, allowedOrigins, room, hub: new PvpHub({ room, ranking }) });
  app.listen().then((addr) => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`STIX server ready`);
    console.log(`  game : http://${shown}:${addr.port}/`);
    console.log(`  ws   : ws://${shown}:${addr.port}/ws`);
    console.log(`  health: http://${shown}:${addr.port}/health`);
  }).catch((e) => { console.error('failed to start:', e.message); process.exit(1); });

  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
