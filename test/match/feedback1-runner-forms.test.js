// test/match/feedback1-runner-forms.test.js — player report #5 after 0.1.0 ("转译基底不会变身…加载变身动画然后就没了"), the
// client runner's part (public/js/battle/runner.js under Node: fake socket, manual clock and animation frames, the real
// sim on the real stage 战场#01). A form change reaches the view only as an fx with a `form` (sim content/enemies.js
// setForm; shared/protocol.js fxForm) — b.snap tuples carry no form. The runner used to drop those fx in a catch-up
// frame (a stall of more than ≈0.53 s real at 2×: only spawn / die / deploy / status / skill / leak passed) and every
// event while the tab was hidden, so the view kept the first form and the 转译基底·α died on the 寻仇者's B_Die (the
// review's headless-Chrome repro). Now a catch-up keeps them (keepsState), a hidden tab holds the battle on screen's
// state-bearing events for the first frame back (≤ HELD_MAX, else the view re-enters from the field meta), and the game
// screen's pre-entry buffer keeps them too (screens/game.js keepEarly, same predicate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBattleRunner, keepsState, HELD_MAX } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { validateC2S, fxForm } from '../../shared/protocol.js';
import { DATA } from './harness.js';

const DS = new DataSource(DATA, null);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TR = 'enemy_10081_mpplai';

function fakeNet() {
  const handlers = new Map();
  const n = {
    sent: [],
    on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); return () => handlers.get(t).delete(fn); },
    emit(t, msg) { for (const fn of handlers.get(t) || []) fn({ t, ...msg }); },
    send(t, fields) { const msg = { ...fields, t }; assert.equal(validateC2S(msg), null, `invalid ${t}`); n.sent.push(msg); return true; },
    request(t, fields) { const msg = { ...fields, t, rid: 1 }; assert.equal(validateC2S(msg), null, `invalid ${t}`); n.sent.push(msg); return Promise.resolve({ t: 'ok' }); },
  };
  return n;
}

function rig({ hidden = false } = {}) {
  let t = 1000;
  const frames = [];
  const intervals = [];
  const docListeners = [];
  const doc = { hidden, addEventListener(type, fn) { if (type === 'visibilitychange') docListeners.push(fn); } };
  const net = fakeNet();
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc,
    now: () => t,
    raf: (fn) => { frames.push(fn); return frames.length; },
    caf: () => {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    loadSim: async () => ({ spec: specMod, ds: DS }),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  const feed = { evs: [], fields: [], snaps: 0 };
  runner.on('ev', (e) => feed.evs.push(e));
  runner.on('field', (f) => feed.fields.push(f));
  runner.on('snap', () => { feed.snaps++; });
  return {
    runner, net, doc, feed,
    /** advance the clock by `ms` in animation frames of `step` ms (pump intervals while hidden) */
    advance(ms, step = 1000 / 60) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + step);
        if (doc.hidden) { for (const fn of intervals) fn(); continue; }
        const q = frames.splice(0);
        for (const fn of q) fn(t);
      }
    },
    show() { doc.hidden = false; for (const fn of docListeners) fn(); },
    async settle() { for (let i = 0; i < 50; i++) { await new Promise((res) => setImmediate(res)); const q = frames.splice(0); for (const fn of q) fn(t); } },
  };
}

/** 战场#01: 百炼嘉维尔 blocks the lower lane on (9,8); one 转译基底·α walks it (9,10) → (9,2) — blocked, it turns 幽灵. */
const start = (authoritative = false) => ({
  battleId: 'fb1.runner', fieldId: 'n:P1', kind: 'normal', speed: 2, elapsed: 0, authoritative, watch: !authoritative,
  spec: specMod.buildBattleSpec({
    battleId: 'fb1.runner', fieldId: 'n:P1', kind: 'normal', seed: 5, modeId: 'mode_multi_hard', round: 3, stageId: 'act2autochess_m01', timeLimit: 400,
    players: [{ playerId: 'P1', seat: 0, side: 'L', colOffset: 0, units: [{ uid: 1, kind: 'chess', chessId: 'chess_char_4_23_b', row: 9, col: 8, dir: 'RIGHT' }], bonds: {}, playerEffects: [] }],
    spawns: [{ time: 0, enemyKey: TR, routeIndex: 0, count: 1, mods: { hpMul: 1, atkMul: 0.01 } }],
    routes: [{ motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [] }], flags: {},
  }),
});

const all = (feed) => feed.evs.flatMap((x) => x.ev);
const formsOf = (list, id) => list.filter((x) => fxForm(x) !== undefined && x[4].id === id).map(fxForm);
const trOf = (e) => e.battle.units.find((u) => u.defId === TR);

test('fxForm / keepsState: a setForm fx (any fx kind with a `form`) is state; a barrier \'phase\', hit sparks and damage numbers are not', () => {
  assert.equal(fxForm(['fx', 'phase', 1, 2, { id: 3, kind: 'translator_youling', form: 'translator_youling', dur: 2 }]), 'translator_youling');
  assert.equal(fxForm(['fx', 'ember', 1, 2, { id: 3, hits: 5, dur: 11, form: 'husk' }]), 'husk');
  assert.equal(fxForm(['fx', 'revive', 1, 2, { id: 3, form: null }]), null, 'null = back to the base clip set');
  assert.equal(fxForm(['fx', 'phase', 1, 2, { id: 3, kind: 'artsBarrier', value: 300 }]), undefined, 'a barrier phase is no form');
  assert.equal(fxForm(['fx', 'ember', 1, 2, { form: 'husk' }]), undefined, 'no unit');
  assert.equal(fxForm(['dmg', 3, 100]), undefined);
  assert.ok(keepsState(['fx', 'revive', 1, 2, { id: 3, form: 'revived' }]));
  assert.ok(keepsState(['spawn', { id: 3 }]) && keepsState(['die', 3, 'killed']));
  assert.ok(!keepsState(['fx', 'explode', 1, 2, { r: 1 }]) && !keepsState(['atk', 1, 3]) && !keepsState(['dmg', 3, 100]));
});

