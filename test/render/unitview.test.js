// test/render/unitview.test.js — render/units.js UnitView and render/textures.js caches against a headless fake PIXI
// (test/render/fakepixi.js): tier chips (tokens have no tier), fallback-portrait allocation (no throw-away
// placeholder canvases, nothing built when the Spine model is already there), and the per-mount texture helpers
// (mountain silhouette, tier-chip redraw) that must not allocate a new canvas each time.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';

let fake, UnitView, T;
before(async () => {
  fake = installFakePixi();
  ({ UnitView } = await import('../../public/js/render/units.js'));
  T = await import('../../public/js/render/textures.js');
});
after(() => fake.restore());

const tick = () => new Promise((r) => setImmediate(r));
const cam = () => presetCamera('prep', { width: 1280, height: 720 });
const diamonds = () => fake.canvases.filter((c) => c.width === 160 && c.height === 160);

/** Asset store stub: avatar image + (optionally) a Spine model, both resolved asynchronously. */
function store({ image = true, spine = false, imageDelay = 0 } = {}) {
  const img = { width: 180, height: 180 };
  const entry = { skel: '/s/x.skel', atlas: '/s/x.atlas', textures: ['/s/x.png'], anims: { idle: 'Idle' }, animations: { Idle: 1 } };
  return {
    picture: (id) => (id ? `/pic/${id}.png` : null),
    image: (u) => new Promise((r) => (imageDelay ? setTimeout(() => r(image ? img : null), imageDelay) : r(image ? img : null))),
    spineEntry: () => (spine ? entry : null),
    spine: { acquire: async () => ({ animations: [{ name: 'Idle' }] }), release() {} },
  };
}

function view(info, opts = {}, assets = store()) {
  const ctx = fakeViewCtx(fake.P, { assets, cam: cam });
  return new UnitView(ctx, { id: 1, side: 'ally', kind: 'chess', defId: 'char_x', tier: 3, x: 5, y: 12, maxHp: 1000, ...info }, opts);
}

describe('tier chips', () => {
  test('summon tokens in the hand show no tier chip (tokens have no tier)', async () => {
    const v = view({ kind: 'token', defId: 'token_10028_vigil_wolf', avatar: 'token_10028_vigil_wolf' }, { prep: true });
    for (let i = 0; i < 3; i++) v.update(1 / 60, cam(), i / 60);
    assert.ok(!v.chip || !v.chip.visible, 'no chip on a token');
  });

  test('operators keep their chip in prep and in battle; enemies never have one', () => {
    const p = view({ kind: 'chess', tier: 4 }, { prep: true });
    p.update(1 / 60, cam(), 0);
    assert.ok(p.chip && p.chip.visible);
    const b = view({ kind: 'chess', tier: 2 });
    b.update(1 / 60, cam(), 0);
    assert.ok(b.chip && b.chip.visible);
    const e = view({ side: 'enemy', kind: 'enemy', defId: 'enemy_1007_slime' });
    e.update(1 / 60, cam(), 0);
    assert.equal(e.chip, null);
  });
});

