// The browser battle runner (public/js/battle/runner.js) under Node with a fake socket, a manual clock and manual
// animation frames: pacing (60 ticks per real second at 2×, ≤ 8 per frame), the b.snap / b.ev feed and the field meta,
// b.progress / b.result when authoritative (valid protocol frames, the same result as the server's simulation),
// fast-forward to `elapsed`, b.end (forced / takeover), the hidden-tab pump, the boss pool sync, phase clearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner, ticksPerFrameCap } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { validateC2S } from '../../shared/protocol.js';
import { validateClientResult, runHeadless } from '../../server/match/fields.js';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch } from './harness.js';

const DS = new DataSource(DATA, null);

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
  const doc = { hidden, addEventListener() {} };
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
  const feed = { snaps: [], evs: [], fields: [] };
  runner.on('snap', (s) => feed.snaps.push(s));
  runner.on('ev', (e) => feed.evs.push(e));
  runner.on('field', (f) => feed.fields.push(f));
  const r = {
    runner, net, store, doc, feed,
    get t() { return t; },
    /** advance the clock by `ms` in animation frames of `step` ms (or pump intervals when hidden) */
    advance(ms, step = 1000 / 60) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + step);
        if (doc.hidden) { for (const fn of intervals) fn(); continue; }
        const q = frames.splice(0);
        for (const fn of q) fn(t);
      }
    },
    async settle() { for (let i = 0; i < 50; i++) { await new Promise((res) => setImmediate(res)); const q = frames.splice(0); for (const fn of q) fn(t); } },
  };
  return r;
}

/** A real b.start of round 2 (a board with operators) from a client-combat match. */
function realStart(seed = 7301) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed, captureFrames: false, clientCombat: true, clients: false });
  h.autoHumans();
  h.m.start();
  h.run(() => h.m.phase === PHASE.COMBAT && h.m.round === 1);
  // round 1: the bot fights, the human (no client here) is taken over at the deadline; round 2 has a real board
  h.run(() => h.m.phase === PHASE.COMBAT && h.m.round === 2, { maxSteps: 3e6 });
  const msg = h.lastTo('p_0', 'b.start');
  h.m.dispose();
  return msg;
}

test('authoritative battle: 2× pacing, ≤ max(8, 4·speed) ticks per frame, b.snap / b.ev feed, field meta in the store, progress ~1 Hz, the server-identical result', async () => {
  const start = realStart();
  assert.ok(start && start.authoritative);
  const r = rig();
  r.net.emit('b.start', start);
  await r.settle();
  assert.equal(r.feed.fields.length, 1);
  const field = r.store.get().match.field;
  assert.equal(field.fieldId, start.fieldId);
  assert.equal(field.local, true);
  assert.equal(field.battleId, start.battleId);
  assert.ok(Array.isArray(field.units), 'unit infos (none deployed before the first tick)');
  assert.deepEqual(r.store.get().match.battle && [r.store.get().match.battle.authoritative, r.store.get().match.battle.own], [true, true]);
  const e = r.runner._entries.get(start.battleId);
  r.advance(1000);
  assert.ok(Math.abs(e.battle.tickCount - 60) <= 2, `60 ticks per real second at 2× (${e.battle.tickCount})`);
  assert.ok(r.feed.snaps.length >= 55, 'a snapshot per frame');
  const snap = r.feed.snaps[r.feed.snaps.length - 1];
  assert.equal(snap.t, 'b.snap');
  assert.equal(snap.fieldId, start.fieldId);
  assert.equal(typeof snap.gt, 'number');
  assert.ok(r.feed.evs.every((x) => x.t === 'b.ev' && Array.isArray(x.ev) && typeof x.gt === 'number'));
  const spawnedOf = () => r.feed.evs.flatMap((x) => x.ev).filter((x) => x[0] === 'spawn').map((x) => x[1]);
  assert.ok(spawnedOf().some((u) => u.side === 'ally' && /^chess_/.test(u.defId)), 'the board arrives as spawn events at the first tick');
  // a slow frame never steps more than the cap
  const before = e.battle.tickCount;
  r.advance(100, 100);
  assert.ok(e.battle.tickCount - before <= ticksPerFrameCap(2), 'cap per frame');
  // run to the end
  for (let i = 0; i < 400 && !e.done; i++) r.advance(1000, 50);
  assert.ok(e.done, 'finished');
  assert.ok(spawnedOf().some((u) => u.side === 'enemy'), 'the enemies arrive as spawn events');
  await r.settle();
  const prog = r.net.sent.filter((x) => x.t === 'b.progress');
  const secs = e.battle.time / 2;
  assert.ok(prog.length >= secs * 0.8 && prog.length <= secs + 3, `~1 progress per real second (${prog.length} over ${secs.toFixed(1)} s)`);
  assert.equal(prog[prog.length - 1].done, true);
  const res = r.net.sent.filter((x) => x.t === 'b.result');
  assert.equal(res.length, 1);
  const server = runHeadless(specMod.createBattleFromSpec(start.spec, DS, { recordEvents: false }), { players: start.spec.players.map((p) => p.playerId) }).result;
  const a = validateClientResult(start.spec, res[0].result, {});
  const b = validateClientResult(start.spec, specMod.compactResult(server), {});
  assert.ok(a.ok && b.ok);
  assert.equal(specMod.resultDigest(a.result).hash, specMod.resultDigest(b.result).hash, 'the browser result equals the server simulation');
  r.runner.dispose();
});

