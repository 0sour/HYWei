// test/render/feedback1d-bombd.test.js — community report D4 after 0.1.0 ("敌方无人机暴鸰的炸弹无法正常投放"), client side:
// 暴鸰's skeleton (enemy_1040_bombd) carries its bomb (slot Bottle) in Idle / Move_Loop / Die and has bomb-less twins
// (Idle_2 / Move_Begin_2 / Move_Loop_2 / Move_End_2 / Die_2: Bottle null) — the official battle prefab switches to them
// after the drop (mode S1, buff bomb_s, replaceAnimPairs Move→Move_2, Idle→Idle_2, Die→Die_2). The view kept the
// bottle under the drone for good and no bomb ever left it. Now: the sim's fx 'phase' { kind: 'bombed' } switches the
// view to those clips (render/units.js FORMS) with no fx of its own, and the drop's 'atk' kind 'droneBomb' flies a
// falling bomb (render/style.js PROJ.droneBomb, the sim's PROJECTILE_SPEEDS.droneBomb) from the drone to the target.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { ANIM } from '../../shared/constants.js';
import { PROJ } from '../../public/js/render/style.js';
import { PROJECTILE_SPEEDS } from '../../server/sim/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const KEY = 'enemy_1040_bombd';

let fake, UnitView, FORMS, FX;
before(async () => {
  fake = installFakePixi();
  ({ UnitView, FORMS } = await import('../../public/js/render/units.js'));
  FX = await import('../../public/js/render/fx.js');
});
after(() => fake.restore());

const tick = () => new Promise((r) => setImmediate(r));
const cam = () => presetCamera('normal', { width: 1280, height: 720 });
function store(id) {
  const entry = assets.enemies[id].spine;
  const names = Object.keys(entry.animations || {});
  return { picture: () => null, image: async () => null, spineEntry: () => entry, spine: { acquire: async () => ({ animations: names.map((name) => ({ name })) }), release() {} } };
}
const sample = (anim = 0) => ({ x: 6, y: 10, hp: 4000, maxHp: 4000, sp: 0, spMax: 0, flags: 0, anim, vx: -0.3 });

describe('D4 暴鸰: the drone lets go of its bomb on screen', () => {
  test('the bomb-less clip set exists in the skeleton the manifest lists', () => {
    const f = FORMS[KEY]?.bombed;
    assert.ok(f, 'FORMS.enemy_1040_bombd.bombed');
    const anims = assets.enemies[KEY].spine.animations;
    for (const name of [f.roles.idle, f.roles.deploy, f.roles.die, f.roles.move.begin, f.roles.move.loop, f.roles.move.end]) assert.ok(name in anims, name);
    assert.ok(!f.change, 'no change clip: the drop itself is the Attack clip (its OnAttack releases the bomb)');
    assert.equal(assets.enemies[KEY].spine.anims.move.loop, 'Move_Loop', 'carrying the bomb until then');
  });

  test('after the drop the drone flies and dies on the *_2 clips; a view built later starts bomb-less', async () => {
    const ctx = fakeViewCtx(fake.P, { assets: store(KEY), cam });
    const v = new UnitView(ctx, { id: 5, side: 'enemy', kind: 'enemy', defId: KEY, spine: KEY, tier: 2, x: 6, y: 10, maxHp: 4000, motion: 'FLY' });
    await tick(); await tick();
    v.sync(sample(ANIM.MOVE), 1);
    assert.equal(v.actor.current, 'Move_Loop', 'the bomb under the drone');
    v.setForm('bombed');
    v.sync(sample(ANIM.MOVE), 2);
    assert.equal(v.actor.current, 'Move_Loop_2', 'no bomb any more');
    v.sync(sample(ANIM.IDLE), 3);
    assert.equal(v.actor.current, 'Idle_2');
    v.die();
    assert.equal(v.actor.current, 'Die_2');
    const w = new UnitView(ctx, { id: 6, side: 'enemy', kind: 'enemy', defId: KEY, spine: KEY, tier: 2, x: 6, y: 10, maxHp: 4000, motion: 'FLY', form: 'bombed' });
    await tick(); await tick();
    w.sync(sample(ANIM.MOVE), 1);
    assert.equal(w.actor.current, 'Move_Loop_2');
  });

  test('the drop plays the Attack clip once at its own speed (its OnAttack on the event), then the bomb-less flight', async () => {
    // the client's lookupDef: the drone's data BAT 5 s (it never attacks normally; its attack rhythm used to drive the drop)
    const ctx = fakeViewCtx(fake.P, { assets: store(KEY), cam, lookupDef: () => ({ stats: { bat: 5, aspd: 100 } }) });
    const v = new UnitView(ctx, { id: 5, side: 'enemy', kind: 'enemy', defId: KEY, spine: KEY, tier: 2, x: 6, y: 10, maxHp: 4000, motion: 'FLY' });
    await tick(); await tick();
    const frames = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) v.update(dt, cam(), i * dt); };
    v.sync(sample(ANIM.MOVE), 1);
    assert.equal(v.actor.current, 'Move_Loop');
    // the 'atk' droneBomb is 0.2 game s ahead in the buffer: the clip winds up to its OnAttack (0.267 s)
    assert.ok(v.windUp(0.2, 'droneBomb'), 'wound up');
    assert.equal(v.actor.current, 'Attack');
    frames(12);                                       // 0.2 s: the event is rendered
    v.onAttack({ x: 5, y: 10 }, 1.2, 'droneBomb');
    v.setForm('bombed');
    v.sync(sample(ANIM.MOVE), 1.2);
    assert.equal(v.actor.current, 'Attack', 'the release frame');
    frames(50);                                       // the rest of the 1 s clip at speed 1 (0.733 s) and a little
    assert.equal(v.actor.current, 'Move_Loop_2', 'back to flying, without the bomb (not a 5 s attack rhythm from its BAT)');
    assert.equal(v.atkInterval, 5, 'a one-off drop leaves the attack rhythm alone');
  });

  test('the drop draws a falling bomb at the sim\'s speed and the mode change draws nothing of its own', () => {
    assert.ok(PROJ.droneBomb, 'PROJ.droneBomb');
    assert.equal(PROJ.droneBomb.speed, PROJECTILE_SPEEDS.droneBomb);
    assert.equal(PROJ.droneBomb.look, 'shell', 'a bomb with a ground shadow, exploding where it lands');
    assert.equal(FX.fxSpec('phase', { kind: 'bombed', id: 5 }).a, 'none');
    assert.notEqual(FX.fxSpec('phase', { kind: 'crawl', id: 5 }).a, 'none', '掠海漂移体 keeps its puff');
  });
});
