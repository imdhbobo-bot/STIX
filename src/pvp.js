'use strict';
const { CHAR_COUNT, sanitizeName } = require('./protocol');

const OPEN = 1; // ws.OPEN
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const other = (side) => (side === 'red' ? 'blue' : 'red');
const num = (v, lo, hi, d = 0) => { v = Number(v); return Number.isFinite(v) ? clamp(v, lo, hi) : d; };

// Real-player 1v1 matchmaking + alternating draft + in-battle relay.
//
//   queue -> match (coin flip decides who picks first) -> pick turns (first side, then the other,
//   each pick is exclusive and visible live to the opponent) -> battle relay -> over
//
// The server is the referee for the *flow* (turns, timers, exclusive picks, who won).
// During the battle each client is authoritative for its own fighter; the server only validates and
// forwards inputs/state to the opponent.
//
// client -> server                                    server -> client
//   pvp_queue {n, owned:[w..]}                          pvp_wait {n}
//   pvp_cancel | pvp_leave                              pvp_match {mid, side, opp:{n}, coin, first, coinMs}
//   pvp_hover {w}                                       pvp_turn {turn, ms}
//   pvp_pick {w}                                        pvp_hover {side, w}
//   pvp_in {l,r,g,j,h,a,q,mx,my}   (battle)             pvp_picked {side, w}
//   pvp_st {x,y,hp,u,f}            (battle)             pvp_start {red, blue}
//   pvp_ev {k:'ult', x, one}       (battle)             pvp_in / pvp_st / pvp_ev   (relayed)
//   pvp_dead                       (battle)             pvp_over {winner, reason:'ko'|'leave'}
//                                                       pvp_cancel {reason}
class PvpHub {
  constructor({ room, log = () => {}, rng = Math.random, pickMs = 20000, coinMs = 3800, revealMs = 2200 } = {}) {
    this.room = room;
    this.log = log;
    this.rng = rng;
    this.pickMs = pickMs;
    this.coinMs = coinMs;
    this.revealMs = revealMs;
    this.queue = [];          // [{ws, n, owned:Set}]
    this.matches = new Set();
    this.seq = 0;
  }

  get stats() { return { queued: this.queue.length, matches: this.matches.size }; }

