// test/sim/feedback1e-skillrange.test.js — community report after 0.1.0 (batch 5, E1): "干员烛煌开启3技能时候攻击范围不会变".
//   Measured: the sim already attacks with the skill range (烛煌 S3 4-11 while it runs — real matches, every range-changing
//   skill of the mode below); what did not change was (1) the battle detail card's 攻击范围, which kept the base grid while
//   the live stats beside it moved (shared/protocol.js unitStatsEntry `range` = Battle._refreshRange's grid), and
//   (2) S3's "攻击变为群体攻击" hit every enemy INSIDE the 4-11 diamond instead of the official one target + a 1.7 splash
//   (PRTS 烛煌 技能3 备注 "攻击溅射半径1.7"), so the fire never reached past the diamond. Same 备注: "补充后的弹药数量
//   无法超过上限" — a burn burst's +2 ammo stops at the skill's ammo.
//   Audit: every selectable skill whose text changes the attack range (攻击范围改变 / 扩大 / 缩小 / 缩短, 攻击距离+N) uses the
//   official grid (skill rangeId, or the base grid grown by ability_range_forward_extend) while it runs, and the DEFAULT
//   trigger still reads the initial range (PRTS 卫戍协议/帮助 "技能就绪，且即将进行普通攻击").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource } from '../../server/sim/simdata.js';
import { absoluteRangeKeys, extendedGrid } from '../../server/sim/targeting.js';
import { buildBattleSpec, createBattleFromSpec } from '../../server/sim/spec.js';
import { createRng } from '../../server/sim/rng.js';
import { COLS } from '../../server/sim/constants.js';
import { unitStatsEntry } from '../../shared/protocol.js';

const ds = getDefaultSource();
const C = ds.raw.chess;
const BLAZE = 'chess_char_5_03_a';
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const keysOf = (grid, u, ext = 0) => new Set(absoluteRangeKeys(grid, u.tileR, u.tileC, u.dir, ext));
const sameSet = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
const tileKey = (e) => Math.round(e.y) * COLS + Math.round(e.x);
const s3Grid = () => C[BLAZE].skills[2].rangeGrid;
const baseGrid = () => C[BLAZE].rangeGrid;
const blazeArena = (enemies, o = {}) => makeBattle({
  defs: { enemies: Object.fromEntries(enemies.map((e) => [e.key, dummy(e.key, e.o)])) },
  units: [{ chessId: o.id ?? BLAZE, row: 10, col: 3, dir: 'RIGHT', skillIndex: 2 }],
  enemies: enemies.map((e) => ({ key: e.key, pos: e.pos })),
  hooks: ['damaged', 'attack', 'skillStart', 'ammoUsed'], captureNoisy: true, autoFinish: false, timeLimit: 120, seed: 5,
});

test('data: 烛煌 S3 众恶的焚场 is the default skill (index 2), skill range 4-11 vs the attack range 3-1, 18 / 21 ammo', () => {
  for (const id of [BLAZE, 'chess_char_5_03_b']) {
    const c = C[id];
    assert.equal(c.skill.skillId, 'skchr_blaze2_3');
    assert.equal(c.skill.index, 2);
    assert.equal(c.rangeId, '3-1');
    assert.equal(c.skill.rangeId, '4-11');
    assert.equal(c.skill.trigger.rule, 'DEFAULT', 'an attack-range change keeps the basic strategy (§20.2)');
  }
  assert.equal(C[BLAZE].skill.bb['attack@trigger_time'], 18);
  assert.equal(C.chess_char_5_03_b.skill.bb['attack@trigger_time'], 21);
});

