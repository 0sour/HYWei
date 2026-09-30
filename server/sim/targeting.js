// server/sim/targeting.js — range tests, target filters and priorities (DESIGN §3, §5.5).
//
// Grid ranges: `[dRow, dCol]` offsets relative to facing RIGHT, rotated by the unit's direction (sim/dir.js: RIGHT
// (dr,dc), UP (dc,−dr), LEFT (−dr,−dc), DOWN (−dc,dr); row 0 = bottom). An enemy is in range when the tile containing
// it (round(y), round(x)) is one of the absolute range tiles — a huge enemy (巨型单位) when any tile its hit rectangle
// occupies is (body.js; user playtest #5 item 10). `rangeExtend` (ability_range_forward_extend) adds N tiles
// past the furthest cell of every row, along +dCol BEFORE rotating (DESIGN §3).
// Operator priority: (1) enemies it blocks (melee units only: meleeUnit), (2) profile priority (fly/lowDef/…),
// (3) higher enemy taunt, (4) least remaining path distance to the goal, (5) earliest spawned. Air units
// (Unit.isFlying: FLY, 近地悬浮, 浮空) need a profile that can hit them (`canHitFly`, never `groundOnly`). Enemy
// priority: sortAllyTargets.

import { COLS, ROWS } from './constants.js';
import { normDir, rotateOffset } from './dir.js';
import { bodyDist } from './body.js';

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

/**
 * A melee unit (近战位: data `position` MELEE — melee-tile operators and summons, 重装要塞 / 领主 / 哨戒铁卫 included):
 * it may always select, and selects first, the enemies it blocks — PRTS 选择器 "可以选择且优先选择阻挡单位" (the
 * BlockedOrAdvancedSelector of units whose range is smaller than their block radius), 索敌的概念 "我方索敌优先级：
 * 阻挡（近战限定）". A ranged operator standing on a melee tile (卫戍协议 "所有行动内远程干员可部署在近战位") blocks, but
 * targets by its range alone: "远程位干员通常而言不会优先攻击自己阻挡的目标；甚至如果这个目标被阻挡在该干员的身后，该干员
 * 可能因为敌人未处于自身攻击范围而无法攻击到这个敌人" (索敌的概念). Used by Battle.blockedTargets and sortEnemyTargets.
 */
export function meleeUnit(u) {
  return String(u?.def?.position ?? 'MELEE').toUpperCase() === 'MELEE';
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

/**
 * Can enemy `e` target ally `a`? `ranged` = the attack is a ranged (non-blocked) one. A stealthed ally (隐匿 / 迷彩, the
 * 排气格栅 tile) is a target only for the enemy it blocks — PRTS 作战机制 §隐匿 "我方干员并不会因为阻挡而解除隐匿" and 索敌的
 * 概念 "敌人会在自身被干员阻挡情况下强行无视对方可选性发动攻击" (the term text "不阻挡时…" is the short form; 异常效果:
 * "隐匿与'阻挡时解除'没有直接关系"). Devices are never targets (阻隔工事: obstacles nobody can select; “双眼皮”: 迷彩 and
 * off the enemy paths — PRTS).
 */
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
  const melee = meleeUnit(attacker);
  const keyed = cands.map((e) => ({
    e,
    b: melee && e.blockedBy === attacker ? 0 : 1,
    p: pf ? pf(e) : priority === 'nearest' ? bodyDist(e, ax, ay) : priority === 'farthest' ? -bodyDist(e, ax, ay) : 0,
    t: -(e.s.taunt || 0),
    d: battle.remainingDistance(e),
    s: e.spawnSeq,
  }));
  keyed.sort((a, b) => a.b - b.b || a.p - b.p || a.t - b.t || a.d - b.d || a.s - b.s);
  for (let i = 0; i < keyed.length; i++) cands[i] = keyed[i].e;
  return cands;
}

/**
 * Enemy target selection among allies (PRTS 作战机制 索敌, 敌方: "阻挡→特殊优先级→仇恨值（更容易被攻击→…→最后部署的目标→
 * 不容易被攻击）→最早出现"): its blocker first → highest taunt level → latest deployed (`aggroSeq`: the deploy order —
 * Battle.start deploys the operators first and ranks the start-of-battle summons after them). Special priorities
 * (优先攻击…) are the enemies' own content: `e.profile.canTarget` filters, key sorts broken by `aggroCmp`.
 */
export function sortAllyTargets(enemy, cands) {
  if (cands.length <= 1) return cands;
  cands.sort((a, b) => {
    const ba = enemy.blockedBy === a ? 0 : 1, bb = enemy.blockedBy === b ? 0 : 1;
    return ba - bb || aggroCmp(a, b);
  });
  return cands;
}

/**
 * 仇恨值 order of two allies for an enemy (negative ⇒ `a` first): higher taunt level, then the latest deployed
 * (`aggroSeq`). The tie-break after an enemy's special priority (优先攻击防御力最高的… — PRTS 索敌: 特殊优先级 → 仇恨值).
 */
export function aggroCmp(a, b) {
  const ta = a.s.taunt || 0, tb = b.s.taunt || 0;
  if (ta !== tb) return tb - ta;
  return (b.aggroSeq || b.deploySeq) - (a.aggroSeq || a.deploySeq);
}
