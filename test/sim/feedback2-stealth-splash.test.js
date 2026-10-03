// GitHub issue #32 item 6 (after 0.1.1): 「隐蔽单位仍会受到溅射伤害」 — a 隐匿 operator still took enemy splash.
//
// Official: PRTS 作战机制 §隐匿 "隐匿效果使得获得该效果的单位无法被任何敌方的能力索敌选中" (a stealthed operator that blocks an
// enemy is attacked by it whatever its selectability: "因为“阻挡优先级最高”的效果，敌人会无视一切可选性对该干员进行攻击");
// §AOE伤害判定 "AOE的判定是对攻击范围内的每个可以被选中的敌人进行判定"; PRTS 选择器 (可选判定): a selector skips 无法选择 units
// unless the ability "无视可选性" — as PRTS marks 萨卡兹悖谬暴虐兵长's 暴击 "（无视无法选择，无视迷彩）" and 假想敌：淤困's burst
// spread "（中点判定，无视目标可选性，不受迷彩制约）"; gamedata_const ba.invisible 隐匿 "不阻挡时不成为敌方攻击的目标" vs
// ba.camou 迷彩 "不阻挡时不成为敌方普通攻击的目标（无法躲避溅射类攻击）"; PRTS 异常效果 迷彩 "所有光环类能力、以及涉及中点判定/
// 格子判定的效果均不受迷彩制约"; PRTS 选择器 "所有触发选择器通常不无视迷彩" (an area skill is cast for a target it may attack).
// Cause: the enemy side's area effects (content/enemies.js, content/bosses.js) took every ally in the area; only the
// operator side skipped an unblocked 隐匿 enemy (Battle.foesInRadius, 0.1.1).
// Now: targeting.js areaSelectable / enemies.js areaAllies, areaAlliesInTiles, fieldAllies — no 隐匿 ally unless it blocks
// the enemy, no untargetable or sleeping one, no airborne 起飞 one for a ground enemy; 迷彩 is hit (DESIGN §22.12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { hasGeneratedData } from '../../server/sim/simdata.js';
import { areaSelectable } from '../../server/sim/targeting.js';
import { areaAllies } from '../../server/sim/content/enemies.js';

const REAL = { skip: !hasGeneratedData() };
const JF = 'chess_char_1_02_a';   // 角峰 (重装, blocks 3)
const GM = 'chess_char_1_10_a';   // 古米 (重装, blocks 3)
const HD = 'chess_char_1_05_a';   // 红豆 (先锋)
const SKULSR = 'enemy_1500_skulsr'; // 碎骨: unblocked, its attacks are grenades that splash the target's surroundings
const POMPEII = 'enemy_1050_lslime'; // “庞贝”: blocked ⇒ every 10 s a radius-1 arts self-blast
const LUCIEN = 'enemy_2016_csphtm';  // 卢西恩，“猩红血钻” (boss_5): 【aoe】 radius 2, "需要目标", "该技能伤害无视迷彩"
const BRUTE = 'enemy_1320_wdrrl_2';  // 萨卡兹悖谬暴虐兵长: first attack's 暴击 splash "无视无法选择，无视迷彩"
const PARASITE = 'enemy_9007_acelem'; // 假想敌：淤困: parasitises its blocker; the host's burst spreads "无视目标可选性"
const FAKE_SUIT = 'chess_item_4_04_e_a'; // 伪装服: first damage taken ⇒ 隐匿 15 s

const done = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors.map((e) => `${e.label} ${e.message}`), []); };
const stealth = (h, u) => h.b.applyStatus(u, 'stealth', { duration: 999, source: u });
const camou = (h, u) => h.b.applyStatus(u, 'camou', { duration: 999, source: u });
/** Every damage instance the enemy `key` deals: { t, target, attack (a normal attack), skill, amount, tags }. */
function damageLog(h, key) {
  const log = [];
  h.b.on('damaged', (c) => {
    if (!c.source || c.source.defId !== key) return;
    log.push({ t: h.b.time, target: c.target, attack: !!c.dmg.isAttack, skill: !!c.dmg.isSkill, amount: c.amount, tags: c.dmg.tags || [] });
  }, { priority: 1000 });
  return log;
}
function countFx(h, kind) {
  const n = { v: 0 };
  const fx0 = h.b.fx.bind(h.b);
  h.b.fx = (k, p) => { if (k === 'explode' && p && p.kind === kind) n.v++; return fx0(k, p); };
  return n;
}