test('烛煌 S3 attacks with the skill range: an enemy only in 4-11 is hit while it runs, an enemy only in 3-1 is not; the cast needs an enemy in 3-1', () => {
  // (10,7) = [0,4]: S3 only; (11,3) = [1,0]: base range only
  const h = blazeArena([{ key: 'enemy_far', pos: [10, 7] }]);
  const u = h.unit(BLAZE);
  h.step();
  u.skill.gainSp(1000);
  h.run(5);
  assert.equal(h.hooksOf('skillStart').length, 0, 'no enemy in the initial range: no cast (DEFAULT, "即将进行普通攻击")');
  assert.equal(h.hooksOf('damaged').filter((c) => c.source === u).length, 0, 'nothing in reach of 3-1');
  const near = h.spawn('enemy_far', { pos: [11, 3] });
  assert.ok(h.runUntil(() => u.skill.active, 5), 'an enemy in 3-1: she casts on her next attack');
  assert.ok(sameSet(new Set(u.rangeKeys), keysOf(s3Grid(), u)), 'the range keys are 4-11');
  const mark = h.hooksOf('damaged').length;
  h.run(2);
  const hit = new Set(h.hooksOf('damaged').slice(mark).filter((c) => c.source === u && c.dmg.isAttack).map((c) => c.target));
  assert.ok(hit.has(h.enemy('enemy_far')), 'the S3-only tile is attacked');
  assert.ok(!hit.has(near), '[1,0] is not part of 4-11');
  done(h);
});

test('烛煌 S3 "攻击变为群体攻击" = one target + a 1.7 splash (PRTS 备注 "攻击溅射半径1.7"): it reaches past the diamond, never all of it at once', () => {
  /** S3 running on an arena: (11,3) = [1,0] (base range only) makes her cast; returns her attacks and hits after that. */
  const s3Hits = (enemies) => {
    const h = blazeArena([{ key: 'enemy_cast', pos: [11, 3] }, ...enemies]);
    const u = h.unit(BLAZE);
    h.step();
    u.skill.gainSp(1000);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'cast');
    const mark = h.hooksOf('attack').length;
    const dmark = h.hooksOf('damaged').length;
    h.run(3);
    const attacks = h.hooksOf('attack').slice(mark).filter((c) => c.attacker === u);
    const hits = h.hooksOf('damaged').slice(dmark).filter((c) => c.source === u && c.dmg.isAttack);
    assert.ok(attacks.length >= 5, `several S3 attacks (${attacks.length})`);
    const s3 = keysOf(s3Grid(), u);
    for (const a of attacks) {
      assert.equal(a.targets.length, 1, 'one target per attack');
      assert.ok(s3.has(tileKey(a.targets[0])), 'the target stands in 4-11');
    }
    // every hit of an attack is its target or within 1.7 of it (中点判定)
    const byAttack = new Map();
    for (const c of hits) { if (!byAttack.has(c.dmg.attackId)) byAttack.set(c.dmg.attackId, []); byAttack.get(c.dmg.attackId).push(c); }
    for (const list of byAttack.values()) {
      const main = list.find((c) => !c.dmg.isSplash);
      assert.ok(main, 'a main hit');
      for (const c of list) assert.ok(Math.hypot(c.target.x - main.target.x, c.target.y - main.target.y) <= 1.7 + 1e-9, 'splash within 1.7');
    }
    done(h);
    return { h, hits, byAttack };
  };
  // (10,7) = [0,4] in 4-11; (10,8) = [0,5] outside it, 1 tile away: splashed
  const a = s3Hits([{ key: 'enemy_main', pos: [10, 7] }, { key: 'enemy_out', pos: [10, 8] }]);
  assert.ok(a.hits.some((c) => c.target === a.h.enemy('enemy_out') && c.dmg.isSplash), 'the splash reaches an enemy outside 4-11');
  assert.ok(!a.hits.some((c) => c.target === a.h.enemy('enemy_cast')), 'the base-only enemy is out of S3');
  // (10,7) = [0,4] and (12,5) = [2,2] both in 4-11 but 2.83 apart: one of them per attack, never both
  const b = s3Hits([{ key: 'enemy_main', pos: [10, 7] }, { key: 'enemy_far', pos: [12, 5] }]);
  for (const list of b.byAttack.values()) assert.equal(list.length, 1, 'one enemy per attack (the old group attack hit both)');
});

