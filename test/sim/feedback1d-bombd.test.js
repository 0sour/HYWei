// test/sim/feedback1d-bombd.test.js — community report D4 after 0.1.0 ("敌方无人机暴鸰的炸弹无法正常投放"). 暴鸰
// (enemy_1040_bombd, only from the 悬赏·飞行II / 战术特训·飞行II bounties) did trigger its one bomb, but the damage and the
// blast hit the operator in the very tick of the trigger while the drone flew on with the bomb still hanging under it
// for the rest of its life: nothing ever left the drone. Official (PRTS 暴鸰; the client's battle prefab
// enemy_1040_bombd + projectile_bombd): the cast plays the Attack clip, the bomb leaves on its OnAttack event (0.267 s,
// `_waitForAttackEvent`), flies to the target as a projectile (`_speed` 5, homing, `_ignoreCamouflage`) and explodes
// there on the target and the 8 tiles around it; the drone switches to its bomb-less mode (S1 `bomb_s`: the *_2
// clips) and flies on at ×2. Now (content/enemies.js kitBombd): 'atk' kind 'droneBomb' + fx 'phase' { kind: 'bombed' }
// at the release, damage on arrival, the speed-up after the blast.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, legalTileFor, chessOfTier, DATA } from '../match/harness.js';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';
import * as enemiesMod from '../../server/sim/content/enemies.js';
import { PROJECTILE_SPEEDS, TICK } from '../../server/sim/constants.js';

const KEY = 'enemy_1040_bombd';
const RELEASE = enemiesMod.BOMBD_RELEASE;
const ability = (e) => e.mem.ab.list.find((a) => a && a.fire);

/** A real round: solo 绝境 match, real stage and wave, seven real operators, the 悬赏·飞行II bounty (one 暴鸰). */
function realRound(seed = 3, round = 4) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', humans: 1, seed, fake: false });
  h.start();
  h.toPrep(round);
  const m = h.m, ps = h.ps('p_0');
  let placed = 0;
  for (const id of [...chessOfTier(1), ...chessOfTier(2)]) {
    if (placed >= 7) break;
    const t = legalTileFor(m, ps, id);
    if (!t) continue;
    give(m, ps, id, 'board', t);
    placed++;
  }
  m.addBounty(ps, DATA.choices.cards.bounty.find((c) => c.effectId === 'enemyeffect_10_5'));
  const opts = m._normalOpts(ps);
  assert.ok(opts.spawns.some((s) => s.enemyKey === KEY), 'the bounty adds a 暴鸰 to the real wave');
  return { h, m, b: m.newBattle(opts) };
}