test('the smooth feed carries 转译基底·α\'s form fx (blocked ⇒ 幽灵)', async () => {
  const r = rig();
  r.net.emit('b.start', start());
  await r.settle();
  const e = r.runner._entries.get('fb1.runner');
  for (let i = 0; i < 12 && trOf(e)?.form == null; i++) r.advance(1000);
  r.advance(1500);
  const tr = trOf(e);
  assert.equal(tr?.form, 'translator_youling', 'fixture: blocked by 百炼嘉维尔 it turns 幽灵');
  assert.equal(r.runner.stats().catchups, 0, 'no catch-up');
  assert.deepEqual(formsOf(all(r.feed), tr.id), ['translator_youling']);
  r.runner.dispose();
});

test('janky frames (0.7 s each: every frame a catch-up) keep the form fx — hit sparks and damage numbers still go', async () => {
  const r = rig();
  r.net.emit('b.start', start());
  await r.settle();
  const e = r.runner._entries.get('fb1.runner');
  for (let i = 0; i < 40 && !e.done && !(trOf(e)?.form && e.battle.time > 12); i++) r.advance(700, 700);
  const tr = trOf(e);
  assert.equal(tr?.form, 'translator_youling');
  assert.ok(r.runner.stats().catchups > 5, `catch-up frames (${r.runner.stats().catchups})`);
  const list = all(r.feed);
  assert.deepEqual(formsOf(list, tr.id), ['translator_youling'], 'the view learns the 幽灵 form (it used to keep the A model)');
  assert.ok(!list.some((x) => x[0] === 'atk' || x[0] === 'dmg'), 'catch-up frames still drop the decoration');
  const spawnAt = list.findIndex((x) => x[0] === 'spawn' && x[1].id === tr.id);
  const formAt = list.findIndex((x) => fxForm(x) !== undefined && x[4].id === tr.id);
  const dieAt = list.findIndex((x) => x[0] === 'die' && x[1] === tr.id);
  assert.ok(spawnAt >= 0 && formAt > spawnAt && (dieAt < 0 || dieAt > formAt), `in order: spawn ${spawnAt}, form ${formAt}, die ${dieAt}`);
  r.runner.dispose();
});

test('a hidden tab across the change: nothing rendered meanwhile, the first frame back delivers the held spawn and form fx', async () => {
  const r = rig({ hidden: true });
  r.net.emit('b.start', start(true));
  await r.settle();
  const e = r.runner._entries.get('fb1.runner');
  assert.equal(r.feed.fields.length, 1, 'shown (the field meta) before the first tick');
  for (let i = 0; i < 12 && trOf(e)?.form == null; i++) r.advance(1000, 250);
  r.advance(1500, 250);
  const tr = trOf(e);
  assert.equal(tr?.form, 'translator_youling', 'pumped through the change while hidden');
  assert.equal(r.feed.evs.length, 0, 'nothing rendered while hidden');
  assert.ok(e.held.length > 0 && e.held.every(keepsState), 'the battle on screen holds its state-bearing events');
  r.show();
  r.advance(1000 / 60);
  const first = r.feed.evs[0]?.ev || [];
  assert.ok(first.some((x) => x[0] === 'spawn' && x[1].id === tr.id), 'the translator\'s spawn (it used to come back as an unknown view)');
  assert.deepEqual(formsOf(first, tr.id), ['translator_youling'], 'and its form');
  assert.equal(e.held.length, 0);
  assert.equal(r.feed.fields.length, 1, 'no re-entry needed');
  r.runner.dispose();
});

test('a hidden-tab backlog beyond HELD_MAX: the first frame back re-enters the view from the field meta (UnitInfo `form`)', async () => {
  const r = rig({ hidden: true });
  r.net.emit('b.start', start(true));
  await r.settle();
  const e = r.runner._entries.get('fb1.runner');
  for (let i = 0; i < 12 && trOf(e)?.form == null; i++) r.advance(1000, 250);
  const tr = trOf(e);
  assert.ok(tr?.form, 'changing');
  e.held.push(...Array.from({ length: HELD_MAX }, () => ['status', tr.id, 'stun', false]));
  r.advance(500, 250);
  assert.ok(e.stale && e.held.length === 0, 'overflow: dropped, marked stale');
  r.show();
  r.advance(1000 / 60);
  assert.equal(r.feed.fields.length, 2, 're-entered');
  const meta = r.feed.fields[1];
  assert.equal(meta.units.find((u) => u.id === tr.id)?.form, 'translator_youling', 'the field meta carries the form');
  assert.equal(e.stale, false);
  r.advance(1000 / 60);
  assert.ok(!r.feed.evs.some((x) => x.ev.some((y) => y[0] === 'status' && y[2] === 'stun')), 'the dropped backlog never arrives');
  r.runner.dispose();
});

test('screens/game.js buffers the form fx with the state-bearing events it replays when a field is entered late', () => {
  const src = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
  assert.match(src, /const keepEarly = \(e\) => Array\.isArray\(e\) && \(STATE_EV\.has\(e\[0\]\) \|\| fxForm\(e\) !== undefined\);/);
  assert.match(src, /for \(const e of msg\.ev\) if \(keepEarly\(e\)\) buf\.push\(e\);/);
});