describe('fallback portraits (avatar diamonds)', () => {
  test('an avatar that loads builds one diamond — no image-less placeholder first', async () => {
    const before = diamonds().length;
    const v = view({ defId: 'char_a', avatar: 'char_a' });
    v.update(1 / 60, cam(), 0);
    await tick(); await tick();
    v.update(1 / 60, cam(), 1 / 60);
    assert.equal(diamonds().length - before, 1, 'one 160×160 canvas');
    assert.notEqual(v.fallback.texture, fake.P.Texture.EMPTY, 'the diamond shows');
  });

  test('a unit whose Spine model is ready before its first frame builds no diamond at all', async () => {
    const before = diamonds().length;
    const v = view({ defId: 'char_b', avatar: 'char_b' }, {}, store({ spine: true }));
    await tick(); await tick();
    assert.ok(v.spineReady, 'spine ready');
    for (let i = 0; i < 30; i++) v.update(1 / 60, cam(), i / 60);
    assert.equal(diamonds().length - before, 0);
  });

  test('a missing avatar falls back to the procedural placeholder (once)', async () => {
    const before = diamonds().length;
    const v = view({ defId: 'char_c', avatar: 'char_c' }, {}, store({ image: false }));
    await tick(); await tick();
    for (let i = 0; i < 3; i++) v.update(1 / 60, cam(), i / 60);
    assert.equal(diamonds().length - before, 1);
    assert.notEqual(v.fallback.texture, fake.P.Texture.EMPTY);
  });

  test('a slow avatar shows the placeholder meanwhile, then the picture', async () => {
    const before = diamonds().length;
    let release;
    const gate = new Promise((r) => { release = r; });
    const assets = { ...store(), image: () => gate };
    const v = view({ defId: 'char_d', avatar: 'char_d' }, {}, assets);
    v.update(1 / 60, cam(), 0);
    assert.equal(diamonds().length - before, 0, 'nothing built while the avatar may still arrive quickly');
    const t0 = Date.now();
    while (v.fallback.texture === fake.P.Texture.EMPTY && Date.now() - t0 < 5000) { await new Promise((r) => setTimeout(r, 40)); v.update(1 / 60, cam(), 0); }
    assert.ok(Date.now() - t0 >= 300, 'placeholder only after the wait');
    assert.notEqual(v.fallback.texture, fake.P.Texture.EMPTY, 'placeholder while waiting');
    release({ width: 180, height: 180 });
    await tick(); await tick();
    v.update(1 / 60, cam(), 0);
    assert.equal(diamonds().length - before, 2, 'placeholder + picture');
  });

  test('two views of the same unit share the cached diamond', async () => {
    const a = view({ defId: 'char_e', avatar: 'char_e' });
    a.update(1 / 60, cam(), 0);
    await tick(); await tick();
    a.update(1 / 60, cam(), 0);
    const before = diamonds().length;
    const b = view({ defId: 'char_e', avatar: 'char_e' });
    b.update(1 / 60, cam(), 0);
    await tick(); await tick();
    b.update(1 / 60, cam(), 0);
    assert.equal(diamonds().length, before);
    assert.equal(a.fallback.texture, b.fallback.texture);
  });
});

describe('diamond cache', () => {
  test('bounded LRU; eviction never destroys a texture a view may still show', () => {
    const first = T.diamondTexture('lru_0', null, 0xffffff);
    for (let i = 1; i < 400; i++) {
      T.diamondTexture(`lru_${i}`, null, 0xffffff);
      if (i % 50 === 0) assert.equal(T.diamondTexture('lru_0', null, 0xffffff), first, 'recently used stays cached');
    }
    assert.ok(!first.destroyed && !first.baseTexture.destroyed);
    const n0 = diamonds().length;
    T.diamondTexture('lru_1', null, 0xffffff);
    assert.equal(diamonds().length, n0 + 1, 'the least recently used ones were evicted');
  });
});

describe('per-mount textures', () => {
  test('silhouetteTexture is cached per image (the field view builds it on every mount)', () => {
    const img = { width: 1024, height: 236 };
    const n0 = fake.canvases.length;
    const t1 = T.silhouetteTexture(img);
    const t2 = T.silhouetteTexture(img);
    assert.equal(t1, t2);
    assert.equal(fake.canvases.length - n0, 1);
    assert.notEqual(T.silhouetteTexture({ width: 512, height: 100 }), t1);
  });

  test('refreshTierChips redraws the chip atlas in place (no new canvas, chips handed out stay valid)', () => {
    const chip = T.tierChip(3, false);
    const n0 = fake.canvases.length;
    const b0 = fake.baseTextures.length;
    for (let i = 0; i < 5; i++) T.refreshTierChips();
    const again = T.tierChip(3, false);
    assert.equal(fake.canvases.length, n0, 'no new canvas');
    assert.equal(fake.baseTextures.length, b0, 'no new base texture');
    assert.equal(again.baseTexture, chip.baseTexture);
    assert.ok(!chip.destroyed && !chip.baseTexture.destroyed);
  });
});

