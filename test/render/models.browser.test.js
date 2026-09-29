// test/render/models.browser.test.js — user playtest #3 items 1 and 7 in headless Chrome, through the in-match mock
// (public/dev/game-mock.html: the real game screen, a mock server behind net.request):
//   1  operator models never go missing: after a battle that outlasts the Spine LRU grace, the battle → prep switch
//      (every battle view destroyed, the prep views built in the same task) used to unload the bench models and hand
//      the doomed skeletons straight back (PIXI.Assets serves an unloading asset from its loader cache): invisible
//      chibis. Also a burst of rapid drags / swaps / direction-wheel previews and commits / cancels / re-drags. After
//      each: every prep piece has a view, visible, on its tile, drawing a live Spine model (textures alive) — and the
//      canvas pixels over it change when it is hidden (it really draws something).
//   7  picking: with an operator directly behind another (same column), presses on its head / torso / legs, on its
//      feet where they show and on its tile beside the front one's head select IT; the front one's face selects the
//      front one — in prep and in battle; equipment dropped on the body of the one behind equips it; a dragged unit's
//      ghost stands on the pointer and the drop (direction wheel) is that tile. Every press on a drawn unit pixel (the
//      whole prep board and a battle) picks the front-most unit drawn there (render/pick.js pixel probe).
//
// Opt-in (starts Chrome): RENDER_E2E=1 node --test test/render/models.browser.test.js
// Chrome path: $CHROME_PATH or the macOS default. Screenshots → test/e2e/out/models-*.png.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.RENDER_E2E === '1' && existsSync(CHROME) && existsSync(path.join(ROOT, 'public/assets'));
const skip = enabled ? false : 'set RENDER_E2E=1 (needs Chrome and downloaded assets)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page-side helpers (installed once per page): the prep pieces, their views, the invariants of item 1. */
function installHelpers() {
  const G = { HAND_ROW: 7, TEMP_ROW: 8, TEMP_C0: 4 };
  const raw = () => globalThis.__SP_VIEW__.raw;
  const priv = () => globalThis.__MOCK__.store.get().match.private;
  const texOk = (t) => !!t && !t.destroyed && !!t.baseTexture && !t.baseTexture.destroyed && t.baseTexture.valid !== false;
  window.__t = {
    pieces() {
      const p = priv(), out = [];
      (p.board || []).forEach((x) => x && out.push({ uid: x.uid, kind: x.kind, row: x.row, col: x.col }));
      (p.hand || []).forEach((x, i) => x && out.push({ uid: x.uid, kind: x.kind, row: G.HAND_ROW, col: i }));
      (p.temp || []).forEach((x, i) => x && out.push({ uid: x.uid, kind: x.kind, row: G.TEMP_ROW, col: G.TEMP_C0 + i }));
      return out;
    },
    /** Client point `up` tiles above the feet of a view (+ `dx` tiles aside); views keyed 'p:uid' (prep) or unit id. */
    at(key, up, dx = 0) {
      const R = raw(), v = R.debug.views.get(key), cv = R.debug.app.view.getBoundingClientRect();
      return { x: cv.left + v.screen.x + dx * v.screen.s, y: cv.top + v.screen.y - up * v.screen.s };
    },
    /** Item 1 invariants; returns the problems found. */
    check() {
      const R = raw(), problems = [];
      for (const p of this.pieces()) {
        const v = R.debug.views.get('p:' + p.uid), tag = `${p.uid}@${p.row},${p.col}`;
        if (!v || v.destroyed) { problems.push(`${tag}: no view`); continue; }
        if (!v.root.visible || !(v.root.alpha > 0.9)) problems.push(`${tag}: hidden (${v.root.visible}, ${v.root.alpha})`);
        if (Math.abs(v.x - p.col) > 0.05 || Math.abs(v.y - p.row) > 0.05) problems.push(`${tag}: parked at ${v.x.toFixed(2)},${v.y.toFixed(2)}`);
        if (p.kind === 'item') continue;
        if (!v.actor || !v.spineReady) { problems.push(`${tag}: no Spine model`); continue; }
        let dead = 0, n = 0;
        for (const slot of v.actor.spine.skeleton.slots) { const s = slot.currentSprite || slot.currentMesh; if (!s || !s.texture) continue; n++; if (!texOk(s.texture)) dead++; }
        if (dead) problems.push(`${tag}: ${dead}/${n} textures destroyed`);
        if (v.imp) { if (!texOk(v.imp.sprite.texture)) problems.push(`${tag}: impostor texture destroyed`); }
        else if (v.actor.spine.parent !== v.body || !v.actor.spine.visible || !(v.actor.spine.alpha > 0.9)) problems.push(`${tag}: model not shown`);
      }
      return problems;
    },
    /** Share of the pixels over each unit's body that change when the unit is hidden (≈ 0: nothing drawn). */
    drawn() {
      const R = raw(), app = R.debug.app, rd = app.renderer, gl = rd.gl, res = rd.resolution, H = rd.view.height, out = {};
      for (const p of this.pieces()) {
        if (p.kind === 'item') continue;
        const v = R.debug.views.get('p:' + p.uid);
        if (!v) continue;
        const b = v.bounds();
        const x0 = Math.max(0, Math.floor(b.x * res)), y0 = Math.max(0, Math.floor(b.y * res));
        const w = Math.max(1, Math.min(Math.floor(b.width * res), rd.view.width - x0)), h = Math.max(1, Math.min(Math.floor(b.height * res), H - y0));
        const read = () => { R.debug.ctx.impostors?.flush?.(); rd.render(app.stage); const px = new Uint8Array(w * h * 4); gl.readPixels(x0, H - y0 - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
        const a = read();
        v.root.visible = false;
        const c = read();
        v.root.visible = true;
        let diff = 0;
        for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - c[i]) + Math.abs(a[i + 1] - c[i + 1]) + Math.abs(a[i + 2] - c[i + 2]) + Math.abs(a[i + 3] - c[i + 3]) > 40) diff++;
        out[p.uid] = diff / (w * h);
      }
      return out;
    },
  };
}

