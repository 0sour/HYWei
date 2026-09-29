// server/sim/damage.js — damage & heal pipeline, shields, dodge, element gauges (DESIGN §5.5).
//
// dealDamage order: (element → gauge path) | invulnerable? → 'hit' hook (mutable DamageInfo, may set cancel)
//   → dodge (phys/arts, canDodge) → mitigation (phys: DEF, arts: RES, true: none)
//   → × source dmgDealtMul (× phys/artsDealtMul) × target dmgTakenMul × type-taken mul × dmg.mul
//   → shields (hit-negating barriers first, then HP shields) → HP loss (boss pool routing) → 'damaged' hook
//   → SP-on-hurt / TAKE_DAMAGE trigger → fatal/kill.
// Phys: max(A − max(0, D×(1−defIgnorePct) − defIgnoreFlat), 5 %·A); Arts: max(A×(1 − R′/100), 5 %·A) with
// R′ = max(0, R×(1−resIgnorePct) − resIgnoreFlat); True: A.
// Element damage ('element' type + element) fills a gauge instead of HP (1000; enemy leaders 2000). A full gauge
// bursts with the official term-table effects (constants.js ELEMENT), which differ by the side hit:
//   operators (enemy damage):  burn 1200 arts + RES −20 10 s · neural 1000 true + stun 10 s · apoptosis 15 s: no skill
//     activation, −1 SP/s, 100 arts/s · erosion 800 phys + permanent DEF −100.
//   enemies (operator damage, "·我方"): burn 7000 元素伤害 + RES −20 (10 s) · neural 6000 元素伤害 + 3 麻痹 (10 s) ·
//     apoptosis 15 s: 50 % weaken recovering over the burst + 800 元素伤害/s · erosion 5000 元素伤害 + permanent DEF −120 (8 s).
//   necrosis (legacy spare gauge): 12 s of 100 true dmg/s and ATK −20 %.
// The gauge stays locked (full) for the burst duration ("冷却") and resets to 0 when it ends. A burst that is still
// resolving (its `elementBurst` hook runs before the `<el>Burst` lock exists; erosion on operators has no lock at all)
// already counts as locked (`unit.burstPending[el]`): same-element fills of that unit are refused until it has resolved,
// so a hook that spreads the element back (淤困 parasite hosts next to each other) cannot re-burst it recursively.
// 元素伤害 (HP damage of an element) is the DamageInfo type 'elemental' (+ optional `element` for display): no DEF/RES,
// no dodge, × source dmgDealtMul × target dmgTakenMul × elemTakenMul. Sleeping units (沉睡: 无敌) take no damage
// unless the attacker's profile has `hitSleep` or the damage carries `ignoreSleep`.

import { MIN_DAMAGE_RATIO, ELEMENT, PALSY_MAX } from './constants.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Normalise a DamageInfo descriptor. */
export function makeDamageInfo(d = {}) {
  const type = d.type ?? 'phys';
  return {
    _norm: true,
    amount: Number.isFinite(+d.amount) ? +d.amount : 0,
    type,
    element: d.element ?? null,
    atkScale: d.atkScale ?? 1,
    defIgnoreFlat: d.defIgnoreFlat ?? 0,
    defIgnorePct: d.defIgnorePct ?? 0,
    resIgnoreFlat: d.resIgnoreFlat ?? 0,
    resIgnorePct: d.resIgnorePct ?? 0,
    mul: d.mul ?? 1,
    canDodge: d.canDodge ?? (type === 'phys' || type === 'arts'),
    isSkill: !!d.isSkill,
    isSplash: !!d.isSplash,
    isAttack: !!d.isAttack,
    isProjectile: !!d.isProjectile,
    tags: d.tags ?? [],
    cancel: false,
    noSp: !!d.noSp,
    ignoreSleep: !!d.ignoreSleep,
    attackId: d.attackId ?? 0,
  };
}

