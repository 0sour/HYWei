// Official route shapes (community report after 0.1.0, D5: on 战场#04 活性源石 the lower-gate enemies walked two tiles
// straight left of the red gate and then straight up, instead of crossing diagonally from the 4th row to the 3rd as in
// the official game). grid.js keeps the official flow field (research 08 §3.1) wherever its route crosses no more
// non-blockable tiles (floor, gates) than the blockable-ground preference of user playtest #2 — a segment that only
// brushes a floor tile's corner does not cross it. Audit: every stage (active or not) × gate × field against the pure
// official algorithm; the routes that still differ are listed, each avoiding floor the official route walks over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid, segmentTiles } from '../../server/sim/grid.js';
import { getDefaultSource, hasGeneratedData } from '../../server/sim/simdata.js';
import { GEO } from '../../shared/constants.js';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';

const REAL = { skip: !hasGeneratedData() && 'no generated data' };
const COLS = 21;
const M04 = 'act1autochess_m04';
const RECT = { normal: GEO.NORMAL_RECT, unite: GEO.UNITE_RECT, boss: GEO.BOSS_RECT };

/** Grid of a real stage with its match-start devices; `pure` = the official algorithm (every tile counted blockable). */
function stageGrid(id, rect, pure = false) {
  const st = getDefaultSource().getStage(id);
  if (!st) return null;
  const g = new Grid(st, rect);
  for (const d of st.raw.devices) {
    if (!d.active || !d.pos) continue;
    if (d.role === 'crate') g.setObstacle(d.pos[0], d.pos[1], true, 'crate');
    if (d.role === 'platform' || d.role === 'mound') g.setObstacle(d.pos[0], d.pos[1], true);
  }
  if (pure) g.unblockable.fill(0);
  return g;
}
const str = (wp) => (wp ? wp.map((p) => p.join(',')).join(' ') : 'null');

test('D5 战场#04 活性源石: the lower-gate route is the official diagonal from row 9 into row 10 (normal and 联防 fields)', REAL, () => {
  const official = [[9, 10], [10, 7], [10, 4], [9, 4], [9, 2]];
  assert.deepEqual(stageGrid(M04, GEO.NORMAL_RECT, true).waypoints(9, 10, 9, 2), official, 'the pure official algorithm');
  assert.deepEqual(stageGrid(M04, GEO.NORMAL_RECT).waypoints(9, 10, 9, 2), official, 'normal field');
  assert.deepEqual(stageGrid(M04, GEO.UNITE_RECT).waypoints(9, 10, 9, 2), official, '联防 field, own lower gate');
  // the segment (9,10) → (10,7) only brushes the corner of the floor tile (10,9): it crosses no non-blockable tile
  assert.deepEqual(segmentTiles([9, 10], [10, 7]), [[9, 10], [9, 9], [10, 8], [10, 7]]);
});

test('D5 real battle (act1 m04, round-1 template act1autochess_01): the 源石虫 leave the gate diagonally, never along row 9 to col 8', REAL, () => {
  const h = makeBattle({ stageId: M04, waveTemplate: 'act1autochess_01', units: [], autoFinish: false });
  let id = null, defId = null;
  const tiles = [];
  let atCol9 = null;
  h.b.on('tick', () => {
    const e = h.b.enemies.find((u) => (id == null ? u.motion === 'WALK' : u.id === id));
    if (!e) return;
    id = e.id;
    defId = e.defId;
    const k = `${Math.round(e.y)},${Math.round(e.x)}`;
    if (tiles[tiles.length - 1] !== k) tiles.push(k);
    if (atCol9 == null && e.x <= 9) atCol9 = e.y;
  });
  h.run(30);
  assert.equal(defId, 'enemy_1007_slime', 'the round-1 源石虫 of the lower gate');
  assert.deepEqual(tiles.slice(0, 5), ['9,10', '9,9', '10,8', '10,7', '10,6'], `tiles: ${tiles.join(' ')}`);
  assert.ok(!tiles.includes('9,8'), `never on (9,8): ${tiles.join(' ')}`);
  // on the official segment (9,10) → (10,7) the walker is a third of a row up when it passes the col-9 centre line
  assert.ok(Math.abs(atCol9 - (9 + 1 / 3)) < 0.02, `row ${atCol9} at col 9 (straight along row 9 would be 9.00)`);
});

