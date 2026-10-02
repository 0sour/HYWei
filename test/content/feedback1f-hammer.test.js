// Player report F1 after 0.1.0 (2026-10-03): "维多利亚坚固锤子的锁血没生效" — 坚固维式重锤 (chess_item_3_09_e_a / _b):
// "首次受到致命伤害时生命值不低于1，持续8秒" (activity_table act2autochess eff_acarm043 / eff_acgarm043, blackboard
// undeadable_duration 8; PRTS 卫戍协议：盟约 下半/PRTS盟约记录 备注 "持有不死" — 异常效果 不死 UNDEADABLE "重设常规生命值时不会
// 使其低于1"). The lock itself works for every kind of lethal damage (pinned here on synthetic and real operators); what
// failed was the order against M3茧甲: with the 茧甲 equipped before the hammer, its revive ran first at the same priority
// and the first lethal hit showed no lock. PRTS (same page, M3茧甲 / 埃芒加德 / 阿戈尔 备注): "“复活”的实现方式为：受益者因移动
// 之外的原因退场时下次部署的再部署时间和费用归零" — a revive acts on a knock-out (退场), which a 不死 prevents, so the lock always
// comes first (items/battle.js PRIO_RESPAWN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { PRIO_REVIVE, PRIO_RESPAWN } from '../../server/sim/content/items/battle.js';
import { PRIO_BAND_REVIVE } from '../../server/sim/content/bands/battle.js';

const HAMMER = 'chess_item_3_09_e_a';
const HAMMER_B = 'chess_item_3_09_e_b';
const M3 = 'chess_item_4_12_e_a';
const SOLVENT = 'chess_item_1_05_e_a';

/** Synthetic operator: 2000 HP, 500 ATK, 200 DEF, 1 s attacks, 20 s redeploy. */
const op = (id) => chessRec({
  id, profession: 'WARRIOR', bonds: [], tier: 1, rangeGrid: [[0, 0], [0, 1]],
  stats: { maxHp: 2000, atk: 500, def: 200, res: 10, aspd: 100, bat: 1, respawnTime: 20, spRecovery: 1, blockCnt: 2 },
  skill: { spCost: 60, duration: 5, initSp: 0 },
});

/** One synthetic carrier at (10, 4) with `items` and a harmless static dummy at (10, 9). */
function carrier(items) {
  const h = makeBattle({
    defs: { chess: { t_op: op('t_op') }, enemies: { e_d: enemyRec({ key: 'e_d', hp: 1e7, speed: 0 }) } },
    units: [{ chessId: 't_op', row: 10, col: 4, items }],
    enemies: [{ key: 'e_d', pos: [10, 9] }], timeLimit: 999, autoFinish: false,
  });
  h.step(1);
  return { h, u: h.unit('t_op'), e: h.b.enemies.find((x) => x.alive) };
}

/** fx events of `kind` on `u` (the hammer's lock: 'undying'; M3茧甲: 'revive'). */
function fxLog(h, u) {
  const log = [];
  const fx0 = h.b.fx.bind(h.b);
  h.b.fx = (kind, p) => { if (p && p.id === u.id) log.push([kind, Math.round(h.b.time * 100) / 100, p.src ?? null]); return fx0(kind, p); };
  return log;
}

test('F1 坚固维式重锤: every kind of lethal damage is held at ≥ 1 HP for 8 s (hit, burst, 流失, 无来源, own drain)', () => {
  const kinds = {
    phys: ({ h, u, e }) => h.b.dealDamage(e, u, { amount: 1e7, type: 'phys', canDodge: false }),
    arts: ({ h, u, e }) => h.b.dealDamage(e, u, { amount: 1e7, type: 'arts', canDodge: false }),
    true: ({ h, u, e }) => h.b.dealDamage(e, u, { amount: 1e7, type: 'true', canDodge: false }),
    sourceless: ({ h, u, e }) => h.b.dealDamage(e, u, { amount: 1e7, type: 'true', canDodge: false, sourceless: true }),
    // a full 神经 gauge bursts on the carrier: stun, then 1000 无来源 true damage (sim/constants.js ELEMENT)
    burst: ({ h, u, e }) => { u.hp = 5; h.b.dealDamage(e, u, { type: 'element', element: 'neural', amount: 5000 }); },
    hpLoss: ({ h, u, e }) => h.b.loseHp(u, 1e7, { source: e }),
    hpLossSourceless: ({ h, u, e }) => h.b.loseHp(u, 1e7, { source: e, sourceless: true }),
  };
  for (const [name, hit] of Object.entries(kinds)) {
    for (const id of [HAMMER, HAMMER_B]) {
      const c = carrier([id]);
      const log = fxLog(c.h, c.u);
      hit(c);
      assert.ok(c.u.alive && c.u.hp >= 1, `${name} ${id}: the first lethal ${name} leaves ≥ 1 HP`);
      assert.deepEqual(log.filter((x) => x[0] === 'undying').map((x) => x[2]), ['item:hammer'], `${name}: the hammer's lock`);
      c.h.run(7.8);
      for (let i = 0; i < 3; i++) c.h.b.dealDamage(c.e, c.u, { amount: 1e7, type: 'true', canDodge: false });
      assert.ok(c.u.alive && c.u.hp >= 1, `${name} ${id}: still held inside the 8 s`);
      c.h.run(0.4);
      c.h.b.dealDamage(c.e, c.u, { amount: 1e7, type: 'true', canDodge: false });
      assert.equal(c.u.alive, false, `${name} ${id}: knocked out after the 8 s`);
    }
  }
});

