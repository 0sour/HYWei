// test/render/pick.test.js — render/pick.js, the one picking rule of every "which unit is under the pointer" path
// (user playtest #3 item 7: "clicking an operator often selects the one a row below it; equipment too"), checked on the
// geometry of the official cameras (render/projection.js presetCamera: prep / battle at 1920×1080 and 1280×720): a unit
// B standing directly behind a unit A (same column, adjacent rows; B on the same height or on a raised tile).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { presetCamera } from '../../public/js/render/projection.js';
import { pickBody, hitBody, coreDistance, bodyBounds, bodyParts, BODY_H, probeCandidates, PROBE_MARGIN } from '../../public/js/render/pick.js';
import { unitDepthKey } from '../../public/js/render/units.js';

const COL = 4;
/** A / B bodies on a camera: A at row 9 (height zA), B at row 10 (height zB), model heights hA / hB. */
function pair(kind, W, H, { zA = 0, zB = 0, hA = BODY_H, hB = BODY_H } = {}) {
  const cam = presetCamera(kind, { width: W, height: H });
  const body = (key, row, z, h) => { const p = cam.project(COL, row, z); return { key, x: p.x, y: p.y, s: p.s, h, flip: 1, depth: unitDepthKey(cam, COL, row), tile: { row, col: COL } }; };
  const A = body('A', 9, zA, hA), B = body('B', 10, zB, hB);
  const heights = new Map([[`9,${COL}`, zA], [`10,${COL}`, zB]]);
  // the tile under a screen point, raised tops first (render/projection.js pickTile semantics)
  const ground = (x, y) => {
    for (const hz of [...new Set([zA, zB, 0])].sort((a, b) => b - a)) {
      const g = cam.unproject(x, y, hz);
      if (!g) continue;
      const t = { row: Math.round(g.y), col: Math.round(g.x) };
      if (hz === 0 || Math.abs((heights.get(`${t.row},${t.col}`) || 0) - hz) < 1e-6) return t;
    }
    return null;
  };
  /** Who a press `up` tiles above the feet of `u` (and `dx` tiles to the side) picks. */
  const at = (u, up, dx = 0, bodies = [A, B]) => { const x = u.x + dx * u.s, y = u.y - up * u.s; return pickBody(bodies, x, y, ground(x, y))?.key ?? null; };
  return { cam, A, B, at, rowGap: (A.y - B.y) / A.s };
}

const CAMS = [['prep', 1920, 1080], ['prep', 1280, 720], ['normal', 1920, 1080], ['normal', 1280, 720]];

