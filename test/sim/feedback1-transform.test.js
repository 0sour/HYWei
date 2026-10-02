// test/sim/feedback1-transform.test.js — player reports after the public 0.1.0 (workstream WD: enemies that change form
// when "killed"), real enemy data in the real sim:
//   #5 转译基底·α "不会变身，原血量打死就加载变身动画然后就没了": its original form cancels every damage instance (PRTS 转译基底·α
//      天赋 "受到伤害时取消此伤害"); the 4th physical / 4th arts instance or being blocked starts a 2 s change into 寻仇者 /
//      特战术师 / 幽灵 (Mode_*_Passive) — only the changed form can die. v0.1.0 let damage through: a sniper + caster lineup
//      killed it in its first form without any change, and its model (still in that form) played the 寻仇者's B_Die.
//   #8 深池逐火战士 / 精锐战士 / 护卫 "被击倒后变的怨恨的余烬无法被击杀": every knock-out ⇒ 1 s 重生 (无敌 + 无法阻挡, immobile) ⇒
//      a 隐匿, disarmed ember of 5 (护卫 10) hits that walks its route on and can be blocked — blocked it is targetable and
//      dies for good after that many damage instances; still standing after 10 s it is the warrior again with full HP
//      (PRTS 深池逐火战士 天赋). v0.1.0's ember stood still, stealthed AND unblockable: nobody could ever target it, so
//      every 逐火 enemy of a round leaked.
// The real-round tests build the battle like Match._normalOpts: an official wave (waves.js buildNormalWave, a 悬赏 card
// through withBounties), the real stage 战场#01, real chess, full content, buildBattleSpec → createBattleFromSpec.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../../server/data.js';
import { GameData } from '../../server/match/gamedata.js';
import { buildNormalWave, withBounties } from '../../server/match/waves.js';
import { createRng } from '../../server/sim/rng.js';
import { buildBattleSpec, createBattleFromSpec } from '../../server/sim/spec.js';
import { getDefaultSource } from '../../server/sim/simdata.js';
import { GEO } from '../../shared/constants.js';
import { makeBattle, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { canTargetEnemy } from '../../server/sim/targeting.js';
import { HUSK_REBIRTH, TRANSLATOR_CHANGE } from '../../server/sim/content/enemies.js';

const QUIET = { warn() {}, error() {}, info() {} };
const DATA = getData({ log: QUIET });
const E = DATA.enemies;
const MODE = 'mode_multi_hard';
const STAGE = 'act2autochess_m01';
const gd = new GameData(DATA, MODE);
const tb = (key, k) => E[key].talents.bb[k];
const TR = 'enemy_10081_mpplai';
const EMBERS = ['enemy_1288_duskls', 'enemy_1288_duskls_2', 'enemy_1292_duskld'];
const approx = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg} ${a} ≈ ${b}`);

/** A player's normal field as Match._normalOpts builds it (real wave, real stage, full content). */
function realBattle({ round, wave, spawns, units, seed = 77 }) {
  const spec = buildBattleSpec({
    battleId: 'fb1.wd', fieldId: 'n:p1', kind: 'normal', seed, modeId: MODE, round, stageId: STAGE, rect: { ...GEO.NORMAL_RECT },
    timeLimit: wave.timeLimit, players: [{ playerId: 'p1', seat: 0, side: 'L', colOffset: 0, units, bonds: {}, playerEffects: [] }],
    spawns: (spawns ?? wave.spawns).map((s) => ({ ...s, ownerPlayerId: 'p1' })), routes: wave.routes,
    flags: { layerGainsEnabled: true, ...gd.dp }, enemyOverrides: wave.overrides, waveId: wave.templateId,
  });
  return createBattleFromSpec(spec, getDefaultSource(), { quiet: true });
}
const chess = (uid, chessId, row, col, dir = 'RIGHT') => ({ uid, kind: 'chess', chessId, row, col, dir });

// synthetic operators for the rule tests (real enemies, real stage and routes): a blocker that never attacks, an
// instant long-range phys gun and arts mage that reach the whole field
const BIG = [];
for (let dr = -4; dr <= 4; dr++) for (let dc = -12; dc <= 12; dc++) BIG.push([dr, dc]);
const CHESS = {
  t_wall: chessRec({ id: 't_wall', profession: 'TANK', stats: { atk: 0, maxHp: 1e7, def: 0, res: 0, blockCnt: 3 }, rangeGrid: [[0, 0]], skill: null }),
  t_gun: chessRec({ id: 't_gun', profession: 'SNIPER', projectile: 'none', stats: { atk: 50, maxHp: 1e7, bat: 1, blockCnt: 0 }, rangeGrid: BIG, skill: null }),
  t_mage: chessRec({ id: 't_mage', profession: 'CASTER', projectile: 'none', stats: { atk: 50, maxHp: 1e7, bat: 1, blockCnt: 0 }, rangeGrid: BIG, skill: null }),
};
const NOATK = () => ({ trait: { noAttack: true } });
/** Real stage + the real routes of an official wave template (route 0 = 战场#01's lower lane (9,10) → (9,2)). */
const ROUTES = DATA.waves.act1autochess_03.routes;
function arena(o = {}) {
  const { kits = {}, ...rest } = o;
  return makeBattle({
    stageId: STAGE, routes: ROUTES, content: 'full', seed: 7, autoFinish: false, timeLimit: 600, modeId: MODE, round: 3,
    defs: { chess: CHESS }, kits: { t_wall: NOATK, ...kits }, ...rest,
  });
}
const put = (h, key, o = {}) => h.spawn(key, { routeIndex: 0, ...o });
/** Synthetic attackers that never attack (the test deals every hit itself). */
const QUIET_GUNS = { t_gun: NOATK, t_mage: NOATK };

// ---------------------------------------------------------------------------------------------------------------
// #8 逐火 embers

describe('#8 深池逐火: a knock-out is a walking 隐匿 ember that a blocker can beat', () => {
  test('a real TIMES round (R3, 深池逐火精锐战士 pick) on 战场#01: every knocked-out 逐火 becomes an ember, the blocked embers die for good — cleared, nobody leaks, each enemy dies once', () => {
    let wave = null;
    for (let seed = 1; seed < 500 && !wave; seed++) {
      const w = buildNormalWave(gd, createRng(seed), ['TIMES', 'INVISIBLE', 'FLY'], 3);
      if (w.pick && w.pick.key === 'enemy_1288_duskls_2') wave = w;
    }
    assert.ok(wave, 'fixture: an official R3 wave with the 深池逐火 TIMES entry');
    assert.ok(wave.spawns.some((s) => EMBERS.includes(s.enemyKey)), 'the round sends 逐火 enemies');
    const b = realBattle({
      round: 3, wave, units: [
        chess(1, 'chess_char_4_23_b', 9, 8),   // 百炼嘉维尔 blocks the lower lane
        chess(2, 'chess_char_4_20_b', 10, 4),  // 远牙
        chess(3, 'chess_char_4_02_b', 11, 4),  // 莫斯提马
        chess(4, 'chess_char_4_17_b', 12, 6),  // 星熊 blocks the upper lane's way down
      ],
    });
    const ember = new Map();   // id → { u, at, x, y, attacks } of its current ember
    let walked = 0;            // the longest walk of an ember past its 重生
    const deaths = new Map();
    const bad = new Set();     // rule details that did not hold (asserted after the outcome)
    const check = (ok, what) => { if (!ok) bad.add(what); };
    let n = 0;
    while (!b.finished && n++ < 30 * 300) {
      b.step();
      for (const ev of b.drainEvents()) {
        if (ev[0] === 'fx' && ev[1] === 'ember') {
          const u = b.units.find((x) => x.id === ev[4].id);
          check(u && u.alive, 'a knock-out never removes the unit');
          check(ev[4].form === 'husk', 'the ember fx carries the clip set of the model (form: husk)');
          ember.set(u.id, { u, at: b.time, x: u.x, y: u.y, attacks: u.stats.attacks });
        }
        if (ev[0] === 'die') {
          const u = b.units.find((x) => x.id === ev[1]);
          if (u && u.side === 'enemy') {
            deaths.set(u.id, (deaths.get(u.id) ?? 0) + 1);
            check(ev[2] === 'killed', 'enemies only die by being killed');
            check(ember.has(u.id) && u.mem.ab.list[0].state === 'husk', 'a 逐火 dies only as an ember');
            check(u.s.maxHp === tb(u.defId, 'Revive[Trigger].prop_max_hp'), 'killed through its hit counter');
          }
        }
      }
      for (const [, m] of ember) {
        const u = m.u;
        if (!u.alive || u.mem.ab.list[0].state !== 'husk') continue;
        if (b.time < m.at + HUSK_REBIRTH - 1e-6) {
          // (its blocker lets go at the next enemy update)
          check(u.s.flags.invulnerable && u.s.flags.unblockable && (b.time - m.at < 0.05 || !u.blockedBy), '重生: 无敌 + 无法阻挡');
          check(u.x === m.x && u.y === m.y, '重生: immobile');
        } else {
          check(u.s.flags.stealth && u.s.flags.disarm && !u.s.flags.unblockable, '余烬: 隐匿 + 缴械, blockable');
          walked = Math.max(walked, Math.hypot(u.x - m.x, u.y - m.y));
        }
        check(u.stats.attacks === m.attacks, 'an ember never attacks');
      }
    }
    const r = b.result();
    const dusk = b.units.filter((u) => u.side === 'enemy' && EMBERS.includes(u.defId));
    assert.ok(dusk.length >= 5);
    assert.deepEqual({ reason: r.reason, leaked: r.perPlayer.p1.leaked.length, killed: r.perPlayer.p1.killed },
      { reason: 'cleared', leaked: 0, killed: r.perPlayer.p1.total }, 'the round is cleared: every enemy killed, no 逐火 walks out');
    for (const u of dusk) assert.equal(deaths.get(u.id), 1, `${u.defId} #${u.id} dies exactly once`);
    assert.equal(ember.size, dusk.length, 'every 逐火 went through its ember');
    assert.deepEqual([...bad], [], 'ember rules');
    assert.ok(walked > 1, `an ember whose blocker fell walks on (${walked.toFixed(2)} tiles)`);
  });

  for (const key of EMBERS) {
    const hits = tb(key, 'Revive[Trigger].prop_max_hp'), delay = tb(key, 'Revive[Trigger].interval');
    test(`${key} ${E[key].name}: 1 s 重生, then a walking 隐匿 ember of ${hits} hits — unblocked no ranged unit can target it, blocked it dies after ${hits} instances; ${delay} s later it would stand up again`, () => {
      // unblocked: the gun cannot target it while it walks on; it revives at full HP, and the next knock-out repeats
      const h = arena({ units: [{ chessId: 't_gun', row: 10, col: 4 }], kits: QUIET_GUNS });
      h.step();
      const e = put(h, key, { mods: { speedMul: 1 } });
      const gun = h.unit('t_gun');
      h.run(2);
      const full = e.s.maxHp;
      const kills = () => h.hooksOf('kill').filter((c) => c.victim === e).length;
      h.b.kill(e, h.unit('t_gun'));
      assert.ok(e.alive, 'not removed');
      assert.equal(kills(), 0, 'a knock-out is no kill for anyone (credit, bounty, bond kill triggers)');
      assert.equal(h.b.killed, 0, 'and no kill count');
      assert.equal(e.s.maxHp, hits);
      assert.equal(e.hp, hits);
      const x0 = e.x;
      assert.equal(h.b.dealDamage(h.unit('t_gun'), e, { amount: 1e6, type: 'true' }), 0, '重生 is invulnerable');
      h.run(HUSK_REBIRTH - 0.05);
      approx(e.x, x0, 1e-9, 'immobile during the 重生');
      h.run(0.1);
      assert.ok(e.s.flags.stealth && e.s.flags.disarm && e.profile.noAttack && !e.s.flags.unblockable);
      assert.equal(canTargetEnemy(gun, e, gun.profile), false, 'unblocked and 隐匿: no ranged operator can target it');
      h.run(3);
      assert.ok(Math.abs(e.x - x0) > 0.5, 'walks its route on');
      assert.equal(e.hp, hits);
      h.run(delay - 3.15);
      assert.ok(e.s.flags.stealth, `still an ember just before ${delay} s`);
      h.run(0.2);
      assert.equal(e.s.maxHp, full, 'the warrior again');
      assert.equal(e.hp, full, 'with full HP');
      assert.ok(!e.s.flags.stealth && !e.s.flags.disarm && !e.profile.noAttack);
      assert.ok(h.eventsOf('fx').some((ev) => ev[1] === 'revive' && ev[4].id === e.id && ev[4].form === 'revived'));
      h.b.kill(e, null);
      assert.ok(e.alive && e.s.maxHp === hits, 'every knock-out of the warrior starts it again');

      // blocked: the blocker lifts its 隐匿, so the gun hits it: `hits` instances end it for good
      const h2 = arena({ units: [{ chessId: 't_gun', row: 10, col: 4 }, { chessId: 't_wall', row: 9, col: 7 }] });
      h2.step();
      const f = put(h2, key, { mods: { speedMul: 1 } });
      assert.ok(h2.runUntil(() => !!f.blockedBy, 20), 'blocked');
      h2.b.kill(f, null);
      h2.run(HUSK_REBIRTH + 0.1);
      assert.ok(f.blockedBy, 'blocked again once the 重生 is over');
      assert.ok(canTargetEnemy(h2.unit('t_gun'), f, h2.unit('t_gun').profile), 'blocked: targetable in spite of its 隐匿');
      assert.ok(h2.runUntil(() => !f.alive, 3 * hits), `beaten by ${hits} gun shots`);
      assert.equal(f.removeReason, 'killed');
      assert.equal(h2.hooksOf('kill').filter((c) => c.victim === f).length, 1, 'one kill: the real death');
      assert.equal(h2.b.killed, 1);
      assert.equal(h2.eventsOf('die').filter((ev) => ev[1] === f.id).length, 1, 'one die event');
      checkInvariants(h2.b);
    });
  }

  test('an ember counts every damage instance as one hit — physical, arts, true, 元素伤害 (AoE / DoT ticks alike); element 损伤 does not', () => {
    const h = arena({ units: [{ chessId: 't_gun', row: 10, col: 4 }], kits: QUIET_GUNS });
    h.step();
    const e = put(h, 'enemy_1292_duskld', { mods: { speedMul: 0 } });
    const g = h.unit('t_gun');
    h.b.kill(e, g);
    h.run(HUSK_REBIRTH + 0.05);
    const n = e.hp;
    for (const type of ['phys', 'arts', 'true', 'elemental']) h.b.dealDamage(g, e, { amount: 1e6, type, tags: ['aoe'] });
    h.b.dealDamage(g, e, { type: 'element', element: 'burn', amount: 300 });
    assert.equal(e.hp, n - 4);
    assert.ok(e.alive);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// #5 转译基底·α

describe('#5 转译基底·α: damage is cancelled until its form change; only the changed form can die', () => {
  test('悬赏·特异I in a real round (R4) on 战场#01, a sniper + caster + late blocker: no HP lost before the change, the 4th physical hit ⇒ 2 s change ⇒ 寻仇者, then killed for the bounty coin', () => {
    const wave = buildNormalWave(gd, createRng(5), ['TIMES', 'INVISIBLE', 'FLY'], 4);
    const card = DATA.choices.cards.bounty.find((c) => c.effectId === 'enemyeffect_16_12');
    assert.equal(card.enemyKey, TR, 'fixture: the 悬赏 card adds a 转译基底·α');
    const spawns = withBounties(gd, 4, wave, [{ id: 'b1', card }], 'p1');
    assert.equal(spawns.filter((s) => s.enemyKey === TR && s.tag === 'bounty').length, 1);
    const b = realBattle({
      round: 4, wave, spawns, units: [
        chess(1, 'chess_char_4_23_b', 9, 3),   // 百炼嘉维尔 near the goal
        chess(2, 'chess_char_6_01_b', 10, 4),  // 蕾缪安 (physical)
        chess(3, 'chess_char_4_02_b', 11, 4),  // 莫斯提马 (arts)
      ],
    });
    let tr = null, phaseAt = null, kind = null, diedAt = null, formAt = null, maxBefore = null, firstFormLoss = null, earlyAttack = false;
    let n = 0;
    while (!b.finished && n++ < 30 * 300) {
      b.step();
      tr = tr ?? b.enemies.find((e) => e.defId === TR) ?? null;
      for (const ev of b.drainEvents()) {
        if (!tr) continue;
        if (ev[0] === 'fx' && ev[1] === 'phase' && ev[4].id === tr.id) { phaseAt = b.time; kind = ev[4].kind; }
        if (ev[0] === 'die' && ev[1] === tr.id) { diedAt = b.time; assert.equal(ev[2], 'killed'); }
        if (ev[0] === 'atk' && ev[1] === tr.id && formAt == null) earlyAttack = true;
      }
      if (!tr || !tr.alive) continue;
      if (formAt == null && tr.findBuff('ab:form')) formAt = b.time;
      if (formAt == null) {
        maxBefore = maxBefore ?? tr.s.maxHp;
        if (tr.hp !== maxBefore && firstFormLoss == null) firstFormLoss = { t: +b.time.toFixed(2), hp: Math.round(tr.hp), max: Math.round(maxBefore) };
      }
    }
    assert.ok(diedAt != null, 'killed');
    assert.ok(phaseAt != null && diedAt > phaseAt + TRANSLATOR_CHANGE - 0.05, 'it changed form before it died — never killed in its first form');
    assert.equal(firstFormLoss, null, 'its first form loses no HP');
    assert.equal(kind, 'translator_fuchou', '4 physical hits first ⇒ 寻仇者');
    approx(formAt - phaseAt, TRANSLATOR_CHANGE, 0.02, 'the change lasts 2 s');
    assert.ok(!earlyAttack, 'no attack before its change');
    const r = b.result();
    assert.equal(r.perPlayer.p1.coins, card.coin, 'the bounty coin is paid to the player');
    assert.equal(r.perPlayer.p1.killed, r.perPlayer.p1.total);
    assert.equal(r.perPlayer.p1.leaked.length, 0);
  });

  test('original form: every damage instance cancelled; 3 physical + 3 arts change nothing; the 4th physical ⇒ a 2 s change (immobile, still cancelled, immune) ⇒ 寻仇者 stats, melee physical attacks through the engine, ATK +100 % below half HP', () => {
    const h = arena({ units: [{ chessId: 't_gun', row: 10, col: 4 }, { chessId: 't_mage', row: 11, col: 4 }], kits: QUIET_GUNS });
    h.step();
    const e = put(h, TR, { mods: { speedMul: 1 } });
    const g = h.unit('t_gun'), m = h.unit('t_mage');
    const base = { hp: e.s.maxHp, atk: e.s.atk, def: e.s.def, res: e.s.res, move: e.s.moveSpeed, bat: e.base.bat, mass: e.s.massLevel };
    for (let i = 0; i < 3; i++) {
      assert.equal(h.b.dealDamage(g, e, { amount: 1e6, type: 'phys' }), 0);
      assert.equal(h.b.dealDamage(m, e, { amount: 1e6, type: 'arts' }), 0);
    }
    assert.equal(h.b.dealDamage(g, e, { amount: 1e6, type: 'true' }), 0, 'true damage too');
    assert.equal(e.hp, base.hp);
    assert.ok(!e.findBuff('ab:change'), '3 + 3 hits: no change yet');
    for (const s of ['stun', 'sleep', 'cold', 'freeze', 'levitate', 'fear']) assert.equal(h.b.applyStatus(e, s, { duration: 3, source: g }), false, `immune to ${s}`);
    assert.ok(e.s.flags.noDisplace, '失衡免疫');
    h.b.dealDamage(g, e, { amount: 10, type: 'phys' });
    assert.ok(e.findBuff('ab:change'), 'the 4th physical hit starts the change');
    assert.ok(h.eventsOf('fx').some((ev) => ev[1] === 'phase' && ev[4].id === e.id && ev[4].kind === 'translator_fuchou'));
    const x0 = e.x;
    h.run(TRANSLATOR_CHANGE - 0.1);
    approx(e.x, x0, 1e-9, 'stands still while changing');
    assert.equal(h.b.dealDamage(g, e, { amount: 1e6, type: 'phys' }), 0, 'still cancelled while changing');
    assert.ok(!e.findBuff('ab:form'));
    h.run(0.15);
    const t = (k) => tb(TR, `Mode_Fuchou_Passive.${k}`);
    approx(e.s.maxHp, base.hp + t('max_hp'));
    approx(e.hp, e.s.maxHp, 1e-6, 'full HP');
    approx(e.s.atk, base.atk + t('atk'));
    approx(e.s.def, base.def + t('def'));
    approx(e.s.res, base.res + t('magic_resistance'));
    approx(e.s.moveSpeed, base.move * (1 + t('move_speed')));
    approx(e.s.interval, base.bat + t('base_attack_time'));
    assert.equal(e.s.massLevel, base.mass + t('mass_level'));
    assert.ok(!e.s.flags.noDisplace, 'the original form\'s immunities are gone');
    assert.ok(h.b.applyStatus(e, 'stun', { duration: 0.5, source: g }));
    assert.ok(h.b.dealDamage(g, e, { amount: 100, type: 'true' }) > 0, 'damage lands now');
    // the 4th arts hit / a block no longer change anything
    for (let i = 0; i < 4; i++) h.b.dealDamage(m, e, { amount: 1, type: 'arts' });
    assert.equal(e.findBuff('ab:form').mods.resFlat, t('magic_resistance'), 'one change only');
    // melee physical attacks on its blocker, through the engine ('atk' event, the attack hooks)
    const h2 = arena({ units: [{ chessId: 't_gun', row: 10, col: 4 }, { chessId: 't_wall', row: 9, col: 7 }], kits: QUIET_GUNS, hooks: ['damaged'], captureNoisy: true });
    h2.step();
    const f = put(h2, TR, { mods: { speedMul: 1 } });
    for (let i = 0; i < 4; i++) h2.b.dealDamage(h2.unit('t_gun'), f, { amount: 1, type: 'phys' });
    assert.ok(h2.runUntil(() => f.stats.attacks >= 1, 20));
    const w = h2.unit('t_wall');
    assert.ok(h2.eventsOf('atk').some((ev) => ev[1] === f.id && ev[2] === w.id && ev[3] === 'none'), 'a melee attack on its blocker');
    const hit = h2.hooksOf('damaged').find((c) => c.source === f);
    assert.equal(hit.dmg.type, 'phys');
    const atk = f.s.atk;
    h2.b.dealDamage(h2.unit('t_gun'), f, { amount: f.s.maxHp * 0.6, type: 'true' });
    h2.step();
    approx(f.s.atk, atk * (1 + tb(TR, 'Mode_Fuchou_Anger.atk')), 1e-6, 'ATK +100 % below half HP');
    h2.b.heal(null, f, f.s.maxHp);
    h2.step();
    approx(f.s.atk, atk, 1e-6, 'and back above half');
    checkInvariants(h2.b);
  });

  test('the 4th arts hit ⇒ 特战术师: its stats, ranged arts attacks on 2 targets at once', () => {
    const h = arena({ units: [{ chessId: 't_mage', row: 11, col: 6 }, { chessId: 't_gun', row: 10, col: 7 }], kits: QUIET_GUNS, hooks: ['damaged'], captureNoisy: true });
    h.step();
    const e = put(h, TR, { pos: [9, 7], mods: { speedMul: 0 } });
    const base = { hp: e.s.maxHp, res: e.s.res, bat: e.base.bat };
    for (let i = 0; i < 4; i++) h.b.dealDamage(h.unit('t_mage'), e, { amount: 1, type: 'arts' });
    assert.ok(h.eventsOf('fx').some((ev) => ev[1] === 'phase' && ev[4].id === e.id && ev[4].kind === 'translator_shushi'));
    h.run(TRANSLATOR_CHANGE + 0.1);
    const t = (k) => tb(TR, `Mode_Shushi_Passive.${k}`);
    approx(e.s.maxHp, base.hp + t('max_hp'));
    approx(e.s.res, base.res + t('magic_resistance'));
    approx(e.s.interval, base.bat + t('base_attack_time'));
    assert.ok(h.runUntil(() => e.stats.attacks >= 1, 10));
    assert.equal(h.eventsOf('atk').filter((ev) => ev[1] === e.id).length, 2, 'one attack, two shots');
    h.run(0.6);                                      // the shots land
    const hits = h.hooksOf('damaged').filter((c) => c.source === e);
    assert.equal(new Set(hits.map((c) => c.target.id)).size, 2, 'two targets at once');
    assert.ok(hits.every((c) => c.dmg.type === 'arts'));
  });

  test('blocked first ⇒ 幽灵: the 2 s change held by its blocker, then unblockable, walks on, never attacks, takes damage', () => {
    const h = arena({ units: [{ chessId: 't_gun', row: 10, col: 4 }, { chessId: 't_wall', row: 9, col: 7 }], kits: QUIET_GUNS });
    h.step();
    const e = put(h, TR, { mods: { speedMul: 1 } });
    assert.ok(h.runUntil(() => !!e.findBuff('ab:change'), 20), 'the block starts the change');
    assert.ok(h.eventsOf('fx').some((ev) => ev[1] === 'phase' && ev[4].id === e.id && ev[4].kind === 'translator_youling'));
    assert.ok(e.blockedBy);
    const hp = e.hp;
    h.run(TRANSLATOR_CHANGE - 0.1);
    assert.equal(h.b.dealDamage(h.unit('t_gun'), e, { amount: 1e6, type: 'phys' }), 0, 'damage cancelled while changing');
    assert.equal(e.hp, hp);
    h.run(0.3);
    assert.ok(e.s.flags.unblockable && !e.blockedBy, '幽灵: unblockable, its blocker lets go');
    const x = e.x;
    h.run(3);
    assert.ok(Math.hypot(e.x - x, e.y - 9) > 0.5, 'walks on');
    assert.ok(h.b.dealDamage(h.unit('t_gun'), e, { amount: 100, type: 'phys' }) > 0, 'damage lands now');
    assert.equal(e.stats.attacks, 0, '幽灵 never attacks');
    assert.equal(e.mem.ab.list.length, 1);
  });
});
