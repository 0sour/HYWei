// Community report E3 after the 0.1.0 release: "干员卡涅利安的攻击不是真群攻". The 阵法术师 trait "技能开启时攻击造成群体
// 法术伤害" is an attack on EVERY enemy inside the attack range (Arknights Terra Wiki, Phalanx Caster: "attacks hit all
// enemies within their range … equal damage to all enemies in range, regardless of distance"; PRTS 作战机制 §AOE伤害判定
// "对攻击范围内的每个可以被选中的敌人进行判定"; PRTS 林 S3 备注 "单次普攻最多触发1次效果" — one normal attack can kill
// several), not one target plus a 1.1-tile splash. The same holds for the 轰击术师 line ("超远距离的群体法术伤害": every
// enemy on the line — Terra Wiki Blast Caster; PRTS 作战机制: 伊芙利特's 炎爆 is a 锁定攻击范围 AoE), while the 扩散术师
// "群体法术伤害" stays a splash of 1.1 tiles around the struck target (Terra Wiki Splash Caster). Real battles with the
// real chess (every selectable attacking skill, normal + elite), counting the enemies each attack damages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource, spawnsFromTemplate } from '../../server/sim/simdata.js';
import { effectiveProfile } from '../../server/sim/ai.js';
import { getData } from '../../server/data.js';

const ds = getDefaultSource();
const dummy = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e8, speed: 0, ...o });
const keyOf = (e) => Math.round(e.y) * 21 + Math.round(e.x);

/** attackId → Map(target → damage) of the normal attacks `u` landed. */
function perAttack(h, u) {
  const out = new Map();
  for (const c of h.hooksOf('damaged')) {
    if (c.source !== u || !c.dmg?.isAttack) continue;
    const k = c.dmg.attackId;
    if (!out.has(k)) out.set(k, new Map());
    const m = out.get(k);
    m.set(c.target, (m.get(c.target) ?? 0) + c.amount);
  }
  return out;
}

/** One phalanx / blast caster with its skill on and `pos` enemies around it: every attack hits all of them alike. */
function hitsAll(id, skillIndex, pos, { equal = true, row = 10, col = 5 } = {}) {
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy() } },
    units: [{ chessId: id, row, col, ...(skillIndex != null ? { skillIndex } : {}) }],
    timeLimit: 120, hooks: ['damaged'], captureNoisy: true,
  });
  h.step();
  const u = h.unit(id);
  const es = pos.map((p) => h.spawn('enemy_dummy', { pos: p }));
  if (u.profile.noAttackUnlessSkill) {
    u.skill.gainSp(u.skill.spCost * Math.max(1, u.skill.maxCharges || 1));
    assert.ok(h.runUntil(() => u.skill.active, 10), `${id}/${skillIndex}: skill on`);
  }
  for (const e of es) assert.ok(u.rangeKeys.includes(keyOf(e)), `${id}/${skillIndex}: enemy at ${e.y},${e.x} inside the range`);
  h.run(5);
  const atks = [...perAttack(h, u).values()];
  assert.ok(atks.length >= 2, `${id}/${skillIndex}: attacked (${atks.length})`);
  for (const m of atks) {
    assert.equal(m.size, es.length, `${id}/${skillIndex}: one attack damages every enemy in range (${m.size}/${es.length})`);
    if (!equal) continue;
    const v = [...m.values()];
    const lo = Math.min(...v), hi = Math.max(...v);
    assert.ok(hi - lo <= 1e-6 * hi, `${id}/${skillIndex}: the same damage near and far (${lo} … ${hi})`);
  }
  checkInvariants(h.b);
  return { h, u };
}

// pairwise ≥ 1.41 tiles apart — no 1.1-tile splash around one of them reaches another; all on her x-1 range (facing RIGHT)
const SPREAD = [[10, 7], [10, 3], [12, 5], [9, 5], [11, 6]];

