// Community report after 0.1.0 (batch 5, E1): "干员烛煌开启3技能时候攻击范围不会变". The sim attacked with S3's 4-11
// (test/sim/feedback1e-skillrange.test.js); the battle detail card did not — its 攻击范围 mini-map kept the base 3-1 grid
// while the live stats beside it showed S3's ATK and interval. The card now draws the live entry's `range`
// (shared/protocol.js unitStatsEntry: the grid the unit attacks with now) — in battle from the browser's own sim, in prep
// from the start-of-battle preview — names a whole-field range instead of drawing it, and draws a grid larger than its
// box (远牙 S3's 21-tile line) with smaller cells so the box keeps its size (review: the line squeezed the live stats
// from 326 px to 80 px).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBattle, enemyRec } from '../helpers/battleHarness.js';
import { unitStatsEntry } from '../../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// the browser data store reads the real data files from disk (the card renders below)
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const { ChessDetail, RangeGrid, cardRangeGrid, rangeGridStyle, FIELD_WIDE_CELLS, RANGE_FIT } = await import('../../public/js/ui/detailPanel.js');
const { rangeGridBox } = await import('../../public/js/ui/gameLogic.js');
const { data } = await import('../../public/js/data.js');

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  if (typeof v.type === 'function' && v.type.name === 'RangeGrid') { yield* walk(v.type(v.props)); return; }
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
const onCells = (tree) => [...walk(tree)].filter((n) => n.type === 'i' && hasClass(n, 'on')).length;
const BLAZE = 'chess_char_5_03_a';

/** 烛煌's live entry from a real battle: before / during her S3. */
function blazeLive() {
  const h = makeBattle({
    defs: { enemies: { enemy_a: enemyRec({ key: 'enemy_a', hp: 1e7, speed: 0 }) } },
    units: [{ chessId: BLAZE, row: 10, col: 3, dir: 'RIGHT', skillIndex: 2 }], enemies: [{ key: 'enemy_a', pos: [10, 4] }],
    autoFinish: false, timeLimit: 60,
  });
  const u = h.unit(BLAZE);
  h.step();
  const before = { ...unitStatsEntry(u, u._s), src: 'battle' };
  u.skill.gainSp(1000);
  h.runUntil(() => u.skill.active, 5);
  const during = { ...unitStatsEntry(u, u._s), src: 'battle' };
  return { before, during };
}

test('the battle card\'s 攻击范围 follows 烛煌 S3: 10 tiles (3-1) before, 13 (4-11) while it runs', async () => {
  await data.loadAll('chess', 'garrisons', 'assets', 'bonds', 'items');
  const c = data.lookup('chess', BLAZE);
  const { before, during } = blazeLive();
  assert.equal(before.range.length, 10);
  assert.equal(during.range.length, 13);
  const stats = (live) => ChessDetail({ chess: c, piece: null, editable: false, bonds: [], loadout: null, live }).find((b) => b.key === 'stats');
  assert.equal(onCells(stats(before)), 10, 'the base range');
  assert.equal(onCells(stats(during)), 13, 'the S3 range on the card');
  assert.equal(onCells(stats(null)), 10, 'no live entry: the record\'s attack range');
});

test('cardRangeGrid: the live range first, else the loadout record\'s attack range; a whole-field range is named, not drawn', async () => {
  await data.loadAll('chess');
  const c = data.lookup('chess', BLAZE);
  assert.deepEqual(cardRangeGrid({ range: [[0, 0], [0, 1]] }, c, c), [[0, 0], [0, 1]]);
  assert.equal(cardRangeGrid({ range: [] }, c, c), c.rangeGrid, 'an empty live range is ignored');
  assert.equal(cardRangeGrid(null, c, c), c.rangeGrid);
  assert.equal(cardRangeGrid({ atk: 1 }, null, c), c.rangeGrid, 'an entry without range (an older server): the record');
  const whole = [];
  for (let dr = -18; dr <= 18; dr++) for (let dc = -20; dc <= 20; dc++) whole.push([dr, dc]);
  assert.ok(whole.length >= FIELD_WIDE_CELLS);
  const v = RangeGrid({ grid: whole });
  assert.ok(hasClass(v, 'rgrid-all'));
  assert.equal(v.props.children, '全场');
  assert.ok(!hasClass(RangeGrid({ grid: c.rangeGrid }), 'rgrid-all'));
});