describe('field view teardown (app.js releaseGl)', () => {
  test('drops the dead renderer’s GL copies of shared textures, buffers, geometries and cached programs', async () => {
    const { releaseGl } = await import('../../public/js/render/app.js');
    const UID = 7;
    const listeners = [];
    const mkBt = () => ({ _glTextures: { [UID]: { texture: {} }, 3: { texture: {} } } });
    const shared = [mkBt(), mkBt()];
    const deleted = [];
    const ts = {
      managedTextures: shared.slice(),
      destroyTexture(bt, skipRemove) {
        deleted.push(bt);
        delete bt._glTextures[UID];
        listeners.push('off');
        if (!skipRemove) this.managedTextures.splice(this.managedTextures.indexOf(bt), 1);
      },
    };
    const disposed = [];
    const sys = (name) => ({ disposeAll(lost) { disposed.push([name, lost]); } });
    const prog = { glPrograms: { [UID]: { program: 'p7' }, 3: { program: 'p3' } } };
    const gl = { deleted: [], deleteProgram(p) { this.deleted.push(p); } };
    const prevPixi = globalThis.PIXI;
    globalThis.PIXI = { ...prevPixi, utils: { ...(prevPixi?.utils || {}), ProgramCache: { src: prog } } };
    try {
      releaseGl({ CONTEXT_UID: UID, gl, texture: ts, geometry: sys('geometry'), buffer: sys('buffer'), framebuffer: sys('framebuffer') });
    } finally { globalThis.PIXI = prevPixi; }
    assert.deepEqual(deleted, shared);
    assert.equal(ts.managedTextures.length, 0);
    for (const bt of shared) assert.deepEqual(Object.keys(bt._glTextures), ['3'], 'other contexts untouched');
    assert.deepEqual(disposed.map((d) => d[0]).sort(), ['buffer', 'framebuffer', 'geometry']);
    assert.ok(disposed.every((d) => d[1] === false));
    assert.deepEqual(Object.keys(prog.glPrograms), ['3']);
    assert.deepEqual(gl.deleted, ['p7']);
    assert.doesNotThrow(() => releaseGl(null));
    assert.doesNotThrow(() => releaseGl({}));
  });
});

// user playtest #3 item 7: the body as drawn, for render/pick.js (the shared picking rule)
describe('pickShape / bounds / hitTest', () => {
  test('the avatar diamond until the Spine model shows, then the chibi at its own measured height', async () => {
    const v = view({ defId: 'char_p1', avatar: 'char_p1' }, { prep: true }, store({ spine: true, imageDelay: 50 }));
    v.update(1 / 60, cam(), 0);
    assert.equal(v.pickShape().kind, 'diamond', 'no model yet');
    await tick(); await tick();
    assert.ok(v.spineReady);
    // the posed skeleton's bounds: 425.6 units above the feet = 1.33 tiles (UNIT.modelScale 1/320)
    v.actor.spine.getLocalBounds = () => ({ x: -60, y: -425.6, width: 120, height: 430 });
    v.update(1 / 60, cam(), 1 / 60);
    const b = v.pickShape();
    assert.equal(b.kind, 'chibi');
    assert.ok(Math.abs(b.h - 1.33) < 1e-6, `measured height ${b.h}`);
    assert.equal(b.w, 1, 'operators: the measured width profile');
    assert.equal(b.x, v.screen.x); assert.equal(b.y, v.screen.y); assert.equal(b.s, v.screen.s);
    assert.equal(b.depth, v.root.zIndex);
    // measured once: a later pose (a raised weapon) does not move the outline
    v.actor.spine.getLocalBounds = () => ({ x: -60, y: -700, width: 120, height: 700 });
    v.update(1 / 60, cam(), 2 / 60);
    assert.ok(Math.abs(v.pickShape().h - 1.33) < 1e-6);
    // the outline tops out at the model; the tier chip (prep) is part of the pick shape, not of bounds()
    const r = v.bounds();
    assert.ok(Math.abs(r.y - (v.screen.y - 1.33 * v.screen.s)) < 1, 'bounds top = model top');
    assert.ok(Math.abs(r.y + r.height - (v.screen.y + 0.08 * v.screen.s)) < 1, 'bounds bottom = just below the feet');
    assert.ok(b.hud && b.hud.y1 < v.screen.y - v.screen.s, 'the chip is up at the head (UNIT.headroom)');
    assert.ok(v.hitTest(v.screen.x, v.screen.y - 0.5 * v.screen.s), 'the torso');
    assert.ok(!v.hitTest(v.screen.x + 0.6 * v.screen.s, v.screen.y - 0.5 * v.screen.s), 'beside it');
    // a new model (Front ⇄ Back swap, _dropActor) is measured again
    v._dropActor();
    assert.equal(v._bodyH, null);
  });

  test('implausible skeleton bounds are clamped; enemies scale their width with their size', async () => {
    const op = view({ defId: 'char_p2', avatar: 'char_p2' }, { prep: true }, store({ spine: true }));
    await tick(); await tick();
    op.actor.spine.getLocalBounds = () => ({ x: -500, y: -1200, width: 1000, height: 1200 }); // an effect in the idle pose
    op.update(1 / 60, cam(), 0);
    assert.equal(op.pickShape().h, 1.55, 'operators ≤ 1.55 tiles');
    const foe = view({ side: 'enemy', kind: 'enemy', defId: 'enemy_big' }, {}, store({ spine: true }));
    await tick(); await tick();
    foe.actor.spine.getLocalBounds = () => ({ x: -300, y: -640, width: 600, height: 640 });
    foe.update(1 / 60, cam(), 0);
    const b = foe.pickShape();
    assert.ok(Math.abs(b.h - 2) < 1e-6);
    assert.ok(Math.abs(b.w - 2 / 1.2) < 1e-6, 'width factor from the height');
    assert.equal(b.hud, null, 'an undamaged enemy shows no bar');
  });

  test('a battle unit\'s bars are its HUD rect; a dead unit is not hit', async () => {
    const v = view({ defId: 'char_p3', avatar: 'char_p3' }, {}, store({ spine: true }));
    await tick(); await tick();
    v.sync({ x: 5, y: 12, hp: 500, maxHp: 1000, sp: 3, spMax: 10, flags: 0, anim: 0, vx: 0 });
    v.update(1 / 60, cam(), 0);
    const hud = v.pickShape().hud;
    assert.ok(hud && hud.x1 > hud.x0 && hud.y1 > hud.y0, 'HP / SP bars and chip');
    assert.ok(hud.y1 < v.screen.y - v.screen.s, 'above the head');
    v.die();
    assert.equal(v.hitTest(v.screen.x, v.screen.y - 0.5 * v.screen.s), false);
  });

  test('item plates: floating above the slot; centred on the pointer while dragged (lifted)', async () => {
    const { ItemView } = await import('../../public/js/render/units.js');
    const ctx = fakeViewCtx(fake.P, { assets: store(), cam });
    const it = new ItemView(ctx, { id: 'p:9', uid: 9, defId: 'item_x', x: 3, y: 7 });
    it.setWorld(3, 7, 0.16);
    it.update(1 / 60, cam(), 0);
    let b = it.pickShape();
    assert.equal(b.kind, 'plate');
    assert.ok(Math.abs(b.y - (it.screen.y - 0.31 * it.screen.s)) < 1e-6, 'resting: the plate above its anchor');
    it.lift = 0.3;
    it.update(1 / 60, cam(), 0);
    b = it.pickShape();
    const g = cam().project(3, 7, 0.16);
    assert.ok(Math.abs(b.x - g.x) < 1e-6 && Math.abs(b.y - g.y) < 1e-6, 'dragged: centred on its ground point (the pointer)');
    assert.equal(it.plate.anchor.y, 0.5);
    assert.ok(it.hitTest(g.x, g.y));
  });
});

