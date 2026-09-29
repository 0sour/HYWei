// INFO_CHECK, band draft (order / skip / timeouts / 队友已选) and 机变 SP drafts (order / timers / auto-assign / effects).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';

test('INFO_CHECK: ends when every human confirmed (bots/departed count as ready) or at the 25 s deadline', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 1 }).start();
  const m = h.m;
  assert.equal(m.phase, PHASE.INFO_CHECK);
  const pub = h.lastBc('m.public');
  assert.equal(pub.deadline - pub.serverNow, 25000);
  assert.equal(pub.players.find((p) => p.playerId === 'ai_0').status, 'ready');
  assert.equal(pub.players.find((p) => p.playerId === 'p_0').status, 'deciding');
  assert.deepEqual(m.handle('p_0', { t: 'g.infoReady' }), { ok: true });
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  m.onLeave('p_1');
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT, 'departed human counts as ready');
  assert.deepEqual(m.handle('p_0', { t: 'g.infoReady' }), { error: ERR.WRONG_PHASE });
  m.dispose();
  const h2 = makeMatch({ mode: 'coop', humans: 2, seed: 1 }).start();
  h2.sched.advance(24999);
  assert.equal(h2.m.phase, PHASE.INFO_CHECK);
  h2.sched.advance(2);
  assert.equal(h2.m.phase, PHASE.BAND_DRAFT, 'deadline');
  h2.m.dispose();
});

test('band draft (co-op): random order, one pick per turn, NOT_YOUR_TURN, one skip each (moves to the end), 队友已选 refused', () => {
  // find a seed where both humans are not first... just use the order the match chose
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 5 }).start();
  const m = h.m;
  for (const id of ['p_0', 'p_1', 'p_2']) m.handle(id, { t: 'g.infoReady' });
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
  const order = m.draft.order.slice();
  assert.deepEqual(order.slice().sort(), ['p_0', 'p_1', 'p_2']);
  const [first, second, third] = order;
  assert.equal(h.lastBc('m.public') && m.publicView().draft.turn, first);
  assert.deepEqual(m.handle(second, { t: 'g.band', bandId: 'band_amiya' }), { error: ERR.NOT_YOUR_TURN });
  assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'nope' }).error, ERR.BAD_TARGET);
  // skip: first goes to the end
  assert.deepEqual(m.handle(first, { t: 'g.bandSkip' }), { ok: true });
  assert.deepEqual(m.draft.order, [second, third, first]);
  assert.equal(m.draftTurn(), second);
  assert.deepEqual(m.handle(second, { t: 'g.band', bandId: 'band_sarkazb' }), { ok: true });
  assert.equal(h.ps(second).lp, 45, '歌利亚 starts with 45 LP');
  assert.deepEqual(m.handle(second, { t: 'g.band', bandId: 'band_sarkazb' }), { error: ERR.ALREADY });
  // research 09 §5 / DESIGN §14 corrections: a strategy a teammate already took is 队友已选 (test/ui/bandDraft.test.js)
  assert.equal(m.handle(third, { t: 'g.band', bandId: 'band_sarkazb' }).error, ERR.BAD_TARGET, '队友已选: no duplicates');
  assert.equal(m.draftTurn(), third, 'the refused pick keeps the turn');
  assert.deepEqual(m.handle(third, { t: 'g.band', bandId: 'band_amiya' }), { ok: true });
  assert.equal(m.draftTurn(), first);
  assert.deepEqual(m.handle(first, { t: 'g.bandSkip' }).error, ERR.ALREADY, 'only one skip');
  assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_lisa' }), { ok: true });
  assert.equal(h.ps(first).lp, 20);
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BATTLE_CHECK);
  m.dispose();
});