test('F1 坚固维式重锤: the carrier\'s own 源石溶剂 drain cannot finish it inside the lock', () => {
  const c = carrier([HAMMER, SOLVENT]);
  c.u.hp = 1;
  c.h.run(1.05); // the drain's first tick (60 per second) is lethal at 1 HP
  assert.ok(c.u.alive && c.u.hp >= 1, 'held by the lock');
  c.h.run(6.5);
  assert.ok(c.u.alive, 'every drain tick inside the 8 s is held');
  c.h.run(2.5);
  assert.equal(c.u.alive, false, 'the first tick after the 8 s knocks it out');
});

test('F1 坚固维式重锤: one lock per battle (a redeploy does not re-arm it [ASSUMED]); a new battle re-arms it', () => {
  const c = carrier([HAMMER]);
  const hit = () => c.h.b.dealDamage(c.e, c.u, { amount: 1e7, type: 'true', canDodge: false });
  hit();
  assert.ok(c.u.alive);
  c.h.run(8.2);
  hit();
  assert.equal(c.u.alive, false, 'knocked out after the window');
  c.h.runUntil(() => c.u.alive, 60);
  assert.ok(c.u.alive, 'redeployed');
  hit();
  assert.equal(c.u.alive, false, 'the second deployment of the battle has no lock left');
  const next = carrier([HAMMER]);
  next.h.b.dealDamage(next.e, next.u, { amount: 1e7, type: 'true', canDodge: false });
  assert.ok(next.u.alive && next.u.hp >= 1, 'the next battle locks again');
});

test('F1 坚固维式重锤 + M3茧甲: the lock comes before the revive whatever the equip order (PRTS: a revive acts on 退场)', () => {
  assert.ok(PRIO_RESPAWN < PRIO_REVIVE && PRIO_RESPAWN > PRIO_BAND_REVIVE, 'revive items: after every 不死, before 埃芒加德');
  for (const items of [[M3, HAMMER], [HAMMER, M3]]) {
    const c = carrier(items);
    const log = fxLog(c.h, c.u);
    const hit = () => c.h.b.dealDamage(c.e, c.u, { amount: 1e7, type: 'true', canDodge: false });
    hit();
    assert.ok(c.u.alive && c.u.hp < 2, `${items}: the first lethal hit is held at 1 HP (lock), not revived to full`);
    assert.deepEqual(log.map((x) => x[0]), ['undying'], `${items}: lock first`);
    c.h.run(8.2);
    hit();
    assert.ok(c.u.alive, `${items}: after the 8 s the 茧甲 revives`);
    assert.equal(Math.round(c.u.hp), 2000, 'full HP');
    assert.deepEqual(log.map((x) => x[0]), ['undying', 'revive']);
    hit();
    assert.equal(c.u.alive, false, `${items}: nothing left`);
  }
});

test('F1 坚固维式重锤 on a real operator in a real fight: 角峰 blocking scaled-up real enemies stands 8 s at 1 HP', () => {
  for (const id of [HAMMER, HAMMER_B]) {
    const h = makeBattle({
      stageId: 'flat', seed: 7,
      units: [{ chessId: 'chess_char_1_02_a', row: 9, col: 5, items: [id] }],
      enemies: Array.from({ length: 6 }, (_, i) => ({ key: 'enemy_1422_lrsldr', time: i * 0.5, route: 0, mods: { atkMul: 30, hpMul: 50 } })),
      timeLimit: 120, autoFinish: false,
    });
    const u = h.unit('chess_char_1_02_a');
    const log = fxLog(h, u);
    let out = null;
    h.b.on('death', (c) => { if (c.unit === u && out == null) out = h.b.time; });
    h.runUntil(() => out != null, 60);
    const lock = log.find((x) => x[0] === 'undying');
    assert.ok(lock && lock[2] === 'item:hammer', `${id}: the hammer locked (${JSON.stringify(log)})`);
    assert.ok(out != null && out >= lock[1] + 8 - 1e-6, `${id}: knocked out ${out} ≥ 8 s after the lock at ${lock[1]}`);
  }
});