describe('enemy preview pen figures (lod idle)', () => {
  /** A UnitView of a pen figure with a Spine model, an impostor atlas (full or not) and a counting renderer. */
  async function penFigure(full) {
    let frame = 0;
    const renders = [];
    const atlas = {
      alloc: (w, h) => (full ? null : { w, h, tex: new fake.P.Texture(), clip: false }),
      free() {}, park(o) { o.visible = false; }, unpark(o) { o.visible = true; }, draw() {},
    };
    const ctx = fakeViewCtx(fake.P, {
      assets: store({ spine: true }), cam, frameNo: () => frame, impostors: atlas,
      renderer: { resolution: 1, render: (obj, o) => renders.push(o?.renderTexture || null) },
    });
    const v = new UnitView(ctx, { id: 'e:0', side: 'enemy', kind: 'enemy', defId: 'enemy_1007_slime', tier: 1, x: 9, y: 15, maxHp: 1, facing: -1 }, { prep: true, lod: 'idle' });
    await tick(); await tick();
    assert.ok(v.spineReady, 'spine ready');
    let steps = 0;
    const upd = v.actor.update.bind(v.actor);
    v.actor.update = (dt) => { steps++; return upd(dt); };
    const step = () => { v.update(1 / 60, cam(), frame / 60); frame++; };
    return { v, step, renders, steps: () => steps };
  }

  test('with room in the shared atlas: an impostor refreshed every 3rd frame, never a private render target', async () => {
    const { v, step, renders, steps } = await penFigure(false);
    for (let i = 0; i < 30; i++) step();
    assert.ok(v.imp && v.imp.slot, 'atlas slot');
    assert.equal(renders.length, 0, 'drawn by the atlas flush, no per-figure render call');
    assert.ok(steps() <= 12, `idle loop stepped ≈ every 3rd frame (${steps()} of 30)`);
  });
});
