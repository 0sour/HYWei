// Player feedback after 0.1.0, report #2 (workstream WB): "本来应该后期出的悬赏的怪物在前期的悬赏就出现了，导致选了打不过".
// The 悬赏决策 draft of the first half (co-op / solo 绝境 · 终极 R3, 险境 co-op R3 / R6) offered boss bounties (碎骨, W,
// 弑君者, 萨卡兹百夫长, 鼠王, 庞贝, 大鲍勃), second-half specials (尖端萨卡兹枯朽战车, 假想敌：蚀裂 / 淤困 …, 法术大师A2,
// 灼藤, 重弩突袭者) and their upgraded variants (新硎, 家族暗影灭迹人, 异光体孽生者 …): the card tier read from the I/II/III
// suffix, the boss bounties' small coin values and the multi-round cards' fixed tier 2 all passed the R3 tier window
// [1, 2]. Evidence (tools/build-data.mjs bountyDraftHalf): the one official co-op draft screenshot shows six boss
// bounties with coins 1–6 together at team LP 6 / 10 / 9 / 15 (a late draft); in the faction series 12 of the 18
// "接下来两场作战" cards bring first-half enemies (5 bring enemies outside the wave tables, enemyeffect_12_4 底海滑动者
// one attached only to second-half specials) and no "下场作战" card a first-half one — a trend, not a rule. Now a
// first-half draft (R ≤ 7, the official wave generator's half) offers the two-battle cards, a draft from R8 on the
// next-battle and multi-round cards ([ASSUMED] beyond that evidence: the 假想敌 cards are named enemyInitial_*, which
// could point at the early draft — kept late, a question for the user). Real data, real draft code, the real match path
// for the players' scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch } from './harness.js';
import { FakeBattle } from './fakeBattle.js';
import { GameData } from '../../server/match/gamedata.js';
import { generateDraft, bountyDraftHalf, MULTI_ROUND_BOUNTY_BATTLES } from '../../server/match/choices.js';
import { createRng } from '../../server/sim/rng.js';

const BOUNTY_MODES = ['mode_multi_normal', 'mode_multi_hard', 'mode_multi_abyss', 'mode_single_hard', 'mode_single_abyss'];
const CARD = new Map(DATA.choices.cards.bounty.map((c) => [c.effectId, c]));
const isBoss = (key) => DATA.enemies[key] && DATA.enemies[key].rank === 'BOSS';

/** The official wave generator's halves (activity_table specialEnemyInfoDict isInFirstHalf), when the cache has it. */
function officialHalves() {
  const p = new URL('../../.cache/gamedata/excel/activity_table.json', import.meta.url);
  if (!existsSync(p)) return null;
  const act = JSON.parse(readFileSync(p, 'utf8')).activity.AUTOCHESS_SEASON.act2autochess;
  const first = new Set(), second = new Set();
  for (const v of Object.values(act.specialEnemyInfoDict)) (v.isInFirstHalf ? first : second).add(v.specialEnemyKey);
  return { first, second, secondOnly: new Set([...second].filter((k) => !first.has(k))) };
}

/** Every bounty draft of every bounty mode and SP round over `seeds` seeds: [{ modeId, round, cards }]. */
function drafts(seeds = 30) {
  const out = [];
  for (const modeId of BOUNTY_MODES) {
    const gd = new GameData(DATA, modeId);
    for (const r of DATA.choices.schedule[modeId].spRounds) {
      for (let seed = 1; seed <= seeds; seed++) {
        const d = generateDraft(gd, createRng(seed * 7919 + r * 31), r, { stageId: 'act2autochess_m01' });
        if (d && d.family === 'bounty') out.push({ modeId, round: r, cards: d.cards });
      }
    }
  }
  return out;
}