test('fast-forward to `elapsed` before showing; display replicas never report; b.end takeover demotes; hidden tab keeps an authoritative battle going', async () => {
  const start = realStart(7302);
  // observing a running field 20 game s in
  const r = rig();
  r.net.emit('b.start', { ...start, authoritative: false, watch: true, elapsed: 20 });
  await r.settle();
  const e = r.runner._entries.get(start.battleId);
  assert.ok(e.battle.time >= 19.8, `caught up to the field clock (${e.battle.time})`);
  assert.equal(r.feed.fields.length, 1, 'shown once, after the catch-up');
  r.advance(3000);
  assert.equal(r.net.sent.length, 0, 'a display replica never reports');
  // the same battleId again (e.g. back from watching): no rebuild
  r.net.emit('b.start', { ...start, authoritative: false, watch: true, elapsed: 30 });
  await r.settle();
  assert.equal(r.runner._entries.get(start.battleId), e);
  r.runner.dispose();

  // authoritative, then the server takes the field over
  const r2 = rig();
  r2.net.emit('b.start', start);
  await r2.settle();
  r2.advance(1500);
  r2.net.emit('b.end', { battleId: start.battleId, fieldId: start.fieldId, reason: 'takeover' });
  const n = r2.net.sent.length;
  for (let i = 0; i < 200; i++) r2.advance(1000, 50);
  assert.equal(r2.net.sent.length, n, 'no more reports after a takeover');
  r2.runner.dispose();

  // hidden tab: the interval pump advances the authoritative battle without rendering
  const r3 = rig({ hidden: true });
  r3.net.emit('b.start', start);
  await r3.settle();
  const e3 = r3.runner._entries.get(start.battleId);
  const snaps = r3.feed.snaps.length;
  r3.advance(2000, 1000);
  assert.ok(e3.battle.tickCount >= 110, `pumped while hidden (${e3.battle.tickCount})`);
  assert.equal(r3.feed.snaps.length, snaps, 'nothing rendered while hidden');
  r3.runner.dispose();
});

