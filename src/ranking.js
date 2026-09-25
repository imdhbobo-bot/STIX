'use strict';
const fs = require('fs');
const path = require('path');

// Seasonal ranked ladder. Seasons are fixed windows counted from SEASON_START (2026-09-25 00:00 KST); when a new
// season begins the ladder is emptied (clients reset their own points when they see the new season number).
// Points are reported by clients after a server-refereed ranked match (see PvpHub 'pvp_rk'), so this is a simple,
// trust-the-client ladder — fine for a friends game, not cheat-proof.
const SEASON_START = Date.UTC(2026, 8, 24, 15, 0, 0);
const SEASON_MS = 28 * 24 * 3600 * 1000;
const MAX_ENTRIES = 5000;

class Ranking {
  constructor({ file = null, now = Date.now, start = SEASON_START, len = SEASON_MS } = {}) {
    this.file = file;
    this.now = now;
    this.start = start;
    this.len = len;
    this.season = this.seasonNo();
    this.entries = new Map(); // id -> {n, p, w, l, at}
    this.timer = null;
    this.load();
  }

  seasonNo() { return Math.max(1, Math.floor((this.now() - this.start) / this.len) + 1); }
  seasonEnd() { return this.start + this.seasonNo() * this.len; }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && j.season === this.season && Array.isArray(j.entries)) {
        for (const e of j.entries) if (e && typeof e.id === 'string') this.entries.set(e.id, { n: e.n, p: e.p | 0, w: e.w | 0, l: e.l | 0, at: e.at | 0 });
      }
    } catch { /* first run / unreadable file: start empty */ }
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const entries = [...this.entries].map(([id, e]) => ({ id, ...e }));
        fs.writeFileSync(this.file, JSON.stringify({ season: this.season, entries }));
      } catch { /* read-only disk: keep serving from memory */ }
    }, 2000);
    if (this.timer.unref) this.timer.unref();
  }

  roll() {
    const s = this.seasonNo();
    if (s !== this.season) { this.season = s; this.entries.clear(); this.save(); }
  }

  report({ id, n, pts, won }) {
    this.roll();
    if (!this.entries.has(id) && this.entries.size >= MAX_ENTRIES) return false;
    const e = this.entries.get(id) || { n, p: 0, w: 0, l: 0, at: 0 };
    e.n = n; e.p = pts; e.at = this.now();
    if (won) e.w++; else e.l++;
    this.entries.set(id, e);
    this.save();
    return true;
  }

  sorted() {
    return [...this.entries].sort((a, b) => b[1].p - a[1].p || (b[1].w - b[1].l) - (a[1].w - a[1].l) || a[1].at - b[1].at);
  }

  board(id, top = 20) {
    this.roll();
    const all = this.sorted();
    const i = id ? all.findIndex(([k]) => k === id) : -1;
    return {
      t: 'pvp_rkboard',
      s: this.season,
      end: this.seasonEnd(),
      total: all.length,
      top: all.slice(0, top).map(([, e]) => ({ n: e.n, p: e.p, w: e.w, l: e.l })),
      me: i >= 0 ? { r: i + 1, p: all[i][1].p, w: all[i][1].w, l: all[i][1].l } : null,
    };
  }
}

module.exports = { Ranking, SEASON_START, SEASON_MS };