test('烛煌 S3: the +60 % ATK elemental damage hits every enemy of the attack in a 灼燃损伤 burst — the splashed ones too', () => {
  const h = blazeArena([{ key: 'enemy_cast', pos: [11, 3] }, { key: 'enemy_main', pos: [10, 7] }, { key: 'enemy_out', pos: [10, 8] }]);
  const u = h.unit(BLAZE);
  h.step();
  const out = h.enemy('enemy_out');
  u.skill.gainSp(1000);
  assert.ok(h.runUntil(() => u.skill.active, 5));
  h.b.applyStatus(out, 'burnBurst', { duration: 10 });
  assert.ok(out.findBuff('burnBurst'));
  const mark = h.hooksOf('damaged').length;
  h.run(1.5);
  const bonus = h.hooksOf('damaged').slice(mark).filter((c) => c.source === u && (c.dmg.tags || []).includes('blazeBurn'));
  assert.ok(bonus.some((c) => c.target === out), 'the splashed burning enemy takes the bonus');
  for (const c of bonus.filter((x) => x.target === out)) assert.ok(Math.abs(c.dmg.amount - u.s.atk * u.def.skill.bb['attack@atk_scale']) < 1e-6);
  assert.ok(!bonus.some((c) => c.target === h.enemy('enemy_main')), 'not on an enemy outside a burst');
  done(h);
});

test('烛煌 S3: a burn burst refills 2 ammo but never above the skill\'s ammo (PRTS 备注 "补充后的弹药数量无法超过上限")', () => {
  for (const id of [BLAZE, 'chess_char_5_03_b']) {
    const h = blazeArena([{ key: 'enemy_main', pos: [10, 5] }, { key: 'enemy_b', pos: [10, 6] }, { key: 'enemy_c', pos: [9, 5] }], { id });
    const u = h.unit(id);
    const max = u.def.skill.bb['attack@trigger_time'];
    h.step();
    u.skill.gainSp(1000);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    const first = u.skill.ammoLeft;                 // the casting attack already fired one bullet
    assert.equal(first, max - 1);
    h.b.dealDamage(null, h.enemy('enemy_main'), { type: 'element', element: 'burn', amount: 1000 });
    assert.equal(u.skill.ammoLeft, max, `${id}: +1 only — ${max} is the cap (it was ${first + 2})`);
    h.b.dealDamage(null, h.enemy('enemy_b'), { type: 'element', element: 'burn', amount: 1000 });
    assert.equal(u.skill.ammoLeft, max, 'a full magazine stays full');
    h.runUntil(() => u.skill.ammoLeft <= max - 3, 5);
    const l2 = u.skill.ammoLeft;
    h.b.dealDamage(null, h.enemy('enemy_c'), { type: 'element', element: 'burn', amount: 1000 });
    assert.equal(u.skill.ammoLeft, l2 + u.def.skill.bb.ammo_recover, 'room for both: +2');
    done(h);
  }
});

test('the live range grid (Battle._refreshRange → unit.liveRangeGrid, unitStatsEntry.range): 3-1, then 4-11 while S3 runs, then 3-1 again', () => {
  const h = blazeArena([{ key: 'enemy_main', pos: [10, 5] }]);
  const u = h.unit(BLAZE);
  h.step();
  const rel = (g) => new Set(g.map(([r, c]) => `${r},${c}`));
  assert.ok(sameSet(rel(unitStatsEntry(u, u.s).range), rel(baseGrid())), 'before: the attack range');
  u.skill.gainSp(1000);
  assert.ok(h.runUntil(() => u.skill.active, 5));
  const during = unitStatsEntry(u, u.s).range;
  assert.ok(sameSet(rel(during), rel(s3Grid())), 'during S3: the skill range');
  assert.ok(sameSet(keysOf(during, u), new Set(u.rangeKeys)), 'exactly the tiles the sim attacks');
  u.skill.stop();
  assert.ok(sameSet(rel(unitStatsEntry(u, u.s).range), rel(baseGrid())), 'after: the attack range again');
  // an enemy has no range on its card
  assert.equal(unitStatsEntry(h.enemy('enemy_main')).range, undefined);
  done(h);
});