test('#2 data: every drafted bounty card names its draft half — the "接下来两场作战" cards the first, the "下场作战" and multi-round cards the second', () => {
  let first = 0, second = 0;
  for (const c of DATA.choices.cards.bounty) {
    if (!c.draft) { assert.equal(c.draftHalf, null, `${c.effectId}: not drafted, no half`); continue; }
    assert.equal(c.draftHalf, c.rounds === 2 ? 1 : 2, `${c.effectId} ${c.name} (${c.rounds} battles): half ${c.draftHalf}`);
    if (c.draftHalf === 1) first++; else second++;
  }
  assert.equal(first, 42, '42 two-battle cards (6 faction series × I–III, 4 sets of 6)');
  assert.equal(second, 63, '56 next-battle cards (incl. 源石虫·特训, 24 boss bounties) + 7 multi-round cards');
  assert.equal(bountyDraftHalf(3), 1);
  assert.equal(bountyDraftHalf(7), 1);
  assert.equal(bountyDraftHalf(8), 2);
  assert.equal(bountyDraftHalf(9), 2);
});

test('#2 data cross-check (official tables): no first-half card brings a boss or a second-half-only special; every such card is a second-half card', (t) => {
  const halves = officialHalves();
  if (!halves) { t.skip('no .cache/gamedata (run tools/build-data.mjs once)'); return; }
  let late = 0;
  for (const c of DATA.choices.cards.bounty) {
    if (!c.draft) continue;
    const lateEnemy = isBoss(c.enemyKey) || halves.secondOnly.has(c.enemyKey);
    if (c.draftHalf === 1) assert.ok(!lateEnemy, `${c.effectId} ${c.name}: ${DATA.enemies[c.enemyKey].name} is a boss / second-half special`);
    if (lateEnemy) { assert.equal(c.draftHalf, 2, `${c.effectId} ${c.name}`); late++; }
  }
  assert.ok(late >= 30, `${late} cards with a boss or a second-half special`);
  // the rule follows the battle count: the faction series' _4–_6 (two battles) are first-half cards, _7 / _8 (next
  // battle) second-half ones — whatever wave half their enemy has (enemyeffect_12_4 底海滑动者 is a second-half
  // attachment, yet a two-battle card)
  for (const s of [10, 11, 12, 13, 14, 15]) {
    for (const i of [4, 5, 6]) assert.equal(CARD.get(`enemyeffect_${s}_${i}`).draftHalf, 1, `enemyeffect_${s}_${i}`);
    for (const i of [7, 8]) assert.equal(CARD.get(`enemyeffect_${s}_${i}`).draftHalf, 2, `enemyeffect_${s}_${i}`);
  }
});

test('#2 the first-half drafts (R3, 险境 R6) offer only two-battle cards: no boss, no second-half special, no multi-round card', () => {
  const halves = officialHalves();
  let early = 0, cards = 0;
  for (const d of drafts()) {
    if (d.round > 7) continue;
    early++;
    for (const c of d.cards) {
      cards++;
      const card = CARD.get(c.id);
      assert.equal(card.rounds, 2, `${d.modeId} R${d.round}: ${c.id} ${c.name} lasts ${card.rounds} battle(s) — a later draft's card`);
      assert.ok(!isBoss(c.enemyKey), `${d.modeId} R${d.round}: ${c.name} — a boss bounty in the first half`);
      if (halves) assert.ok(!halves.secondOnly.has(c.enemyKey), `${d.modeId} R${d.round}: ${c.name} — a second-half special`);
      assert.ok(!card.multiRound, `${d.modeId} R${d.round}: ${c.name} — a multi-round card`);
    }
  }
  assert.ok(early >= 100 && cards >= 400, `${early} first-half bounty drafts, ${cards} cards`);
});

test('#2 the second-half drafts (R9) offer the next-battle and multi-round cards — boss bounties of every coin value among them (the official screenshot: 碎骨 1 … “复仇者” 6)', () => {
  const coins = new Set();
  let late = 0, multi = 0;
  for (const d of drafts(60)) {
    if (d.round < 8) continue;
    late++;
    for (const c of d.cards) {
      const card = CARD.get(c.id);
      assert.notEqual(card.rounds, 2, `${d.modeId} R${d.round}: ${c.id} ${c.name} — a first-half (two-battle) card`);
      if (isBoss(c.enemyKey)) coins.add(c.coin);
      if (card.multiRound) {
        multi++;
        assert.equal(c.rounds, MULTI_ROUND_BOUNTY_BATTLES, 'a multi-round card still lasts two battles (settled, DESIGN §20.9)');
      }
    }
  }
  assert.ok(late >= 100, `${late} second-half drafts`);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(coins.has(n), `a boss bounty worth ${n} was offered (seen: ${[...coins].sort().join(', ')})`);
  assert.ok(multi > 0, 'multi-round cards are offered in the second half');
});

