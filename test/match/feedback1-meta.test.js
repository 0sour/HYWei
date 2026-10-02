// Player feedback after 0.1.0 (workstream WA, match-side effects), through the real match paths (g.refresh / g.buy /
// g.move / g.equip, the round loop's SETTLE):
//   #1 拉普兰德 garrison_123 "<刷新时>若为本回合首次主动刷新，使已激活的【叙拉古】层数+4(+8)，此干员在整备区时也有效": the
//      players' official behaviour — "获得该干员后该回合的首次刷新" also stacks. The refresh count is the 拉普兰德's own
//      (each copy counts the manual refreshes it witnessed this round), not the player's.
//   #4 昆图斯 突变细胞 "战斗结束后，装备者替换为高一阶的随机干员": the cell is not consumed — the original operator is
//      destroyed (PRTS 备注 "生效时，原干员销毁，获得一名高一阶的随机初始干员（最高六阶）") and its equipment, the cell
//      included, returns to the hand, to be equipped again ("之后就是一直打针，扎到核心卡…就换人扎").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, legalTileFor, checkInvariants, DATA } from './harness.js';
import { createRegistry } from '../../server/match/effectsMeta.js';
import { botPrep, botPrepEnd, cellTarget } from '../../server/match/bot.js';

const QUIET = { warn() {}, error() {}, info() {} };
const REG = createRegistry({ log: QUIET });
const OK = { ok: true };
const LAP = 'chess_char_2_16_a'; // 拉普兰德 (Ⅱ, 叙拉古) — garrison_123_a
const LAP_B = 'chess_char_2_16_b';
const PROVENCE = 'chess_char_1_07_a'; // 普罗旺斯 (Ⅰ, 叙拉古)
const TEXAS = 'chess_char_1_08_a'; // 德克萨斯 (Ⅰ, 独行 / 叙拉古)
const CELL = 'chess_item_5_08_e_a'; // 突变细胞
const KEY = 'garrison:SERVER_GAIN_BOND_LAYER_BY_REFRESH_CNT';

function setup({ seed = 70, mode = 'solo' } = {}) {
  const h = makeMatch({ mode, seed, registry: REG, fake: true }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear();
  ps.hand.fill(null);
  ps.temp.fill(null);
  ps.offers.length = 0;
  ps.funds = 50;
  ps.layers = {};
  ps.pendingFunds = 0;
  ps.shop.freeRefreshes = 0;
  ps.bandId = null; // isolate from the band's own prep effects
  ps.recompute();
  /** layers added by 拉普兰德's trait (the dispatcher's reason = the registry key) */
  const lap = { n: 0 };
  const addLayers = ps.addLayers.bind(ps);
  ps.addLayers = (b, n, o = {}) => { const a = addLayers(b, n, o); if (o.reason === KEY && b === 'siracusaShip') lap.n += a; return a; };
  const refresh = () => assert.deepEqual(m.handle('p_0', { t: 'g.refresh' }), OK);
  const L = () => lap.n;
  /** put `id` into shop slot `i` (as a roll would) and buy it through g.buy; returns the owned piece */
  const buy = (id, i = 0) => {
    ps.shop.slots[i] = { kind: 'chess', id, basePrice: m.gd.chessPrice(id), frozen: false, sold: false };
    const before = new Set(ps.allChess().map((p) => p.uid));
    assert.deepEqual(m.handle('p_0', { t: 'g.buy', slot: i }), OK, `buy ${id}`);
    return ps.allChess().find((p) => !before.has(p.uid));
  };
  const place = (piece) => {
    const [row, col] = legalTileFor(m, ps, piece.id);
    assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row, col } }), OK);
    return [row, col];
  };
  const activate = () => { ps.bondCountBonus.siracusaShip = 20; ps.recompute(); };
  return { h, m, ps, refresh, L, buy, place, activate };
}

// ---------------------------------------------------------------------------------------------------------------------
// #1 拉普兰德