  send(ws, obj) { if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(obj)); }
  both(m, obj) { this.send(m.p.red.ws, obj); this.send(m.p.blue.ws, obj); }

  handle(ws, msg) {
    switch (msg.t) {
      case 'pvp_queue': return this.enqueue(ws, msg);
      case 'pvp_cancel':
      case 'pvp_leave': return this.leave(ws);
      case 'pvp_hover': return this.hover(ws, msg);
      case 'pvp_pick': return this.pick(ws, msg);
      case 'pvp_dead': return this.dead(ws);
      case 'pvp_in':
      case 'pvp_st':
      case 'pvp_ev': return this.relay(ws, msg);
      default: return undefined;
    }
  }

  // ---- queue / match creation
  enqueue(ws, msg) {
    if (ws.pvp || this.queue.some((q) => q.ws === ws)) return;
    let owned = Array.isArray(msg.owned) ? msg.owned.map(Number).filter((w) => Number.isInteger(w) && w >= 0 && w < CHAR_COUNT) : [];
    if (!owned.length) owned = [0, 1, 2, 3, 4];
    ws.pvpBusy = true;
    this.room.bye(ws); // hide from the plaza while queued / in a match
    this.queue.push({ ws, n: sanitizeName(msg.n), owned: new Set(owned) });
    this.send(ws, { t: 'pvp_wait', n: this.queue.length });
    this.tryMatch();
  }

  tryMatch() {
    this.queue = this.queue.filter((q) => q.ws.readyState === OPEN);
    while (this.queue.length >= 2) {
      const a = this.queue.shift(), b = this.queue.shift();
      const [red, blue] = this.rng() < 0.5 ? [a, b] : [b, a];
      const coin = this.rng() < 0.5 ? 'heads' : 'tails';
      const m = {
        id: 'm' + (++this.seq),
        p: { red, blue },
        phase: 'coin',
        coin,
        first: coin === 'heads' ? 'red' : 'blue', // heads -> red picks first, tails -> blue
        turn: null,
        picks: { red: null, blue: null },
        timer: null,
      };
      red.ws.pvp = { m, side: 'red' };
      blue.ws.pvp = { m, side: 'blue' };
      this.matches.add(m);
      for (const side of ['red', 'blue']) {
        this.send(m.p[side].ws, {
          t: 'pvp_match', mid: m.id, side, opp: { n: m.p[other(side)].n },
          coin, first: m.first, coinMs: this.coinMs,
        });
      }
      this.log(`pvp ${m.id}: ${red.n}(red) vs ${blue.n}(blue) coin=${coin} first=${m.first}`);
      m.timer = setTimeout(() => this.beginPick(m), this.coinMs);
    }
  }

  // ---- draft
  beginPick(m) {
    if (m.phase !== 'coin') return;
    m.phase = 'pick';
    m.turn = m.first;
    this.turn(m);
  }

  turn(m) {
    clearTimeout(m.timer);
    this.both(m, { t: 'pvp_turn', turn: m.turn, ms: this.pickMs });
    m.timer = setTimeout(() => this.autoPick(m), this.pickMs);
  }

  hover(ws, msg) {
    const s = ws.pvp;
    if (!s || s.m.phase !== 'pick') return;
    const w = Number(msg.w);
    if (!Number.isInteger(w) || w < 0 || w >= CHAR_COUNT) return;
    this.send(s.m.p[other(s.side)].ws, { t: 'pvp_hover', side: s.side, w });
  }

  pick(ws, msg) {
    const s = ws.pvp;
    if (!s) return;
    const { m, side } = s;
    if (m.phase !== 'pick' || m.turn !== side) return;
    const w = Number(msg.w);
    if (!Number.isInteger(w) || w < 0 || w >= CHAR_COUNT) return;
    if (!m.p[side].owned.has(w)) return;            // can only pick what you own
    if (m.picks[other(side)] === w) return;          // exclusive: the opponent already took it
    this.commit(m, side, w);
  }

  autoPick(m) {
    if (m.phase !== 'pick') return;
    const side = m.turn, taken = m.picks[other(side)];
    const pool = [...m.p[side].owned].filter((w) => w !== taken);
    const w = pool.length ? pool[Math.floor(this.rng() * pool.length)] : (taken === 0 ? 1 : 0);
    this.commit(m, side, w);
  }

  commit(m, side, w) {
    clearTimeout(m.timer);
    m.picks[side] = w;
    this.both(m, { t: 'pvp_picked', side, w });
    if (m.picks.red !== null && m.picks.blue !== null) {
      m.phase = 'reveal';
      m.timer = setTimeout(() => this.startBattle(m), this.revealMs);
    } else {
      m.turn = other(side);
      this.turn(m);
    }
  }

  startBattle(m) {
    if (m.phase !== 'reveal') return;
    m.phase = 'battle';
    this.both(m, { t: 'pvp_start', red: m.picks.red, blue: m.picks.blue });
  }

  // ---- battle relay (validated, size-bounded copies only)
  relay(ws, msg) {
    const s = ws.pvp;
    if (!s || s.m.phase !== 'battle') return;
    let out;
    if (msg.t === 'pvp_in') {
      out = {
        t: 'pvp_in', l: msg.l ? 1 : 0, r: msg.r ? 1 : 0, g: msg.g ? 1 : 0, j: msg.j ? 1 : 0, h: msg.h ? 1 : 0,
        a: msg.a ? 1 : 0, q: msg.q ? 1 : 0, mx: num(msg.mx, -50, 400, 160), my: num(msg.my, -50, 250, 90),
      };
    } else if (msg.t === 'pvp_st') {
      out = { t: 'pvp_st', x: num(msg.x, -20, 340), y: num(msg.y, -200, 200), hp: num(msg.hp, 0, 5000), u: num(msg.u, 0, 1000), f: Number(msg.f) < 0 ? -1 : 1 };
    } else if (msg.t === 'pvp_ev' && msg.k === 'ult') {
      out = { t: 'pvp_ev', k: 'ult', x: num(msg.x, -20, 340), one: msg.one ? 1 : 0 };
    } else return;
    this.send(s.m.p[other(s.side)].ws, out);
  }

  // a client reports that ITS OWN fighter died -> the other side wins
  dead(ws) {
    const s = ws.pvp;
    if (!s || s.m.phase !== 'battle') return;
    this.over(s.m, other(s.side), 'ko');
  }

  over(m, winner, reason) {
    if (m.phase === 'over') return;
    m.phase = 'over';
    clearTimeout(m.timer);
    this.both(m, { t: 'pvp_over', winner, reason });
    this.finish(m);
  }

  finish(m) {
    this.matches.delete(m);
    for (const side of ['red', 'blue']) {
      const ws = m.p[side].ws;
      if (ws.pvp && ws.pvp.m === m) { ws.pvp = null; ws.pvpBusy = false; }
    }
  }

  // explicit leave, cancel, or disconnect
  leave(ws) {
    const qi = this.queue.findIndex((q) => q.ws === ws);
    if (qi >= 0) this.queue.splice(qi, 1);
    const s = ws.pvp;
    if (s) {
      const { m, side } = s;
      if (m.phase === 'battle') {
        this.over(m, other(side), 'leave');         // leaving a live fight = forfeit
      } else if (m.phase !== 'over') {
        m.phase = 'over';
        clearTimeout(m.timer);
        this.send(m.p[other(side)].ws, { t: 'pvp_cancel', reason: 'leave' }); // before the fight: nobody wins/loses
        this.finish(m);
      }
    }
    ws.pvp = null;
    ws.pvpBusy = false;
  }

  onClose(ws) { this.leave(ws); }

  shutdown() {
    for (const m of this.matches) clearTimeout(m.timer);
    this.matches.clear();
    this.queue = [];
  }
}

module.exports = { PvpHub };
