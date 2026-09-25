'use strict';
// Wire protocol + input validation for the plaza. The client is never trusted:
// every field is coerced/clamped here before it is stored or broadcast.
//
// client -> server (JSON text frames)
//   {t:'join',  n, w}                         optional first message
//   {t:'state', n, w, x, y, f, m, e, et}      position/character, sent ~9Hz (>= every 1.5s)
//   {t:'bye'}                                 left the plaza (socket stays open)
// server -> client
//   {t:'welcome', id, tickMs, room}
//   {t:'snap', p:[{id, n, w, x, y, f, m, e, et}, ...]}   all active players, ~10Hz

const MAP = { W: 1120, H: 840 }; // plaza size (client: PW/PH)
const CHAR_COUNT = 9;            // client: CN.length
const EMOTES = ['♥', '♪', '!', '?', '…'];
const NAME_MAX = 12;
const DEFAULT_NAME = '플레이어';
const MAX_MSG_BYTES = 512;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function sanitizeName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .trim()
    .slice(0, NAME_MAX);
  return s || DEFAULT_NAME;
}

// Returns a clean partial state; only fields that are present and valid are set.
function parseState(msg) {
  const out = {};
  if (msg.n !== undefined) out.n = sanitizeName(msg.n);
  if (msg.w !== undefined) {
    const w = Number(msg.w);
    if (Number.isInteger(w)) out.w = clamp(w, 0, CHAR_COUNT - 1);
  }
  const x = Number(msg.x), y = Number(msg.y);
  if (msg.x !== undefined && Number.isFinite(x)) out.x = Math.round(clamp(x, 0, MAP.W));
  if (msg.y !== undefined && Number.isFinite(y)) out.y = Math.round(clamp(y, 0, MAP.H));
  if (msg.f !== undefined) out.f = Number(msg.f) < 0 ? -1 : 1;
  if (msg.m !== undefined) out.m = msg.m ? 1 : 0;
  if (msg.e !== undefined) out.e = EMOTES.includes(msg.e) ? msg.e : null;
  if (msg.et !== undefined) {
    const et = Number(msg.et);
    if (Number.isFinite(et)) out.et = Math.trunc(et) % 1000000;
  }
  return out;
}

module.exports = { MAP, CHAR_COUNT, EMOTES, NAME_MAX, DEFAULT_NAME, MAX_MSG_BYTES, sanitizeName, parseState };
