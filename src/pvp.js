'use strict';
const { CHAR_COUNT, sanitizeName } = require('./protocol');
const { Ranking } = require('./ranking');

const OPEN = 1; // ws.OPEN
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const other = (side) => (side === 'red' ? 'blue' : 'red');
const num = (v, lo, hi, d = 0) => { v = Number(v); return Number.isFinite(v) ? clamp(v, lo, hi) : d; };
const TEAM_SIZE = 2;

// Real-player 1v1 matchmaking + drafts + in-battle relay. Two modes with separate queues. Both play with a team of
// TEAM_SIZE (2) characters: a player can swap between them with T during the fight (pvp_ev k:'sw', each character keeps its own
// hp/gauge), a KO brings the partner in, and a side that loses both characters loses the match.
//
//   normal : queue -> match (coin decides who picks first) -> alternating picks A B A B, picks are EXCLUSIVE
//            (nobody may take a character the opponent already has) -> battle relay -> over
//   ranked : queue -> match -> coin (decides who bans / picks first) -> BAN (1 each, alternating; my ban only
//            blocks the OPPONENT) -> PICK (2 each, alternating A B A B; picks are NOT exclusive, one player
//            can't pick the same character twice) -> battle relay
//
// The server is the referee for the *flow* (turns, timers, legality, who won). During the battle each client is
// authoritative for its own fighter; the server only validates and forwards inputs/state to the opponent.
//
// client -> server                                     server -> client
//   pvp_queue {n, owned:[w..], mode:'normal'|'ranked'}   pvp_wait {n}
//   pvp_cancel | pvp_leave                               pvp_match {mid, side, mode, opp:{n}, coin, first, coinMs}
//   pvp_hover {w}                                        pvp_turn {phase:'ban'|'pick', turn, ms, n}
//   pvp_ban {w}          (ranked)                        pvp_hover {side, w}
//   pvp_pick {w}                                         pvp_banned {side, w}     (ranked)
//   pvp_in {l,r,g,j,h,a,q,mx,my}   (battle)              pvp_picked {side, w, n}
//   pvp_st {x,y,hp,u,f}            (battle)              pvp_start {mode, red, blue}   (ranked: arrays of 3)
//   pvp_ev {k:'ult', x, one}       (battle)              pvp_in / pvp_st / pvp_ev   (relayed)
//   pvp_ev {k:'sw', i:0|1}  (swap to team slot i)        pvp_start {mode, red, blue}   (arrays of TEAM_SIZE)
//   pvp_dead                       (battle)              pvp_round {loser, idx:{red,blue}}   (every KO except the last)
//                                                        pvp_over {winner, reason:'ko'|'leave'}
//                                                        pvp_cancel {reason}
class PvpHub {
  constructor({
    room, log = () => {}, rng = Math.random, ranking = new Ranking(),
    pickMs = 20000, banMs = 15000, coinMs = 3800, revealMs = 2200, roundGuardMs = 1500,
  } = {}) {
    this.room = room;
    this.ranking = ranking;
    this.log = log;
    this.rng = rng;
    this.pickMs = pickMs;
    this.banMs = banMs;
    this.coinMs = coinMs;
    this.revealMs = revealMs;
    this.roundGuardMs = roundGuardMs;
    this.queues = { normal: [], ranked: [] }; // [{ws, n, owned:Set}]
    this.matches = new Set();
    this.seq = 0;
  }

  get stats() {
    return {
      queued: this.queues.normal.length + this.queues.ranked.length,
      queuedRanked: this.queues.ranked.length,
      matches: this.matches.size,
    };
  }

