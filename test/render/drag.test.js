// test/render/drag.test.js — drop target resolution and the pointer state machine (no DOM, fake timers).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GEO } from '../../shared/constants.js';
import { tileSlot, pieceSlot, pieceTile, resolveDrop, isLegal, sameSlot, createDragController } from '../../public/js/render/drag.js';

describe('slots & targets', () => {
  test('tileSlot classifies hand, temp, board and everything else', () => {
    assert.deepEqual(tileSlot({ row: 7, col: 0 }), { area: 'hand', idx: 0 });
    assert.deepEqual(tileSlot({ row: 7, col: 9 }), { area: 'hand', idx: 9 });
    assert.equal(tileSlot({ row: 7, col: 10 }), null);
    assert.deepEqual(tileSlot({ row: 8, col: 4 }), { area: 'temp', idx: 0 });
    assert.deepEqual(tileSlot({ row: 8, col: 8 }), { area: 'temp', idx: 4 });
    assert.equal(tileSlot({ row: 8, col: 3 }), null);
    assert.deepEqual(tileSlot({ row: 9, col: 2 }), { area: 'board', row: 9, col: 2 });
    assert.deepEqual(tileSlot({ row: 12, col: 10 }), { area: 'board', row: 12, col: 10 });
    assert.equal(tileSlot({ row: 12, col: 11 }), null, 'partner half is not ours');
    assert.equal(tileSlot({ row: 9, col: 1 }), null);
    assert.equal(tileSlot({ row: 13, col: 5 }), null);
    assert.equal(tileSlot({ row: 3, col: 5 }), null, 'boss field is not a prep target');
    assert.equal(tileSlot(null), null);
    assert.equal(tileSlot({ row: 9.5, col: 3 }), null);
  });

  test('pieceSlot / pieceTile for hand, temp, board', () => {
    assert.deepEqual(pieceSlot({ uid: 1, area: 'hand', idx: 3 }), { area: 'hand', idx: 3 });
    assert.deepEqual(pieceTile({ uid: 1, area: 'hand', idx: 3 }), { row: GEO.HAND_ROW, col: 3 });
    assert.deepEqual(pieceSlot({ uid: 1, area: 'temp', idx: 2 }), { area: 'temp', idx: 2 });
    assert.deepEqual(pieceTile({ uid: 1, area: 'temp', idx: 2 }), { row: GEO.TEMP_ROW, col: GEO.TEMP_C0 + 2 });
    assert.deepEqual(pieceSlot({ uid: 1, area: 'board', row: 10, col: 4 }), { area: 'board', row: 10, col: 4 });
    assert.deepEqual(pieceTile({ uid: 1, row: 10, col: 4 }), { row: 10, col: 4 });
    assert.equal(pieceSlot(null), null);
    assert.equal(pieceTile({ uid: 1 }), null);
    assert.ok(sameSlot({ area: 'hand', idx: 1 }, { area: 'hand', idx: 1 }));
    assert.ok(!sameSlot({ area: 'hand', idx: 1 }, { area: 'board', row: 1, col: 1 }));
  });

  test('resolveDrop: board, hand, outside, cancel cases', () => {
    const piece = { uid: 5, area: 'hand', idx: 2 };
    const from = pieceSlot(piece);
    const base = { piece, from, overCanvas: true, clientX: 10, clientY: 20 };
    assert.deepEqual(resolveDrop({ ...base, tile: { row: 10, col: 5 } }), { kind: 'drop', target: { area: 'board', row: 10, col: 5 } });
    assert.deepEqual(resolveDrop({ ...base, tile: { row: 7, col: 6 } }), { kind: 'drop', target: { area: 'hand', idx: 6 } });
    assert.equal(resolveDrop({ ...base, tile: { row: 7, col: 2 } }).reason, 'same');
    assert.equal(resolveDrop({ ...base, tile: { row: 8, col: 5 } }).reason, 'temp');
    assert.equal(resolveDrop({ ...base, tile: { row: 15, col: 9 } }).reason, 'notTarget');
    assert.deepEqual(resolveDrop({ ...base, tile: null }), { kind: 'drop', target: { area: 'outside', clientX: 10, clientY: 20 } });
    assert.deepEqual(resolveDrop({ ...base, tile: { row: 10, col: 5 }, overCanvas: false }).target.area, 'outside');
    const canPlace = (p, r, c) => !(r === 10 && c === 5);
    assert.equal(resolveDrop({ ...base, tile: { row: 10, col: 5 }, canPlace }).reason, 'illegal');
    assert.equal(resolveDrop({ ...base, tile: { row: 10, col: 6 }, canPlace }).kind, 'drop');
    // hand targets ask canPlace with (HAND_ROW, idx)
    const seen = [];
    resolveDrop({ ...base, tile: { row: 7, col: 8 }, canPlace: (p, r, c, t) => { seen.push([r, c, t.area]); return true; } });
    assert.deepEqual(seen, [[GEO.HAND_ROW, 8, 'hand']]);
  });

  test('isLegal: throwing callback ⇒ illegal; no callback ⇒ legal; temp/outside never', () => {
    assert.equal(isLegal(() => { throw new Error('x'); }, {}, { area: 'board', row: 9, col: 3 }), false);
    assert.equal(isLegal(null, {}, { area: 'board', row: 9, col: 3 }), true);
    assert.equal(isLegal(null, {}, { area: 'temp', idx: 0 }), false);
    assert.equal(isLegal(null, {}, null), false);
  });
});