test('areaSelectable: no 隐匿 ally unless it blocks the source, no untargetable / sleeping one, no 起飞 one for a ground source; 迷彩 is selected', () => {
  const h = makeBattle({
    seed: 2, autoFinish: false, timeLimit: 60,
    defs: { enemies: { enemy_g: enemyRec({ key: 'enemy_g', hp: 1e7, speed: 0 }), enemy_f: enemyRec({ key: 'enemy_f', hp: 1e7, speed: 0, motion: 'FLY' }) } },
    units: [{ chessId: JF, row: 9, col: 6 }, { chessId: GM, row: 10, col: 6 }, { chessId: HD, row: 9, col: 7 }],
    enemies: [{ key: 'enemy_g', pos: [9, 6] }, { key: 'enemy_f', pos: [11, 6] }],
  });
  h.step(2);
  const jf = h.unit(JF), gm = h.unit(GM), hd = h.unit(HD);
  const g = h.b.enemies.find((e) => e.defId === 'enemy_g'), f = h.b.enemies.find((e) => e.defId === 'enemy_f');
  assert.equal(g.blockedBy, jf, '角峰 blocks the ground enemy');
  assert.ok(f.isFlying && !g.isFlying);
  for (const u of [jf, gm, hd]) assert.ok(areaSelectable(g, u) && areaSelectable(f, u) && areaSelectable(null, u), `${u.def.name}: plain ⇒ selected`);
  stealth(h, jf); stealth(h, gm);
  assert.equal(areaSelectable(g, jf), true, '隐匿 but blocking the source: selected');
  assert.equal(areaSelectable(f, jf), false, '隐匿, blocking another enemy: not selected');
  assert.equal(areaSelectable(g, gm), false, '隐匿, not blocking: not selected');
  assert.equal(areaSelectable(null, gm), false, '隐匿 vs an effect with no selecting enemy');
  assert.deepEqual(areaAllies(h.b, g, g.x, g.y, 1.01).map((u) => u.def.name).sort(), [jf, hd].map((u) => u.def.name).sort(), 'areaAllies: the 隐匿 bystander is left out');
  camou(h, hd);
  assert.equal(areaSelectable(g, hd), true, '迷彩: still selected by an area effect ("无法躲避溅射类攻击")');
  h.b.addBuff(gm, { key: 'test:liftoff', persist: true, flags: { liftoff: true } });
  h.b.removeBuff(gm, 'stealth');
  assert.equal(areaSelectable(g, gm), false, '起飞 vs a ground source (对地规避)');
  assert.equal(areaSelectable(f, gm), true, '起飞 vs a flying source');
  assert.equal(areaSelectable(null, gm), true, '起飞 vs no source');
  h.b.removeBuff(gm, 'test:liftoff');
  h.b.addBuff(gm, { key: 'test:untargetable', persist: true, flags: { untargetable: true } });
  assert.equal(areaSelectable(f, gm), false, 'untargetable (不可选中)');
  h.b.removeBuff(gm, 'test:untargetable');
  h.b.addBuff(gm, { key: 'test:sleep', persist: true, flags: { sleep: true } });
  assert.equal(areaSelectable(f, gm), false, 'asleep (沉睡 = 无敌)');
  h.b.removeBuff(gm, 'test:sleep');
  h.b.kill(g, null);
  assert.equal(areaSelectable(g, jf), false, 'a dead source (death blast) blocks nobody: its 隐匿 former blocker is spared');
  done(h);
});

/** 碎骨 walks lane row 9 and grenades 角峰 on (10,6); 古米 stands next to it (distance 1 = the splash radius). */
function grenades({ gm = [10, 7], items = [], status = null, seconds = 25 } = {}) {
  const h = makeBattle({
    seed: 5, timeLimit: 120, autoFinish: false,
    units: [{ chessId: JF, row: 10, col: 6, dir: 'RIGHT' }, { chessId: GM, row: gm[0], col: gm[1], dir: 'RIGHT', items }],
    enemies: [{ key: SKULSR, route: 0, time: 3 }],
  });
  h.step(1);
  const jf = h.unit(JF), g = h.unit(GM);
  if (status) h.b.applyStatus(g, status, { duration: 999, source: g });
  const log = damageLog(h, SKULSR);
  h.run(seconds);
  return { h, jf, g, log, onJf: log.filter((x) => x.target === jf && x.attack), splashOnG: log.filter((x) => x.target === g && !x.attack), attacksOnG: log.filter((x) => x.target === g && x.attack) };
}

