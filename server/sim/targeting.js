// server/sim/targeting.js — range tests, target filters and priorities (DESIGN §3, §5.5).
//
// Grid ranges: `[dRow, dCol]` offsets relative to facing RIGHT, rotated by the unit's direction (sim/dir.js: RIGHT
// (dr,dc), UP (dc,−dr), LEFT (−dr,−dc), DOWN (−dc,dr); row 0 = bottom). An enemy is in range when the tile containing
// it (round(y), round(x)) is one of the absolute range tiles. `rangeExtend` (ability_range_forward_extend) adds N tiles
// past the furthest cell of every row, along +dCol BEFORE rotating (DESIGN §3).
// Operator priority: (1) enemies it blocks, (2) profile priority (fly/lowDef/…), (3) higher enemy taunt,
// (4) least remaining path distance to the goal, (5) earliest spawned.

import { COLS, ROWS } from './constants.js';
import { normDir, rotateOffset } from './dir.js';

/**
 * Build the absolute tile-key list of a grid for a unit standing at (r,c) facing `dir` ('UP'|'RIGHT'|'DOWN'|'LEFT';
 * a legacy facing sign ±1 is read as RIGHT / LEFT).
 */
export function absoluteRangeKeys(grid, r, c, dir, extend = 0) {
  const keys = [];
  const seen = new Set();
  const d = normDir(dir);
  const add = (dr, dc) => {
    const [ar, ac] = rotateOffset(dr, dc, d);
    const rr = r + ar, cc = c + ac;
    if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) return;
    const k = rr * COLS + cc;
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  };
  // kits may hand over junk (a number, a string, [[1,'a']]): ignore anything that is not an integer [dr, dc] pair
  // instead of throwing inside the attack loop every tick
  if (!Array.isArray(grid) || !Number.isInteger(r) || !Number.isInteger(c)) return keys;
  const cells = grid.filter((p) => Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1]));
  for (const [dr, dc] of cells) add(dr, dc);
  if (extend > 0 && Number.isFinite(extend)) {
    const maxByRow = new Map();
    for (const [dr, dc] of cells) maxByRow.set(dr, Math.max(maxByRow.get(dr) ?? -Infinity, dc));
    for (const [dr, mx] of maxByRow) for (let k = 1; k <= Math.min(extend, COLS); k++) add(dr, mx + k);
  }
  return keys;
}

/** Tile key of a unit's current position. */
export function tileKeyOf(u) {
  const r = Math.round(u.y), c = Math.round(u.x);
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return -1;
  return r * COLS + c;
}

/** Can `attacker` (ally) target enemy `e` at all (ignoring range)? */
export function canTargetEnemy(attacker, e, profile) {
  if (!e.alive || e.hidden || !e.deployed) return false;
  const f = e.s.flags;
  if (f.untargetable || (f.sleep && !(profile && profile.hitSleep))) return false;
  if (f.stealth && !f.reveal && !e.blockedBy) return false;
  if (e.isFlying && !(profile && profile.canHitFly)) return false;
  if (profile && profile.groundOnly && e.isFlying) return false;
  return true;
}

/** Can enemy `e` target ally `a`? `ranged` = the attack is a ranged (non-blocked) one. */
export function canTargetAlly(e, a, ranged) {
  if (!a.alive || !a.deployed || a.hidden || a.kind === 'device') return false;
  const f = a.s.flags;
  if (f.untargetable || f.sleep) return false;
  if (ranged && f.stealth && e.blockedBy !== a) return false;
  return true;
}

const PRIORITY_FNS = {
  fly: (e) => (e.isFlying ? 0 : 1),
  lowDef: (e) => e.s.def,
  highDef: (e) => -e.s.def,
  ranged: (e) => (e.base.rangeRadius > 0 && e.def?.applyWay !== 'MELEE' ? 0 : 1),
  lowestHp: (e) => e.hp,
  highestHp: (e) => -e.hp,
  lowestHpRatio: (e) => e.hpRatio,
  highestAtk: (e) => -e.s.atk,
  boss: (e) => (e.isBoss ? 0 : 1),
  notBurst: (e) => (e.s.flags.burstLock ? 1 : 0),
  ground: (e) => (e.isFlying ? 1 : 0),
};

/**
 * Sort candidate enemies for an attacker (in place) and return them.
 * @param {object} attacker ally unit
 * @param {object[]} cands enemies
 * @param {string|null} priority profile/skill priority key
 */
export function sortEnemyTargets(battle, attacker, cands, priority) {
  if (cands.length <= 1) return cands;
  const pf = priority ? (PRIORITY_FNS[priority] || (priority === 'nearest' || priority === 'farthest' ? null : null)) : null;
  const ax = attacker.x, ay = attacker.y;
  const keyed = cands.map((e) => ({
    e,
    b: e.blockedBy === attacker ? 0 : 1,
    p: pf ? pf(e) : priority === 'nearest' ? Math.hypot(e.x - ax, e.y - ay) : priority === 'farthest' ? -Math.hypot(e.x - ax, e.y - ay) : 0,
    t: -(e.s.taunt || 0),
    d: battle.remainingDistance(e),
    s: e.spawnSeq,
  }));
  keyed.sort((a, b) => a.b - b.b || a.p - b.p || a.t - b.t || a.d - b.d || a.s - b.s);
  for (let i = 0; i < keyed.length; i++) cands[i] = keyed[i].e;
  return cands;
}

/**
 * Enemy target selection among allies: blocker first → highest taunt → latest deployed (DESIGN §5.5).
 */
export function sortAllyTargets(enemy, cands) {
  if (cands.length <= 1) return cands;
  cands.sort((a, b) => {
    const ba = enemy.blockedBy === a ? 0 : 1, bb = enemy.blockedBy === b ? 0 : 1;
    if (ba !== bb) return ba - bb;
    const ta = a.s.taunt || 0, tb = b.s.taunt || 0;
    if (ta !== tb) return tb - ta;
    return b.deploySeq - a.deploySeq;
  });
  return cands;
}
