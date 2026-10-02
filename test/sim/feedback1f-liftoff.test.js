// Player report after the 0.1.0 release (sixth batch, F3): "干员蒂比（巡空者）起飞后仍能被不该打到的攻击打到".
//
// Verdict: real. Official rule (gamedata_const termDescriptionDict ba.liftoff 起飞 "不阻挡地面敌人且不会被地面敌人攻击，可以
// 阻挡飞行敌人"; PRTS 术语释义 起飞 "※包含对地规避（无法被不同阵营行动方式为地面的单位选中）… ※起飞后单位的行动方式依旧是地面";
// PRTS 异常效果 MOTION_TARGET_FREE 对地规避 "无法被行动方式为地面的不同阵营单位选中（属于无法选择类效果）", ignored when the
// selector's 行动方式 is not ground; PRTS 行动方式 "起飞的干员仍然是地面单位" and 近地悬浮 / 浮空 units count as flyers;
// PRTS 作战机制 "AOE的判定是对攻击范围内的每个可以被选中的敌人进行判定"):
//   - no ground enemy (行动方式 ground: data WALK, not hovering / levitated) selects an airborne operator — normal attacks,
//     the targets its abilities add (控潮术师's 周围四格, chain / bounce jumps) and its area damage and statuses skip her;
//   - flyers, 近地悬浮 and 浮空 enemies still select her (she stays a ground unit: no 对空 check);
//   - sourceless damage and abilities that "无视无法选择" (【污染秽蚀】, PRTS 萨卡兹枯朽战士) still reach her, at the
//     low-ground rate: she is still on her low tile;
//   - she stays a 地面单位 for ally rules (隐德来希 S2 puts a 血镰 on her; PRTS 备注 "被添加血镰的单位处于起飞时，血镰可对空").
// Cause: 起飞 was `unit.ground = false` (an operator on a high tile): melee enemies could not reach her (she released them),
// but every ranged ground enemy kept shooting her and the AoE / skills of ground enemies hit her.
// [ASSUMED] a ground enemy's damage already under way (a shot in flight, a DoT ticking) is cancelled too (PRTS 作战机制 伤害
// 流程 7 "取消掉隐匿/无敌状态下的攻击", read for 对地规避); sourceless auras of ground enemies (no selector source in the sim)
// still apply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { hasGeneratedData, getDefaultSource } from '../../server/sim/simdata.js';

const REAL = { skip: !hasGeneratedData() };
const ds = getDefaultSource();
const TIPPI = ['chess_char_2_13_a', 'chess_char_2_13_b'];
const S1 = 'skchr_tippi_1';              // 专业喷绘技巧: MANUAL → DEFAULT trigger, takes off at once
const S2 = 'skchr_tippi_2';              // 紧急赶场通知: takes off when attacked (dodging that hit)
const BAIT = 'chess_char_1_02_a';        // 角峰 (TANK) on the fence tile below her
const TIDMAG = 'enemy_1161_tidmag';      // 控潮术师: ground caster, hits its target and the 周围四格 (+ erosion)
const JSHOOT = 'enemy_1019_jshoot';      // 隐形弩手: ground sniper
const DUMAGE = 'enemy_1168_dumage';      // 深池暗影术师: ground caster
const LAZERD = 'enemy_1041_lazerd';      // 法术大师A1: FLY caster
const SYUFO = 'enemy_2025_syufo';        // 掠海漂移体: 近地悬浮 (a flyer while it hovers)
const NHPBR = 'enemy_1267_nhpbr';        // 萨卡兹枯朽战士: ground melee; death → 【污染秽蚀】 50 / 25 true per s
const ETLCHI = 'chess_char_5_06_a';      // 隐德来希 (S2 绯红壁合: 血镰 on herself and one other 地面单位)
const GOPRO = 'enemy_1000_gopro_2';      // 猎狗pro: ground melee
const skillIndex = (id, sk) => ds.rawChess(id).skills.find((s) => s.skillId === sk).index;
const done = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors.map((e) => `${e.label} ${e.message}`), []); };

/**
 * act2 m02's lower lane: 蒂比 on the road (9,5) facing the gate, 角峰 on the fence tile (10,5) — inside 控潮术师's 周围四格 of
 * her and she of him — and a still, tanky enemy at (9,7) (in her range and both of them in its own). Runs until she has
 * landed and `after` more seconds; returns the hits on her while airborne / after landing and those on the bait.
 */