/** 沉睡 (ba.sleep "无敌且无法行动"): only attackers whose profile has `hitSleep` (or `ignoreSleep` damage) reach a sleeper. */
function sleepBlocks(target, source, dmg) {
  return !!target.s.flags.sleep && !dmg.ignoreSleep && !(source && source.profile && source.profile.hitSleep);
}

/** Pure mitigation formula (exported for tests). */
export function mitigate(amount, type, target, ign = {}) {
  if (type === 'phys') {
    const D = target.def ?? 0;
    const eff = Math.max(0, D * (1 - clamp01(ign.defIgnorePct ?? 0)) - (ign.defIgnoreFlat ?? 0));
    return Math.max(amount - eff, MIN_DAMAGE_RATIO * amount);
  }
  if (type === 'arts') {
    const R = target.res ?? 0;
    const eff = Math.max(0, R * (1 - clamp01(ign.resIgnorePct ?? 0)) - (ign.resIgnoreFlat ?? 0));
    return Math.max(amount * (1 - Math.min(100, eff) / 100), MIN_DAMAGE_RATIO * amount);
  }
  return amount;
}

/** Absorb damage with shields on `target`. Returns the remaining amount. */
export function absorbShields(battle, target, amount) {
  if (amount <= 0) return 0;
  let changed = false;
  let rest = amount;
  for (let i = 0; i < target.buffs.length && rest > 0; i++) {
    const b = target.buffs[i];
    if (b.shieldHits > 0) {
      b.shieldHits--;
      rest = 0;
      if (b.shieldHits <= 0 && !(b.shield > 0) && !b.mods && !b.flags) { battle._removeBuffAt(target, i); i--; }
      changed = true;
      break;
    }
  }
  for (let i = 0; i < target.buffs.length && rest > 0; i++) {
    const b = target.buffs[i];
    if (b.shield > 0) {
      const take = Math.min(b.shield, rest);
      b.shield -= take;
      rest -= take;
      changed = true;
      if (b.shield <= 1e-9) {
        b.shield = 0;
        if (!b.mods && !b.flags && !(b.shieldHits > 0)) { battle._removeBuffAt(target, i); i--; }
      }
    }
  }
  if (changed) target.markDirty();
  return rest;
}

/**
 * Full damage pipeline. Returns the HP actually removed (0 when dodged/cancelled/absorbed).
 */
export function dealDamage(battle, source, target, dmgIn) {
  if (!target || !target.alive || target.removed || target.hidden || !target.deployed) return 0;
  const dmg = dmgIn && dmgIn._norm ? dmgIn : makeDamageInfo(dmgIn);
  if (dmg.type === 'element') return applyElement(battle, source, target, dmg);
  let ts = target.s;
  if (ts.flags.invulnerable || sleepBlocks(target, source, dmg)) return 0;
  if (battle._hooks.hit) {
    battle.emit('hit', { source, target, dmg });
    if (dmg.cancel || !target.alive || !target.deployed) return 0;
    if (dmg.type === 'element') return applyElement(battle, source, target, dmg);
    ts = target.s; // handlers may have changed the target's buffs (fragile, invulnerable, dodge…): never use stale stats
    if (ts.flags.invulnerable || sleepBlocks(target, source, dmg)) return 0;
  }
  const type = dmg.type;
  // dodge
  if (dmg.canDodge && (type === 'phys' || type === 'arts')) {
    const p = type === 'phys' ? ts.dodgePhys : ts.dodgeArts;
    if (p > 0 && battle.rng() < p) {
      battle.fx('dodge', { x: target.x, y: target.y, id: target.id });
      if (battle._hooks.dodge) battle.emit('dodge', { source, target, dmg });
      return 0;
    }
  }
  // 频次 units (flags hitCount / hitCountArts): every damage instance removes exactly 1 HP (maxHp = hits needed);
  // hitCountArts ignores physical instances. The instance keeps its own DamageInfo, so `damaged` handlers still
  // recognise their own (tagged) damage — never re-create such a loss with a fresh loseHp.
  if (ts.flags.hitCount || ts.flags.hitCountArts) {
    const counts = !(ts.flags.hitCountArts && !ts.flags.hitCount && type === 'phys');
    return applyHpLoss(battle, source, target, absorbShields(battle, target, counts ? 1 : 0), dmg);
  }
  const ss = source && source.s ? source.s : null;
  let final = mitigate(dmg.amount, type, ts, {
    defIgnorePct: dmg.defIgnorePct + (ss ? ss.defIgnorePct : 0),
    defIgnoreFlat: dmg.defIgnoreFlat + (ss ? ss.defIgnoreFlat : 0),
    resIgnorePct: dmg.resIgnorePct + (ss ? ss.resIgnorePct : 0),
    resIgnoreFlat: dmg.resIgnoreFlat + (ss ? ss.resIgnoreFlat : 0),
  });
  let mul = dmg.mul * ts.dmgTakenMul;
  if (ss) mul *= ss.dmgDealtMul * (type === 'phys' ? ss.physDealtMul : type === 'arts' ? ss.artsDealtMul : 1);
  mul *= type === 'phys' ? ts.physTakenMul : type === 'arts' ? ts.artsTakenMul : type === 'elemental' ? ts.elemTakenMul : ts.trueTakenMul;
  final *= mul;
  if (!(final > 0) || !Number.isFinite(final)) final = 0;
  final = absorbShields(battle, target, final);
  return applyHpLoss(battle, source, target, final, dmg);
}