test('extendedGrid: the relative form of absoluteRangeKeys\' rangeExtend, for every facing (random grids)', () => {
  const rng = createRng(77);
  for (let n = 0; n < 200; n++) {
    const g = [];
    const cells = 1 + Math.floor(rng() * 8);
    for (let i = 0; i < cells; i++) g.push([Math.floor(rng() * 7) - 3, Math.floor(rng() * 6) - 1]);
    const ext = [0, 0.25, 1, 1.5, 2, 3][n % 6];
    for (const dir of ['UP', 'RIGHT', 'DOWN', 'LEFT']) {
      const want = new Set(absoluteRangeKeys(g, 10, 10, dir, ext));
      const got = new Set(absoluteRangeKeys(extendedGrid(g, ext), 10, 10, dir, 0));
      assert.ok(sameSet(got, want), `${JSON.stringify(g)} +${ext} ${dir}`);
    }
  }
  assert.deepEqual(extendedGrid([[0, 0], [0, 1], [1, 0]], 1).map(String).sort(), ['0,0', '0,1', '0,2', '1,0', '1,1']);
  assert.deepEqual(extendedGrid(null, 2), []);
});

// ---- audit: every attack-range change of the mode -----------------------------------------------------------------

/** "攻击范围改变 / 扩大 / 缩小 / 缩短" ("攻击范围与溅射范围扩大"), "攻击距离+N", "攻击范围改为…" — an attack-range change (plain text; not a 技能范围). */
const RANGE_TEXT = /攻击范围(?:与溅射范围)?(?:改变|扩大|缩小|缩短)|攻击距离\+|攻击范围改为/;
/** Text-matched skills whose range the audit table checks by hand (their kit draws the range itself). */
const BY_HAND = new Map([
  ['skchr_lionhd_2', 'instant: the burst hits the 3-3 skill range at its cast (kit onStart); no lasting range'],
  ['skchr_fartth_3', '前方无限长的直线 (CUSTOM_RANGE kit line)'],
  ['skchr_agoat2_3', '整个战场 (WHOLE_FIELD)'],
]);

function rangeSkills() {
  const out = [];
  for (const c of Object.values(C)) {
    if (!(c.visible || (c.isGolden && C[c.baseId]?.visible))) continue;
    for (const s of c.skills || []) {
      const ext = s.bb?.ability_range_forward_extend ?? s.bb?.['attack@ability_range_forward_extend'] ?? null;
      const text = RANGE_TEXT.test(s.desc || '');
      if (!text && !(ext >= 1)) continue;
      out.push({ c, s, ext: ext >= 1 ? Math.floor(ext) : 0, text });
    }
  }
  return out;
}

test('audit: every selectable attack-range change attacks with the official grid while it runs and shows it as the live range', () => {
  const list = rangeSkills();
  assert.ok(list.length >= 90, `normal + elite records (${list.length})`);
  const seen = new Set();
  for (const { c, s, ext } of list) {
    if (BY_HAND.has(s.skillId)) { seen.add(s.skillId); continue; }
    const h = makeBattle({ units: [{ chessId: c.chessId, row: 10, col: 5, dir: 'UP', skillIndex: s.index }], autoFinish: false, timeLimit: 30 });
    const u = h.unit(c.chessId);
    h.step();
    const permExt = u.s.rangeExtend;
    const grid = s.rangeGrid && !ext ? s.rangeGrid : c.rangeGrid;
    const want = keysOf(grid, u, permExt + ext);
    if (s.skillType !== 'PASSIVE' && !/被动效果：攻击范围扩大/.test(s.desc)) {
      assert.ok(u.skill.activate('test', { free: true }), `${c.chessId} ${s.name}: cast`);
      h.step();
      assert.ok(u.skill.active, `${c.chessId} ${s.name}: running`);
    }
    assert.ok(sameSet(new Set(u.rangeKeys), want), `${c.chessId} S${s.index + 1} ${s.name}: the attack tiles`);
    const live = unitStatsEntry(u, u._s).range;
    assert.ok(sameSet(keysOf(live, u), want), `${c.chessId} S${s.index + 1} ${s.name}: the live range on the card`);
    done(h);
  }
  assert.deepEqual([...seen].sort(), [...BY_HAND.keys()].sort(), 'the hand-checked skills are still in the data');
});