test('b.end forced ends the local battle and reports at once; a new prep clears every battle', async () => {
  const start = realStart(7303);
  const r = rig();
  r.net.emit('b.start', start);
  await r.settle();
  r.advance(2000);
  r.net.emit('b.end', { battleId: start.battleId, fieldId: start.fieldId, reason: 'forced' });
  await r.settle();
  const res = r.net.sent.filter((x) => x.t === 'b.result');
  assert.equal(res.length, 1);
  assert.equal(res[0].result.reason, 'forced');
  r.store.patch('match', { public: { phase: 'SETTLE' } });
  assert.equal(r.runner._entries.size, 1, 'the finished field stays on screen through SETTLE');
  r.store.patch('match', { public: { phase: 'PREP' } });
  assert.equal(r.runner._entries.size, 0);
  assert.equal(r.store.get().match.battle, null);
  r.runner.dispose();
});

test('boss field: the local pool follows b.pool (server hp − unacknowledged local damage); progress carries bossDmg / by / leaks at 4 Hz', async () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 7304, captureFrames: false, clientCombat: true, clients: false });
  h.autoHumans();
  h.m.start();
  h.run(() => h.ended != null || h.m.phase === PHASE.FINAL_ASSAULT, { maxSteps: 5e6 });
  if (h.m.phase !== PHASE.FINAL_ASSAULT) { h.m.dispose(); return; } // (the seed did not reach the boss round)
  const start = h.lastTo('p_0', 'b.start');
  h.m.dispose();
  assert.equal(start.kind, 'boss');
  const r = rig();
  r.net.emit('b.start', start);
  await r.settle();
  const e = r.runner._entries.get(start.battleId);
  const pool = e.battle.sharedBoss;
  // the pool's cumulative damage at the instant of each report (damage dealt after the last report of the window is
  // reported by the next one)
  const cumAtSend = [];
  const send = r.net.send;
  r.net.send = (t, fields) => { if (t === 'b.progress') cumAtSend.push(pool.cum); return send(t, fields); };
  r.advance(3000);
  assert.ok(pool.cum > 0, 'local damage to the pool');
  const prog = r.net.sent.filter((x) => x.t === 'b.progress');
  assert.ok(prog.length >= 10 && prog.length <= 14, `4 Hz (${prog.length} in 3 s)`);
  const last = prog[prog.length - 1];
  assert.equal(last.bossDmg, cumAtSend[cumAtSend.length - 1]);
  assert.ok(last.bossDmg <= pool.cum);
  assert.ok(last.by && typeof last.by === 'object');
  assert.equal(typeof last.leaks, 'number');
  r.net.emit('b.pool', { hp: pool.maxHp * 0.5, max: pool.maxHp, teamLp: 20, acked: { [start.fieldId]: pool.cum } });
  assert.ok(Math.abs(pool.hp - pool.maxHp * 0.5) < 1e-6, 'server hp when everything is acknowledged');
  r.runner.dispose();
});

/** A fake net whose b.result requests follow a script: 'ok' | 'lost' (DISCONNECTED) | 'offline' | 'timeout' | 'refused'. */
function scriptResults(r, script) {
  r.net.request = (t, fields) => {
    const msg = { ...fields, t, rid: 1 };
    assert.equal(validateC2S(msg), null, `invalid ${t}`);
    r.net.sent.push(msg);
    const mode = script.shift() || 'ok';
    if (mode === 'ok') return Promise.resolve({ t: 'ok' });
    const code = { lost: 'DISCONNECTED', offline: 'OFFLINE', timeout: 'TIMEOUT', refused: 'WRONG_PHASE' }[mode];
    return Promise.reject(Object.assign(new Error(code), { code }));
  };
}