/**
 * Remove HP (after mitigation) and run damaged/fatal/kill bookkeeping. Also used by `battle.loseHp` (流失).
 */
export function applyHpLoss(battle, source, target, amount, dmg) {
  if (!target.alive) return 0;
  let dealt = 0;
  if (target.bossPool) {
    const pool = target.bossPool;
    const before = pool.hp;
    const pid = source && source.side === 'ally' ? source.ownerId : null;
    if (amount > 0) {
      try { pool.damage(pid, amount); } catch (e) { battle._internalError('bossPool.damage', e); pool.hp = Math.max(0, pool.hp - amount); }
    }
    dealt = Math.max(0, before - pool.hp);
    if (!Number.isFinite(dealt)) dealt = 0; // a misbehaving pool (NaN hp) must not poison damage stats
    if (pid != null) { const pp = battle._pp(pid); if (pp) pp.bossDamage += dealt; }
    battle._syncBossHp(target);
  } else {
    const before = target.hp;
    target.hp -= amount;
    if (target.hp <= 0) {
      target.hp = 0;
      if (battle._hooks.fatal) {
        const fctx = { unit: target, source, dmg, amount, prevented: false };
        battle.emit('fatal', fctx);
        if (fctx.prevented && target.alive) { if (target.hp < 1) target.hp = Math.min(1, target.s.maxHp); }
      }
    }
    dealt = Math.max(0, before - Math.max(0, target.hp));
  }
  if (source) {
    source.stats.dmg += dealt;
    if (source.side === 'ally' && source.ownerId != null) { const pp = battle._pp(source.ownerId); if (pp) pp.damageDealt += dealt; }
  }
  target.stats.taken += dealt;
  target.lastHitAt = battle.time;
  if (dmg && !dmg.silent && amount >= 0.5) {
    const shown = dmg.type === 'element' ? dmg.element : dmg.type === 'elemental' ? (dmg.element || 'true') : dmg.type;
    battle._ev(['dmg', target.id, Math.round(amount), shown]);
  }
  if (battle._hooks.damaged) battle.emit('damaged', { source, target, amount, type: dmg ? dmg.type : 'true', dmg });
  if (target.side === 'ally' && target.skill && dmg && !dmg.noSp && dmg.type !== 'element') battle._skills.onDamaged(target);
  const dead = target.bossPool ? target.bossPool.hp <= 0 : target.hp <= 0;
  if (dead && target.alive) battle.kill(target, source);
  return dealt;
}

/** Is `target`'s `el` gauge locked: its `<el>Burst` buff is up, or its burst is resolving right now (see header). */
export function burstLocked(target, el) {
  return !!(target.burstPending && target.burstPending[el]) || !!target.findBuff(el + 'Burst');
}

