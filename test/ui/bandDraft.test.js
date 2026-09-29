// Strategy draft 队友已选 (research 09 §5 / §7, DESIGN §14 corrections): a strategy a teammate already picked cannot be
// chosen again — the server refuses it (server/match/Match.js pickBand → BAD_TARGET '队友已选'), bots re-draw, and the
// UI marks it (screens/bandDraft.js teammateBands). Automatic assignments (12 s turn timeout, 50 s cap, a departing
// seat) give the official default 「华法琳」 only while no teammate holds it, else the first free strategy
// (Match.js defaultBand; the UI names it: bandDraft.js timeoutBand).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { makeMatch, DATA } from '../match/harness.js';
import { teammateBands, timeoutBand, allowedBands } from '../../public/js/screens/bandDraft.js';

function draftOf(o) {
  const h = makeMatch({ mode: 'coop', ...o }).start();
  for (const ps of h.m.players.values()) if (!ps.isBot) h.m.handle(ps.playerId, { t: 'g.infoReady' });
  h.sched.advance(1);
  assert.equal(h.m.phase, PHASE.BAND_DRAFT);
  return h;
}

describe('server: no duplicate strategies in the co-op draft', () => {
  test('a band picked by a teammate is refused with 队友已选; a free one is accepted', () => {
    const h = draftOf({ humans: 3, seed: 5 });
    const m = h.m;
    const [first, second, third] = m.draft.order;
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_sarkazb' }), { ok: true });
    const dup = m.handle(second, { t: 'g.band', bandId: 'band_sarkazb' });
    assert.equal(dup.error, ERR.BAD_TARGET, 'duplicate refused');
    assert.equal(m.draftTurn(), second, 'still their turn');
    assert.equal(m.bandTaken('band_sarkazb', second), true);
    assert.equal(m.bandTaken('band_sarkazb', first), false, 'your own pick is not "taken by a teammate"');
    assert.deepEqual(m.handle(second, { t: 'g.band', bandId: 'band_lisa' }), { ok: true });
    assert.equal(m.handle(third, { t: 'g.band', bandId: 'band_lisa' }).error, ERR.BAD_TARGET);
    assert.deepEqual(m.handle(third, { t: 'g.band', bandId: 'band_amiya' }), { ok: true });
    const picks = Object.values(m.publicView().draft?.picks || m.draft.picks);
    assert.equal(new Set(picks).size, picks.length, 'all different');
    h.sched.advance(1);
    assert.equal(m.phase, PHASE.BATTLE_CHECK);
    m.dispose();
  });

  test('bots never take a strategy a teammate already holds', () => {
    for (const seed of [1, 2, 3, 4, 6, 9, 11]) {
      const h = draftOf({ humans: 1, bots: 3, seed });
      const m = h.m;
      // the human picks first when it is their turn; bots pick by themselves
      h.run(() => m.phase !== PHASE.BAND_DRAFT || m.draftTurn() === 'p_0', { maxTime: 20000 });
      if (m.phase === PHASE.BAND_DRAFT) assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: 'band_bldsk' }), { ok: true });
      h.run(() => m.phase !== PHASE.BAND_DRAFT, { maxTime: 60000 });
      const ids = [...m.players.values()].map((p) => p.bandId);
      assert.equal(new Set(ids).size, ids.length, `seed ${seed}: distinct strategies ${ids}`);
      for (const id of ids) assert.ok(DATA.bands[id], id);
      m.dispose();
    }
  });

  test('solo: the rule has nothing to compare against', () => {
    const h = makeMatch({ mode: 'solo', seed: 2 }).start();
    h.m.handle('p_0', { t: 'g.infoReady' });
    h.sched.advance(1);
    assert.equal(h.m.bandTaken('band_orchid', 'p_0'), false);
    assert.deepEqual(h.m.handle('p_0', { t: 'g.band', bandId: 'band_orchid' }), { ok: true });
    h.m.dispose();
  });
});