test('band draft timers: 12 s per turn → 华法琳; the 50 s step cap assigns the rest; bots pick by themselves', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 2, seed: 9 }).start();
  const m = h.m;
  m.handle('p_0', { t: 'g.infoReady' });
  m.handle('p_1', { t: 'g.infoReady' });
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
  // humans never act: each human turn times out after 12 s; bots pick within ~1 s
  h.run(() => m.phase !== PHASE.BAND_DRAFT, { maxTime: 60000 });
  assert.equal(m.phase, PHASE.BATTLE_CHECK);
  // a timeout gives 华法琳 while no teammate holds it, else the first free strategy by sortId — never 队友已选
  // (Match.defaultBand): replay the assignments in draft order
  const taken = new Set();
  for (const pid of m.draft.order) {
    if (pid.startsWith('ai_')) { assert.ok(DATA.bands[h.ps(pid).bandId], 'bot picked a band'); taken.add(h.ps(pid).bandId); continue; }
    const want = !taken.has('band_bldsk') ? 'band_bldsk' : m.gd.bandIds().find((b) => !taken.has(b));
    assert.equal(h.ps(pid).bandId, want, `${pid} gets the default strategy nobody else holds`);
    assert.equal(h.ps(pid).lp, DATA.bands[want].totalHp);
    taken.add(want);
  }
  assert.equal(new Set(Object.values(m.draft.picks)).size, 4, 'no duplicate strategies');
  m.dispose();
  // overall cap: with 4 humans × 12 s > 50 s the last one is assigned at the cap
  const h2 = makeMatch({ mode: 'coop', humans: 4, seed: 9 }).start();
  for (const ps of h2.m.players.values()) h2.m.handle(ps.playerId, { t: 'g.infoReady' });
  h2.sched.advance(1);
  const t0 = h2.sched.now();
  h2.run(() => h2.m.phase !== PHASE.BAND_DRAFT, { maxTime: 120000 });
  assert.ok(h2.sched.now() - t0 <= 50000 + 5, `ended by the 50 s cap (${h2.sched.now() - t0} ms)`);
  const first = h2.m.draft.order[0];
  assert.equal(h2.ps(first).bandId, 'band_bldsk', 'the first timeout gets 华法琳');
  assert.equal(new Set([...h2.m.players.values()].map((ps) => ps.bandId)).size, 4, 'the rest get distinct free strategies');
  h2.m.dispose();
});

test('band draft (solo): free pick, no timer, no skip; mode-restricted bands rejected', () => {
  const h = makeMatch({ mode: 'solo', seed: 2 }).start();
  const m = h.m;
  m.handle('p_0', { t: 'g.infoReady' });
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
  assert.equal(m.deadline, 0);
  h.sched.advance(10 * 60 * 1000);
  assert.equal(m.phase, PHASE.BAND_DRAFT, 'untimed');
  assert.deepEqual(m.handle('p_0', { t: 'g.bandSkip' }).error, ERR.WRONG_PHASE);
  const multiOnly = Object.values(DATA.bands).find((b) => !b.modeTypeList.includes('SINGLE'));
  if (multiOnly) assert.equal(m.handle('p_0', { t: 'g.band', bandId: multiOnly.bandId }).error, ERR.BAD_TARGET);
  assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: 'band_orchid' }), { ok: true });
  assert.equal(h.ps('p_0').lp, DATA.bands.band_orchid.totalHp);
  m.dispose();
});

test('机变 (co-op): 6 shared cards, random order, 30 s first / 16 s others, timeout auto-assigns, each takes one', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 3, seed: 14, fake: true }).start();
  const m = h.m;
  assert.deepEqual(m.gd.spRounds(), [3, 6, 9]);
  h.drive(() => m.phase === PHASE.SP_DRAFT || m.round > 3, { ready: true });
  // the harness picks for humans; stop before: re-run with humans passive
  m.dispose();
  const h2 = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 3, seed: 14, fake: true }).start();
  const m2 = h2.m;
  h2.drive(() => m2.phase === PHASE.ROUND_START && m2.round === 3);
  h2.run(() => m2.phase === PHASE.SP_DRAFT);
  assert.equal(m2.phase, PHASE.SP_DRAFT);
  const sp = m2.publicView().sp;
  assert.equal(sp.cards.length, 6);
  assert.deepEqual(sp.order.slice().sort(), ['p_0', 'p_1', 'p_2']);
  assert.equal(Math.round((m2.deadline - h2.sched.now()) / 1000), 30, 'first picker 30 s');
  const [a, b, c] = sp.order;
  assert.equal(m2.handle(b, { t: 'g.choice', idx: 0 }).error, ERR.NOT_YOUR_TURN);
  assert.deepEqual(m2.handle(a, { t: 'g.choice', idx: 2 }), { ok: true });
  assert.equal(m2.handle(a, { t: 'g.choice', idx: 3 }).error, ERR.ALREADY);
  assert.equal(Math.round((m2.deadline - h2.sched.now()) / 1000), 16, 'others 16 s');
  assert.equal(m2.handle(b, { t: 'g.choice', idx: 2 }).error, ERR.SOLD_OUT);
  assert.equal(m2.handle(b, { t: 'g.choice', idx: 7 }).error, ERR.BAD_TARGET);
  // b times out → auto-assigned a random remaining card
  h2.sched.advance(16001);
  assert.ok(m2.sp.picks[b] != null && m2.sp.picks[b] !== 2);
  assert.deepEqual(m2.handle(c, { t: 'g.choice', idx: m2.sp.cards.map((x) => x.idx).find((i) => m2.sp.taken[i] == null) }), { ok: true });
  h2.sched.advance(1);
  assert.equal(m2.phase, PHASE.PREP, '机变 → prep');
  checkInvariants(m2);
  m2.dispose();
});