test('#32.6 碎骨: a 隐匿 operator next to the grenade\'s target takes no splash; a 迷彩 one still does', REAL, () => {
  const hid = grenades({ status: 'stealth' });
  assert.ok(hid.onJf.length >= 4, `4+ grenades on 角峰 (${hid.onJf.length})`);
  assert.ok(hid.g.s.flags.stealth, '古米 stays 隐匿 (999 s)');
  assert.deepEqual(hid.log.filter((x) => x.target === hid.g).map((x) => `${x.t.toFixed(2)} ${Math.round(x.amount)}`), [], '隐匿, not blocking: nothing reaches it (in 0.1.1: 4 splashes, knocked out)');
  done(hid.h);
  const cam = grenades({ status: 'camou' });
  assert.ok(cam.onJf.length >= 4, `4+ grenades on 角峰 (${cam.onJf.length})`);
  assert.equal(cam.attacksOnG.length, 0, '迷彩: never the grenade\'s target');
  const standing = (t) => cam.g.alive || t <= cam.g.deathAt + 1e-6;     // the splashes may knock it out
  assert.ok(cam.splashOnG.length >= 3, `迷彩: splashed (${cam.splashOnG.length})`);
  assert.equal(cam.splashOnG.length, cam.onJf.filter((x) => standing(x.t)).length, '迷彩: splashed by every grenade while it stands (ba.camou "无法躲避溅射类攻击")');
  assert.ok(cam.splashOnG.every((x) => x.skill && x.amount > 0));
  done(cam.h);
});

test('#32.6 碎骨: 伪装服\'s 隐匿 (its carrier\'s first damage) spares the carrier from the following splashes until it ends', REAL, () => {
  // 古米 on (10,5) — deployed before 角峰, so 角峰 is the grenades' target (latest deployed) and 古米 its neighbour
  const r = grenades({ gm: [10, 5], items: [FAKE_SUIT], seconds: 32 });
  const first = r.splashOnG[0];
  assert.ok(first && first.amount > 0, 'the first grenade splashes 古米 — its first damage');
  const end = first.t + 15;
  const during = r.log.filter((x) => x.target === r.g && x.t > first.t + 1e-6 && x.t < end - 1e-6);
  const jfDuring = r.onJf.filter((x) => x.t > first.t + 1e-6 && x.t < end - 1e-6);
  assert.ok(jfDuring.length >= 3, `grenades kept landing next to it (${jfDuring.length})`);
  assert.deepEqual(during.map((x) => `${x.t.toFixed(2)} ${Math.round(x.amount)}`), [], '伪装服 隐匿 (flag `stealth`): no splash for its 15 s');
  assert.ok(r.log.some((x) => x.target === r.g && x.t > end), '…and hit again once its 隐匿 ends');
  done(r.h);
});

test('#32.6 “庞贝”\'s self-blast while blocked hits its 隐匿 blocker and a 迷彩 bystander, not a 隐匿 bystander', REAL, () => {
  const h = makeBattle({
    seed: 3, timeLimit: 120, autoFinish: false,
    units: [{ chessId: JF, row: 9, col: 6, dir: 'RIGHT' }, { chessId: GM, row: 10, col: 6, dir: 'RIGHT' }, { chessId: HD, row: 9, col: 7, dir: 'RIGHT' }],
    enemies: [{ key: POMPEII, pos: [9, 6], time: 1, mods: { hpMul: 1e3, speedMul: 0, atkMul: 0.01 } }],
  });
  h.step(1);
  const jf = h.unit(JF), gm = h.unit(GM), hd = h.unit(HD);
  stealth(h, jf); stealth(h, gm); camou(h, hd);
  const log = damageLog(h, POMPEII), blasts = countFx(h, 'selfBlast');
  h.run(12);
  const p = h.b.enemies.find((e) => e.defId === POMPEII);
  assert.equal(p.blockedBy, jf, 'blocked by the 隐匿 角峰');
  assert.equal(blasts.v, 1, 'one self-blast in 12 s');
  const blast = (u) => log.filter((x) => x.target === u && x.skill && !x.attack).length;
  assert.equal(blast(jf), 1, '隐匿 blocker: hit (a blocked enemy ignores its blocker\'s selectability)');
  assert.equal(blast(hd), 1, '迷彩 bystander: hit');
  assert.equal(blast(gm), 0, '隐匿 bystander (distance 1, not blocking): spared');
  done(h);
});