test('#1 players\' scenario: 普罗旺斯 + 德克萨斯 deployed, refresh, buy 拉普兰德, deploy her (3 叙拉古), refresh again → 叙拉古 +4', () => {
  const s = setup();
  const { m, ps } = s;
  give(m, ps, PROVENCE, 'board', legalTileFor(m, ps, PROVENCE));
  give(m, ps, TEXAS, 'board', legalTileFor(m, ps, TEXAS));
  assert.ok(!ps.bonds.siracusaShip.active, '2 叙拉古: not active yet');
  s.refresh(); // the round's first manual refresh — no 拉普兰德 owned yet
  const lap = s.buy(LAP);
  s.place(lap);
  assert.ok(ps.bonds.siracusaShip.active, '3 different 叙拉古 on the board: active');
  const before = ps.layers.siracusaShip || 0;
  s.refresh(); // the round's 2nd refresh, her 1st
  assert.equal((ps.layers.siracusaShip || 0) - before, 4, 'the first refresh after she joined stacks +4 (the official behaviour the players report)');
  s.refresh();
  assert.equal((ps.layers.siracusaShip || 0) - before, 4, 'only her first refresh of the round');
  // the next round: her first refresh of that round stacks again
  s.h.toPrep(2);
  ps.funds = 50;
  const b2 = ps.layers.siracusaShip || 0;
  s.refresh();
  assert.equal((ps.layers.siracusaShip || 0) - b2, 4, 'R2: first refresh +4');
  s.refresh();
  assert.equal((ps.layers.siracusaShip || 0) - b2, 4, 'R2: once');
  checkInvariants(m);
  m.dispose();
});

test('#1 each copy counts its own refreshes: a bench copy (整备区时也有效) bought later fires on its own first refresh; an elite keeps "already fired"', () => {
  const s = setup();
  const { m, ps } = s;
  s.activate();
  const a = give(m, ps, LAP, 'board', legalTileFor(m, ps, LAP));
  s.refresh();
  assert.equal(s.L(), 4, 'copy A (board): its first refresh');
  const b = s.buy(LAP); // copy B stays in the hand (整备区)
  assert.equal(ps.find(b.uid).area, 'hand');
  s.refresh();
  assert.equal(s.L(), 8, 'copy B: its first refresh (A already fired this round)');
  s.refresh();
  assert.equal(s.L(), 8, 'nothing more this round');
  // the third copy completes the elite: A and B already fired this round, so the elite does not fire again this round
  // [ASSUMED: conservative — the elite keeps the highest refresh count of its copies]
  const elite = s.buy(LAP);
  assert.equal(elite.id, LAP_B, 'merged into the elite');
  assert.ok(!ps.find(a.uid) && !ps.find(b.uid), 'copies consumed');
  s.refresh();
  assert.equal(s.L(), 8, 'the elite made this round from copies that already fired: no second trigger');
  s.h.toPrep(2);
  ps.funds = 50;
  s.activate();
  s.refresh();
  assert.equal(s.L(), 8 + 8, 'R2: the elite fires +8 on the round\'s first refresh');
  checkInvariants(m);
  m.dispose();
});

test('#1 an elite merged from copies that had not fired yet this round fires on the next refresh; a re-bought copy is a new 拉普兰德', () => {
  const s = setup();
  const { m, ps } = s;
  s.activate();
  s.refresh();
  s.refresh(); // two refreshes before owning any copy
  give(m, ps, LAP, 'hand');
  give(m, ps, LAP, 'hand');
  const elite = s.buy(LAP);
  assert.equal(elite.id, LAP_B);
  s.refresh();
  assert.equal(s.L(), 8, 'the elite\'s first refresh (the round\'s 3rd) stacks +8');
  // sell it, buy a new copy: a new operator — it fires on its own first refresh (costs its price and a refresh)
  assert.deepEqual(m.handle('p_0', { t: 'g.sell', uid: elite.uid }), OK);
  s.buy(LAP);
  s.refresh();
  assert.equal(s.L(), 8 + 4, 'a newly acquired copy counts from its own first refresh');
  s.refresh();
  assert.equal(s.L(), 12);
  checkInvariants(m);
  m.dispose();
});