test('E3 卡涅利安: every attack of each skill hits every enemy in her range, with equal damage (normal + elite)', () => {
  for (const id of ['chess_char_4_24_a', 'chess_char_4_24_b']) {
    hitsAll(id, 0, SPREAD); // S1 沙暴守卫
    hitsAll(id, 1, SPREAD); // S2 沙缚镣锁 (default)
    // S3 食噬之印 widens the range to x-2: an enemy on the wider range only is hit by the same attacks
    hitsAll(id, 2, [...SPREAD, [12, 6], [11, 3]]);
  }
});

test('E3 卡涅利安 S2: the 停顿 (charged: 束缚) lands on every enemy each attack hits', () => {
  const id = 'chess_char_4_24_a', bb = ds.getChess(id).skill.bb;
  const h = makeBattle({ defs: { enemies: { enemy_dummy: dummy() } }, units: [{ chessId: id, row: 10, col: 5 }], timeLimit: 60, hooks: ['statusApplied', 'damaged'], captureNoisy: true });
  h.step();
  const u = h.unit(id);
  const es = SPREAD.map((p) => h.spawn('enemy_dummy', { pos: p }));
  u.skill.gainSp(u.skill.spCost); // one charge: an uncharged cast
  assert.ok(h.runUntil(() => u.skill.active, 5));
  h.run(2);
  for (const e of es) assert.ok(h.hooksOf('statusApplied').some((c) => c.target === e && c.source === u && c.status === 'sluggish' && c.duration === bb['attack@sluggish']), `enemy at ${e.y},${e.x} slowed`);
});

test('E3 audit: every 阵法术师 of the pool (薄绿, 蜜蜡, 圣聆初雪) hits every enemy in range with each attack', () => {
  for (const id of ['chess_char_3_08_a', 'chess_char_3_08_b']) {
    hitsAll(id, 0, [...SPREAD, [12, 6]]); // S1 风语: x-2
    hitsAll(id, 1, SPREAD); // S2 聚能涡旋 (default): each struck enemy is pushed towards her, still in range
  }
  for (const id of ['chess_char_4_05_a', 'chess_char_4_05_b']) hitsAll(id, null, SPREAD); // S2 守卫尖碑 (hidden chess)
  for (const id of ['chess_char_6_02_a', 'chess_char_6_02_b']) {
    hitsAll(id, 1, SPREAD); // S2 霜涛覆岭 (toggle)
    hitsAll(id, 2, [...SPREAD, [12, 6]]); // S3 群山俯首 (default, x-2)
  }
});

test('E3 audit: the 轰击术师 (阿罗玛, 协律) hit every enemy on their line, not one target plus a splash', () => {
  const LINE = [[10, 3], [10, 5], [10, 7]]; // 2 tiles apart on the 5-1 line of an operator at (10, 2)
  hitsAll('chess_char_4_10_a', null, LINE, { col: 2 });
  hitsAll('chess_char_4_10_b', null, LINE, { col: 2, equal: false }); // BLA-X: farther targets take more
  hitsAll('chess_char_4_10_a', 0, LINE, { col: 2 }); // S1 强效清洁 (charges)
  hitsAll('chess_char_2_15_a', null, LINE, { col: 2 });
  hitsAll('chess_char_2_15_b', null, LINE, { col: 2, equal: false });
});

test('E3 audit: a 扩散术师 still splashes 1.1 tiles around its target — not every enemy in range', () => {
  for (const id of ['chess_char_1_14_a', 'chess_char_4_02_a']) {
    const h = makeBattle({ defs: { enemies: { enemy_dummy: dummy() } }, units: [{ chessId: id, row: 10, col: 3 }], timeLimit: 60, hooks: ['damaged'], captureNoisy: true });
    h.step();
    const u = h.unit(id);
    // A and B 1 tile apart (one splash), C 1.41 / 2.24 tiles from them — all three on the 3 × 3 range ahead
    const [A, B, C] = [[10, 4], [10, 5], [11, 3]].map((p) => h.spawn('enemy_dummy', { pos: p }));
    for (const e of [A, B, C]) assert.ok(u.rangeKeys.includes(keyOf(e)), `${id}: ${e.y},${e.x} in range`);
    h.run(8);
    const atks = [...perAttack(h, u).values()];
    assert.ok(atks.length >= 2, id);
    for (const m of atks) {
      const hit = new Set(m.keys());
      assert.ok(hit.size < 3, `${id}: never every enemy in range`);
      if (hit.has(A) || hit.has(B)) assert.ok(hit.has(A) && hit.has(B) && !hit.has(C), `${id}: A and B splash each other, C is out of the splash`);
    }
  }
});