describe('UI: teammateBands', () => {
  test('maps each band a teammate picked to its pickers; never the viewer', () => {
    const picks = new Map([['a', 'band_x'], ['b', 'band_y'], ['c', 'band_x'], ['me', 'band_z']]);
    const t = teammateBands(picks, 'me');
    assert.deepEqual([...t.keys()].sort(), ['band_x', 'band_y']);
    assert.deepEqual(t.get('band_x'), ['a', 'c']);
    assert.equal(t.has('band_z'), false);
    assert.equal(teammateBands(null, 'me').size, 0);
  });
});

describe('UI: draftSelection (review regression)', () => {
  test('on my turn a selection a teammate took meanwhile moves to the first free band; otherwise it is kept', async () => {
    const { draftSelection } = await import('../../public/js/screens/bandDraft.js');
    const bands = [{ bandId: 'a' }, { bandId: 'b' }, { bandId: 'c' }];
    const taken = new Map([['a', ['p1']]]);
    assert.equal(draftSelection(null, { bands, taken, myPick: null, myTurn: false }), 'b', 'default: first free');
    assert.equal(draftSelection(null, { bands, taken, myPick: 'c', myTurn: false }), 'c', 'default: my pick');
    assert.equal(draftSelection('a', { bands, taken, myPick: null, myTurn: false }), 'a', 'browsing a taken band is fine while waiting');
    assert.equal(draftSelection('a', { bands, taken, myPick: null, myTurn: true }), 'b', 'my turn: off the taken band');
    assert.equal(draftSelection('c', { bands, taken, myPick: null, myTurn: true }), 'c', 'a free selection is kept');
    assert.equal(draftSelection('a', { bands, taken, myPick: 'c', myTurn: false }), 'a', 'after my pick nothing moves');
    assert.equal(draftSelection('x', { bands: [], taken, myPick: null, myTurn: true }), 'x', 'no bands: unchanged');
  });
});

describe('server: automatic assignments never duplicate a teammate\'s strategy', () => {
  const distinct = (m) => {
    const ids = [...m.players.values()].map((p) => p.bandId);
    assert.equal(new Set(ids).size, ids.length, `distinct strategies ${ids}`);
    for (const id of ids) assert.ok(DATA.bands[id], id);
    return ids;
  };

  test('12 s turn timeout: 华法琳 when free, else the first free strategy (sortId order)', () => {
    const h = draftOf({ humans: 3, seed: 5 });
    const m = h.m;
    const [first, second, third] = m.draft.order;
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_bldsk' }), { ok: true });
    assert.equal(m.defaultBand(second), 'band_amiya', 'the next free strategy by sortId');
    h.sched.advance(12001);
    assert.equal(m.draft.picks[second], 'band_amiya', 'timeout never assigns 队友已选 华法琳');
    assert.equal(h.ps(second).lp, DATA.bands.band_amiya.totalHp, 'the LP of the assigned strategy');
    assert.equal(m.draftTurn(), third);
    h.sched.advance(12001);
    assert.equal(m.draft.picks[third], 'band_duyaoy');
    distinct(m);
    m.dispose();
  });

  test('the default stays 华法琳 while nobody holds it (also for a player whose teammates picked others)', () => {
    const h = draftOf({ humans: 2, seed: 5 });
    const m = h.m;
    const [first, second] = m.draft.order;
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_amiya' }), { ok: true });
    assert.equal(m.defaultBand(second), 'band_bldsk');
    h.sched.advance(12001);
    assert.equal(m.draft.picks[second], 'band_bldsk');
    m.dispose();
  });

  test('every human idle: the turn timeouts and the 50 s step cap assign distinct strategies', () => {
    const h = draftOf({ humans: 4, seed: 9 });
    const m = h.m;
    h.run(() => m.phase !== PHASE.BAND_DRAFT, { maxTime: 120000 });
    assert.equal(m.phase, PHASE.BATTLE_CHECK);
    const ids = distinct(m);
    assert.ok(ids.includes('band_bldsk'), 'the first idle player still gets the official default');
    for (const ps of m.players.values()) assert.equal(ps.lp, DATA.bands[ps.bandId].totalHp, `${ps.playerId} LP follows its strategy`);
    m.dispose();
  });

  test('the step cap (finishBandDraft) assigns the remaining seats one after another without duplicates', () => {
    const h = draftOf({ humans: 3, seed: 5 });
    const m = h.m;
    const [first] = m.draft.order;
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_bldsk' }), { ok: true });
    m.finishBandDraft(true);
    distinct(m);
    assert.equal(m.phase, PHASE.BATTLE_CHECK);
    m.dispose();
  });

  test('a departing seat passes with a free strategy; mixed with bots nobody shares one', () => {
    const h = draftOf({ humans: 3, seed: 5 });
    const m = h.m;
    const [first, second] = m.draft.order;
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_bldsk' }), { ok: true });
    m.onLeave(second);
    assert.notEqual(m.draft.picks[second], 'band_bldsk', 'the leaver does not duplicate 华法琳');
    assert.ok(DATA.bands[m.draft.picks[second]]);
    m.dispose();
    for (const seed of [1, 2, 3, 4]) {
      const h2 = draftOf({ humans: 2, bots: 2, seed });
      h2.run(() => h2.m.phase !== PHASE.BAND_DRAFT, { maxTime: 120000 });
      distinct(h2.m);
      h2.m.dispose();
    }
  });
});