/** Harness: pieces at canvas points, tiles from a simple 100px grid (col = x/100, row = 12 - y/100). */
function harness(opts = {}) {
  const events = [];
  const timers = new Map();
  let nextTimer = 1;
  const pieces = opts.pieces || [
    { uid: 1, area: 'hand', idx: 0, x: 50, y: 550 },     // tile (7,0)
    { uid: 2, area: 'board', row: 10, col: 4, x: 450, y: 250 },
    { uid: 3, area: 'hand', idx: 1, x: 150, y: 550, draggable: false },
  ];
  const c = createDragController({
    hitPiece: (x, y) => pieces.find((p) => Math.abs(p.x - x) < 40 && Math.abs(p.y - y) < 40) || null,
    pickTile: (x, y) => (x < 0 || y < 0 || x >= 2100 ? null : { row: 12 - Math.floor(y / 100), col: Math.floor(x / 100) }),
    dropPoint: opts.dropPoint,
    isOverCanvas: (cx, cy) => !(opts.domCover && cy > 900),
    canPlace: opts.canPlace,
    emit: (name, p) => events.push([name, p]),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const ev = (type, x, y, extra = {}) => c[type]({ pointerId: 1, pointerType: 'mouse', button: 0, x, y, clientX: x, clientY: y, ...extra });
  const fire = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } };
  const names = () => events.map((e) => e[0]).filter((n) => n !== 'pieceDragMove' && n !== 'tileHover');
  return { c, events, ev, fire, names, timers };
}