test('#2 the mode\'s inactive enemy list does not thin the bounty draft (PRTS 卫戍协议：盟约 11/18 note "不影响悬赏决策出场")', () => {
  const gd = new GameData(DATA, 'mode_multi_normal');
  const dropped = ['enemy_1272_nhtank_2', 'enemy_10067_ftsjc', 'enemy_9008_acbunn'];
  for (const k of dropped) assert.ok(gd.inactiveEnemies.has(k), `${k} is inactive in 险境 waves`);
  const seen = new Set();
  for (let seed = 1; seed <= 400 && seen.size < dropped.length; seed++) {
    const d = generateDraft(gd, createRng(seed), 9, { stageId: 'act2autochess_m01' });
    if (d && d.family === 'bounty') for (const c of d.cards) if (dropped.includes(c.enemyKey)) seen.add(c.enemyKey);
  }
  assert.deepEqual([...seen].sort(), dropped.slice().sort(), 'the three bounties stay in 险境\'s second-half drafts');
});

test('#2 E2E (co-op 绝境, the players\' case): the real R3 draft offers no late bounty, and the picked enemy comes for R3 and R4 at their round scale', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 1, seed: 910 + seed, fake: true }).start();
    const m = h.m;
    assert.ok(h.drive(() => m.phase === PHASE.SP_DRAFT && m.round === 3, { ready: true }), 'the R3 draft');
    assert.equal(m.sp.family, 'bounty', 'R3 of 绝境 is always a bounty draft');
    const names = m.sp.cards.map((c) => `${c.name}(${CARD.get(c.id).rounds})`).join(', ');
    for (const c of m.sp.cards) {
      assert.equal(CARD.get(c.id).draftHalf, 1, `seed ${seed}: ${names}`);
      assert.ok(!isBoss(c.enemyKey), `seed ${seed}: ${c.name} is a boss bounty`);
    }
    assert.equal(m.publicView().sp.cards.length, m.sp.cards.length);
    // the human takes a card when its turn comes; the bot picks by itself
    let picked = null;
    for (let guard = 0; guard < 200 && m.phase === PHASE.SP_DRAFT; guard++) {
      if (m.spTurn() === 'p_0') {
        picked = m.sp.cards.find((c) => m.sp.taken[c.idx] == null);
        assert.deepEqual(m.handle('p_0', { t: 'g.choice', idx: picked.idx }), { ok: true });
      } else h.sched.runNext();
    }
    assert.ok(picked, 'the human picked');
    const b = h.ps('p_0').bounties.find((x) => x.card.effectId === picked.id);
    assert.ok(b, 'the picker holds the bounty');
    h.drive(() => m.phase === PHASE.ROUND_START && m.round === 6, { ready: true });
    const rounds = [];
    for (const f of FakeBattle.instances) {
      if (f.kind !== 'normal' || !f.players.includes('p_0')) continue;
      const spec = f.spawns.find((s) => s.tag === 'bounty' && s.mods && s.mods.bountyId === b.id);
      if (!spec) continue;
      rounds.push(f.round);
      const scale = m.gd.enemyScale(f.round);
      assert.equal(spec.mods.hpMul, scale.hpMul, `R${f.round}: the bounty enemy takes the round's HP scale`);
      assert.equal(spec.mods.atkMul, scale.atkMul, `R${f.round}: the bounty enemy takes the round's ATK scale`);
    }
    assert.deepEqual(rounds, [3, 4], `seed ${seed}: ${picked.name} (两场作战) spawned in R${rounds.join(', R')}`);
    m.dispose();
  }
});
