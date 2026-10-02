// Player feedback after 0.1.0, workstream WE (report #7): the 鸭爵 strategy “神秘顾客” and its four enemies —
// "鸭爵策略带来的怪物圆仔错误的能被阻挡，鸭爵带来的其它几个敌人你也都复核下规则，数据对不对".
// Official: the band's enemylist names the act2 versions (enemy_*_2; enemy_database level 0) and PRTS 卫戍协议：盟约 下半/
// PRTS盟约记录 §策略 鸭爵 备注: "每回合将有0~2名敌人被替换为上述敌人之一，且上述敌人为特殊版本，相较于原版更弱（鸭爵 6000 生命，
// 受伤后移动速度+300%；高普尼克 11000 / 攻击 1600；流泪小子 4500，攻击附加3.5秒晕眩；圆仔 13000），但进入保护目标点将减少1点
// 目标生命值，且在最终回合和隐秘核心回合中仍然生效"; PRTS 圆仔 天赋 "无法攻击/被阻挡".
// Real match paths (the match harness in virtual time, real data, the real meta registry) and the real Battle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch, give, legalTileFor } from './harness.js';
import { FakeBattle } from './fakeBattle.js';
import { Battle } from '../../server/sim/Battle.js';
import { buildBossWave } from '../../server/match/waves.js';

const BAND = 'band_ducklord';
const PARAMS = DATA.bands[BAND].buffs.find((b) => b.key === 'round_start_all_player_change_enemy_2');
const DUCKS = PARAMS.bbStr.enemylist.split(',');
const YUANZAI = 'enemy_2085_skzjxd_2';
const DUCK = 'enemy_2001_duckmi_2';
const QUIET = { info() {}, debug() {}, warn() {}, error() {} };
const TANKS = Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden && c.profession === 'TANK' && c.tier <= 2).map((c) => c.chessId).sort();

/** A real Battle of a match's battle options (the match itself runs FakeBattles in these tests). */
const realBattle = (m, opts) => new Battle({ data: m.ds, content: m.battleContent, logger: QUIET, ...opts });

/** Solo match at PREP of round `r` holding the 鸭爵 band (FakeBattle rounds before). */
function soloAt(r, seed) {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed, fake: true }).start();
  h.toPrep(r, { band: BAND });
  const ps = h.ps('p_0');
  assert.equal(ps.bandId, BAND);
  return { h, m: h.m, ps };
}

/** The player's normal-battle options until the band swapped a `key` into the real wave (the real onBattleStart path). */
function optsWith(m, ps, key, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const opts = m._normalOpts(ps);
    const spec = opts.spawns.find((s) => s.enemyKey === key);
    if (spec) return { opts, spec };
  }
  assert.fail(`no ${key} in ${tries} battles`);
}

test('#7 圆仔 brought by 鸭爵 is never blocked: it walks past a board full of defenders (real R6 wave, real Battle)', () => {
  const { h, m, ps } = soloAt(6, 7071);
  h.setStage('act1autochess_m01');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear();
  ps.hand.fill(null);
  // a defender (3 blocks) on every melee tile of the board: any blockable ground enemy meets one
  let n = 0;
  for (let k = 0; k < 40; k++) {
    const id = TANKS.find((t) => m.pool.has(t) && m.pool.left(t) > 0);
    const at = id && legalTileFor(m, ps, id);
    if (!at) break;
    give(m, ps, id, 'board', at);
    n++;
  }
  assert.ok(n >= 6, `${n} defenders`);
  const { opts, spec } = optsWith(m, ps, YUANZAI);
  assert.deepEqual(spec.bounty, { coins: 1, ownerPlayerId: 'p_0' }, '1 fund to whoever knocks it out');
  // the swapped-in 圆仔 alone, at once (its real route and round multipliers)
  const b = realBattle(m, { ...opts, spawns: [{ ...spec, time: 0 }], timeLimit: 600 });
  let yz = null;
  let blocked = 0;
  for (let t = 0; t < 600 * 30 && !b.finished; t++) {
    b.step();
    yz = yz || b.enemies.find((e) => e.defId === YUANZAI) || null;
    if (yz && yz.alive && yz.blockedBy) blocked++;
  }
  assert.ok(yz, 'spawned');
  assert.equal(blocked, 0, 'never blocked (ticks blocked)');
  assert.ok(yz.s.flags.unblockable, 'PRTS 圆仔 天赋 "无法攻击/被阻挡"');
  assert.equal(yz.stats.attacks, 0, 'never attacks');
  const r = b.result();
  const leaked = (r.perPlayer.p_0.leaked || []).filter((l) => l.enemyKey === YUANZAI);
  assert.ok(leaked.length === 1 || !yz.alive, 'it either leaks or is knocked out on the way');
  m.dispose();
});

test('#7 the four 鸭爵 enemies are the act2 versions: PRTS stats, 1 LP when they reach the protection point', () => {
  const s = (k) => DATA.enemies[k].stats;
  assert.deepEqual(DUCKS.slice().sort(), ['enemy_2001_duckmi_2', 'enemy_2002_bearmi_2', 'enemy_2034_sythef_2', 'enemy_2085_skzjxd_2']);
  assert.equal(s('enemy_2001_duckmi_2').maxHp, 6000);
  assert.equal(s('enemy_2002_bearmi_2').maxHp, 11000);
  assert.equal(s('enemy_2002_bearmi_2').atk, 1600);
  assert.equal(s('enemy_2034_sythef_2').maxHp, 4500);
  assert.equal(DATA.enemies.enemy_2034_sythef_2.talents.bb['Combat.attack@stun'], 3.5);
  assert.equal(s('enemy_2085_skzjxd_2').maxHp, 13000);
  // "但进入保护目标点将减少1点目标生命值" (the database's lifePointReduce 0 is the roguelike 宝藏 rule)
  for (const k of DUCKS) assert.equal(s(k).lpr, 1, k);
  // the original (roguelike) versions keep the database value
  for (const k of ['enemy_2001_duckmi', 'enemy_2002_bearmi', 'enemy_2034_sythef', 'enemy_2085_skzjxd']) assert.equal(s(k).lpr, 0, k);
});