test('#1 only manual refreshes count: a re-triggered "刷新时" trait (ctx.triggerGarrisons) neither fires nor uses up her first refresh', () => {
  const s = setup();
  const { m, ps } = s;
  s.activate();
  const a = give(m, ps, LAP, 'hand');
  assert.equal(m.dispatcher.triggerGarrisons(ps, a, 'SERVER_REFRESH_SHOP'), 1, 'the trait ran as a trigger');
  assert.equal(s.L(), 0, 'not a manual refresh');
  s.refresh();
  assert.equal(s.L(), 4, 'her first manual refresh still counts');
  checkInvariants(m);
  m.dispose();
});

// ---------------------------------------------------------------------------------------------------------------------
// #4 突变细胞

/** Plain visible normal chess (only IN_BATTLE traits) of a tier with a free pool copy. */
const plainOf = (m, tier) => Object.values(DATA.chess)
  .filter((c) => c.visible && !c.isGolden && c.tier === tier && (c.garrisonIds || []).every((g) => DATA.garrisons[g].eventType === 'IN_BATTLE') && !m.gd.placeableTokens(c.chessId).length && m.pool.has(c.chessId) && m.pool.left(c.chessId) > 0)
  .map((c) => c.chessId).sort();
const ownedItems = (ps, id) => [...ps.hand, ...ps.temp].filter((p) => p && p.kind === 'item' && p.id === id);
const equip = (m, item, target) => m.handle('p_0', { t: 'g.equip', itemUid: item.uid, targetUid: target.uid });

test('#4 players\' report: 突变细胞 is not used up — after each battle the carrier is replaced (normal, tier +1) and the cell returns to the hand', () => {
  const s = setup({ seed: 5 });
  const { h, m, ps } = s;
  const t2 = plainOf(m, 2)[0];
  const carrier = give(m, ps, t2, 'board', legalTileFor(m, ps, t2));
  const tile = ps.find(carrier.uid).key;
  const cell = giveItem(m, ps, CELL);
  const sword = giveItem(m, ps, 'chess_item_1_01_e_a'); // 维式重锤: other equipment returns too
  assert.deepEqual(equip(m, cell, carrier), OK);
  assert.deepEqual(equip(m, sword, carrier), OK);
  h.toPrep(2);
  assert.ok(!ps.find(carrier.uid), 'the original operator is gone (原干员销毁)');
  const next = ps.board.get(tile);
  assert.ok(next && next.kind === 'chess', 'the new operator takes the tile');
  assert.equal(m.gd.chess(next.id).tier, 3, 'one tier higher');
  assert.ok(!m.gd.isGolden(next.id), 'an initial (normal) operator');
  assert.deepEqual(next.items, [], 'its equipment came off');
  assert.equal(ownedItems(ps, CELL).length, 1, 'the cell is back in the hand, not consumed');
  assert.equal(ownedItems(ps, 'chess_item_1_01_e_a').length, 1, 'the other equipment too');
  // "一直打针": inject again — the same new operator here; it climbs once more
  assert.deepEqual(equip(m, ownedItems(ps, CELL)[0], next), OK);
  h.toPrep(3);
  const third = ps.board.get(tile);
  assert.equal(m.gd.chess(third.id).tier, 4, 'tier 4 after the second battle');
  assert.equal(ownedItems(ps, CELL).length, 1, 'and the cell is back again');
  checkInvariants(m);
  m.dispose();
});