describe('pickBody on the official cameras: B directly behind A', () => {
  for (const [kind, W, H] of CAMS) {
    test(`${kind} ${W}×${H}, same height: B's head / face / torso / legs / tile beside A are B's; A's face, torso and feet are A's`, () => {
      const { at, A, B, rowGap } = pair(kind, W, H);
      assert.ok(rowGap > 0.8 && rowGap < 0.95, `rows ${rowGap.toFixed(2)} of a tile apart on screen (test premise)`);
      assert.ok(BODY_H > rowGap, 'a chibi is taller than a row: A covers B\'s feet (test premise)');
      for (const up of [1.2, 0.86, 0.6, 0.45, 0.3]) assert.equal(at(B, up), 'B', `B ${up} tile above its feet`);
      for (const dx of [-0.4, 0.4]) assert.equal(at(B, 0, dx), 'B', `B's tile beside A's head (${dx})`);
      for (const up of [0.86, 0.6, 0.3, 0.05, -0.1]) assert.equal(at(A, up), 'A', `A ${up} tile above its feet`);
      // the feet of B are drawn behind A's face: that press is A's (nothing of B shows there)
      assert.equal(at(B, 0), 'A');
      // A's hair crown over B's legs / tile goes to B; with nobody behind it is A's
      assert.equal(at(A, 1.2), 'B');
      assert.equal(at(A, 1.2, 0, [A]), 'A');
      assert.equal(at(A, 0.86, 0, [A]), 'A');
    });

    test(`${kind} ${W}×${H}, B on a raised tile (ranged high ground behind a melee lane): B's feet are B's too`, () => {
      const { at, B, A } = pair(kind, W, H, { zB: 0.42 });
      for (const up of [1.2, 0.86, 0.45, 0.2, 0]) assert.equal(at(B, up), 'B', `B ${up} tile above its feet`);
      for (const up of [0.86, 0.45, 0.05]) assert.equal(at(A, up), 'A', `A ${up} tile above its feet`);
    });
  }

  test('the old rule would have picked A for most of B\'s lower half (the playtest report)', () => {
    // the pre-fix hit box: 0.7 tile wide, 1.18 tiles above the feet + 0.1 below, front-most wins
    const { A, B } = pair('prep', 1920, 1080);
    const box = (u, x, y) => Math.abs(x - u.x) <= 0.35 * u.s && y >= u.y - 1.18 * u.s && y <= u.y + 0.1 * u.s;
    const old = (x, y) => (box(A, x, y) ? 'A' : box(B, x, y) ? 'B' : null);
    let wrong = 0;
    for (const up of [0.3, 0.2, 0.1, 0]) for (const dx of [-0.3, 0, 0.3]) if (old(B.x + dx * B.s, B.y - up * B.s) === 'A') wrong++;
    assert.ok(wrong >= 6, `old rule: ${wrong}/12 presses on B's lower body / feet went to A`);
  });
});