describe('drag controller', () => {
  test('click without movement emits pieceClick (not a drag)', () => {
    const h = harness();
    h.c.setEditable(true);
    h.ev('pointerDown', 50, 550);
    h.ev('pointerMove', 52, 551);
    h.ev('pointerUp', 52, 551);
    assert.deepEqual(h.names(), ['pieceClick']);
    assert.equal(h.events[0][1].uid, 1);
    assert.equal(h.events[0][1].detail, false);
  });

  test('drag hand → board emits start, moves, drop with board target, end', () => {
    const h = harness();
    h.c.setEditable(true);
    h.ev('pointerDown', 50, 550);
    h.ev('pointerMove', 70, 540);
    assert.ok(h.c.dragging);
    h.ev('pointerMove', 350, 250);
    h.ev('pointerUp', 350, 250);
    assert.deepEqual(h.names(), ['pieceDragStart', 'pieceDrop', 'pieceDragEnd']);
    const drop = h.events.find((e) => e[0] === 'pieceDrop')[1];
    assert.deepEqual(drop.target, { area: 'board', row: 10, col: 3 });
    assert.deepEqual(drop.from, { area: 'hand', idx: 0 });
    const moves = h.events.filter((e) => e[0] === 'pieceDragMove');
    assert.ok(moves.length >= 2);
    assert.equal(moves[moves.length - 1][1].legal, true);
    assert.ok(h.events.some((e) => e[0] === 'tileHover' && e[1] && e[1].row === 10 && e[1].col === 3));
    assert.equal(h.c.dragging, false);
  });

  test('illegal tile (canPlace false) cancels; legality shown during the move', () => {
    const h = harness({ canPlace: (p, r, c) => c !== 3 });
    h.c.setEditable(true);
    h.ev('pointerDown', 50, 550);
    h.ev('pointerMove', 350, 250);
    const mv = h.events.filter((e) => e[0] === 'pieceDragMove').pop()[1];
    assert.equal(mv.legal, false);
    assert.deepEqual(mv.target, { area: 'board', row: 10, col: 3 });
    h.ev('pointerUp', 350, 250);
    assert.deepEqual(h.names(), ['pieceDragStart', 'pieceDragEnd']);
    assert.equal(h.events.pop()[1].cancelled, true);
  });

  test('release over DOM covering the canvas ⇒ outside target with client coords', () => {
    const h = harness({ domCover: true });
    h.c.setEditable(true);
    h.ev('pointerDown', 450, 250);
    h.ev('pointerMove', 470, 950);
    h.ev('pointerUp', 470, 950);
    const drop = h.events.find((e) => e[0] === 'pieceDrop')[1];
    assert.deepEqual(drop.target, { area: 'outside', clientX: 470, clientY: 950 });
    assert.deepEqual(drop.from, { area: 'board', row: 10, col: 4 });
  });

  test('not editable: press+move does not drag; release gives no click; hover still works', () => {
    const h = harness();
    h.ev('pointerDown', 50, 550);
    h.ev('pointerMove', 300, 300);
    h.ev('pointerUp', 300, 300);
    assert.deepEqual(h.names(), []);
    h.ev('pointerMove', 450, 250);
    assert.deepEqual(h.names(), ['pieceHover']);
    assert.equal(h.events.find((e) => e[0] === 'pieceHover')[1].uid, 2);
    h.ev('pointerMove', 1000, 250);
    assert.equal(h.events.filter((e) => e[0] === 'pieceHover').pop()[1].uid, null);
  });

  test('non-draggable pieces never start a drag', () => {
    const h = harness();
    h.c.setEditable(true);
    h.ev('pointerDown', 150, 550);
    h.ev('pointerMove', 400, 300);
    h.ev('pointerUp', 400, 300);
    assert.deepEqual(h.names(), []);
  });

  test('right click ⇒ pieceClick(detail) + pieceDetail, no drag', () => {
    const h = harness();
    h.c.setEditable(true);
    h.ev('pointerDown', 450, 250, { button: 2 });
    assert.deepEqual(h.names(), ['pieceClick', 'pieceDetail']);
    assert.equal(h.events[0][1].detail, true);
    h.ev('pointerMove', 600, 300);
    assert.equal(h.c.dragging, false);
  });

  test('touch long-press ⇒ detail; the later release is not a click', () => {
    const h = harness();
    h.c.setEditable(true);
    h.ev('pointerDown', 450, 250, { pointerType: 'touch' });
    h.fire();
    h.ev('pointerUp', 450, 250, { pointerType: 'touch' });
    assert.deepEqual(h.names(), ['pieceClick', 'pieceDetail']);
    assert.equal(h.events[0][1].detail, true);
  });

  test('touch drag cancels the long-press timer and uses a larger threshold', () => {
    const h = harness();
    h.c.setEditable(true);
    h.ev('pointerDown', 450, 250, { pointerType: 'touch' });
    h.ev('pointerMove', 457, 250, { pointerType: 'touch' });
    assert.equal(h.c.dragging, false, 'below touch threshold');
    h.ev('pointerMove', 470, 250, { pointerType: 'touch' });
    assert.equal(h.c.dragging, true);
    assert.equal(h.timers.size, 0, 'long-press timer cleared');
    h.ev('pointerUp', 550, 350, { pointerType: 'touch' });
    assert.deepEqual(h.events.find((e) => e[0] === 'pieceDrop')[1].target, { area: 'board', row: 9, col: 5 });
  });

  test('setEditable(false) during a drag cancels it; pointerCancel cancels; other pointers ignored', () => {
    const h = harness();
    h.c.setEditable(true);
    h.ev('pointerDown', 50, 550);
    h.ev('pointerMove', 300, 300);
    h.c.setEditable(false);
    assert.equal(h.c.dragging, false);
    assert.deepEqual(h.names(), ['pieceDragStart', 'pieceDragEnd']);
    h.c.setEditable(true);
    h.ev('pointerDown', 50, 550);
    h.ev('pointerMove', 300, 300, { pointerId: 2 });
    assert.equal(h.c.dragging, false, 'second pointer ignored');
    h.ev('pointerMove', 300, 300);
    h.c.pointerCancel({ pointerId: 1 });
    assert.equal(h.c.dragging, false);
    assert.equal(h.events.filter((e) => e[0] === 'pieceDrop').length, 0);
  });

  // user playtest #3 item 7: the drop target is the tile under the dragged ghost's feet (render/app.js dropPoint: the
  // pointer for a mouse, a little above the finger for touch) — the hover tile, legality, the ghost and the drop agree
  test('dropPoint: target, tileHover, legality and the drop follow the ghost\'s feet; default = the pointer', () => {
    const calls = [];
    const h = harness({
      dropPoint: (e, piece) => { calls.push([e.pointerType, piece.uid]); return e.pointerType === 'touch' ? { x: e.x, y: e.y - 100 } : null; },
      canPlace: (p, r) => r !== 11,
    });
    h.c.setEditable(true);
    // mouse: the hook returns nothing → the pointer itself
    h.ev('pointerDown', 50, 550);
    h.ev('pointerMove', 350, 250);
    let mv = h.events.filter((e) => e[0] === 'pieceDragMove').pop()[1];
    assert.deepEqual([mv.hx, mv.hy, mv.target], [350, 250, { area: 'board', row: 10, col: 3 }]);
    h.ev('pointerUp', 350, 250);
    assert.deepEqual(h.events.find((e) => e[0] === 'pieceDrop')[1].target, { area: 'board', row: 10, col: 3 });
    // touch: the ghost (and the target) one row above the finger
    h.events.length = 0;
    h.ev('pointerDown', 50, 550, { pointerType: 'touch' });
    h.ev('pointerMove', 450, 350, { pointerType: 'touch' });
    mv = h.events.filter((e) => e[0] === 'pieceDragMove').pop()[1];
    assert.deepEqual([mv.x, mv.y, mv.hx, mv.hy], [450, 350, 450, 250], 'pointer and drop point both reported');
    assert.deepEqual(mv.target, { area: 'board', row: 10, col: 4 });
    assert.equal(mv.legal, true);
    assert.ok(h.events.some((e) => e[0] === 'tileHover' && e[1] && e[1].row === 10 && e[1].col === 4), 'tileHover = the target');
    h.ev('pointerMove', 450, 250, { pointerType: 'touch' });
    assert.equal(h.events.filter((e) => e[0] === 'pieceDragMove').pop()[1].legal, false, 'row 11 under the ghost: illegal');
    h.ev('pointerUp', 450, 350, { pointerType: 'touch' });
    assert.deepEqual(h.events.find((e) => e[0] === 'pieceDrop')[1].target, { area: 'board', row: 10, col: 4 });
    assert.ok(calls.every(([, uid]) => uid === 1) && calls.some(([t]) => t === 'touch'));
  });

  // the view may skip its pixel probe on hover picks (a readback per mouse move stalls on the GPU): the controller says
  // which calls are hovers — mouse moves without a press, drag moves — and which must be exact: presses and releases
  test('hitPiece / dropPoint tell hovers from presses and releases', () => {
    const hits = [];
    const drops = [];
    const pieces = [{ uid: 1, area: 'hand', idx: 0, x: 50, y: 550 }];
    const c = createDragController({
      hitPiece: (x, y, hover) => { hits.push(hover === true); return pieces.find((p) => Math.abs(p.x - x) < 40 && Math.abs(p.y - y) < 40) || null; },
      pickTile: (x, y) => ({ row: 12 - Math.floor(y / 100), col: Math.floor(x / 100) }),
      dropPoint: (e, piece, final) => { drops.push(final === true); return null; },
      emit: () => {},
    });
    const ev = (type, x, y) => c[type]({ pointerId: 1, pointerType: 'mouse', button: 0, x, y, clientX: x, clientY: y });
    c.setEditable(true);
    ev('pointerMove', 50, 550);
    assert.deepEqual(hits, [true], 'a mouse move without a press is a hover');
    ev('pointerDown', 50, 550);
    assert.deepEqual(hits, [true, false], 'a press probes');
    ev('pointerMove', 350, 250);
    ev('pointerMove', 360, 250);
    ev('pointerUp', 360, 250);
    assert.ok(drops.length >= 3);
    assert.ok(drops.slice(0, -1).every((f) => f === false), 'drag moves are hovers');
    assert.equal(drops[drops.length - 1], true, 'the release is final');
  });

  // review of item 7: on a phone the bench is the lowest canvas row and the shop bar (DOM) sits right under it — a
  // touch ghost lifted onto the bench has the finger on the shop bar. DOM cover is judged at the drop point.
  test('dropPoint: DOM cover is tested at the ghost\'s feet, not at the finger (touch onto the bench above the shop bar)', () => {
    const h = harness({ domCover: true, dropPoint: (e) => (e.pointerType === 'touch' ? { x: e.x, y: e.y - 400 } : null) });
    h.c.setEditable(true);
    // board unit (10,4) dragged by touch; the finger ends on the covered strip (y > 900), its ghost on bench slot 2
    h.ev('pointerDown', 450, 250, { pointerType: 'touch' });
    h.ev('pointerMove', 250, 950, { pointerType: 'touch' });
    const mv = h.events.filter((e) => e[0] === 'pieceDragMove').pop()[1];
    assert.deepEqual(mv.target, { area: 'hand', idx: 2 });
    assert.equal(mv.legal, true);
    h.ev('pointerUp', 250, 950, { pointerType: 'touch' });
    assert.deepEqual(h.events.find((e) => e[0] === 'pieceDrop')[1].target, { area: 'hand', idx: 2 });
    // the ghost itself under the DOM: outside (the piece goes back), as for a mouse released on the DOM
    h.events.length = 0;
    h.ev('pointerDown', 450, 250, { pointerType: 'touch' });
    h.ev('pointerMove', 250, 1350, { pointerType: 'touch' });
    assert.equal(h.events.filter((e) => e[0] === 'pieceDragMove').pop()[1].target, null);
    h.ev('pointerUp', 250, 1350, { pointerType: 'touch' });
    assert.equal(h.events.find((e) => e[0] === 'pieceDrop')[1].target.area, 'outside');
  });

  test('a throwing listener or hit-test never breaks the controller', () => {
    const c = createDragController({
      hitPiece: () => { throw new Error('boom'); },
      pickTile: () => { throw new Error('boom'); },
      emit: () => { throw new Error('listener'); },
    });
    c.setEditable(true);
    const orig = console.error; console.error = () => {};
    try {
      assert.equal(c.pointerDown({ pointerId: 1, x: 1, y: 1, button: 0 }), false);
      c.pointerMove({ pointerId: 1, x: 5, y: 5 });
      c.pointerUp({ pointerId: 1, x: 5, y: 5 });
      c.pointerLeave({});
      c.reset();
    } finally { console.error = orig; }
  });
});