test('#4 突变细胞 details: an elite carrier → a NORMAL operator one tier higher; 6阶 → another 6阶; no room → it stays on the new operator', () => {
  {
    const s = setup({ seed: 9 });
    const { h, m, ps } = s;
    const t3 = plainOf(m, 3)[0];
    const elite = give(m, ps, m.gd.goldenIdOf(t3), 'hand');
    assert.deepEqual(equip(m, giveItem(m, ps, CELL), elite), OK);
    h.toPrep(2);
    const got = ps.allChess();
    assert.equal(got.length, 1);
    assert.equal(m.gd.chess(got[0].id).tier, 4);
    assert.ok(!m.gd.isGolden(got[0].id), 'PRTS 备注: 获得一名高一阶的随机初始干员');
    assert.equal(ownedItems(ps, CELL).length, 1);
    m.dispose();
  }
  {
    const s = setup({ seed: 10 });
    const { h, m, ps } = s;
    const t6 = plainOf(m, 6)[0] || Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && c.tier === 6 && m.pool.has(c.chessId) && m.pool.left(c.chessId) > 0).chessId;
    const top = give(m, ps, t6, 'hand');
    assert.deepEqual(equip(m, giveItem(m, ps, CELL), top), OK);
    h.toPrep(2);
    const got = ps.allChess();
    assert.equal(got.length, 1);
    assert.equal(m.gd.chess(got[0].id).tier, 6, '最高6阶');
    assert.equal(ownedItems(ps, CELL).length, 1);
    m.dispose();
  }
  {
    // hand and temp full: the cell cannot come off and stays on the new operator (nothing is lost)
    const s = setup({ seed: 11 });
    const { m, ps } = s;
    const t2 = plainOf(m, 2)[0];
    const carrier = give(m, ps, t2, 'board', legalTileFor(m, ps, t2));
    assert.deepEqual(equip(m, giveItem(m, ps, CELL), carrier), OK);
    const at = ps.find(carrier.uid).key;
    for (let i = 0; i < ps.hand.length; i++) if (!ps.hand[i]) giveItem(m, ps, 'chess_item_1_01_e_a', 'hand', i);
    for (let i = 0; i < ps.temp.length; i++) if (!ps.temp[i]) giveItem(m, ps, 'chess_item_1_01_e_a', 'temp', i);
    m.dispatch(ps, 'onBattleResult', { result: {}, lpLoss: 0, perfect: true });
    const next = ps.board.get(at);
    assert.ok(next && next.uid !== carrier.uid && m.gd.chess(next.id).tier === 3);
    assert.deepEqual(next.items.map((it) => it.id), [CELL], 'kept on the new operator');
    checkInvariants(m);
    m.dispose();
  }
});

