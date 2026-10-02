// AI player after the 0.1.0 player feedback (#10 "目前的人机有点太笨了", server/match/bot.js): bounty picks against the
// own board, item carriers by what the item does, a tactician's 援军 inside its attack range, pairs completed through
// the shop freeze, and a cost guard on the prep heuristics. The outcome numbers (old vs new bot on the same seeds) are
// measured with tools/botbench.mjs (docs/META.md §1.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { botPickCard, bountyKillChance, itemTarget, arrange, botPrepBegin, rangeTiles } from '../../server/match/bot.js';
import { parseKey } from '../../server/match/board.js';
import { makeMatch, checkInvariants, give, giveItem, DATA } from './harness.js';

const soloBot = (o = {}) => makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats: [{ seat: 0, playerId: 'ai_0', name: 'AI', isBot: true, connected: true }], ...o });

/** A 悬赏决策 card as the draft builds it (choices.js buildCards), by its enemy's name. */
function bountyCard(enemyName) {
  const c = DATA.choices.cards.bounty.find((x) => x.draft && DATA.enemies[x.enemyKey] && DATA.enemies[x.enemyKey].name === enemyName);
  assert.ok(c, `a draft bounty with ${enemyName}`);
  return { kind: 'bounty', id: c.effectId, name: c.name, tier: c.tier, coin: c.coin, payout: c.payout, rounds: c.rounds >= 90 ? 2 : c.rounds, enemyKey: c.enemyKey, count: c.count };
}

test('bounty pick: the card the own board can beat, never one it cannot (even when that one pays more)', () => {
  const h = soloBot({ seed: 5, difficulty: 'HARD' }).start();
  const m = h.m;
  const ps = m.order[0];
  h.run(() => m.phase === PHASE.PREP && m.round === 1);
  ps.lp = 999;
  h.run(() => m.phase === PHASE.PREP && m.round === 5);
  assert.ok(ps.deployCount >= 6, `a board (${ps.deployCount} deployed)`);
  const easy = bountyCard('源石虫'); // 550 HP, pays nothing
  const hard = bountyCard('泥岩巨像'); // 100000 HP, pays 3
  const huge = bountyCard('纠缠藤蔓'); // 90000 HP, pays 3
  const pe = bountyKillChance(m, ps, easy);
  const ph = bountyKillChance(m, ps, hard);
  assert.ok(pe > 0.8, `the board kills a 源石虫 (p ${pe.toFixed(2)})`);
  assert.ok(ph < 0.3, `…but not a 泥岩巨像 (p ${ph.toFixed(2)})`);
  assert.equal(botPickCard(m, ps, [hard, easy, huge].map((c, idx) => ({ ...c, idx })), [0, 1, 2]), 1);
  ps.lp = 2;
  assert.equal(botPickCard(m, ps, [hard, huge, easy].map((c, idx) => ({ ...c, idx })), [0, 1, 2]), 2, 'low LP: still the beatable one');
  m.dispose();
});

test('bounty pick in real drafts (绝境 R3 悬赏决策): never a card the board cannot beat while a beatable one is offered', () => {
  let drafts = 0;
  for (const seed of [1, 2, 3, 4]) {
    const h = soloBot({ seed, difficulty: 'HARD', fake: true }).start();
    const m = h.m;
    const apply = m._applyCard.bind(m);
    m._applyCard = (ps, idx) => {
      const cards = m.sp ? m.sp.cards : [];
      if (cards.length && cards.every((c) => c.kind === 'bounty')) {
        drafts++;
        const p = cards.map((c) => bountyKillChance(m, ps, c));
        const best = Math.max(...p);
        const picked = p[cards.findIndex((c) => c.idx === idx)];
        if (best >= 0.9) assert.ok(picked >= 0.5, `seed ${seed} R${m.round}: picked p ${picked.toFixed(2)} while ${best.toFixed(2)} was offered`);
      }
      return apply(ps, idx);
    };
    h.run(() => m.phase === PHASE.PREP && m.round === 1);
    m.order[0].lp = 999;
    h.run(() => m.phase === PHASE.PREP && m.round === 4);
    assert.equal(m.errorCount, 0);
    m.dispose();
  }
  assert.ok(drafts >= 4, `${drafts} bounty drafts seen`);
});

test('items: 信标 never on the lineup when a bench single can take it; 博士投影 on a normal deployed operator; 突变细胞 on the weakest one below VI; 拟态物质 on a pair', () => {
  const h = soloBot({ seed: 6 }).start();
  const m = h.m;
  const ps = m.order[0];
  h.run(() => m.phase === PHASE.PREP && m.round === 1);
  ps.lp = 999;
  h.run(() => m.phase === PHASE.ROUND_START && m.round === 7);
  const deployed = () => [...ps.board.values()].filter((p) => p.kind === 'chess');
  assert.ok(deployed().length >= 6);
  const owned = new Set(ps.allChess().map((p) => m.gd.baseIdOf(p.id)));
  const fresh = (tier) => Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && c.tier === tier && m.pool.left(c.chessId) >= 3 && !owned.has(c.chessId)).chessId;
  for (const p of ps.hand) if (p && p.kind === 'chess') ps.returnCopies(p);
  ps.hand.fill(null);
  const single = give(m, ps, fresh(4), 'hand');
  const pairId = fresh(1);
  const pairA = give(m, ps, pairId, 'hand');
  const pairB = give(m, ps, pairId, 'hand');
  const tierOf = (p) => m.gd.chess(p.id).tier;
  // 信标 (destroys its carrier for a pick of two of its tier)
  const beacon = itemTarget(m, ps, giveItem(m, ps, 'chess_item_5_04_e_a'));
  assert.equal(beacon && beacon.uid, single.uid, '信标 on the bench single');
  // 博士投影 (promotion): a normal operator on the board
  const promo = itemTarget(m, ps, giveItem(m, ps, 'chess_item_5_06_e_a'));
  assert.ok(promo && deployed().includes(promo) && !m.gd.isGolden(promo.id), '博士投影 on a normal deployed operator');
  // 突变细胞 (becomes a random tier + 1 operator after the battle): deployed, normal, below VI, not the strongest
  const cell = itemTarget(m, ps, giveItem(m, ps, 'chess_item_5_08_e_a'));
  assert.ok(cell && deployed().includes(cell) && !m.gd.isGolden(cell.id) && tierOf(cell) < 6, '突变细胞 on a normal deployed operator below VI');
  assert.notEqual(cell.uid, promo.uid, 'the promotion target (the strongest) is not the one mutated');
  // 拟态物质 (a third copy when two are owned): the pair
  const mimic = itemTarget(m, ps, giveItem(m, ps, 'chess_item_5_05_e_a'));
  assert.ok(mimic && [pairA.uid, pairB.uid].includes(mimic.uid), '拟态物质 on the pair');
  m.dispose();
});