function duel(id, sk, enemyKey, { after = 12, mods = {}, pos = [9, 7] } = {}) {
  const h = makeBattle({
    stageId: 'act2autochess_m02', seed: 3, autoFinish: false, timeLimit: 400, hooks: ['damaged', 'skillStart', 'skillEnd'], captureNoisy: true,
    units: [{ chessId: id, row: 9, col: 5, carryState: { sp: 999 }, skillIndex: skillIndex(id, sk) }, { chessId: BAIT, row: 10, col: 5 }],
    enemies: [{ key: enemyKey, pos, mods: { hpMul: 1e4, speedMul: 0, ...mods } }],
  });
  const u = h.unit(id), bait = h.unit(BAIT);
  let up = null, down = null, airborneSeen = false;
  for (let i = 0; i < 120 * 30 && (down == null || h.b.time < down + after); i++) {
    h.step();
    if (up == null && u.skill.active) up = h.b.time;
    if (u.skill.active && u.s.flags.liftoff) airborneSeen = true;
    if (up != null && down == null && !u.skill.active) down = h.b.time;
  }
  const fromEnemy = (c) => c.source && c.source.side === 'enemy';
  const on = (t) => h.hooksOf('damaged').filter((c) => c.target === t && fromEnemy(c));
  const tOf = (c) => c.t ?? c.time;
  return {
    h, u, bait, up, down, airborneSeen,
    air: on(u).filter((c) => tOf(c) > up + 1e-6 && tOf(c) < down - 1e-6),
    landed: on(u).filter((c) => tOf(c) > down + 1e-6),
    baitAir: on(bait).filter((c) => tOf(c) > up + 1e-6 && tOf(c) < down - 1e-6),
  };
}

test('F3: no ground enemy hits an airborne 蒂比 — 控潮术师 (direct and 周围四格), S1 and S2, normal and elite; she is a target again once landed', REAL, () => {
  for (const id of TIPPI) for (const sk of [S1, S2]) {
    const r = duel(id, sk, TIDMAG);
    assert.ok(r.up != null && r.down != null, `${id} ${sk}: took off and landed`);
    assert.ok(r.airborneSeen, `${id} ${sk}: 起飞 is the buff flag \`liftoff\``);
    assert.deepEqual(r.air.map((c) => `${c.type} ${Math.round(c.amount)}`), [], `${id} ${sk}: nothing from the ground caster while airborne`);
    assert.ok(r.baitAir.length > 0, `${id} ${sk}: the caster shoots 角峰 instead`);
    assert.ok(r.landed.length > 0, `${id} ${sk}: hit again after landing`);
    assert.equal(r.u.ground, true, `${id} ${sk}: still on her low tile (行动方式 ground)`);
    done(r.h);
  }
});

test('F3: ranged ground snipers / casters (隐形弩手, 深池暗影术师) never shoot an airborne 蒂比', REAL, () => {
  // the 隐匿 隐形弩手 is no target of hers, so S1's DEFAULT trigger never fires for it: S2 (its shot sets her off)
  for (const [key, sk] of [[JSHOOT, S2], [DUMAGE, S1], [DUMAGE, S2]]) {
    const r = duel(TIPPI[0], sk, key);
    assert.ok(r.up != null && r.down != null, `${key} ${sk}: took off and landed`);
    assert.deepEqual(r.air.map((c) => `${c.type} ${Math.round(c.amount)}`), [], `${key} ${sk}: nothing while airborne`);
    assert.ok(r.baitAir.length > 0, `${key} ${sk}: it shoots 角峰 instead`);
    done(r.h);
  }
});

test('F3: flyers and 近地悬浮 enemies still attack an airborne 蒂比 (对地规避 only stops ground selectors; she stays a ground unit)', REAL, () => {
  for (const key of [LAZERD, SYUFO]) {
    const r = duel(TIPPI[0], S1, key, { mods: { atkMul: 0.2 } });
    assert.ok(r.up != null, `${key}: took off`);
    assert.ok(r.air.length > 0, `${key}: hits her while she is airborne`);
    done(r.h);
  }
});