test('a whole-field skill (纯烬艾雅法拉 S3 "攻击范围扩大至整个战场") reaches the card as such', async () => {
  await data.loadAll('chess', 'garrisons', 'assets', 'bonds', 'items');
  const id = 'chess_char_6_20_a';
  const h = makeBattle({ units: [{ chessId: id, row: 10, col: 5, dir: 'RIGHT', skillIndex: 2 }], autoFinish: false, timeLimit: 30 });
  const u = h.unit(id);
  h.step();
  assert.ok(u.skill.activate('test', { free: true }));
  h.step();
  const live = { ...unitStatsEntry(u, u._s), src: 'battle' };
  assert.ok(live.range.length >= FIELD_WIDE_CELLS);
  const stats = ChessDetail({ chess: data.lookup('chess', id), piece: null, editable: false, bonds: [], loadout: null, live }).find((b) => b.key === 'stats');
  assert.ok([...walk(stats)].some((n) => hasClass(n, 'rgrid-all')), '全场');
});

test('the game screen hands the card the live entry it already reads (battle runner / m.unitStats)', () => {
  const src = readFileSync(path.join(ROOT, 'public/js/ui/detailPanel.js'), 'utf8');
  assert.match(src, /grid=\$\{cardRangeGrid\(live, fr, c\)\}/);
  const game = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
  assert.match(game, /battleRunner\.unitStats\(uid, fid\)/);
});

test('远牙 S3 光羽箭 (default, "攻击范围改为前方无限长的直线"): the 21-tile line is drawn whole, in the box\'s own space', async () => {
  await data.loadAll('chess', 'garrisons', 'assets', 'bonds', 'items');
  const id = 'chess_char_4_20_a';
  const h = makeBattle({ units: [{ chessId: id, row: 10, col: 0, dir: 'RIGHT', skillIndex: 2 }], autoFinish: false, timeLimit: 30 });
  const u = h.unit(id);
  h.step();
  assert.ok(u.skill.activate('test', { free: true }));
  h.step();
  const live = { ...unitStatsEntry(u, u._s), src: 'battle' };
  const box = rangeGridBox(live.range);
  assert.equal(box.cols, 21);
  assert.equal(box.rows, 1);
  const stats = ChessDetail({ chess: data.lookup('chess', id), piece: null, editable: false, bonds: [], loadout: null, live }).find((b) => b.key === 'stats');
  const grid = [...walk(stats)].find((n) => hasClass(n, 'rgrid'));
  assert.ok(grid, 'drawn, not named');
  assert.equal(onCells(stats), 21, 'the whole line, her own tile included');
  assert.match(grid.props.style, /--rg:max\(1px, min\(\.14rem, calc\(\(6 \* \.14rem \+ 10px\) \/ 21\)/, 'cells shrunk to the 6-column width');
  assert.match(grid.props.style, /gap:0/);
});

test('rangeGridStyle: the attack ranges of the records keep the .14rem cells; only a grid beyond RANGE_FIT (6 columns, 7 rows) shrinks them', async () => {
  await data.loadAll('chess');
  const plain = (b) => rangeGridStyle(b) === `grid-template-columns:repeat(${b.cols}, var(--rg))`;
  assert.deepEqual(RANGE_FIT, { cols: 6, rows: 7 });
  // every attack range a record gives the card (the unit's own, a module's) — the widest 灰毫 / 协律 / 阿罗玛 (6 columns)
  let n = 0;
  for (const c of data.list('chess')) {
    const grids = [c.rangeGrid, ...(c.modules || []).flatMap((m) => (m.talentChanges || []).map((t) => t.rangeGrid))];
    for (const g of grids) if (Array.isArray(g) && g.length) { n++; assert.ok(plain(rangeGridBox(g)), `${c.name}: ${rangeGridBox(g).cols} cols`); }
  }
  assert.ok(n > 250, `record grids (${n})`);
  // the tallest live skill range (银灰 S3 真银斩 3-7: 7 rows × 4 columns) too
  assert.ok(plain(rangeGridBox(data.lookup('chess', 'chess_char_4_22_a').skills[2].rangeGrid)), '银灰 S3');
  assert.ok(!plain({ cols: 7, rows: 1 }) && !plain({ cols: 1, rows: 8 }));
  assert.match(rangeGridStyle({ cols: 3, rows: 9 }), /calc\(\(7 \* \.14rem \+ 12px\) \/ 9\)/, 'a tall grid fits the 7 rows');
});