describe('pickBody rule details', () => {
  const cam = presetCamera('prep', { width: 1920, height: 1080 });
  const at = (row, col, extra = {}) => { const p = cam.project(col, row, 0); return { x: p.x, y: p.y, s: p.s, h: BODY_H, depth: unitDepthKey(cam, col, row), tile: { row, col }, ...extra }; };

  test('off every body, the unit standing on the pressed tile is picked; an empty tile picks nothing', () => {
    const U = { key: 'U', ...at(10, 6) };
    const tile = cam.project(6, 10, 0);
    // the tile's corner, well away from the body
    const cx = tile.x + 0.45 * tile.s, cy = tile.y + 0.3 * tile.s;
    assert.equal(hitBody(U, cx, cy), 0, 'premise: not on the body');
    assert.equal(pickBody([U], cx, cy, { row: 10, col: 6 }), U);
    assert.equal(pickBody([U], cx, cy, { row: 10, col: 7 }), null);
    assert.equal(pickBody([U], cx, cy, null), null);
  });

  test('side by side (same row): each unit keeps its own body, weapon edges go by the tile', () => {
    const L = { key: 'L', ...at(10, 5) }, R = { key: 'R', ...at(10, 6) };
    for (const u of [L, R]) for (const up of [0.9, 0.5, 0.15]) assert.equal(pickBody([L, R], u.x, u.y - up * u.s, u.tile), u);
    const mid = (L.x + R.x) / 2;
    assert.equal(pickBody([L, R], mid - 2, L.y - 0.3 * L.s, { row: 10, col: 5 }), L);
    assert.equal(pickBody([L, R], mid + 2, L.y - 0.3 * L.s, { row: 10, col: 6 }), R);
  });

  test('a moving unit (no tile, e.g. an enemy walking in front) is picked by its body only, front-most on cores', () => {
    const op = { key: 'op', ...at(10, 5) };
    const foe = { key: 'foe', ...at(9, 5), tile: null, w: 1.1, h: 1.3 };
    assert.equal(pickBody([op, foe], foe.x, foe.y - 0.5 * foe.s, { row: 9, col: 5 }), foe, 'its torso');
    assert.equal(pickBody([op, foe], op.x, op.y - 0.6 * op.s, { row: 10, col: 5 }), op, 'the operator above it');
    // off its body on the tile it walks over: nothing stands there
    assert.equal(pickBody([foe], foe.x + 0.48 * foe.s, foe.y + 0.35 * foe.s, { row: 9, col: 5 }), null);
  });

  test('the HUD (tier chip / bars) is an outline: its own unit when nothing else is there, never over a torso', () => {
    const B = { key: 'B', ...at(10, 5) }, C = { key: 'C', ...at(11, 5) };
    const chipY = B.y - 1.3 * B.s;
    B.hud = { x0: B.x - 12, y0: chipY - 12, x1: B.x + 12, y1: chipY + 12 };
    assert.equal(pickBody([B], B.x, chipY, null), B, 'alone: the chip is its unit\'s');
    assert.equal(hitBody(C, B.x, chipY), 2, 'premise: C\'s legs are behind B\'s chip');
    assert.equal(pickBody([B, C], B.x, chipY, { row: 11, col: 5 }), C);
  });

  test('model height, width factor and facing shape the outline', () => {
    const tall = { ...at(10, 5), h: 1.45 }, short = { ...at(10, 5), h: 1.1 };
    const topOf = (b) => bodyBounds(b).y;
    assert.ok(topOf(tall) < topOf(short), 'taller model → higher outline');
    assert.ok(Math.abs(topOf(tall) - (tall.y - 1.45 * tall.s)) < 1, 'the outline tops out at the model height');
    const big = { ...at(10, 5), h: 2.4, w: 2 };
    assert.ok(bodyBounds(big).width > 1.9 * bodyBounds(short).width, 'enemies scale with their size');
    const right = bodyParts({ ...at(10, 5), flip: 1 }).outline[1].rect, left = bodyParts({ ...at(10, 5), flip: -1 }).outline[1].rect;
    const x = at(10, 5).x;
    assert.ok(x - right.x0 > right.x1 - x && left.x1 - x > x - left.x0, 'the back side (hair, capes) is the wider one');
  });

  test('avatar diamonds and item plates', () => {
    const d = { kind: 'diamond', ...at(10, 5), d: 0.78 };
    const centre = d.y - (0.08 + 0.39) * d.s;
    assert.equal(hitBody(d, d.x, centre), 2);
    assert.equal(hitBody(d, d.x + 0.33 * d.s, centre), 1, 'near its tip');
    assert.equal(hitBody(d, d.x + 0.45 * d.s, centre), 0);
    const plate = { kind: 'plate', x: 500, y: 300, s: 100, r: 0.31 };
    assert.equal(hitBody(plate, 500, 300), 2);
    assert.equal(hitBody(plate, 528, 300), 1);
    assert.equal(hitBody(plate, 540, 300), 0);
    assert.deepEqual(bodyBounds(plate), { x: 469, y: 269, width: 62, height: 62 });
    assert.equal(coreDistance(plate, 500, 300), 0);
    assert.ok(Math.abs(coreDistance(plate, 541.7, 300) - 0.2) < 1e-6, 'px to the core / px per tile');
  });

  test('junk input picks nothing', () => {
    const U = { key: 'U', ...at(10, 5) };
    assert.equal(pickBody([U], NaN, 3), null);
    assert.equal(pickBody(null, 3, 3), null);
    assert.equal(pickBody([null, { x: 1, y: 1, s: 0 }, { x: NaN, y: 1, s: 5 }], 1, 1, { row: 1, col: 1 }), null);
    assert.equal(hitBody(null, 0, 0), 0);
  });
});