describe('D4 暴鸰: the bomb leaves the drone and lands', () => {
  test('real wave: trigger → release on the OnAttack frame (atk droneBomb + bomb-less mode) → damage on arrival → ×2 speed', () => {
    const { m, b } = realRound();
    const log = [];
    let drone = null, castAt = null, hitAt = null, firstHit = null;
    const hits = [];
    b.on('damaged', (c) => {
      if (c.source !== drone || !drone) return;
      hits.push({ t: b.time, target: c.target, amount: c.amount ?? c.dmg?.amount, splash: (c.dmg?.tags || []).includes('splash') });
      if (hitAt == null) { hitAt = b.time; firstHit = c.target; }
    });
    while (!b.finished && b.time < 200) {
      b.step();
      if (!drone) drone = b.enemies.find((x) => x.defId === KEY) || null;
      if (drone && castAt == null && (ability(drone)?.casts ?? 0) > 0) {
        castAt = b.time;
        assert.equal(hits.length, 0, 'nothing is hit in the tick of the trigger');
        assert.ok(!drone.findBuff('ab:bombRun'), 'no speed-up before the bomb went off');
      }
      for (const ev of b.drainEvents()) if (drone && ((ev[0] === 'atk' && ev[1] === drone.id) || (ev[0] === 'fx' && ev[4]?.id === drone.id))) log.push([b.time, ev]);
      if (hitAt != null && b.time > hitAt + 1) break;
    }
    assert.ok(drone, 'the drone spawned');
    assert.ok(castAt != null, 'it triggered its bomb near the operators');
    const atk = log.filter(([, ev]) => ev[0] === 'atk');
    assert.equal(atk.length, 1, 'exactly one drop (and never a normal attack)');
    const [relT, relEv] = atk[0];
    assert.equal(relEv[3], 'droneBomb', 'drawn as the drone\'s bomb');
    assert.ok(Math.abs(relT - castAt - RELEASE) <= TICK + 1e-9, `released ${(relT - castAt).toFixed(3)} s after the trigger (OnAttack ${RELEASE})`);
    const phase = log.find(([, ev]) => ev[0] === 'fx' && ev[1] === 'phase');
    assert.ok(phase && phase[1][4].kind === 'bombed' && Math.abs(phase[0] - relT) < 1e-9, 'the model drops to its bomb-less mode at the release');
    assert.ok(hitAt != null, 'the bomb lands');
    assert.equal(firstHit.id, relEv[2], 'on the operator it was dropped on');
    assert.ok(hitAt - relT > TICK, `then flies (${(hitAt - relT).toFixed(3)} s at ${PROJECTILE_SPEEDS.droneBomb} tiles/s)`);
    assert.ok(hitAt - relT < 1.2, 'and lands promptly');
    const main = hits.filter((x) => !x.splash);
    assert.equal(main.length, 1, 'one main hit');
    for (const x of hits.filter((y) => y.splash)) {
      assert.ok(Math.max(Math.abs(x.target.tileR - firstHit.tileR), Math.abs(x.target.tileC - firstHit.tileC)) <= 1, 'splash only on the 8 tiles around the target');
    }
    const run = drone.findBuff('ab:bombRun');
    if (drone.alive) assert.equal(run?.mods?.moveMul, DATA.enemies[KEY].skills[0].bb.move_speed, '移速最终提升至200% after the blast');
    assert.equal(drone.stats.attacks, 0, 'no normal attack');
    m.dispose();
  });

  const WALL = (id) => chessRec({ id, profession: 'TANK', stats: { atk: 0, maxHp: 1e7, def: 0, res: 0, blockCnt: 3 }, rangeGrid: [[0, 0]], skill: null });
  const arena = (units) => makeBattle({
    content: 'generic', extraContent: [enemiesMod], seed: 7, autoFinish: false, timeLimit: 600,
    defs: { chess: { t_a: WALL('t_a'), t_b: WALL('t_b'), t_c: WALL('t_c') } },
    kits: { t_a: () => ({ trait: { noAttack: true } }), t_b: () => ({ trait: { noAttack: true } }), t_c: () => ({ trait: { noAttack: true } }) },
    units,
  });
  const put = (h, pos) => h.spawn(KEY, { pos, routeIndex: 0, mods: { speedMul: 0 }, route: 2 });

  test('a target gone mid-flight: the bomb still lands where it was and splashes its neighbours', () => {
    const h = arena([{ chessId: 't_a', row: 10, col: 5 }, { chessId: 't_b', row: 11, col: 5 }]);
    h.step();
    const e = put(h, [10, 7]);
    const [a, bb] = [h.unit('t_a'), h.unit('t_b')];
    h.runUntil(() => (ability(e)?.casts ?? 0) > 0, 5);
    h.run(RELEASE + TICK);
    const rel = h.eventsOf('atk').find((ev) => ev[1] === e.id);
    assert.ok(rel, 'released');
    const tgt = [a, bb].find((u) => u.id === rel[2]);
    const other = tgt === a ? bb : a;
    h.b.retreat(tgt, { reason: 'test', permanent: true });
    h.run(1.5);
    assert.equal(tgt.stats.taken, 0, 'the withdrawn target is not hit');
    assert.ok(other.stats.taken > 0, 'its neighbour takes the splash at the landing point');
  });

  test('the drone killed before the release: no bomb, no mode change', () => {
    const h = arena([{ chessId: 't_a', row: 10, col: 6 }]);
    h.step();
    const e = put(h, [10, 7]);
    h.runUntil(() => (ability(e)?.casts ?? 0) > 0, 5);
    h.b.kill(e, null);
    h.run(2);
    assert.equal(h.unit('t_a').stats.taken, 0);
    assert.ok(!h.events.some((ev) => ev[0] === 'atk' && ev[1] === e.id), 'no drop');
    assert.ok(!h.events.some((ev) => ev[0] === 'fx' && ev[1] === 'phase' && ev[4]?.id === e.id), 'no bomb-less mode');
  });
});