describe('user playtest #3 items 1 and 7 (mock match, headless Chrome)', { skip }, () => {
  let srv, browser;
  before(async () => {
    const require = createRequire(path.join(ROOT, 'package.json'));
    const puppeteer = require('puppeteer-core');
    const { startServer } = await import('../../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--force-device-scale-factor=1'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  async function open(query, w = 1920, h = 1080) {
    const page = await browser.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.setViewport({ width: w, height: h });
    await page.goto(`http://127.0.0.1:${srv.port}/dev/game-mock.html?shot=1&render=engine&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)') && !!globalThis.__SP_VIEW__?.raw?.debug, { timeout: 30000 });
    await page.evaluate(installHelpers);
    await sleep(2000); // Spine models
    return { page, problems };
  }
  const setPhase = (page, ph) => page.evaluate(async (p) => { const { PHASE } = await import('/shared/constants.js'); globalThis.__MOCK__.setPhase(PHASE[p]); }, ph);
  const uidAt = (page, row, col) => page.evaluate((r, c) => globalThis.__MOCK__.S().priv.board.find((p) => p.row === r && p.col === c)?.uid ?? null, row, col);
  const assertAllDrawn = async (page, label) => {
    assert.deepEqual(await page.evaluate(() => window.__t.check()), [], `${label}: every prep model alive and in place`);
    const drawn = await page.evaluate(() => window.__t.drawn());
    for (const [uid, frac] of Object.entries(drawn)) assert.ok(frac > 0.05, `${label}: unit ${uid} draws pixels (${frac.toFixed(3)})`);
  };

  test('1: the prep models come back alive after a battle that outlasts the Spine LRU grace', async () => {
    const { page, problems } = await open('phase=PREP');
    await assertAllDrawn(page, 'first prep');
    // a short grace stands in for a long battle (default 15 s)
    await page.evaluate(async () => { const { assets } = await import('/js/assets.js'); assets.spine.cache.idleGrace = 400; });
    for (let round = 0; round < 2; round++) {
      await setPhase(page, 'COMBAT');
      await sleep(2000);
      await setPhase(page, 'PREP');
      await sleep(2500);
      await assertAllDrawn(page, `prep after battle ${round + 1}`);
    }
    const st = await page.evaluate(async () => (await import('/js/assets.js')).assets.spine.stats());
    assert.equal(st.unloading, 0);
    await page.screenshot({ path: path.join(OUT, 'models-after-battles.png') });
    await page.close();
    assert.deepEqual(problems, []);
  });

  test('1: rapid drags, swaps, wheel previews (all four directions) with commit / Esc / ✕ and re-drags keep every model', async () => {
    const { page, problems } = await open('phase=PREP', 1600, 900);
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const tiles = await page.evaluate(() => { const st = globalThis.__MOCK__.S().stage; return [...st.deployTiles.normal.melee, ...st.deployTiles.normal.rangedOnly]; });
    const drag = async (from, to) => {
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
      await page.mouse.up();
    };
    const wheel = async (how) => {
      const g = await page.evaluate(() => { const el = document.querySelector('.fwheel__dia'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height / 2 }; });
      if (!g) return;
      if (how === 'esc') { await page.keyboard.press('Escape'); return; }
      if (how === 'x') { await page.click('.fwheel__cancel').catch(() => {}); return; }
      await page.mouse.move(g.x, g.y); await page.mouse.down();
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) await page.mouse.move(g.x + dx * g.h * 0.6, g.y + dy * g.h * 0.6, { steps: 3 });
      if (how === 'up') await page.mouse.move(g.x, g.y - g.h * 0.6, { steps: 2 });
      await page.mouse.up();
    };
    for (let burst = 0; burst < 2; burst++) {
      for (let k = 0; k < 16; k++) {
        const units = (await page.evaluate(() => window.__t.pieces())).filter((p) => p.kind !== 'item');
        const p = units[Math.floor(rnd() * units.length)];
        const [row, col] = rnd() < 0.8 ? tiles[Math.floor(rnd() * tiles.length)] : [7, Math.floor(rnd() * 10)];
        const from = await page.evaluate((u) => window.__t.at('p:' + u, 0.5), p.uid);
        const to = await page.evaluate((r, c) => globalThis.__SP_VIEW__.raw.tileScreen(r, c), row, col);
        await drag(from, to);
        await sleep(40 + rnd() * 80);
        await wheel(['up', 'up', 'left', 'esc', 'x'][Math.floor(rnd() * 5)]);
        await sleep(rnd() < 0.5 ? 20 : 300); // re-drag before the mock server answered, or after
      }
      await page.keyboard.press('Escape');
      await sleep(1800);
      await assertAllDrawn(page, `burst ${burst + 1}`);
    }
    await page.close();
    assert.deepEqual(problems, []);
  });

  test('7: picking an operator standing directly behind another — prep and battle; equipment on the one behind', async () => {
    const { page, problems } = await open('phase=PREP');
    // col 4: row 9 (ground) · rows 10–12 (high ground) — a ranged operator behind a melee one, and two on the same height
    const [a9, b10, c11] = [await uidAt(page, 9, 4), await uidAt(page, 10, 4), await uidAt(page, 11, 4)];
    assert.ok(a9 && b10 && c11, 'mock premise: three operators in one column');
    const clicks = async (keyOf, idOf, cases) => {
      await page.evaluate(() => { window.__picked = []; window.__offPick?.(); window.__offPick = globalThis.__SP_VIEW__.raw.on('pieceClick', (e) => window.__picked.push(e.uid)); });
      for (const [label, key, up, dx, want] of cases) {
        const pt = await page.evaluate((k, u, d) => window.__t.at(k, u, d), keyOf(key), up, dx);
        await page.mouse.click(pt.x, pt.y);
        await sleep(120);
        const got = await page.evaluate(() => window.__picked.splice(0));
        assert.deepEqual(got.slice(-1), [idOf(want)], `${label}`);
        await page.keyboard.press('Escape');
        await sleep(60);
      }
    };
    const cases = [
      // [label, whose feet, tiles up, tiles aside, expected]
      ['raised B: face', b10, 0.86, 0, b10], ['raised B: torso', b10, 0.45, 0, b10], ['raised B: legs', b10, 0.22, 0, b10],
      // B's feet where they show (straight under B's centre, A's hair crown is drawn over them: that pixel is A's)
      ['raised B: feet', b10, 0.05, -0.12, b10],
      ['raised B: its tile beside A\'s head', b10, 0, 0.42, b10],
      ['A (in front): face', a9, 0.86, 0, a9], ['A: torso', a9, 0.45, 0, a9], ['A: feet', a9, 0.05, 0, a9],
      // (B's head and staff are drawn over the middle of C's lower torso and legs: those pixels are B's)
      ['same height C behind B: face', c11, 0.86, 0, c11], ['C: torso', c11, 0.62, 0, c11], ['C: legs beside B\'s head', c11, 0.4, -0.2, c11],
      ['C: its tile beside B\'s head', c11, 0, -0.42, c11], ['B in front of C: face', b10, 0.86, 0, b10],
    ];
    await clicks((u) => 'p:' + u, (u) => u, cases);
    // equipment: an item dropped on the torso of the one behind (C) equips C; one on A's face equips A
    const items = await page.evaluate(() => globalThis.__MOCK__.S().priv.hand.filter((x) => x && x.kind === 'item').map((x) => x.uid));
    for (const [target, up] of [[c11, 0.62], [a9, 0.86]]) {
      const it = items.shift();
      const from = await page.evaluate((u) => { const r = globalThis.__SP_VIEW__.pieceScreenRect(u); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, it);
      const to = await page.evaluate((u, k) => window.__t.at('p:' + u, k), target, up);
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10); await sleep(16); }
      await sleep(120);
      assert.equal(await page.evaluate(() => globalThis.__SP_VIEW__.raw.debug.dragHit?.over ?? null), target, 'the plate is over the target (pieceDragOver)');
      await page.mouse.up();
      await sleep(600);
      const eq = await page.evaluate((u) => globalThis.__MOCK__.S().priv.board.find((p) => p.uid === u).items.map((x) => x.uid), target);
      assert.ok(eq.includes(it), `item ${it} equipped on ${target} (got ${eq})`);
    }
    await page.screenshot({ path: path.join(OUT, 'models-pick-prep.png') });
    // battle: the same presses on the battle views (ids → piece uids)
    await setPhase(page, 'COMBAT');
    await sleep(2500);
    // …at a moment of the battle when the units stand at rest: a press takes whatever is DRAWN under it (pixel probe),
    // and the mock battle keeps every operator attacking (lunges, attack clips) and in random skill poses, which move
    // the drawn face / torso / legs off the aimed points (then the unit in front or behind rightly takes the press —
    // the pixel-truth test below covers moving poses). So the mock battle is stopped with one last snapshot that clears
    // the skill flags, and the presses wait until every ally is back in its idle pose.
    await page.evaluate(async () => {
      const { net } = await import('/js/net.js');
      const S = globalThis.__MOCK__.S();
      const last = await new Promise((resolve) => { const off = net.on('b.snap', (m) => { off(); resolve(m); }); });
      clearInterval(S.battle.timer);
      net._emit('b.snap', { ...last, gt: last.gt + 0.2, units: last.units.map((u) => { const c = u.slice(); c[7] = 0; return c; }) });
    });
    await page.waitForFunction(() => [...globalThis.__SP_VIEW__.raw.debug.views.values()]
      .filter((v) => v.info?.side === 'ally' && v.alive && v.actor)
      .every((v) => v.actor.mode === 'base' && !v.actor.skillOn && !(v.lunge > 0)), { timeout: 15000, polling: 100 });
    await sleep(300);
    const ids = await page.evaluate(() => { const out = {}; for (const [id, v] of globalThis.__SP_VIEW__.raw.debug.views) if (v.info?.uid != null) out[v.info.uid] = id; return out; });
    await clicks((u) => ids[u], (u) => u, cases.filter(([label]) => !label.includes('tile')));
    await page.screenshot({ path: path.join(OUT, 'models-pick-battle.png') });
    await page.close();
    assert.deepEqual(problems, []);
  });

  // review of item 7: the pick against what is really drawn. Every unit is rendered alone (its pixels = where its model
  // is opaque); the truth at a pixel is the front-most unit drawn there. Sampled over the whole prep board and a
  // battle: the shape rule alone got 7 % (battle 18 %) of these presses wrong, mostly giving the front unit's hair /
  // arms to the unit behind; the pixel probe settles every overlap.
  test('7: picks agree with the rendered pixels (prep and battle)', async () => {
    const { page, problems } = await open('phase=PREP');
    const measure = (phase) => page.evaluate((ph) => {
      const R = globalThis.__SP_VIEW__.raw, app = R.debug.app, rd = app.renderer, gl = rd.gl, res = rd.resolution;
      const keyOf = new Map([...R.debug.views].map(([k, v]) => [v, k]));
      const views = [...R.debug.views].filter(([k, v]) => v.pickShape && v.info && v.info.kind !== 'item' && v.info.kind !== 'device'
        && v.alive && v.spineReady && !v.culled && (ph === 'PREP' ? k.startsWith('p:') : true));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [, v] of views) { const s = v.screen.s; x0 = Math.min(x0, v.screen.x - s); x1 = Math.max(x1, v.screen.x + s); y0 = Math.min(y0, v.screen.y - 2 * s); y1 = Math.max(y1, v.screen.y + 0.3 * s); }
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(rd.view.width / res - 1, Math.ceil(x1)); y1 = Math.min(rd.view.height / res - 1, Math.ceil(y1));
      const w = Math.floor((x1 - x0) * res), h = Math.floor((y1 - y0) * res), H = rd.view.height;
      const all = [...R.debug.views.values()];
      const saved = all.map((v) => [v, v.root?.visible, v.hud?.visible, v.shadow?.visible]);
      for (const v of all) { if (v.hud) v.hud.visible = false; if (v.shadow) v.shadow.visible = false; if (v.root) v.root.visible = false; }
      const read = () => { R.debug.ctx.impostors?.flush?.(); rd.render(app.stage); const px = new Uint8Array(w * h * 4); gl.readPixels(Math.floor(x0 * res), H - Math.floor(y0 * res) - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
      const bg = read();
      const masks = [];
      for (const [k, v] of views) {
        v.root.visible = true; const a = read(); v.root.visible = false;
        const m = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) { const j = i * 4; if (a[j + 3] > 40 && Math.abs(a[j] - bg[j]) + Math.abs(a[j + 1] - bg[j + 1]) + Math.abs(a[j + 2] - bg[j + 2]) + Math.abs(a[j + 3] - bg[j + 3]) > 40) m[i] = 1; }
        masks.push({ k, m, z: v.root.zIndex });
      }
      for (const [v, a, b, c] of saved) { if (v.root) v.root.visible = a; if (v.hud) v.hud.visible = b; if (v.shadow) v.shadow.visible = c; }
      const pick = (x, y) => { if (ph === 'PREP') { const p = R.debug.pick.pieceAt(x, y); return p ? 'p:' + p.uid : null; } const v = R.debug.pick.battleUnitAt(x, y); return v ? keyOf.get(v) : null; };
      let n = 0, ok = 0, wrong = 0;
      for (let py = 0; py < h; py += 4) for (let px = 0; px < w; px += 4) {
        const i = (h - 1 - py) * w + px;
        let truth = null, tz = -Infinity;
        for (const mk of masks) if (mk.m[i] && mk.z > tz) { tz = mk.z; truth = mk.k; }
        if (!truth) continue;
        const got = pick(x0 + px / res, y0 + py / res);
        n++;
        if (got === truth) ok++; else if (got) wrong++;
      }
      return { units: views.length, n, ok: ok / n, wrong: wrong / n };
    }, phase);
    const prep = await measure('PREP');
    assert.ok(prep.units >= 10 && prep.n > 3000, `premise: a full prep board (${JSON.stringify(prep)})`);
    assert.ok(prep.ok > 0.95 && prep.wrong < 0.015, `prep: presses on a drawn unit pick it (${JSON.stringify(prep)})`);
    await setPhase(page, 'COMBAT');
    await sleep(3000);
    const battle = await measure('COMBAT');
    assert.ok(battle.units >= 10 && battle.n > 3000, `premise: a battle (${JSON.stringify(battle)})`);
    assert.ok(battle.ok > 0.93 && battle.wrong < 0.03, `battle: presses on a drawn unit pick it (${JSON.stringify(battle)})`);
    await page.close();
    assert.deepEqual(problems, []);
  });

  test('7: a dragged unit stands on the pointer; the drop and its direction wheel are that tile', async () => {
    const { page, problems } = await open('phase=PREP');
    const hand = await page.evaluate(() => globalThis.__MOCK__.S().priv.hand.find((x) => x && x.kind === 'chess').uid);
    const from = await page.evaluate((u) => window.__t.at('p:' + u, 0.5), hand);
    const to = await page.evaluate(() => globalThis.__SP_VIEW__.raw.tileScreen(9, 4)); // an occupied melee tile: a swap
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10); await sleep(16); }
    await sleep(150);
    const ghost = await page.evaluate((u) => { const v = globalThis.__SP_VIEW__.raw.debug.views.get('p:' + u); return { x: v.x, y: v.y, lift: v.lift }; }, hand);
    assert.ok(Math.abs(ghost.x - 4) < 0.06 && Math.abs(ghost.y - 9) < 0.06 && ghost.lift > 0, `the ghost stands on the pointer's tile (${ghost.x}, ${ghost.y})`);
    await page.screenshot({ path: path.join(OUT, 'models-drag-ghost.png') });
    await page.mouse.up();
    await page.waitForSelector('.fwheel__dia', { timeout: 3000 });
    const w = await page.evaluate(() => { const r = document.querySelector('.fwheel__dia').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    assert.ok(Math.hypot(w.x - to.x, w.y - to.y) < 2, 'the wheel opens on that tile');
    await page.keyboard.press('Escape');
    await page.close();
    assert.deepEqual(problems, []);
  });

  // review of item 7: a touch drag holds its ghost (and drop point) 0.6 tile above the finger. On a phone the bench is
  // the lowest canvas row with the shop bar right under it, so putting a unit back on the bench has the finger on the
  // shop bar: the drop is judged where the ghost is, not under the finger (it used to send the piece back).
  test('7: touch — a board unit dragged back onto a bench slot above the shop bar lands there (phone)', async () => {
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
    await page.goto(`http://127.0.0.1:${srv.port}/dev/game-mock.html?shot=1&render=engine&phase=PREP`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)') && !!globalThis.__SP_VIEW__?.raw?.debug, { timeout: 30000 });
    await page.evaluate(() => globalThis.__MOCK__.mutate((S) => { S.priv.hand[5] = null; }));
    await sleep(2000);
    const g = await page.evaluate(() => {
      const V = globalThis.__SP_VIEW__.raw, cv = V.debug.app.view.getBoundingClientRect();
      const u = globalThis.__MOCK__.S().priv.board[0], v = V.debug.views.get('p:' + u.uid), t = V.tileScreen(7, 5);
      const finger = { x: t.x, y: t.y + 0.6 * t.s };
      const el = document.elementFromPoint(finger.x, finger.y);
      return { uid: u.uid, from: { x: cv.left + v.screen.x, y: cv.top + v.screen.y - 0.5 * v.screen.s }, finger, onDom: !!el && el !== V.debug.app.view };
    });
    assert.ok(g.onDom, 'premise: the finger is on the DOM (shop bar) below the bench slot');
    await page.touchscreen.touchStart(g.from.x, g.from.y);
    for (let i = 1; i <= 12; i++) { await page.touchscreen.touchMove(g.from.x + ((g.finger.x - g.from.x) * i) / 12, g.from.y + ((g.finger.y - g.from.y) * i) / 12); await sleep(16); }
    await sleep(100);
    await page.touchscreen.touchEnd();
    await sleep(800);
    assert.equal(await page.evaluate(() => globalThis.__MOCK__.S().priv.hand[5]?.uid ?? null), g.uid, 'the unit is on bench slot 5');
    await page.close();
    assert.deepEqual(problems, []);
  });
});