test('a tactician\'s 援军 (伺夜\'s 狼群) is placed on a tactical point inside the tactician\'s attack range', () => {
  const VIGIL = 'chess_char_3_19_a';
  const WOLF = 'token_10028_vigil_wolf';
  for (const seed of [3, 8]) {
    const h = soloBot({ seed }).start();
    const m = h.m;
    const ps = m.order[0];
    h.run(() => m.phase === PHASE.PREP && m.round === 2);
    for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
    ps.board.clear();
    ps.hand.fill(null);
    ps.recompute();
    const vigil = give(m, ps, VIGIL, 'hand');
    const melee = Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden && c.tier === 1 && c.position === 'MELEE' && c.attackKind === 'melee').slice(0, 2);
    for (const c of melee) give(m, ps, c.chessId, 'hand');
    arrange(m, ps);
    const at = [...ps.board.entries()].find(([, p]) => p.uid === vigil.uid);
    assert.ok(at, '伺夜 deployed');
    const wolf = [...ps.board.entries()].find(([, p]) => p.kind === 'token' && p.id === WOLF);
    assert.ok(wolf, `seed ${seed}: the 狼群 is placed`);
    const [r, c] = parseKey(at[0]);
    assert.ok(rangeTiles(m.gd.chess(VIGIL), r, c, at[1].dir || 'RIGHT').includes(wolf[0]), `seed ${seed}: 狼群 at ${wolf[0]} inside 伺夜's range from ${at[0]}`);
    checkInvariants(m);
    m.dispose();
  }
});

test('economy: a held pair is completed — bought when affordable, else the shop is frozen and the copy bought next round', () => {
  const h = soloBot({ seed: 9 }).start();
  const m = h.m;
  const ps = m.order[0];
  h.run(() => m.phase === PHASE.PREP && m.round === 1);
  ps.lp = 999;
  h.run(() => m.phase === PHASE.ROUND_START && m.round === 6);
  const owned = new Set(ps.allChess().map((p) => m.gd.baseIdOf(p.id)));
  const id = Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && c.tier === 2 && m.pool.left(c.chessId) >= 4 && !owned.has(c.chessId)).chessId;
  for (const p of ps.hand) if (p && p.kind === 'chess') ps.returnCopies(p);
  ps.hand.fill(null);
  give(m, ps, id, 'hand');
  give(m, ps, id, 'hand');
  h.run(() => m.phase === PHASE.PREP && m.round === 6);
  // the third copy in the shop, unaffordable this prep
  ps.funds = 0;
  ps.shop.slots[0] = { kind: 'chess', id, basePrice: m.gd.chessPrice(id), price: m.gd.chessPrice(id), sold: false, frozen: false };
  const merges = ps.stats.merges;
  h.run(() => m.phase === PHASE.COMBAT && m.round === 6);
  if (ps.stats.merges === merges) {
    assert.ok(ps.shop.slots[0] && ps.shop.slots[0].id === id && ps.shop.slots[0].frozen, 'the shop was frozen with the third copy in it');
    h.run(() => m.phase === PHASE.COMBAT && m.round === 7);
  }
  assert.ok(ps.stats.merges > merges, 'the pair was completed');
  assert.ok(ps.allChess().some((p) => p.id === m.gd.goldenIdOf(id)), 'the elite is owned');
  checkInvariants(m);
  m.dispose();
});

test('cost guard: the prep heuristics of a late-round 4-bot match stay cheap (rehearsal off)', () => {
  const seats = [0, 1, 2, 3].map((i) => ({ seat: i, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true }));
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats, seed: 13, fake: true }).start();
  const m = h.m;
  h.run(() => m.phase === PHASE.PREP && m.round === 1);
  for (const ps of m.order) ps.lp = 999;
  h.run(() => m.phase === PHASE.PREP && m.round === 10);
  let worst = 0;
  for (const ps of m.alivePlayers()) {
    // CPU time (process.cpuUsage) rather than wall clock: a loaded host stretches it far less
    const u0 = process.cpuUsage();
    assert.equal(botPrepBegin(m, ps), null, 'no rehearsal job with rehearsal off');
    const u = process.cpuUsage(u0);
    worst = Math.max(worst, (u.user + u.system) / 1000);
  }
  // ≈ 10–40 ms on a quiet desktop (tools/botbench.mjs); the bound only catches an accidental blow-up
  assert.ok(worst < 1500, `worst bot prep ${worst.toFixed(1)} ms of CPU`);
  assert.equal(m.errorCount, 0);
  m.dispose();
});