test('#7 鸭爵 runs at +300 % move speed once hurt (PRTS: 受伤后移动速度+300%), never attacks, is never blocked', () => {
  const { m, ps } = soloAt(5, 7072);
  const { opts, spec } = optsWith(m, ps, DUCK);
  const b = realBattle(m, { ...opts, spawns: [{ ...spec, time: 0 }], timeLimit: 600 });
  let d = null;
  for (let t = 0; t < 30 && !d; t++) { b.step(); d = b.enemies.find((e) => e.defId === DUCK) || null; }
  assert.ok(d && d.s.flags.unblockable);
  const v = d.s.moveSpeed;
  b.dealDamage(null, d, { amount: 1, type: 'true' });
  const run = DATA.enemies[DUCK].talents.bb['run.attack@move_speed'];
  assert.equal(run, 3);
  assert.ok(Math.abs(d.s.moveSpeed - v * (1 + run)) < 1e-9, `${d.s.moveSpeed} = ${v} × ${1 + run}`);
  assert.ok(d.profile.noAttack);
  m.dispose();
});

test('#7 the swap still happens in the Final Assault (escorts, never the leader or its parts), and a leaked swap costs the merged LP 1', () => {
  let swapped = 0;
  let lpChecked = false;
  for (let seed = 1; seed <= 8 && (!swapped || !lpChecked); seed++) {
    const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', seed: 7100 + seed, fake: true, script: (b) => (b.kind === 'boss' ? { bossDps: 1e9 } : {}) }).start();
    const m = h.m;
    h.drive(() => m.phase === PHASE.PREP && m.round === m.gd.bossRound, { band: BAND });
    h.drive(() => m.phase === PHASE.FINAL_ASSAULT, { band: BAND });
    const f = FakeBattle.instances.find((b) => b.kind === 'boss');
    assert.ok(f, 'boss field');
    const ducks = f.opts.spawns.filter((s) => DUCKS.includes(s.enemyKey));
    assert.ok(ducks.length <= PARAMS.bb.max, `${ducks.length} swaps`);
    assert.ok(f.opts.spawns.some((s) => s.tag === 'boss'), 'the leader stays');
    for (const d of ducks) {
      assert.equal(d.tag, 'duck');
      assert.deepEqual(d.bounty, { coins: 1, ownerPlayerId: 'p_0' });
    }
    swapped += ducks.length;
    if (ducks.length && !lpChecked) {
      // the real boss battle (no operators): the swapped enemy walks into the goal and the team pool loses its lpr 1
      const pool = { hp: 1e12, maxHp: 1e12, damage() { return 0; } };
      const b = realBattle(m, { ...f.opts, sharedBoss: pool, spawns: [{ ...ducks[0], time: 0 }] });
      const leaks = [];
      b.on('enemyLeak', (ctx) => leaks.push(ctx.enemy));
      for (let t = 0; t < 400 * 30 && !leaks.length; t++) b.step();
      assert.equal(leaks.length, 1, 'leaked');
      assert.equal(leaks[0].lpr, 1);
      const lp = m.teamLp;
      m._bossLeak(leaks[0]);
      assert.equal(m.teamLp, lp - 1);
      lpChecked = true;
    }
    m.dispose();
  }
  assert.ok(swapped > 0, 'some Final Assault had a swap');
  assert.ok(lpChecked);
});

test('#7 the Hidden Core and pair boss fields: each player of the field gets 0–2 swaps among the escorts', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, seed: 7201, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  h.ps('p_0').bandId = BAND;
  h.ps('p_1').bandId = 'band_bldsk';
  const seen = { boss: 0, hidden: 0 };
  for (const [kind, round] of [['boss', m.gd.bossRound], ['hidden', m.gd.hiddenRound]]) {
    for (let k = 0; k < 40; k++) {
      m.round = round;
      const wave = buildBossWave(m.gd, m.rngWaves, m.factions, round, { bossId: kind === 'hidden' ? m.hiddenBossId : m.bossId, solo: false });
      const spawns = wave.spawns.map((s) => ({ ...s, mods: s.mods ? { ...s.mods } : undefined }));
      const before = spawns.reduce((n, s) => n + (s.count || 1), 0);
      for (const [j, ps] of [h.ps('p_0'), h.ps('p_1')].entries()) {
        const ev = { input: ps.battleInput({ side: j ? 'R' : 'L', colOffset: j ? 8 : 0 }), kind, round, spawns };
        m.dispatch(ps, 'onBattleStart', ev);
      }
      const ducks = spawns.filter((s) => DUCKS.includes(s.enemyKey));
      assert.ok(ducks.length <= 2 * PARAMS.bb.max, `${kind}: ${ducks.length}`);
      assert.equal(spawns.reduce((n, s) => n + (s.count || 1), 0), before, 'same enemy count');
      assert.ok(spawns.filter((s) => s.tag === 'boss').length >= 1);
      for (const d of ducks) assert.ok(['p_0', 'p_1'].includes(d.bounty.ownerPlayerId));
      seen[kind] += ducks.length;
    }
  }
  assert.ok(seen.boss > 0 && seen.hidden > 0, JSON.stringify(seen));
  m.dispose();
});
