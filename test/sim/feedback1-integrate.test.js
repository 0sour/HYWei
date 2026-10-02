// Integration regressions found while merging the feedback1 workstreams (player feedback after 0.1.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';

const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });

// A full co-op match (fullmatch-coop3, seed 116) had a 联防 battle end at its time limit while 隐德来希's S3 candles were
// standing: the result listed the 心烛 (enemy_5601_entlec, in no spawn schedule) as a leak and the server rejected the
// honest client's result ('leak key'). A candle follows its original; only the originals count at the limit.
test('隐德来希 S3: candles still standing at the time limit are no leaks (the originals are)', () => {
  const h = makeBattle({
    defs: { enemies: { e_a: dummy('e_a', { hp: 1e6 }), e_b: dummy('e_b', { hp: 2e6 }) } },
    units: [{ chessId: 'chess_char_5_06_a', row: 9, col: 4 }],
    enemies: [{ key: 'e_a', pos: [10, 5] }, { key: 'e_b', pos: [9, 5] }],
    timeLimit: 6,
  });
  const u = h.unit('chess_char_5_06_a');
  h.step();
  u.skill.gainSp(1000);
  assert.ok(h.runUntil(() => u.skill.active, 5), 'S3 starts');
  assert.ok(h.b.enemies.some((e) => e.alive && e.mem.candleOwner === u), 'candles stand');
  assert.ok(h.runUntil(() => h.b.finished, 10), 'the battle reaches its time limit');
  const r = h.result();
  assert.equal(r.reason, 'timeout');
  const leaked = Object.values(r.perPlayer).flatMap((p) => p.leaked).map((l) => l.enemyKey);
  assert.ok(!leaked.includes('enemy_5601_entlec'), `no candle leak: ${leaked.join(',')}`);
  assert.equal(leaked.filter((k) => /e_a|e_b/.test(k)).length, 2, 'both originals count');
  assert.deepEqual(h.b.errors.map((e) => e.message), []);
  checkInvariants(h.b);
});
