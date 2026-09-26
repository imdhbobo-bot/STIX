'use strict';
const { CHAR_COUNT, sanitizeName } = require('./protocol');

const OPEN = 1; // ws.OPEN
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Co-op survival parties. Every client simulates its OWN copy of each wave (same seed => same enemies), the server only keeps the
// party together: membership, the shared seed/difficulty, a wave barrier (next wave starts when everyone alive has cleared it,
// dead members are revived at the next wave if anybody survived) and a relay of positions so teammates can see each other.
//
// client -> server                                       server -> client
//   pty_join {code:'1..999999', size:2-4, dif:0-2, n, w}   pty_state {code, size, dif, me, host, started, mem:[{i,n,w,host}]}
//   pty_leave                                              pty_err {msg}
//   pty_start   (host, >=2 members)                        pty_start {seed, dif, size, me, mem:[..]}
//   pty_pos {x,y,f,w,hp,mh,d}                              pty_pos {i, x, y, f, w, hp, mh, d}   (relayed to the others)
//   pty_wave {wave, st:'clear'|'dead'}                     pty_next {wave, rv:[member index revived]}
//                                                          pty_end {wave}   (everybody dead: wave = last wave anybody cleared)
class PartyHub {
  constructor({ log = () => {}, rng = Math.random } = {}) {
    this.log = log; this.rng = rng;
    this.parties = new Map();
  }

  get stats() { let players = 0; for (const p of this.parties.values()) players += p.mem.filter((m) => !m.gone).length; return { parties: this.parties.size, players }; }

  send(ws, o) { if (ws && ws.readyState === OPEN) { try { ws.send(JSON.stringify(o)); } catch {} } }
  active(p) { return p.mem.filter((m) => !m.gone); }
  view(p) { return p.mem.map((m, i) => ({ i, n: m.n, w: m.w, host: p.host === m, gone: !!m.gone })); }
  broadcast(p, o, except) { for (const m of p.mem) if (!m.gone && m.ws !== except) this.send(m.ws, o); }
  state(p) { for (const m of this.active(p)) this.send(m.ws, { t: 'pty_state', code: p.code, size: p.size, dif: p.dif, me: p.mem.indexOf(m), started: p.started, mem: this.view(p) }); }

  handle(ws, msg) {
    switch (msg.t) {
      case 'pty_join': return this.join(ws, msg);
      case 'pty_leave': return this.leave(ws);
      case 'pty_start': return this.start(ws);
      case 'pty_pos': return this.pos(ws, msg);
      case 'pty_wave': return this.wave(ws, msg);
      default: return undefined;
    }
  }

  join(ws, msg) {
    if (ws.pty) this.leave(ws);
    const code = String(msg.code == null ? '' : msg.code).replace(/\D/g, '').slice(0, 6);
    if (!code) { this.send(ws, { t: 'pty_err', msg: '파티 코드는 숫자 1~6자리예요' }); return; }
    const n = sanitizeName(msg.n), w = Number.isInteger(msg.w) ? clamp(msg.w, 0, CHAR_COUNT - 1) : 0;
    let p = this.parties.get(code);
    if (!p) {
      p = { code, size: clamp(Math.floor(Number(msg.size)) || 2, 2, 4), dif: clamp(Math.floor(Number(msg.dif)) || 0, 0, 2), seed: Math.floor(this.rng() * 2 ** 31), mem: [], host: null, started: false, wave: 1, best: 0, born: Date.now() };
      this.parties.set(code, p);
    } else if (p.started) { this.send(ws, { t: 'pty_err', msg: '이미 시작한 파티예요' }); return; }
    else if (this.active(p).length >= p.size) { this.send(ws, { t: 'pty_err', msg: '파티가 가득 찼어요' }); return; }
    const m = { ws, n, w, alive: true, cl: false, gone: false, lp: 0 };
    p.mem.push(m); if (!p.host) p.host = m; ws.pty = { p, m };
    this.log(`party ${code}: ${n} joined (${this.active(p).length}/${p.size})`);
    this.state(p);
  }

  leave(ws) {
    const c = ws.pty; if (!c) return; ws.pty = null;
    const { p, m } = c; m.gone = true;
    if (!p.started) { p.mem = p.mem.filter((x) => x !== m); if (p.host === m) p.host = p.mem[0] || null; }
    else if (p.host === m) p.host = this.active(p)[0] || null;
    if (!this.active(p).length) { this.parties.delete(p.code); return; }
    if (!p.started) this.state(p); else { this.state(p); this.barrier(p); }
  }

  start(ws) {
    const c = ws.pty; if (!c) return; const { p, m } = c;
    if (p.host !== m || p.started) return;
    if (this.active(p).length < 2) { this.send(ws, { t: 'pty_err', msg: '2명 이상이어야 시작할 수 있어요' }); return; }
    p.started = true; p.wave = 1; p.best = 0;
    for (const x of p.mem) { x.alive = true; x.cl = false; }
    for (const x of this.active(p)) this.send(x.ws, { t: 'pty_start', seed: p.seed, dif: p.dif, size: p.size, me: p.mem.indexOf(x), mem: this.view(p) });
  }

  pos(ws, msg) {
    const c = ws.pty; if (!c || !c.p.started) return; const { p, m } = c;
    const now = Date.now(); if (now - m.lp < 60) return; m.lp = now;
    const f = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? clamp(v, lo, hi) : 0; };
    this.broadcast(p, { t: 'pty_pos', i: p.mem.indexOf(m), x: f(msg.x, -50, 400), y: f(msg.y, -50, 400), f: msg.f < 0 ? -1 : 1, w: Number.isInteger(msg.w) ? clamp(msg.w, 0, CHAR_COUNT - 1) : 0, hp: f(msg.hp, 0, 99999), mh: f(msg.mh, 1, 99999), d: msg.d ? 1 : 0 }, ws);
  }

  wave(ws, msg) {
    const c = ws.pty; if (!c || !c.p.started) return; const { p, m } = c;
    if (msg.wave !== p.wave) return;
    if (msg.st === 'clear') { m.cl = true; p.best = Math.max(p.best, p.wave); }
    else if (msg.st === 'dead') { m.alive = false; }
    else return;
    this.barrier(p);
  }

  // next wave once every remaining member has cleared it (or died); everybody dead = the run is over
  barrier(p) {
    const act = this.active(p); if (!act.length) return;
    if (!act.every((m) => m.cl || !m.alive)) return;
    if (!act.some((m) => m.alive)) {
      this.broadcast(p, { t: 'pty_end', wave: p.best });
      for (const m of act) m.ws.pty = null;
      this.parties.delete(p.code); return;
    }
    const rv = act.filter((m) => !m.alive).map((m) => p.mem.indexOf(m));
    for (const m of act) { m.alive = true; m.cl = false; }
    p.wave++;
    this.broadcast(p, { t: 'pty_next', wave: p.wave, rv });
  }

  onClose(ws) { this.leave(ws); }
  shutdown() { this.parties.clear(); }
}

module.exports = { PartyHub };