/** Element gauge accumulation + burst. Fires `elementHit` { source, target, dmg } first (mutable amount/mul, cancel). */
export function applyElement(battle, source, target, dmg) {
  const el = dmg.element;
  if (!el || !(el in target.elem)) return 0;
  if (target.s.flags.invulnerable || sleepBlocks(target, source, dmg)) return 0;
  if (burstLocked(target, el)) return 0;
  if (battle._hooks.elementHit) {
    battle.emit('elementHit', { source, target, dmg });
    if (dmg.cancel || !target.alive || !target.deployed || burstLocked(target, el)) return 0;
    if (dmg.type !== 'element') return dealDamage(battle, source, target, dmg); // a handler converted it
  }
  const max = target.gaugeMax;
  let amt = dmg.amount * dmg.mul * target.s.elemTakenMul * (1 - clamp01(target.def?.epDamageResistance ?? 0));
  if (!(amt > 0) || !Number.isFinite(amt)) return 0;
  target.elem[el] = Math.min(max, target.elem[el] + amt);
  battle._ev(['dmg', target.id, Math.round(amt), el]);
  if (source) source.stats.elem = (source.stats.elem ?? 0) + amt;
  if (battle._hooks.damaged) battle.emit('damaged', { source, target, amount: amt, type: 'element', dmg });
  if (target.elem[el] >= max && target.alive) elementBurst(battle, source, target, el);
  return amt;
}

/**
 * A burst (see header): side-aware official effects; the `<el>Burst` buff locks the gauge for its duration. The unit
 * is marked `burstPending[el]` while the burst resolves (hook, lock, hits), so nothing re-bursts it in the meantime.
 */
export function elementBurst(battle, source, target, el) {
  if (!ELEMENT[el] || !target.alive || burstLocked(target, el)) return;
  const pending = target.burstPending || (target.burstPending = {});
  pending[el] = true;
  try { resolveBurst(battle, source, target, el); } finally { pending[el] = false; }
}

function resolveBurst(battle, source, target, el) {
  const cfg = ELEMENT[el];
  target.elem[el] = target.gaugeMax;
  const reset = () => { target.elem[el] = 0; };
  battle.fx('burst', { x: target.x, y: target.y, id: target.id, element: el });
  if (battle._hooks.elementBurst) battle.emit('elementBurst', { source, target, element: el });
  if (!target.alive) { reset(); return; }
  const tags = ['burst', el];
  const hit = (amount, type) => battle.dealDamage(source, target, { amount, type, element: el, canDodge: false, tags });
  const lock = (duration, extra = {}) => {
    if (!(duration > 0)) { reset(); return null; }
    return battle.addBuff(target, { key: `${el}Burst`, duration, visible: true, onExpire: reset, onRemove: reset, ...extra, flags: { burstLock: true, ...(extra.flags || {}) } });
  };
  if (el === 'necrosis') {
    lock(cfg.duration, {
      mods: { atkMul: 1 - cfg.atkDownPct }, interval: 1,
      onTick: () => battle.dealDamage(source, target, { amount: cfg.dps, type: 'true', canDodge: false, tags: ['burst', 'necrosis'] }),
    });
    return;
  }
  const enemy = target.side === 'enemy';
  const c = enemy ? cfg.enemy : cfg.ally;
  if (el === 'burn') {
    lock(c.duration, { mods: { resFlat: -c.resDown } });
    if (enemy) hit(c.elemDamage, 'elemental'); else hit(c.damage, c.type);
  } else if (el === 'neural') {
    lock(c.duration);
    if (enemy) {
      hit(c.elemDamage, 'elemental');
      if (target.alive) battle.applyStatus(target, 'palsy', { value: c.palsy, source });
    } else {
      hit(c.damage, c.type);
      if (target.alive) battle.applyStatus(target, 'stun', { duration: c.stun, source, force: true });
    }
  } else if (el === 'apoptosis') {
    if (enemy) {
      // 50 % 虚弱 that recovers linearly over the burst, 800 元素伤害 per second
      lock(c.duration, {
        mods: { atkMul: 1 - c.weaken }, interval: 1,
        onTick: ({ buff }) => {
          buff.mods = { atkMul: 1 - c.weaken * Math.max(0, buff.timeLeft - 1) / c.duration };
          target.markDirty();
          hit(c.elemDps, 'elemental');
        },
      });
    } else {
      // 15 s: no skill activation, −1 SP per second, 100 arts damage per second
      lock(c.duration, {
        flags: { silence: true }, interval: 1,
        onTick: () => {
          const sk = target.skill;
          if (sk && !sk.noSkill && sk.kind !== 'passive' && !(sk.active && sk.isTimed) && sk.sp > 0) sk.sp = Math.max(0, sk.sp - c.spLossPerSec);
          hit(c.dps, c.dpsType);
        },
      });
    }
  } else if (el === 'erosion') {
    // the permanent DEF cut lands first, then the hit
    lock(c.duration);
    battle.addBuff(target, { key: 'erosionDown', refresh: 'stack', stacks: 1, maxStacks: 1e6, mods: { defFlat: -c.defDown }, visible: true });
    if (enemy) hit(c.elemDamage, 'elemental'); else hit(c.damage, c.type);
  }
}