test('E3 real stage + real wave: 卡涅利安 targets every enemy on her range with each attack (act2 m01, round 10)', () => {
  const data = getData({ log: { warn() {}, error() {}, info() {} } });
  const mode = data.config.modes.mode_multi_normal;
  const round = '10';
  const rc = mode.rounds[round];
  const tpl = ds.getWave(rc.template);
  const sc = mode.enemyScale?.[round] ?? {};
  const mods = { hpMul: (sc.hp ?? 1) ** (sc.kHp ?? 0), atkMul: (sc.atk ?? 1) ** (sc.kAtk ?? 0), speedMul: sc.speed ?? 1 };
  assert.ok(spawnsFromTemplate(tpl, { mods }).spawns.length > 0);
  for (const skillIndex of [1, 2]) {
    const id = 'chess_char_4_24_b';
    const h = makeBattle({
      stageId: 'act2autochess_m01', waveTemplate: tpl, mods, timeLimit: rc.combatTimeLimit, seed: 11, flags: { startOpCooldown: 3 },
      units: [
        { chessId: id, row: 10, col: 6, skillIndex },
        { chessId: 'chess_char_1_02_a', row: 10, col: 7 }, { chessId: 'chess_char_1_02_a', row: 11, col: 7 },
        { chessId: 'chess_char_1_01_a', row: 9, col: 7 }, { chessId: 'chess_char_2_14_a', row: 12, col: 6 },
      ],
      hooks: [],
    });
    const u = h.unit(id);
    const rows = [];
    // (beforeAttack, after every content hook: the targets of the attack and the enemies on her range at that moment)
    h.b.on('beforeAttack', (c) => {
      if (c.attacker !== u) return;
      const p = effectiveProfile(u);
      const want = new Set(h.b.enemiesInKeys(u.rangeKeys, u, p));
      for (const e of h.b.blockedTargets(u, p)) want.add(e);
      rows.push({ got: c.targets.length, want: want.size, all: [...want].every((e) => c.targets.includes(e)) });
    }, { priority: -2000 });
    h.runToEnd(rc.combatTimeLimit + 5);
    assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
    const crowded = rows.filter((r) => r.want >= 3);
    assert.ok(crowded.length >= 1, `S${skillIndex + 1}: attacks into a crowd (${crowded.length}/${rows.length})`);
    for (const r of rows) assert.ok(r.all && r.got === r.want, `S${skillIndex + 1}: ${r.got} targets of ${r.want} enemies on her range`);
  }
});

test('E3 卡涅利安 S3 食噬之印 values: ATK climbs from +0 % in 1 s steps to the full bonus at 20 s (PRTS 备注), normal + elite', () => {
  for (const id of ['chess_char_4_24_a', 'chess_char_4_24_b']) {
    const bb = ds.getChess(id, { skillIndex: 2 }).skill.bb;
    const h = makeBattle({ units: [{ chessId: id, row: 10, col: 5, skillIndex: 2 }], timeLimit: 60, hooks: [] });
    h.step();
    const u = h.unit(id);
    u.skill.addCharge(1);
    assert.ok(u.skill.activate('test'));
    const t0 = h.b.time;
    const bonus = () => u.s.atk / u.base.atk - 1;
    // PRTS 卡涅利安 S3 备注 "攻击力从+0%开始在20秒内线性增加，攻击力每1秒更新1次，在第20秒达到最大值"
    for (const [at, steps] of [[0.5, 0], [1.5, 1], [10.5, 10], [19.5, 19], [20.5, 20]]) {
      h.run(t0 + at - h.b.time);
      assert.ok(u.skill.active, `${id}: still on at ${at} s`);
      const want = bb.atk * steps / 20;
      assert.ok(Math.abs(bonus() - want) < 1e-9, `${id}: +${(bonus() * 100).toFixed(2)} % at ${at} s, want +${(want * 100).toFixed(2)} %`);
    }
  }
});