test('#32.6 boss: 卢西恩\'s 【aoe】 is not cast for 隐匿 / 迷彩 operators alone; cast, it hits the 迷彩 and plain ones, not the 隐匿 one', REAL, () => {
  const run = (plain) => {
    const units = [{ chessId: JF, row: 10, col: 5, dir: 'RIGHT' }, { chessId: GM, row: 11, col: 6, dir: 'RIGHT' }];
    if (plain) units.push({ chessId: HD, row: 9, col: 6, dir: 'RIGHT' });
    const h = makeBattle({ seed: 3, timeLimit: 400, autoFinish: false, units, enemies: [{ key: LUCIEN, pos: [10, 6], time: 1, mods: { hpMul: 1e3, speedMul: 0, atkMul: 0.01 } }] });
    h.step(1);
    stealth(h, h.unit(JF)); camou(h, h.unit(GM));
    const log = damageLog(h, LUCIEN), casts = countFx(h, 'crimsonAoe');
    h.run(30);
    const aoe = (id) => log.filter((x) => x.target === h.unit(id) && x.skill && !x.attack).length;
    return { h, casts: casts.v, aoe };
  };
  const alone = run(false);
  assert.equal(alone.casts, 0, 'only a 隐匿 and a 迷彩 operator within 2: no cast (its trigger selection skips both)');
  done(alone.h);
  const r = run(true);
  assert.ok(r.casts >= 2, `cast with 红豆 in range (${r.casts})`);
  assert.equal(r.aoe(HD), r.casts, 'plain: hit by every cast');
  assert.equal(r.aoe(GM), r.casts, '迷彩: hit by every cast ("该技能伤害无视迷彩")');
  assert.equal(r.aoe(JF), 0, '隐匿, not blocking: never hit');
  done(r.h);
});

test('#32.6 ignoreSelect: 萨卡兹悖谬暴虐兵长\'s 暴击 ("无视无法选择") and 假想敌：淤困\'s burst spread ("无视目标可选性") still reach a 隐匿 operator', REAL, () => {
  {
    const h = makeBattle({
      seed: 3, timeLimit: 120, autoFinish: false,
      units: [{ chessId: JF, row: 9, col: 6, dir: 'RIGHT' }, { chessId: GM, row: 10, col: 6, dir: 'RIGHT' }],
      enemies: [{ key: BRUTE, pos: [9, 6.4], time: 1, mods: { hpMul: 1e3, speedMul: 0 } }],
    });
    h.step(1);
    const gm = h.unit(GM);
    stealth(h, gm);
    const log = damageLog(h, BRUTE);
    h.run(6);
    assert.equal(h.b.enemies.find((e) => e.defId === BRUTE).blockedBy, h.unit(JF), '角峰 (block 3) holds it');
    const splash = log.filter((x) => x.target === gm && x.tags.includes('aoeAttack'));
    assert.equal(splash.length, 1, '暴击 splash on the 隐匿 古米 next to its target (once: "此技能仅能触发一次")');
    assert.ok(splash[0].amount > 0);
    done(h);
  }
  {
    const h = makeBattle({
      seed: 3, timeLimit: 120, autoFinish: false,
      units: [{ chessId: JF, row: 9, col: 6, dir: 'RIGHT' }, { chessId: GM, row: 10, col: 6, dir: 'RIGHT' }, { chessId: HD, row: 9, col: 7, dir: 'RIGHT' }],
      enemies: [{ key: PARASITE, pos: [9, 6.4], time: 1, mods: { hpMul: 1e3, speedMul: 0 } }],
    });
    h.step(1);
    const jf = h.unit(JF), gm = h.unit(GM), hd = h.unit(HD);
    stealth(h, gm);
    h.b.addBuff(hd, { key: 'test:liftoff', persist: true, flags: { liftoff: true, blockFly: true } }); // 起飞 (蒂比's flag)
    h.run(1.5);
    assert.ok(jf.findBuff('ab:parasite'), '淤困 parasitises its blocker 角峰');
    const src = h.b.enemies.find((e) => e.defId === PARASITE);
    h.b.dealDamage(src, jf, { type: 'element', element: 'burn', amount: 5000, tags: ['test'] });
    h.step(1);
    assert.ok(jf.findBuff('burnBurst') || jf.elem.burn >= jf.gaugeMax - 1e-6, 'the host bursts');
    assert.ok(gm.elem.burn > 0, '隐匿 neighbour: 1000 burn spread onto it');
    assert.ok(hd.elem.burn > 0, 'airborne 起飞 neighbour: reached too (until 0.1.2 the pipeline refused a ground enemy\'s fill)');
    done(h);
  }
});
