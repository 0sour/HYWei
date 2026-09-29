// Shared pool accounting, copy-weighted odds, per-match bans (research 00-INDEX §3, §6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameData } from '../../server/match/gamedata.js';
import { SharedPool, drawDisabledBonds } from '../../server/match/pool.js';
import { createRng } from '../../server/sim/rng.js';
import { DATA, makeMatch, give, checkInvariants, chessOfTier } from './harness.js';

const gdOf = (modeId = 'mode_multi_normal') => new GameData(DATA, modeId);

test('pool caps follow config (12/14/18/16/8/5, 缪尔赛思 4) and only visible, unbanned chess enter', () => {
  const gd = gdOf();
  const pool = new SharedPool(gd, { banned: [] });
  const caps = { 1: 12, 2: 14, 3: 18, 4: 16, 5: 8, 6: 5 };
  assert.equal(pool.entries.size, gd.visibleChess.length);
  assert.equal(pool.entries.size, 112);
  for (const [id, e] of pool.entries) {
    const expect = id === 'chess_char_6_11_a' ? 4 : caps[e.tier];
    assert.equal(e.cap, expect, id);
    assert.equal(e.left, e.cap);
    assert.ok(DATA.chess[id].visible && !DATA.chess[id].isGolden);
  }
  const banned = [gd.visibleChess[0], gd.visibleChess[5]];
  const p2 = new SharedPool(gd, { banned });
  assert.equal(p2.entries.size, 110);
  assert.ok(!p2.has(banned[0]) && p2.left(banned[0]) === 0 && p2.take(banned[0]) === 0);
});

test('take/give never go below 0 or above the cap', () => {
  const pool = new SharedPool(gdOf());
  const id = chessOfTier(6)[0];
  const cap = pool.cap(id);
  assert.equal(pool.take(id, 3), 3);
  assert.equal(pool.left(id), cap - 3);
  assert.equal(pool.take(id, 100), cap - 3, 'take clamps at what is left');
  assert.equal(pool.left(id), 0);
  assert.equal(pool.take(id, 1), 0);
  assert.equal(pool.give(id, 100), cap, 'give clamps at the cap');
  assert.equal(pool.left(id), cap);
  assert.equal(pool.give(id, 1), 0);
  assert.equal(pool.take('nope', 1), 0);
  assert.equal(pool.give('nope', 1), 0);
  assert.equal(pool.take(id, -1), 0);
  assert.equal(pool.take(id, NaN), 0);
});

test('odds sanity: level L rolls only tiers ≤ L; level 1 only tier 1; shares ≈ research table', () => {
  const pool = new SharedPool(gdOf());
  const rng = createRng(12345);
  for (let level = 1; level <= 6; level++) {
    const seen = {};
    for (let i = 0; i < 4000; i++) {
      const id = pool.roll(rng, { maxTier: level });
      const t = DATA.chess[id].tier;
      assert.ok(t <= level, `level ${level} rolled tier ${t}`);
      seen[t] = (seen[t] || 0) + 1;
    }
    if (level === 1) assert.deepEqual(Object.keys(seen), ['1']);
    const shares = pool.tierShares(level);
    for (const [t, n] of Object.entries(seen)) assert.ok(Math.abs(n / 4000 - shares[t]) < 0.035, `L${level} T${t} ${n / 4000} vs ${shares[t]}`);
  }
  // research table (full pools, no bans): L6 ≈ 14.0 / 17.4 / 25.0 / 25.7 / 11.1 / 6.9 %
  const s6 = pool.tierShares(6);
  const want = { 1: 0.14, 2: 0.174, 3: 0.25, 4: 0.257, 5: 0.111, 6: 0.069 };
  for (const t of Object.keys(want)) assert.ok(Math.abs(s6[t] - want[t]) < 0.01, `T${t} ${s6[t]}`);
  const s2 = pool.tierShares(2);
  assert.ok(Math.abs(s2[1] - 0.447) < 0.01 && Math.abs(s2[2] - 0.553) < 0.01);
});