test('a b.result lost with the socket is sent again when the session resumes and on an authoritative b.start of the finished battle; a refusal is final', async () => {
  const start = realStart(7305);
  const results = (r) => r.net.sent.filter((x) => x.t === 'b.result');
  const warn = console.warn;
  console.warn = () => {};
  try {
    // DISCONNECTED around the end of the battle
    const r = rig();
    scriptResults(r, ['lost']);
    r.net.emit('b.start', start);
    await r.settle();
    r.advance(1500);
    r.net.emit('b.end', { battleId: start.battleId, fieldId: start.fieldId, reason: 'forced' });
    await r.settle();
    const e = r.runner._entries.get(start.battleId);
    assert.equal(results(r).length, 1);
    assert.equal(e.delivery, 'undelivered');
    r.net.emit('status', { status: 'reconnecting' });
    await r.settle();
    assert.equal(results(r).length, 1, 'not while reconnecting');
    r.net.emit('status', { status: 'online' });
    await r.settle();
    assert.equal(results(r).length, 2, 're-sent on resume');
    assert.deepEqual(results(r)[1].result, results(r)[0].result, 'the same result');
    assert.equal(results(r)[1].battleId, start.battleId);
    assert.equal(e.delivery, 'delivered');
    r.net.emit('status', { status: 'online' });
    await r.settle();
    assert.equal(results(r).length, 2, 'a delivered result is not sent again on resume');
    // the server resyncs the finished field as still waiting for its authority's result: sent again
    r.net.emit('b.start', { ...start, authoritative: true, elapsed: 3 });
    await r.settle();
    assert.equal(results(r).length, 3);
    assert.equal(r.runner._entries.get(start.battleId), e, 'no rebuild');
    // a display resend does not
    r.net.emit('b.start', { ...start, authoritative: false, watch: false, elapsed: 3 });
    await r.settle();
    assert.equal(results(r).length, 3);
    r.runner.dispose();

    // two timeouts (retried once) → undelivered; OFFLINE → undelivered; both go out on resume
    const r2 = rig();
    scriptResults(r2, ['timeout', 'timeout']);
    r2.net.emit('b.start', start);
    await r2.settle();
    r2.net.emit('b.end', { battleId: start.battleId, fieldId: start.fieldId, reason: 'forced' });
    await r2.settle();
    assert.equal(results(r2).length, 2, 'one retry on a timeout');
    assert.equal(r2.runner._entries.get(start.battleId).delivery, 'undelivered');
    r2.net.emit('status', { status: 'online' });
    await r2.settle();
    assert.equal(results(r2).length, 3);
    r2.runner.dispose();

    // the server answered with a refusal (stale battle, match over): never sent again
    const r3 = rig();
    scriptResults(r3, ['refused']);
    r3.net.emit('b.start', start);
    await r3.settle();
    r3.net.emit('b.end', { battleId: start.battleId, fieldId: start.fieldId, reason: 'forced' });
    await r3.settle();
    r3.net.emit('status', { status: 'online' });
    await r3.settle();
    assert.equal(results(r3).length, 1);
    r3.runner.dispose();
  } finally {
    console.warn = warn;
  }
});

test('solo pause: m.public.paused freezes every local battle clock (no ticks, no reports); resume continues where it stopped', async () => {
  const start = realStart(7306);
  const r = rig();
  r.store.patch('match', { public: { phase: 'COMBAT', paused: false } });
  r.net.emit('b.start', start);
  await r.settle();
  const e = r.runner._entries.get(start.battleId);
  r.advance(1000);
  const t1 = e.battle.tickCount;
  assert.ok(Math.abs(t1 - 60) <= 2, `running (${t1})`);
  r.store.patch('match', { public: { phase: 'COMBAT', paused: true } });
  assert.equal(r.runner.state().paused, true);
  assert.equal(r.store.get().match.battle.paused, true, 'published for the HUD');
  const reports = r.net.sent.length;
  r.advance(5000);
  assert.equal(e.battle.tickCount, t1, 'no tick while paused');
  assert.equal(r.net.sent.length, reports, 'no report while paused');
  // a resend while paused (reconnect) keeps the clock frozen
  r.net.emit('b.start', { ...start, elapsed: t1 / 30 });
  await r.settle();
  r.advance(1000);
  assert.equal(e.battle.tickCount, t1);
  r.store.patch('match', { public: { phase: 'COMBAT', paused: false } });
  assert.equal(r.runner.state().paused, false);
  r.advance(1000);
  assert.ok(Math.abs(e.battle.tickCount - (t1 + 60)) <= 2, `resumed on the same clock, no catch-up burst (${e.battle.tickCount})`);
  r.runner.dispose();
});