// Routes that differ from the official one (ours, as waypoints): each crosses fewer non-blockable tiles — user playtest
// #2's 战场#01 col-9 floor lane (its 联防 partner routes pass the same exit), the boss exits (2,10) of 战场#01 / #02
// that would cut across the arena's central floor, 战场#02's 联防 partner lower gate (floor (12,17)) and the inactive
// 战场#07 (上半)'s 联防 partner upper gate (row 12 through (12,9) vs row 9). Every other route of every stage is official.
const DEVIATIONS = {
  'act1autochess_m01 normal 9,10>9,2': '9,10 9,8 12,8 12,4 9,4 9,2',
  'act1autochess_m01 unite 9,10>9,2': '9,10 9,8 12,8 12,4 9,4 9,2',
  'act1autochess_m01 unite 9,18>9,2': '9,18 9,16 12,16 12,12 9,12 9,8 12,8 12,4 9,4 9,2',
  'act1autochess_m01 unite 12,18>9,2': '12,18 12,12 9,12 9,8 12,8 12,4 9,4 9,2',
  'act1autochess_m01 boss 2,10>1,3': '2,10 2,8 5,8 5,4 2,4 2,3 1,3',
  'act1autochess_m01 boss 2,10>2,2': '2,10 2,8 5,8 5,4 2,4 2,2',
  'act1autochess_m01 boss 2,10>1,17': '2,10 2,12 5,12 5,16 2,16 2,17 1,17',
  'act1autochess_m01 boss 2,10>2,18': '2,10 2,12 5,12 5,16 2,16 2,18',
  'act1autochess_m02 unite 9,18>9,2': '9,18 9,17 11,17 12,12 12,3 9,3 9,2',
  'act1autochess_m02 boss 2,10>1,3': '2,10 2,9 4,9 4,6 2,6 2,3 1,3',
  'act1autochess_m02 boss 2,10>2,2': '2,10 2,9 4,9 4,6 2,6 2,2',
  'act1autochess_m02 boss 2,10>1,17': '2,10 3,11 4,11 4,14 2,14 2,17 1,17',
  'act1autochess_m02 boss 2,10>2,18': '2,10 3,11 4,11 4,14 2,14 2,18',
  'act1autochess_m07 unite 12,18>9,2': '12,18 12,11 9,11 9,2',
};

test('audit: every route of every stage (11, active or not) × gate × field is the official one, except the listed floor-avoiding ones', REAL, () => {
  const stages = ['act1autochess_m01', 'act1autochess_m02', 'act1autochess_m03', 'act1autochess_m04', 'act1autochess_m05', 'act1autochess_m06', 'act1autochess_m07',
    'act2autochess_m01', 'act2autochess_m02', 'act2autochess_m03', 'act2autochess_m04'];
  const legs = [
    ['normal', [9, 10], [9, 2]], ['normal', [12, 10], [9, 2]],
    ['unite', [9, 10], [9, 2]], ['unite', [12, 10], [9, 2]], ['unite', [9, 18], [9, 2]], ['unite', [12, 18], [9, 2]],
    ...[[5, 10], [2, 10]].flatMap((s) => [[1, 3], [2, 2], [1, 17], [2, 18]].map((e) => ['boss', s, e])),
  ];
  const floor = (g, wp) => {
    const out = [];
    for (let i = 1; i < wp.length; i++) for (const [r, c] of segmentTiles(wp[i - 1], wp[i]).slice(1)) if (g.unblockable[r * COLS + c]) out.push(`${r},${c}`);
    return out;
  };
  const seen = new Set();
  let official = 0;
  for (const sid of stages) {
    for (const [kind, s, e] of legs) {
      const g = stageGrid(sid, RECT[kind]), p = stageGrid(sid, RECT[kind], true);
      assert.ok(g, `${sid} in data/stages.json`);
      const ours = g.waypoints(s[0], s[1], e[0], e[1]), off = p.waypoints(s[0], s[1], e[0], e[1]);
      const key = `${sid} ${kind} ${s}>${e}`;
      assert.ok(ours && off, `${key} reachable`);
      assert.equal(g.flowField(e[0], e[1]).dist[s[0] * COLS + s[1]], p.flowField(e[0], e[1]).dist[s[0] * COLS + s[1]], `${key}: official length`);
      if (str(ours) === str(off)) { assert.ok(!(key in DEVIATIONS), `${key} is official now: drop it from DEVIATIONS`); official++; continue; }
      seen.add(key);
      assert.equal(str(ours), DEVIATIONS[key], `${key} differs from the official ${str(off)}`);
      const fo = floor(g, ours), ff = floor(g, off);
      assert.ok(fo.length < ff.length, `${key}: crosses ${fo.join(' ')}, the official route ${ff.join(' ')}`);
    }
  }
  assert.equal(seen.size, Object.keys(DEVIATIONS).length, 'every listed deviation still exists');
  assert.equal(official, stages.length * legs.length - seen.size);
});

test('D5: an operator on (9,9), (9,8) or (10,8) blocks the lower-gate enemy on the official diagonal', REAL, () => {
  const guard = chessRec({ id: 't_guard', profession: 'WARRIOR', stats: { atk: 0, blockCnt: 3, maxHp: 1e6 }, skill: null });
  const walker = enemyRec({ key: 'enemy_walker', hp: 1e6, speed: 1 });
  const route = { motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [] };
  for (const [r, c] of [[9, 9], [9, 8], [10, 8]]) {
    const h = makeBattle({ stageId: M04, defs: { chess: { t_guard: guard }, enemies: { enemy_walker: walker } },
      units: [{ chessId: 't_guard', row: r, col: c }], enemies: [{ key: 'enemy_walker', route }], content: 'none', autoFinish: false, timeLimit: 60 });
    const u = h.unit('t_guard');
    assert.ok(h.runUntil(() => h.enemies()[0]?.blockedBy === u, 30), `blocked by the operator on (${r},${c})`);
  }
});