test('rolls are copy-weighted: an exhausted chess never rolls; tier/filter options work', () => {
  const pool = new SharedPool(gdOf());
  const rng = createRng(7);
  const t1 = chessOfTier(1);
  for (const id of t1.slice(1)) pool.take(id, 100);
  for (let i = 0; i < 200; i++) assert.equal(pool.roll(rng, { maxTier: 1 }), t1[0]);
  pool.take(t1[0], 100);
  assert.equal(pool.roll(rng, { maxTier: 1 }), null, 'empty tier → null');
  for (let i = 0; i < 100; i++) assert.equal(DATA.chess[pool.roll(rng, { tier: 3 })].tier, 3);
  const f = pool.roll(rng, { maxTier: 6, filter: (id) => id === chessOfTier(5)[2] });
  assert.equal(f, chessOfTier(5)[2]);
});

test('item slot: tier ≤ level, shop-eligible normal equipment only', () => {
  const gd = gdOf();
  const pool = new SharedPool(gd);
  const rng = createRng(99);
  for (let level = 1; level <= 6; level++) {
    for (let i = 0; i < 300; i++) {
      const id = pool.rollItem(rng, level);
      const it = DATA.items[id];
      assert.ok(it && it.itemType === 'EQUIP' && !it.isGolden && !it.hideInShop, id);
      assert.ok(it.tier <= level, `L${level} item tier ${it.tier}`);
    }
  }
});

test('per-match disabled bonds: 3 core + 4 add-on (NORMAL+), FUNNY static + 0 + 1; weight-0 never drawn; subset ban rule', () => {
  for (const [modeId, core, addon] of [['mode_multi_hard', 3, 4], ['mode_single_abyss', 3, 4], ['mode_multi_funny', 0, 1], ['mode_single_normal', 3, 4]]) {
    const gd = new GameData(DATA, modeId);
    for (let seed = 1; seed <= 20; seed++) {
      const { drawn, staticOff, banned } = drawDisabledBonds(gd, createRng(seed));
      const nCore = drawn.filter((b) => DATA.bonds[b].isCore).length;
      assert.equal(nCore, core, `${modeId} core`);
      assert.equal(drawn.length - nCore, addon, `${modeId} addon`);
      for (const b of drawn) {
        assert.ok(DATA.bonds[b].weight > 0, `${b} has weight 0`);
        assert.ok(!staticOff.includes(b));
      }
      const off = new Set([...drawn, ...staticOff]);
      for (const id of gd.visibleChess) {
        const bonds = DATA.chess[id].bonds;
        assert.equal(banned.includes(id), bonds.length > 0 && bonds.every((b) => off.has(b)), id);
      }
    }
  }
  // FUNNY: the static list alone removes many operators
  const f = drawDisabledBonds(new GameData(DATA, 'mode_multi_funny'), createRng(1));
  assert.equal(f.staticOff.length, 10);
  assert.ok(f.banned.length >= 20);
});

test('the match pool excludes banned chess; m.public lists disabled bonds and banned chess', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 1, seed: 3 }).start();
  const pub = h.lastBc('m.public');
  assert.equal(pub.drawnDisabledBonds.length, 7);
  assert.ok(pub.bannedChess.length > 0);
  for (const id of pub.bannedChess) assert.ok(!h.m.pool.has(id), `${id} should not be in the pool`);
  assert.equal(h.m.pool.entries.size + pub.bannedChess.length, 112);
  checkInvariants(h.m);
  h.m.dispose();
});

test('selling and elimination return copies; elites return 3', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 5 }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  const id = chessOfTier(2).find((c) => m.pool.has(c));
  const cap = m.pool.cap(id);
  const a = give(m, ps, id);
  assert.equal(m.pool.left(id), cap - 1);
  assert.deepEqual(m.handle('p_0', { t: 'g.sell', uid: a.uid }), { ok: true });
  assert.equal(m.pool.left(id), cap);
  const golden = DATA.chess[id].goldenId;
  const e = give(m, ps, golden);
  assert.equal(e.poolCopies, 3);
  assert.equal(m.pool.left(id), cap - 3);
  checkInvariants(m);
  m.handle('p_0', { t: 'g.sell', uid: e.uid });
  assert.equal(m.pool.left(id), cap);
  // elimination returns everything
  const ids = chessOfTier(1).filter((c) => m.pool.has(c)).slice(0, 4);
  for (const c of ids) give(m, ps, c);
  const before = ids.map((c) => m.pool.left(c));
  ps.eliminate(1);
  ids.forEach((c, i) => assert.equal(m.pool.left(c), before[i] + 1));
  checkInvariants(m);
  m.dispose();
});