test('#4 strategy 昆图斯 end to end: the R3 cell survives its first transformation; a bot injects its weakest single normal operator, never an elite', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 21, registry: REG, fake: true }).start();
  const m = h.m;
  h.toPrep(1, { band: 'band_quintus' });
  const ps = h.ps('p_0');
  assert.equal(ps.bandId, 'band_quintus');
  h.toPrep(3, { band: 'band_quintus' });
  assert.equal(ownedItems(ps, CELL).length, 1, 'R3: the strategy grants the cell');
  // equip it on a deployed operator (any) and play the R3 battle
  const target = ps.allChess()[0] || give(m, ps, plainOf(m, 1)[0], 'board', legalTileFor(m, ps, plainOf(m, 1)[0]));
  assert.deepEqual(equip(m, ownedItems(ps, CELL)[0], target), OK);
  h.toPrep(4);
  const owned = [...ownedItems(ps, CELL), ...ps.allChess().flatMap((p) => (p.items || []).filter((it) => it.id === CELL))];
  assert.equal(owned.length, 1, 'R4: the cell is still owned after its transformation');
  m.dispose();

  // the bot's choice: its least valuable single normal operator below 6阶 — never an elite, a merge pair or a 6阶
  const s = setup({ seed: 23 });
  const { m: m2, ps: p2 } = s;
  const [t1a, t1b] = plainOf(m2, 1);
  const t3 = plainOf(m2, 3)[0];
  const t6 = Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && c.tier === 6 && m2.pool.has(c.chessId) && m2.pool.left(c.chessId) > 0).chessId;
  const elite = give(m2, p2, m2.gd.goldenIdOf(t3), 'board', legalTileFor(m2, p2, t3));
  const pair = [give(m2, p2, t1a, 'board', legalTileFor(m2, p2, t1a)), give(m2, p2, t1a, 'hand')];
  const top = give(m2, p2, t6, 'hand');
  assert.equal(cellTarget(m2, p2), null, 'no candidate: the cell waits in the hand');
  const single = give(m2, p2, t1b, 'board', legalTileFor(m2, p2, t1b));
  assert.equal(cellTarget(m2, p2).uid, single.uid, 'the single normal operator');
  void elite; void pair; void top;
  // through the whole bot prep (it may buy, sell and move first): whoever carries the cell is a normal operator below 6阶
  p2.isBot = true;
  giveItem(m2, p2, CELL);
  botPrep(m2, p2);
  const carrierOf = p2.allChess().find((p) => (p.items || []).some((it) => it.id === CELL));
  assert.ok(carrierOf, 'the bot equipped the cell');
  assert.ok(!m2.gd.isGolden(carrierOf.id) && m2.gd.tierOf(carrierOf.id) < 6, 'never an elite or a 6阶');
  m2.dispose();
});

// ---------------------------------------------------------------------------------------------------------------------
// #4 follow-up: the returned cell must not be pushed into temp by the new operator's summon card (it would be lost at
// the deadline), and a bot never throws it away

const VIGIL = 'chess_char_3_19_a'; // 伺夜 (Ⅲ) — a placeable 狼群 summon card
/** Distinct normal equipment ids (never merge with each other), the cell excluded. */
const fillerItems = () => Object.values(DATA.items).filter((it) => it.itemType === 'EQUIP' && !it.isGolden && it.id !== CELL).map((it) => it.id).sort();
/** Fill every free hand slot but `leave` with distinct items. */
const fillHand = (m, ps, leave = 1) => {
  const ids = fillerItems().filter((id) => ![...ps.hand, ...ps.temp].some((p) => p && p.id === id));
  while (ps.hand.filter((x) => x == null).length > leave) giveItem(m, ps, ids.shift());
};
/** Force the cell's roll (the random draw) to 伺夜 for tier 3; everything else stays the real path. */
const forceVigil = (m) => { const roll = m.pool.roll.bind(m.pool); m.pool.roll = (rng, o = {}) => (o.tier === 3 ? VIGIL : roll(rng, o)); };
const where = (ps, pred) => (ps.hand.some((p) => p && pred(p)) ? 'hand' : ps.temp.some((p) => p && pred(p)) ? 'temp' : null);

test('#4 one free hand slot, the new operator brings a summon card: the returned cell takes the slot, the card waits in temp', () => {
  const s = setup({ seed: 31 });
  const { m, ps } = s;
  forceVigil(m);
  const t2 = plainOf(m, 2)[0];
  const carrier = give(m, ps, t2, 'board', legalTileFor(m, ps, t2));
  const at = ps.find(carrier.uid).key;
  assert.deepEqual(equip(m, giveItem(m, ps, CELL), carrier), OK);
  fillHand(m, ps, 1);
  m.dispatch(ps, 'onBattleResult', { result: {}, lpLoss: 0, perfect: true });
  const next = ps.board.get(at);
  assert.equal(next && next.id, VIGIL, '伺夜 takes the carrier\'s tile');
  assert.equal(where(ps, (p) => p.id === CELL), 'hand', 'the cell came back into the hand (it would be lost in temp at the deadline)');
  assert.equal(where(ps, (p) => p.kind === 'token' && p.ownerUid === next.uid), 'temp', 'the 狼群 card overflows into temp (it comes back at the next round start)');
  checkInvariants(m);
  m.dispose();
});