/** Add `n` 麻痹 stacks (at most PALSY_MAX). */
export function palsyBuff(n) {
  const stacks = Math.max(1, Math.min(PALSY_MAX, Math.floor(Number.isFinite(n) ? n : 1)));
  return { key: 'palsy', refresh: 'stack', stacks, maxStacks: PALSY_MAX, visible: true, status: 'palsy' };
}

/** Reduce an element gauge (e.g. wandermedic "回复元素损伤"). Returns the amount removed. */
export function reduceElement(target, amount, el = null) {
  let removed = 0;
  const els = el ? [el] : Object.keys(target.elem);
  for (const k of els) {
    if (burstLocked(target, k)) continue;
    const take = Math.min(target.elem[k], amount - removed);
    if (take > 0) { target.elem[k] -= take; removed += take; }
    if (removed >= amount) break;
  }
  return removed;
}

/** Heal pipeline. Returns the HP actually restored. */
export function heal(battle, source, target, amount, opts = {}) {
  if (!target || !target.alive || target.removed || !target.deployed || target.bossPool) return 0;
  const self = source === target || !!opts.self;
  if (!self && (target.s.flags.noHeal || (target.profile && target.profile.noHeal))) return 0;
  let amt = amount * (source && source.s ? source.s.healingDealtMul : 1) * target.s.healingTakenMul;
  if (!(amt > 0) || !Number.isFinite(amt)) return 0;
  if (battle._hooks.heal) {
    const ctx = { source, target, amount: amt, opts };
    battle.emit('heal', ctx);
    amt = Number.isFinite(ctx.amount) ? Math.max(0, ctx.amount) : 0;
    // a handler may have killed / retreated the target: healing a dead unit would leave it "dead with hp > 0"
    if (!target.alive || !target.deployed) return 0;
  }
  const max = target.s.maxHp;
  const actual = Math.max(0, Math.min(amt, max - target.hp));
  target.hp = Math.min(max, target.hp + actual);
  if (opts.overheal && amt > actual) {
    // overheal becomes a shield (capped at max HP) so hp stays within [0, maxHp]
    const cur = target.findBuff('overheal');
    const val = Math.min(max, (cur ? cur.shield : 0) + (amt - actual));
    battle.addBuff(target, { key: 'overheal', shield: val, duration: opts.overhealDuration ?? Infinity });
  }
  if (source) {
    source.stats.heal += actual;
    if (source.side === 'ally' && source.ownerId != null) { const pp = battle._pp(source.ownerId); if (pp) pp.healingDone += actual; }
  }
  if (actual >= 0.5 && !opts.silent) battle._ev(['heal', target.id, Math.round(actual)]);
  return actual;
}
