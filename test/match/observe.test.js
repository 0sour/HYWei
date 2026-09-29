// Observing rules of the client (public/js/battle/observe.js, research 09 §3.1 / §6.3) — the mirror of the server's
// Match._watchClient: prep boards, no observing while the own normal battle runs, a teammate's field once it is over,
// the other pair's boss field hidden, eliminated players free; the 联防 / 最终攻势 camera halves and their captions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeTarget, teammateProgress, cameraLayers, layerCamera, isClientCombat } from '../../public/js/battle/observe.js';

const P = (id, seat, extra = {}) => ({ playerId: id, seat, name: id.toUpperCase(), alive: true, ...extra });
const pubOf = (phase, fields, players) => ({ phase, combatMode: 'client', fields, players });

test('observeTarget: prep, own battle running / over, boss pairs, eliminated players', () => {
  const players = [P('a', 0), P('b', 1), P('c', 2, { alive: false })];
  assert.equal(isClientCombat(pubOf('PREP', [], players)), true);
  assert.deepEqual(observeTarget(players[1], pubOf('PREP', [], players), 'a'), { fieldId: 'n:b' });
  assert.match(observeTarget(players[2], pubOf('PREP', [], players), 'a').reason, /淘汰/);
  const combat = (liveA) => pubOf('COMBAT', [
    { fieldId: 'n:a', kind: 'normal', players: ['a'], live: liveA },
    { fieldId: 'n:b', kind: 'normal', players: ['b'], live: true, progress: { killed: 3, total: 8, done: false } },
  ], players);
  assert.match(observeTarget(players[1], combat(true), 'a').reason, /作战中无法查看/);
  assert.deepEqual(observeTarget(players[1], combat(true), 'a', { ownDone: true }), { fieldId: 'n:b' }, 'the local battle already ended');
  assert.deepEqual(observeTarget(players[1], combat(false), 'a'), { fieldId: 'n:b' });
  assert.deepEqual(observeTarget(players[0], combat(false), 'a', { observing: true }), { back: true });
  assert.deepEqual(teammateProgress(combat(false), 'a'), [{ playerId: 'b', name: 'B', isBot: false, killed: 3, total: 8, done: false }]);
  const fa = pubOf('FINAL_ASSAULT', [
    { fieldId: 'b1', kind: 'boss', players: ['a', 'b'], live: true },
    { fieldId: 'b2', kind: 'boss', players: ['d'], live: true },
  ], [...players, P('d', 3)]);
  assert.match(observeTarget(P('d', 3), fa, 'a').reason, /另一组/);
  assert.match(observeTarget(players[1], fa, 'a').reason, /同一战场/);
  const dead = pubOf('FINAL_ASSAULT', fa.fields, [{ ...players[0], alive: false }, players[1], P('d', 3)]);
  assert.deepEqual(observeTarget(P('d', 3), dead, 'a'), { fieldId: 'b2' }, 'eliminated: anything');
});

test('cameraLayers: ‹ LEFT / 全景 / RIGHT › with "你自己" / name / "无人在家"; none for normal or single boss fields', () => {
  const pub = { players: [P('a', 0), P('b', 1)] };
  const unite = { fieldId: 'u', kind: 'unite', rect: { r0: 9, r1: 12, c0: 0, c1: 20 }, players: ['a', 'b'], sides: { a: 'R', b: 'L' } };
  assert.deepEqual(cameraLayers(unite, pub, 'a').map((l) => [l.key, l.label]), [['L', 'B'], ['ALL', '全景'], ['R', '你自己']]);
  const single = { ...unite, players: ['b'], sides: { b: 'L' } };
  assert.deepEqual(cameraLayers(single, pub, 'a').map((l) => l.label), ['B', '全景', '无人在家']);
  assert.deepEqual(cameraLayers({ kind: 'normal' }, pub, 'a'), []);
  assert.deepEqual(cameraLayers({ kind: 'boss', players: ['a'], sides: { a: 'L' } }, pub, 'a'), [], 'a solo boss field has no halves');
  assert.deepEqual(layerCamera(unite, 'R', 'R'), { rect: unite.rect, side: 'R', half: true });
  assert.deepEqual(layerCamera(unite, 'ALL', 'R'), { rect: unite.rect, side: 'R' });
});