  send(ws, obj) { if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(obj)); }
  both(m, obj) { this.send(m.p.red.ws, obj); this.send(m.p.blue.ws, obj); }

  handle(ws, msg) {
    switch (msg.t) {
      case 'pvp_queue': return this.enqueue(ws, msg);
      case 'pvp_cancel':
      case 'pvp_leave': return this.leave(ws);
      case 'pvp_hover': return this.hover(ws, msg);
      case 'pvp_ban': return this.ban(ws, msg);
      case 'pvp_pick': return this.pick(ws, msg);
      case 'pvp_dead': return this.dead(ws);
      case 'pvp_rk': return this.rkReport(ws, msg);
      case 'pvp_rkget': return this.send(ws, this.ranking.board(typeof msg.id === 'string' ? msg.id.slice(0, 40) : ''));
      case 'pvp_in':
      case 'pvp_st':
      case 'pvp_ev': return this.relay(ws, msg);
      default: return undefined;
    }
  }

  // ---- queue / match creation
  enqueue(ws, msg) {
    if (ws.pvp || this.inQueue(ws)) return;
    const mode = msg.mode === 'ranked' ? 'ranked' : 'normal';
    let owned = Array.isArray(msg.owned) ? msg.owned.map(Number).filter((w) => Number.isInteger(w) && w >= 0 && w < CHAR_COUNT) : [];
    if (!owned.length) owned = [0, 1, 2, 3, 4];
    ws.pvpBusy = true;
    this.room.bye(ws); // hide from the plaza while queued / in a match
    const q = this.queues[mode];
    q.push({ ws, n: sanitizeName(msg.n), owned: new Set(owned) });
    this.send(ws, { t: 'pvp_wait', n: q.length });
    this.tryMatch(mode);
  }

  inQueue(ws) { return this.queues.normal.some((q) => q.ws === ws) || this.queues.ranked.some((q) => q.ws === ws); }

  tryMatch(mode) {
    let q = this.queues[mode] = this.queues[mode].filter((e) => e.ws.readyState === OPEN);
    while (q.length >= 2) {
      const a = q.shift(), b = q.shift();
      const [red, blue] = this.rng() < 0.5 ? [a, b] : [b, a];
      const coin = this.rng() < 0.5 ? 'heads' : 'tails';
      const m = {
        id: 'm' + (++this.seq),
        mode,
        p: { red, blue },
        phase: 'coin',
        coin,
        first: coin === 'heads' ? 'red' : 'blue', // heads -> red goes first, tails -> blue
        turn: null,
        picks: { red: null, blue: null },   // normal mode: one character each
        bans: { red: null, blue: null },    // ranked: bans[side] = what THAT side banned (blocks the other side)
        teams: { red: [], blue: [] },       // ranked: 3 picks each, in pick order
        turns: [], ti: 0,
        deaths: { red: 0, blue: 0 }, lastDead: {},
        timer: null,
      };
      red.ws.pvp = { m, side: 'red' };
      blue.ws.pvp = { m, side: 'blue' };
      this.matches.add(m);
      for (const side of ['red', 'blue']) {
        this.send(m.p[side].ws, {
          t: 'pvp_match', mid: m.id, side, mode, opp: { n: m.p[other(side)].n },
          coin, first: m.first, coinMs: this.coinMs,
        });
      }
      this.log(`pvp ${m.id} [${mode}]: ${red.n}(red) vs ${blue.n}(blue) coin=${coin} first=${m.first}`);
      m.timer = setTimeout(() => this.afterCoin(m), this.coinMs);
    }
  }

  afterCoin(m) {
    if (m.phase !== 'coin') return;
    if (m.mode === 'ranked') {
      m.phase = 'ban';
      m.turns = [m.first, other(m.first)];
      m.ti = 0;
      this.turnR(m, 'ban');
    } else {
      m.phase = 'pick';                                        // normal: no bans, straight to the picks
      m.turns = this.pickTurns(m.first);
      m.ti = 0;
      this.turnR(m, 'pick');
    }
  }

  // pick order A B A B ... (TEAM_SIZE picks each)
  pickTurns(first) {
    const t = [];
    for (let i = 0; i < TEAM_SIZE; i++) t.push(first, other(first));
    return t;
  }

  hover(ws, msg) {
    const s = ws.pvp;
    if (!s || (s.m.phase !== 'pick' && s.m.phase !== 'ban')) return;
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
    if (!m.p[side].owned.has(w)) return;                       // can only pick what you own
    if (m.mode === 'ranked') {
      if (m.bans[other(side)] === w) return;                   // the opponent banned it for me
      if (m.teams[side].includes(w) && m.p[side].owned.size >= TEAM_SIZE) return; // not the same character twice (unless you own fewer)
    } else if (m.teams.red.includes(w) || m.teams.blue.includes(w)) return; // normal: exclusive
    this.commitPickR(m, side, w);
  }

  // ---- draft turns: ranked = ban, then TEAM_SIZE alternating picks each; normal = the picks only
  turnR(m, phase) {
    clearTimeout(m.timer);
    m.turn = m.turns[m.ti];
    const ms = phase === 'ban' ? this.banMs : this.pickMs;
    this.both(m, { t: 'pvp_turn', phase, turn: m.turn, ms, n: m.ti });
    m.timer = setTimeout(() => this.autoR(m), ms);
  }

  ban(ws, msg) {
    const s = ws.pvp;
    if (!s) return;
    const { m, side } = s;
    if (m.mode !== 'ranked' || m.phase !== 'ban' || m.turn !== side) return;
    const w = Number(msg.w);
    if (!Number.isInteger(w) || w < 0 || w >= CHAR_COUNT) return;
    this.commitBan(m, side, w);
  }

  commitBan(m, side, w) {
    clearTimeout(m.timer);
    m.bans[side] = w;
    this.both(m, { t: 'pvp_banned', side, w });
    m.ti++;
    if (m.ti >= 2) {
      m.phase = 'pick';
      m.turns = this.pickTurns(m.first);
      m.ti = 0;
      this.turnR(m, 'pick');
    } else {
      this.turnR(m, 'ban');
    }
  }

  commitPickR(m, side, w) {
    clearTimeout(m.timer);
    m.teams[side].push(w);
    this.both(m, { t: 'pvp_picked', side, w, n: m.ti });
    m.ti++;
    if (m.ti >= TEAM_SIZE * 2) {
      m.phase = 'reveal';
      m.timer = setTimeout(() => this.startBattle(m), this.revealMs);
    } else {
      this.turnR(m, 'pick');
    }
  }

  autoR(m) {
    const side = m.turn;
    if (m.phase === 'ban') {
      const pool = [...m.p[other(side)].owned];            // ban something the opponent could actually use
      this.commitBan(m, side, pool.length ? pool[Math.floor(this.rng() * pool.length)] : 0);
    } else if (m.phase === 'pick') {
      let pool;
      if (m.mode === 'ranked') {
        const own = m.p[side].owned.size >= TEAM_SIZE;
        pool = [...m.p[side].owned].filter((w) => m.bans[other(side)] !== w && (!own || !m.teams[side].includes(w)));
      } else {
        pool = [...m.p[side].owned].filter((w) => !m.teams.red.includes(w) && !m.teams.blue.includes(w));
      }
      let w = pool.length ? pool[Math.floor(this.rng() * pool.length)] : -1;
      if (w < 0) { w = 0; while (w < CHAR_COUNT && (m.teams.red.includes(w) || m.teams.blue.includes(w))) w++; if (w >= CHAR_COUNT) w = 0; }
      this.commitPickR(m, side, w);
    }
  }

  startBattle(m) {
    if (m.phase !== 'reveal') return;
    m.phase = 'battle';
    this.both(m, { t: 'pvp_start', mode: m.mode, red: m.teams.red, blue: m.teams.blue });
  }

  // ---- battle relay (validated, size-bounded copies only)
  relay(ws, msg) {
    const s = ws.pvp;
    if (!s || s.m.phase !== 'battle') return;
    let out;
    if (msg.t === 'pvp_in') {
      out = {
        t: 'pvp_in', l: msg.l ? 1 : 0, r: msg.r ? 1 : 0, g: msg.g ? 1 : 0, j: msg.j ? 1 : 0, h: msg.h ? 1 : 0,
        a: msg.a === 2 ? 2 : msg.a ? 1 : 0, q: msg.q === 2 ? 2 : msg.q ? 1 : 0, v: msg.v ? 1 : 0, mx: num(msg.mx, -50, 400, 160), my: num(msg.my, -50, 250, 90),
      };
    } else if (msg.t === 'pvp_st') {
      out = { t: 'pvp_st', x: num(msg.x, -20, 340), y: num(msg.y, -200, 200), hp: num(msg.hp, 0, 5000), u: num(msg.u, 0, 1000), f: Number(msg.f) < 0 ? -1 : 1 };
    } else if (msg.t === 'pvp_ev' && msg.k === 'ult') {
      out = { t: 'pvp_ev', k: 'ult', x: num(msg.x, -20, 340), one: msg.one ? 1 : 0 };
    } else if (msg.t === 'pvp_ev' && msg.k === 'sw') {
      out = { t: 'pvp_ev', k: 'sw', i: Number(msg.i) === 1 ? 1 : 0 };      // swap to team slot 0 / 1
    } else return;
    this.send(s.m.p[other(s.side)].ws, out);
  }

  // a client reports that ITS OWN fighter died
  dead(ws) {
    const s = ws.pvp;
    if (!s || s.m.phase !== 'battle') return;
    const { m, side } = s;
    const now = Date.now();
    if (now - (m.lastDead[side] || 0) < this.roundGuardMs) return; // ignore duplicate reports of the same KO
    m.lastDead[side] = now;
    m.deaths[side]++;
    if (m.deaths[side] >= TEAM_SIZE) { this.over(m, other(side), 'ko'); return; }   // lost every character
    this.both(m, { t: 'pvp_round', loser: side, idx: { red: m.deaths.red, blue: m.deaths.blue } });
  }

  over(m, winner, reason) {
    if (m.phase === 'over') return;
    m.phase = 'over';
    clearTimeout(m.timer);
    this.both(m, { t: 'pvp_over', winner, reason });
    if (m.mode === 'ranked') { // each player may now report their new points once (see rkReport)
      const at = Date.now();
      m.p.red.ws.rkRes = { won: winner === 'red', at };
      m.p.blue.ws.rkRes = { won: winner === 'blue', at };
    }
    this.finish(m);
  }

  // client reports its new ranked points after a finished ranked match; accepted once, only if the change fits the rules
  rkReport(ws, msg) {
    const r = ws.rkRes;
    ws.rkRes = null;
    if (!r || Date.now() - r.at > 120000) return;
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 40) : '';
    const pts = Math.floor(Number(msg.pts)), old = Math.floor(Number(msg.old));
    if (!id || !Number.isFinite(pts) || !Number.isFinite(old) || pts < 0 || pts > 9999 || old < 0 || old > 9999) return;
    const d = pts - old;
    // win: 40..70 base + streak bonus up to 30; loss: -20..-50, or up to +75 net when the 3-loss underdog refund applies
    if (r.won ? d < 40 || d > 100 : d < -50 || d > 75) return;
    this.ranking.report({ id, n: sanitizeName(msg.n), pts, won: r.won });
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
    for (const mode of ['normal', 'ranked']) {
      const qi = this.queues[mode].findIndex((q) => q.ws === ws);
      if (qi >= 0) this.queues[mode].splice(qi, 1);
    }
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
    this.queues = { normal: [], ranked: [] };
  }
}

module.exports = { PvpHub };