test('F3: the pipeline — a ground enemy\'s damage, element and statuses never land on an airborne 蒂比; a flyer\'s and sourceless ones do', REAL, () => {
  const h = makeBattle({
    stageId: 'act2autochess_m02', seed: 3, autoFinish: false, timeLimit: 400, hooks: ['hit', 'damaged', 'statusApplied'], captureNoisy: true,
    defs: { enemies: { enemy_g: enemyRec({ key: 'enemy_g', hp: 1e7, speed: 0, atk: 0 }), enemy_f: enemyRec({ key: 'enemy_f', hp: 1e7, speed: 0, atk: 0, motion: 'FLY' }) } },
    units: [{ chessId: TIPPI[0], row: 9, col: 5, carryState: { sp: 999 }, skillIndex: skillIndex(TIPPI[0], S1) }],
    enemies: [{ key: 'enemy_g', pos: [11, 9] }, { key: 'enemy_f', pos: [9, 7] }],
  });
  const u = h.unit(TIPPI[0]);
  assert.ok(h.runUntil(() => u.skill.active, 3), 'S1 takes off (the flyer is in range)');
  const g = h.b.enemies.find((e) => e.defId === 'enemy_g'), f = h.b.enemies.find((e) => e.defId === 'enemy_f');
  assert.equal(g.isFlying, false);
  // a ground enemy's hit: cancelled before any hook (she is not selected: no 'hit', no 片场工作指南 / S2 trigger)
  const hits0 = h.hooksOf('hit').filter((c) => c.target === u).length;
  assert.equal(h.b.dealDamage(g, u, { amount: 300, type: 'phys', canDodge: false, isAttack: true }), 0, 'ground attack');
  assert.equal(h.b.dealDamage(g, u, { amount: 300, type: 'true', isSkill: true }), 0, 'ground ability (true damage)');
  assert.equal(h.b.dealDamage(g, u, { type: 'element', element: 'burn', amount: 500 }), 0, 'ground element fill');
  assert.equal(u.elem.burn, 0);
  assert.equal(h.hooksOf('hit').filter((c) => c.target === u).length, hits0, 'no hit hook for a ground source');
  assert.equal(h.b.applyStatus(u, 'stun', { duration: 2, source: g }), false, 'ground enemy\'s stun refused');
  assert.equal(u.s.flags.stun, false);
  // a flyer, sourceless damage and an ability that ignores 无法选择 still land
  assert.ok(h.b.dealDamage(f, u, { amount: 300, type: 'true', isSkill: true }) > 0, 'flyer');
  assert.ok(h.b.dealDamage(null, u, { amount: 300, type: 'true' }) > 0, 'sourceless');
  assert.ok(h.b.dealDamage(g, u, { amount: 300, type: 'true', ignoreSelect: true }) > 0, '无视无法选择 (ignoreSelect)');
  assert.equal(h.b.applyStatus(u, 'stun', { duration: 0.2, source: f }), true, 'a flyer\'s stun lands');
  // landed: the ground enemy reaches her again
  h.runUntil(() => !u.skill.active, 40);
  h.run(0.5);
  assert.equal(u.s.flags.liftoff, undefined);
  assert.ok(h.b.dealDamage(g, u, { amount: 300, type: 'true', isSkill: true }) > 0, 'landed: ground ability lands');
  done(h);
});

test('F3: 【污染秽蚀】 (萨卡兹枯朽战士) still reaches an airborne 蒂比, at the low-ground rate (PRTS "可对空，无视无法选择")', REAL, () => {
  const h = makeBattle({
    stageId: 'act2autochess_m02', seed: 3, autoFinish: false, timeLimit: 400, hooks: ['damaged'], captureNoisy: true,
    units: [{ chessId: TIPPI[0], row: 9, col: 5, carryState: { sp: 999 }, skillIndex: skillIndex(TIPPI[0], S1) }],
    enemies: [{ key: NHPBR, pos: [9, 6], mods: { hpMul: 0.01, speedMul: 0 } }],
  });
  const u = h.unit(TIPPI[0]);
  assert.ok(h.runUntil(() => u.skill.active, 3), 'takes off');
  assert.ok(h.runUntil(() => !h.b.enemies.some((e) => e.alive), 10), 'she kills the 战士 while airborne');
  h.run(4);
  assert.ok(u.skill.active && u.s.flags.liftoff, 'still airborne');
  const ticks = h.hooksOf('damaged').filter((c) => c.target === u && (c.dmg?.tags || []).includes('pollution'));
  assert.ok(ticks.length >= 3, `pollution ticks on her: ${ticks.length}`);
  for (const c of ticks) assert.equal(Math.round(c.amount), 50, 'low-ground rate (her tile is low ground)');
  done(h);
});

test('F3: an airborne 蒂比 is still a 地面单位 for 隐德来希 S2 — she carries a 血镰 and it cuts the flyer next to her', REAL, () => {
  const h = makeBattle({
    stageId: 'act2autochess_m02', seed: 3, autoFinish: false, timeLimit: 400, hooks: ['damaged', 'skillStart'], captureNoisy: true,
    units: [
      { chessId: TIPPI[0], row: 9, col: 5, carryState: { sp: 999 }, skillIndex: skillIndex(TIPPI[0], S1) },
      { chessId: ETLCHI, row: 9, col: 3, skillIndex: skillIndex(ETLCHI, 'skchr_etlchi_2') },
    ],
    enemies: [
      { key: GOPRO, pos: [9, 4], mods: { hpMul: 1e4, speedMul: 0, atkMul: 0 } },
      { key: LAZERD, pos: [9, 6.2], mods: { hpMul: 1e4, speedMul: 0, atkMul: 0 } },
    ],
  });
  const u = h.unit(TIPPI[0]), et = h.unit(ETLCHI);
  assert.ok(h.runUntil(() => u.skill.active, 3), '蒂比 takes off');
  assert.ok(h.runUntil(() => et.skill.active, 40), '隐德来希 casts S2');
  assert.ok(u.skill.active && u.s.flags.liftoff, 'while 蒂比 is airborne');
  assert.ok((et.mem.sickles || []).includes(u), 'the second 血镰 is on 蒂比');
  h.run(2);
  const fl = h.b.enemies.find((e) => e.defId === LAZERD);
  const cuts = h.hooksOf('damaged').filter((c) => c.target === fl && c.source === et && (c.dmg?.tags || []).includes('bloodSickle'));
  assert.ok(cuts.length > 0, 'her 血镰 hits the flyer (可对空 while she is airborne)');
  done(h);
});