describe('UI: timeoutBand (the tip names what a timeout gives me)', () => {
  const bands = allowedBands([
    { bandId: 'band_amiya', sortId: 2 }, { bandId: 'band_bldsk', sortId: 1 }, { bandId: 'band_duyaoy', sortId: 3 },
    { bandId: 'band_solo', sortId: 0, modeTypeList: ['SINGLE'] },
  ], 'MULTI');
  test('allowedBands keeps the server order (sortId, then id) and the mode filter', () => {
    assert.deepEqual(bands.map((b) => b.bandId), ['band_bldsk', 'band_amiya', 'band_duyaoy']);
  });
  test('华法琳 while free; else the first free one; never a taken one', () => {
    assert.equal(timeoutBand(bands, new Map()), 'band_bldsk');
    assert.equal(timeoutBand(bands, new Map([['band_amiya', ['a']]])), 'band_bldsk');
    assert.equal(timeoutBand(bands, new Map([['band_bldsk', ['a']]])), 'band_amiya');
    assert.equal(timeoutBand(bands, new Map([['band_bldsk', ['a']], ['band_amiya', ['b']]])), 'band_duyaoy');
    assert.equal(timeoutBand([], new Map()), 'band_bldsk', 'no data yet: the official default');
    assert.equal(timeoutBand(bands, null), 'band_bldsk');
  });
  test('matches the server for every combination of taken strategies', () => {
    const h = draftOf({ humans: 4, seed: 3 });
    const m = h.m;
    const all = allowedBands(Object.values(DATA.bands), 'MULTI');
    assert.deepEqual(all.map((b) => b.bandId), m.gd.bandIds(), 'same order as gd.bandIds');
    const [a, b, c, d] = m.draft.order;
    for (const picks of [[], ['band_bldsk'], ['band_bldsk', 'band_amiya'], ['band_amiya', 'band_duyaoy'], ['band_bldsk', 'band_amiya', 'band_duyaoy']]) {
      m.draft.picks = Object.fromEntries(picks.map((id, i) => [[a, b, c][i], id]));
      const taken = teammateBands(new Map(Object.entries(m.draft.picks)), d);
      assert.equal(timeoutBand(all, taken), m.defaultBand(d), `picks ${picks}`);
    }
    m.dispose();
  });
});