// Review of item 7: measured against the rendered pixels of the mock match (every drawn unit pixel of the prep board at
// 1920×1080), the shape rule alone put ~8 % of the presses on the wrong unit — mostly the unit BEHIND: the hair crown
// and the sides (arms, clothes, weapons) of the unit in front lie over the legs / tile of the one behind. The pixel
// probe (render/app.js drawnAt) settles every overlap by what is really drawn on top.
describe('pickBody with the pixel probe', () => {
  const { A, B, cam } = pair('prep', 1920, 1080);
  const ground = (x, y) => { const g = cam.unproject(x, y, 0); return g ? { row: Math.round(g.y), col: Math.round(g.x) } : null; };
  /** A probe that says which bodies draw the point (and records who was asked, in order). */
  const probeOf = (drawing, calls = []) => (b) => { calls.push(b.key); return drawing.includes(b.key); };

  test('A\'s hair crown drawn over B\'s torso: A (the shape rule alone says B)', () => {
    const x = A.x, y = A.y - 1.2 * A.s;
    assert.equal(pickBody([A, B], x, y, ground(x, y))?.key, 'B', 'premise: the rule gives it to B');
    const calls = [];
    assert.equal(pickBody([A, B], x, y, ground(x, y), probeOf(['A', 'B'], calls))?.key, 'A');
    assert.deepEqual(calls, ['A'], 'front-most first; stops at the first that draws');
  });

  test('B\'s legs showing beside A\'s head: B', () => {
    const x = B.x + 0.3 * B.s, y = B.y - 0.3 * B.s;
    assert.equal(pickBody([A, B], x, y, ground(x, y), probeOf(['B']))?.key, 'B');
  });

  test('A\'s arm over the tile of B, outside B\'s outline: A (a single candidate the rule did not pick)', () => {
    // a point on B's tile in front of B's feet, beside A's body: the rule picks B (standing on the pressed tile)
    const t = cam.project(COL, 10, 0);
    const x = t.x + 0.45 * t.s, y = t.y + 0.3 * t.s;
    assert.equal(ground(x, y)?.row, 10, 'premise: B\'s tile');
    assert.equal(pickBody([A, B], x, y, ground(x, y))?.key, 'B');
    const cand = probeCandidates([A, B], x, y);
    if (cand.length === 1) assert.equal(cand[0].key, 'A');
    assert.equal(pickBody([A, B], x, y, ground(x, y), probeOf(['A']))?.key, 'A');
    // nothing drawn there: the rule (B's tile)
    assert.equal(pickBody([A, B], x, y, ground(x, y), probeOf([]))?.key, 'B');
  });

  test('the probe is only asked where it can change the answer; null / throwing → the shape rule', () => {
    const lone = { ...A, key: 'L' };
    const calls = [];
    assert.equal(pickBody([lone], lone.x, lone.y - 0.5 * lone.s, null, probeOf([], calls))?.key, 'L');
    assert.deepEqual(calls, [], 'one body that the rule picks: no probe');
    assert.equal(pickBody([lone], lone.x + 5 * lone.s, lone.y, null, probeOf([], calls)), null);
    assert.deepEqual(calls, [], 'no body around: no probe');
    const x = A.x, y = A.y - 1.2 * A.s;
    assert.equal(pickBody([A, B], x, y, ground(x, y), () => null)?.key, 'B', 'cannot tell → the rule');
    assert.equal(pickBody([A, B], x, y, ground(x, y), () => { throw new Error('lost context'); })?.key, 'B');
    // the one in front cannot tell: the rule decides (never a unit behind an unknown one)
    assert.equal(pickBody([A, B], x, y, ground(x, y), (b) => (b.key === 'A' ? null : true))?.key, 'B');
    assert.equal(pickBody([A, B], x, y, ground(x, y), (b) => (b.key === 'A' ? null : true)), pickBody([A, B], x, y, ground(x, y)));
  });

  test('probe candidates: bodies whose outline + PROBE_MARGIN holds the point, front-most first', () => {
    const r = bodyBounds({ ...A, hud: null });
    assert.deepEqual(probeCandidates([B, A], A.x, A.y - 0.9 * A.s).map((b) => b.key), ['A', 'B']);
    assert.deepEqual(probeCandidates([A], r.x - (PROBE_MARGIN - 0.05) * A.s, A.y - 0.5 * A.s).map((b) => b.key), ['A']);
    assert.deepEqual(probeCandidates([A], r.x - (PROBE_MARGIN + 0.05) * A.s, A.y - 0.5 * A.s), []);
    assert.deepEqual(probeCandidates([null, { x: NaN, y: 0, s: 1 }], 0, 0), []);
  });
});