test('机变 (solo): 3 cards, untimed; supply/shop cards give the item, bounty cards add enemies to the next battle', () => {
  // solo NORMAL: R6 道具补给, R9 战术决策
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 3, fake: true }).start();
  const m = h.m;
  assert.deepEqual(m.gd.spRounds(), [6, 9]);
  h.drive(() => m.phase === PHASE.ROUND_START && m.round === 6);
  h.run(() => m.phase === PHASE.SP_DRAFT);
  const sp = m.publicView().sp;
  assert.equal(sp.cards.length, 3);
  assert.equal(sp.family, 'supply');
  assert.equal(m.deadline, 0, 'solo is untimed');
  h.sched.advance(600000);
  assert.equal(m.phase, PHASE.SP_DRAFT);
  const card = sp.cards[1];
  assert.equal(card.kind, 'item');
  assert.deepEqual(m.handle('p_0', { t: 'g.choice', idx: 1 }), { ok: true });
  const ps = h.ps('p_0');
  assert.ok([...ps.hand, ...ps.temp].some((p) => p && (p.id === card.id || p.id === DATA.items[card.id].goldenId)), 'item granted');
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.PREP);
  // a bounty card applied through the default
  const bounty = DATA.choices.cards.bounty.find((c) => c.payout === 'kill' && DATA.enemies[c.enemyKey]);
  m.addBounty(ps, bounty);
  const prev = ps.privateView().nextEnemies;
  assert.ok(prev.some((e) => e.enemyKey === bounty.enemyKey && e.tag === 'bounty'), 'preview shows the bounty enemies');
  m.dispose();
});

test('机变 tactic defaults: team cards reach teammates; layers / funds / free refreshes / next-buy elite', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 4, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  const [a, b] = [h.ps('p_0'), h.ps('p_1')];
  const { applyCard } = awaitImport;
  const tactic = (id) => ({ kind: 'tactic', id, name: DATA.effects[id].name, desc: '', team: !!DATA.choices.cards.tactic.find((c) => c.effectId === id)?.team, family: 'tactic', idx: 0 });
  applyCard(m, a, tactic('allybuff_select_2_1'));
  for (const bond of ['raidShip', 'steadShip', 'egirShip']) {
    assert.equal(a.layers[bond], 8, `${bond} picker`);
    assert.equal(b.layers[bond], 8, `${bond} teammate`);
  }
  const fa = a.funds;
  const fb = b.funds;
  applyCard(m, a, tactic('allybuff_select_3'));
  assert.equal(a.funds, fa + 1);
  assert.equal(b.funds, fb + 1);
  applyCard(m, b, tactic('allybuff_select_4'));
  assert.equal(a.shop.freeRefreshes, 2);
  assert.equal(b.shop.freeRefreshes, 2);
  applyCard(m, a, tactic('allybuff_select_6'));
  assert.ok(a.effects.some((e) => e.key === 'effect:builtin_next_buy_elite'));
  assert.ok(!b.effects.some((e) => e.key === 'effect:builtin_next_buy_elite'), 'personal card');
  a.funds = 20;
  const slot = a.shop.slots.findIndex((s) => s && s.kind === 'chess');
  const id = a.shop.slots[slot].id;
  if (m.pool.left(id) >= 3) {
    m.handle('p_0', { t: 'g.buy', slot });
    assert.ok([...a.hand].some((p) => p && p.id === DATA.chess[id].goldenId), '升华: bought operator became elite');
    assert.ok(!a.effects.some((e) => e.key === 'effect:builtin_next_buy_elite'), 'consumed');
  }
  applyCard(m, a, tactic('enemydebuff_select_1'));
  const eff = a.effects.find((e) => e.data && e.data.effectId === 'enemydebuff_select_1');
  assert.ok(eff && eff.battle, 'battle-side cards become playerEffects');
  assert.ok(a.battleInput().playerEffects.some((e) => e.id === eff.id));
  checkInvariants(m);
  m.dispose();
});

const awaitImport = await import('../../server/match/choices.js');