test('#4 the transformation completes a merge on the board: the cell is returned before the elite\'s summon card', () => {
  const s = setup({ seed: 32 });
  const { m, ps } = s;
  forceVigil(m);
  const copies = [give(m, ps, VIGIL, 'board', legalTileFor(m, ps, VIGIL))];
  copies.push(give(m, ps, VIGIL, 'board', legalTileFor(m, ps, VIGIL)));
  for (const c of copies) ps.removeTokensOf(c.uid); // keep the hand count exact
  const t2 = plainOf(m, 2)[0];
  const carrier = give(m, ps, t2, 'board', legalTileFor(m, ps, t2));
  assert.deepEqual(equip(m, giveItem(m, ps, CELL), carrier), OK);
  fillHand(m, ps, 1);
  m.dispatch(ps, 'onBattleResult', { result: {}, lpLoss: 0, perfect: true });
  const elite = [...ps.board.values()].find((p) => p.id === m.gd.goldenIdOf(VIGIL));
  assert.ok(elite, 'the elite 伺夜 is deployed on a consumed copy\'s tile');
  assert.equal(where(ps, (p) => p.id === CELL), 'hand', 'the cell is in the hand');
  assert.equal(where(ps, (p) => p.kind === 'token' && p.ownerUid === elite.uid), 'temp', 'the elite\'s 狼群 card in temp');
  checkInvariants(m);
  m.dispose();
});

test('#10 AI 托管 never destroys a human\'s item to clear temp: a bench operator is sold for its slot instead', () => {
  const s = setup({ seed: 34 });
  const { m, ps } = s;
  ps.autoplay = true;                                  // a human seat under AI 托管 (ps.isBot stays false)
  const elites = [1, 2, 3, 4, 5, 6].flatMap((t) => plainOf(m, t)).map((id) => m.gd.goldenIdOf(id)).filter((g) => g && m.pool.left(m.gd.baseIdOf(g)) >= m.gd.goldenCopies);
  while (ps.hand.some((x) => x == null)) give(m, ps, elites.shift(), 'hand');
  const item = Object.values(DATA.items).find((it) => it && it.id !== CELL && !it.isGolden && it.price > 0 && /_e_a$/.test(it.id));
  giveItem(m, ps, item.id, 'temp');
  botPrepEnd(m, ps);
  assert.equal(ownedItems(ps, item.id).length, 1, `${item.name}: kept (it used to be destroyed when the hand was full)`);
  assert.ok(ps.tempEmpty, 'temp resolved');
  checkInvariants(m);
  m.dispose();
});

test('#4 a bot never destroys the cell: left in temp with a full hand and nobody to inject, it gets a hand slot', () => {
  const s = setup({ seed: 33 });
  const { m, ps } = s;
  ps.isBot = true;
  const elites = [1, 2, 3, 4, 5, 6].flatMap((t) => plainOf(m, t)).map((id) => m.gd.goldenIdOf(id)).filter((g) => g && m.pool.left(m.gd.baseIdOf(g)) >= m.gd.goldenCopies);
  for (let i = 0; i < 8; i++) { const id = elites.shift(); give(m, ps, id, 'board', legalTileFor(m, ps, id)); }
  while (ps.hand.some((x) => x == null)) give(m, ps, elites.shift(), 'hand');
  giveItem(m, ps, CELL, 'temp');
  assert.equal(cellTarget(m, ps), null, 'elites only: nobody to inject');
  botPrepEnd(m, ps); // the end of the bot's prep: temp → hand / sell / destroy, a free hand slot, Ready
  assert.equal(ownedItems(ps, CELL).length, 1, 'the bot kept its strategy item (a hand chess was sold for the slot)');
  assert.ok(ps.tempEmpty, 'temp resolved');
  checkInvariants(m);
  m.dispose();
});
