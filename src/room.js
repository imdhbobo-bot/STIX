'use strict';
const crypto = require('crypto');
const { MAP, DEFAULT_NAME, parseState } = require('./protocol');

const OPEN = 1; // ws.OPEN

// One plaza room. Holds every connected player and broadcasts a snapshot of all
// active players on a fixed tick. Structured so more rooms can be added later
// (the server just keeps a map of Room instances).
class Room {
  constructor({ name = 'plaza', tickMs = 100, maxPlayers = 100, staleMs = 7000 } = {}) {
    this.name = name;
    this.tickMs = tickMs;
    this.maxPlayers = maxPlayers;
    this.staleMs = staleMs;
    this.players = new Map(); // ws -> player
    this.dirty = false;
    this.timer = null;
  }

  get size() { return this.players.size; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  canJoin() { return this.players.size < this.maxPlayers; }

  join(ws) {
    const id = 'u' + crypto.randomBytes(4).toString('hex');
    const p = {
      id, n: DEFAULT_NAME, w: 0,
      x: MAP.W / 2, y: MAP.H / 2, f: 1, m: 0, e: null, et: 0,
      active: false,   // becomes true on first state/join; false again after 'bye'
      seen: Date.now(),
    };
    this.players.set(ws, p);
    this.send(ws, { t: 'welcome', id, tickMs: this.tickMs, room: this.name });
    return p;
  }

  update(ws, patch, { activate = true } = {}) {
    const p = this.players.get(ws);
    if (!p) return;
    Object.assign(p, patch);
    p.seen = Date.now();
    if (activate) p.active = true;
    this.dirty = true;
  }

  bye(ws) {
    const p = this.players.get(ws);
    if (p && p.active) { p.active = false; this.dirty = true; }
  }

  leave(ws) {
    if (this.players.delete(ws)) this.dirty = true;
  }

  handle(ws, msg) {
    switch (msg.t) {
      case 'join':
      case 'state': this.update(ws, parseState(msg)); break;
      case 'bye': this.bye(ws); break;
      default: break; // unknown message types are ignored
    }
  }

  snapshot() {
    const p = [];
    for (const q of this.players.values()) {
      if (!q.active) continue;
      p.push({ id: q.id, n: q.n, w: q.w, x: q.x, y: q.y, f: q.f, m: q.m, e: q.e, et: q.et });
    }
    return { t: 'snap', p };
  }

  tick() {
    const now = Date.now();
    for (const [ws, p] of this.players) {
      if (p.active && now - p.seen > this.staleMs) { p.active = false; this.dirty = true; }
    }
    if (!this.dirty) return;
    this.dirty = false;
    const data = JSON.stringify(this.snapshot());
    for (const ws of this.players.keys()) if (ws.readyState === OPEN) ws.send(data);
  }

  send(ws, obj) {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(obj));
  }
}

module.exports = { Room };