test('audit: the DEFAULT trigger of an attack-range change reads the INITIAL range (PRTS "技能就绪，且即将进行普通攻击")', () => {
  // an enemy on [0,4]: inside 4-11, outside 3-1
  for (const id of [BLAZE, 'chess_char_5_03_b']) {
    const h = blazeArena([{ key: 'enemy_far', pos: [10, 7] }], { id });
    const u = h.unit(id);
    h.step();
    u.skill.gainSp(1000);
    h.run(4);
    assert.equal(h.hooksOf('skillStart').length, 0, `${id}: no cast`);
    done(h);
  }
});

test('real product path: a BattleSpec (S3 by loadout) on act2 m01 with a real wave — 烛煌 picks her targets on 4-11 and splashes past it', () => {
  // the round-5 template with its placeholder enemies as they stand (ground and air, both gates)
  const tpl = ds.getWave('act1autochess_05');
  const spawns = tpl.spawns.map((s) => ({ time: s.time, enemyKey: s.key, routeIndex: s.routeIndex, count: s.count, interval: s.interval }));
  const spec = buildBattleSpec({
    battleId: 'fb1e', fieldId: 'n:p1', kind: 'normal', seed: 4242, modeId: 'mode_multi_hard', round: 5, stageId: 'act2autochess_m01',
    timeLimit: 110, players: [{ playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, playerEffects: [], units: [
      { uid: 1, kind: 'chess', chessId: BLAZE, row: 11, col: 6, dir: 'RIGHT', skillIndex: 2 },
      { uid: 2, kind: 'chess', chessId: 'chess_char_3_12_a', row: 10, col: 8, dir: 'RIGHT' },
      { uid: 3, kind: 'chess', chessId: 'chess_char_1_10_a', row: 11, col: 8, dir: 'RIGHT' },
    ] }], spawns, routes: tpl.routes, flags: {}, waveId: 'act1autochess_05',
  });
  const b = createBattleFromSpec(spec, ds, { recordEvents: false, quiet: true });
  const u = b.allyUnits.find((x) => x.uid === 1);
  assert.equal(u.def.skill.id, 'skchr_blaze2_3');
  let picks = 0, offGrid = 0, splashOut = 0, casts = 0;
  b.on('skillStart', (c) => { if (c.unit === u) casts++; });
  b.on('attack', (c) => {
    if (c.attacker !== u || !u.skill.active) return;
    const s3 = keysOf(s3Grid(), u);
    for (const t of c.targets) { picks++; if (!s3.has(tileKey(t)) && t.blockedBy !== u) offGrid++; }
  });
  b.on('damaged', (c) => {
    if (c.source !== u || !u.skill.active || !c.dmg.isSplash) return;
    if (!keysOf(s3Grid(), u).has(tileKey(c.target))) splashOut++;
  });
  for (let i = 0; i < 110 * 30 && !b.finished; i++) b.step();
  assert.equal(b.errors.length, 0);
  assert.ok(casts >= 1, `S3 cast (${casts})`);
  assert.ok(picks > 10, `S3 attacks (${picks})`);
  assert.equal(offGrid, 0, 'every S3 target stands on 4-11');
  assert.ok(splashOut > 0, `splash victims outside 4-11 (${splashOut})`);
});
