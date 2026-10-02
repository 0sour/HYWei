// Player feedback after 0.1.0, report #2 (workstream WB): "本来应该后期出的悬赏的怪物在前期的悬赏就出现了，导致选了打不过".
// The user then collected the official 悬赏决策 of rounds 3, 9 and 11 in 11 official co-op matches (33 screenshots, 绝境 /
// 终极; the readings are test/fixtures/official-bounty-drafts.json, player names left out). They settle the draft rules
// (tools/build-data.mjs BOUNTY_INITIAL_SETS, server/match/choices.js bountyDraftCards):
//   R3  six "接下来两场作战" cards, 3 × I + 2 × II + 1 × III, one of the official fixed sets (a whole series 17 / 18 / 19,
//       or one card from each of 6 of the series 10–15 / 20) — 7 of the 10 events seen;
//   R9  boss bounties + 源石虫·特训: a group of named bosses that come together + cheap ones to 6;
//   R11 悬赏决策 / 机密商店 / 战术决策 (never 道具补给); its bounty: one 特异III giant + 5 "下场战斗" cards, at most one per
//       faction series;
//   no draft shows a multi-round card, a pre-series card (enemyeffect_3_*), 战术特训 or the 鸭爵 set; no card twice.
// Each card's enemy is fixed by its effect; the title only names category and tier (悬赏·损伤I = 底海滑动者 in
// enemyeffect_12_4, 临时收音师 in enemyeffect_18_1). Real data, real draft code, the real match path for the players' case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch } from './harness.js';
import { FakeBattle } from './fakeBattle.js';
import { GameData } from '../../server/match/gamedata.js';
import { generateDraft, bountyDraftKind } from '../../server/match/choices.js';
import { createRng } from '../../server/sim/rng.js';

const OFFICIAL = JSON.parse(readFileSync(new URL('../fixtures/official-bounty-drafts.json', import.meta.url), 'utf8'));
const CARDS = DATA.choices.cards.bounty;
const CARD = new Map(CARDS.map((c) => [c.effectId, c]));
const SPEC = DATA.choices.bountyDrafts;
const COOP_BOUNTY_MODES = ['mode_multi_normal', 'mode_multi_hard', 'mode_multi_abyss'];
const isBoss = (key) => DATA.enemies[key] && DATA.enemies[key].rank === 'BOSS';
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** The data card of a screenshot reading [title, enemy, coins, battles] (by title, the enemy in the text, coins, battles). */
function resolve([title, enemy, coin, battles]) {
  const name = OFFICIAL.aliases[enemy] || enemy;
  const hits = CARDS.filter((c) => c.name === title && c.coin === coin && (c.desc.includes(`1只${name}`) || c.desc.includes(`1个${name}`))
    && (battles === 2 ? c.rounds === 2 : c.rounds === 1));
  assert.equal(hits.length, 1, `${title} ${enemy} ${coin}: ${hits.map((c) => c.effectId).join(', ') || 'no card'}`);
  return hits[0].effectId;
}
/** Every official draft of the fixture: [{ where, round, family, ids? }] (ids for 悬赏决策). */
function officialDrafts() {
  const out = [];
  for (const [match, rounds] of Object.entries(OFFICIAL.matches)) {
    for (const [round, d] of Object.entries(rounds)) out.push({ where: `match ${match} R${round}`, round: Number(round), family: d.family, ids: d.family === 'bounty' ? d.cards.map(resolve) : null });
  }
  for (const [key, d] of Object.entries(OFFICIAL.extra)) out.push({ where: key, round: 9, family: d.family, ids: d.cards.map(resolve) });
  return out;
}
const tiersOf = (ids) => ids.map((id) => CARD.get(id).tier).sort().join('');

/** The rule of the unseen R3 slots (and of the seen mixed sets): one card from each of 6 of the series, I I I II II III. */
function mixedRule(ids) {
  const mx = SPEC.initial.mixed;
  const series = ids.map((id) => CARD.get(id).series);
  return ids.length === mx.count && ids.every((id) => CARD.get(id).draftPool === 'initial') && new Set(series).size === series.length
    && series.every((s) => mx.series.includes(s)) && tiersOf(ids) === mx.tiers.slice().sort().join('');
}
/** Which official R3 structure a set of ids is: 'set:<i>' (a seen set), 'mixed' (the unseen-slot rule) or null. */
function initialFit(ids) {
  const i = SPEC.initial.sets.findIndex((s) => sameSet(s.cards, ids));
  if (i >= 0) return `set:${i}`;
  return mixedRule(ids) ? 'mixed' : null;
}
/** The R9 groups a set of ids fits (its featured bosses all there, the rest from the group's fill). */
const bossFits = (ids) => SPEC.boss.templates.map((t, i) => [t, i]).filter(([t]) => ids.length === SPEC.boss.count
  && t.featured.every((id) => ids.includes(id)) && ids.filter((id) => !t.featured.includes(id)).every((id) => t.fill.includes(id))).map(([, i]) => i);
/** Whether a set of ids follows the R11 rule (one giant, the rest from the next-battle cards, one per faction series). */
function hunterFits(ids) {
  const h = SPEC.hunter;
  const anchors = ids.filter((id) => h.anchors.includes(id));
  const rest = ids.filter((id) => !h.anchors.includes(id));
  const series = rest.map((id) => CARD.get(id).series).filter((s) => h.onePerSeries.includes(s));
  return ids.length === h.count && anchors.length === h.anchorCount && rest.every((id) => h.rest.includes(id)) && new Set(series).size === series.length;
}

/** Bounty drafts generated for `modeId` at `round` over `seeds` seeds. */
function drafts(modeId, round, seeds, data = DATA) {
  const gd = new GameData(data, modeId);
  const out = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const d = generateDraft(gd, createRng(seed * 7919 + round * 31), round, { stageId: 'act2autochess_m01' });
    if (d && d.family === 'bounty') out.push(d);
  }
  return out;
}

test('#2 screenshots → data: every card read is one act2autochess (下半) effect, whose enemy_id is the enemy the card brings', (t) => {
  const seen = new Set();
  for (const d of officialDrafts()) for (const id of d.ids || []) seen.add(id);
  assert.equal(seen.size, 72, 'distinct cards in the 27 bounty drafts: 36 at R3, 20 at R9, 16 at R11');
  // the R3(1) question: the title names category and tier only — two different 悬赏·损伤I cards, each with its own enemy
  assert.equal(resolve(['悬赏·损伤I', '临时收音师', 1, 2]), 'enemyeffect_18_1');
  assert.equal(resolve(['悬赏·损伤I', '底海滑动者', 1, 2]), 'enemyeffect_12_4');
  assert.equal(CARD.get('enemyeffect_18_1').enemyKey, 'enemy_10094_crstf');
  assert.equal(CARD.get('enemyeffect_12_4').enemyKey, 'enemy_1148_dssbr');
  const p = new URL('../../.cache/gamedata/excel/activity_table.json', import.meta.url);
  if (!existsSync(p)) { t.diagnostic('no .cache/gamedata: the season cross-check is skipped'); return; }
  const act = JSON.parse(readFileSync(p, 'utf8')).activity.AUTOCHESS_SEASON;
  for (const id of seen) {
    const bb = act.act2autochess.effectBuffInfoDataDict[id][0].blackboard.find((x) => x.key === 'enemy_id').valueStr;
    assert.equal(CARD.get(id).enemyKey, bb, `${id}: the card's enemy is the effect's enemy_id`);
  }
  // 上半 (act1autochess) lacks the series 17–20 and 澪 / 纠缠藤蔓 … and has 沉沙 where 下半 has 清明: the screenshots are 下半
  for (const id of ['enemyeffect_17_1', 'enemyeffect_18_1', 'enemyeffect_19_1', 'enemyeffect_20_2', 'enemyeffect_b_19', 'enemyeffect_b_24']) {
    assert.ok(seen.has(id) && !act.act1autochess.effectInfoDataDict[id], `${id} is 下半-only`);
  }
  assert.match(act.act1autochess.effectInfoDataDict.enemyeffect_11_6.effectDesc, /沉沙/);
});

test('#2 R3 (11 of 11 official drafts): one of the official sets of six "接下来两场作战" cards, 3 × I + 2 × II + 1 × III', () => {
  const r3 = officialDrafts().filter((d) => d.round === 3);
  assert.equal(r3.length, 11);
  const hits = SPEC.initial.sets.map(() => 0);
  for (const d of r3) {
    assert.equal(d.family, 'bounty', `${d.where}: R3 is a 悬赏决策`);
    assert.ok(d.ids.every((id) => CARD.get(id).rounds === 2 && CARD.get(id).draftPool === 'initial'), `${d.where}: two-battle cards`);
    assert.equal(tiersOf(d.ids), '111223', `${d.where}: tiers`);
    assert.ok(d.ids.every((id) => !isBoss(CARD.get(id).enemyKey)), `${d.where}: no boss`);
    const fit = initialFit(d.ids);
    assert.match(fit || '', /^set:/, `${d.where}: a seen set`);
    hits[Number(fit.slice(4))]++;
  }
  assert.deepEqual(hits, [4, 1, 1, 2, 1, 1, 1], 'series 18 ×4, 19, 17, the 10_5… set ×2, three more mixed sets');
  // each seen set is a whole series 17 / 18 / 19 or follows the rule the unseen slots are built by
  for (const s of SPEC.initial.sets) {
    const series = new Set(s.cards.map((id) => CARD.get(id).series));
    assert.ok(series.size === 1 ? [17, 18, 19].includes([...series][0]) && s.cards.length === 6 : mixedRule(s.cards), s.cards.join());
    assert.equal(tiersOf(s.cards), '111223');
  }
  assert.equal(SPEC.initial.slots, 10, 'enemy_initial_1..10');
});

test('#2 R3 generated: a seen set or an unseen-slot set (one card from each of 6 of the series 10–15 / 20, I I I II II III) — every seen set comes up, the unseen slots about 3 in 10', () => {
  const counts = new Map();
  let n = 0;
  for (const modeId of COOP_BOUNTY_MODES) {
    for (const round of DATA.choices.schedule[modeId].spRounds.filter((r) => bountyDraftKind(r) === 'initial')) {
      for (const d of drafts(modeId, round, modeId === 'mode_multi_hard' ? 400 : 60)) {
        const ids = d.cards.map((c) => c.id);
        assert.equal(new Set(ids).size, 6, 'six different cards');
        const fit = initialFit(ids);
        assert.ok(fit, `${modeId} R${round}: ${d.cards.map((c) => c.name).join(', ')}`);
        assert.ok(d.cards.every((c) => c.rounds === 2 && !isBoss(c.enemyKey)), 'two-battle cards, no boss');
        assert.match(d.eventId, /^enemy_initial_\d+$/);
        if (modeId === 'mode_multi_hard') { counts.set(fit, (counts.get(fit) || 0) + 1); n++; }
      }
    }
  }
  for (let i = 0; i < SPEC.initial.sets.length; i++) assert.ok(counts.get(`set:${i}`) > 0, `set ${i} offered`);
  const mixed = (counts.get('mixed') || 0) / n;
  assert.ok(mixed > 0.2 && mixed < 0.4, `unseen-slot sets ${(mixed * 100).toFixed(0)} %`);
  // solo: 3 cards of such a set
  for (const d of drafts('mode_single_hard', 3, 40)) {
    assert.equal(d.cards.length, 3);
    assert.ok(d.cards.every((c) => CARD.get(c.id).draftPool === 'initial'));
  }
});

test('#2 R9 (12 of 12 official drafts): boss bounties + 源石虫·特训 — a group of named bosses always together, filled to 6 with the cheap ones', () => {
  const r9 = officialDrafts().filter((d) => d.round === 9);
  assert.equal(r9.length, 12, '11 matches + the Bahamut co-op screenshot');
  const hits = SPEC.boss.templates.map(() => 0);
  for (const d of r9) {
    assert.equal(d.family, 'bounty', `${d.where}: R9 is a 悬赏决策`);
    assert.ok(d.ids.every((id) => CARD.get(id).draftPool === 'boss' && CARD.get(id).rounds === 1), `${d.where}: boss bounties / 源石虫·特训, 下场作战`);
    const fits = bossFits(d.ids);
    assert.equal(fits.length, 1, `${d.where}: fits exactly one seen group (${fits.join(', ')})`);
    hits[fits[0]]++;
  }
  assert.ok(hits.every((x) => x > 0), `every group seen (${hits.join(' ')})`);
  for (const d of drafts('mode_multi_abyss', 9, 300)) {
    const ids = d.cards.map((c) => c.id);
    assert.equal(new Set(ids).size, 6);
    assert.ok(bossFits(ids).length > 0, ids.join(', '));
    assert.match(d.eventId, /^bossInitial_\d+$/);
  }
  const offered = new Set(drafts('mode_multi_hard', 9, 300).flatMap((d) => d.cards.map((c) => c.id)));
  for (const t of SPEC.boss.templates) for (const id of t.featured) assert.ok(offered.has(id), `${CARD.get(id).name} offered`);
  for (const id of ['enemyeffect_b_6', 'enemyeffect_b_7', 'enemyeffect_b_15', 'enemyeffect_b_16', 'enemyeffect_b_18']) {
    assert.equal(CARD.get(id).draftExcluded, 'unseen', `${CARD.get(id).name}: in no official R9 draft`);
    assert.ok(!offered.has(id));
  }
});

test('#2 R11 (11 matches: 悬赏决策 5, 机密商店 4, 战术决策 2, 道具补给 0): the families, and the bounty rule — one 特异III giant + 5 "下场战斗" cards, one per faction series', () => {
  const r11 = officialDrafts().filter((d) => d.round === 11);
  const fam = {};
  for (const d of r11) fam[d.family] = (fam[d.family] || 0) + 1;
  assert.deepEqual(fam, { bounty: 5, shop: 4, tactic: 2 });
  for (const d of r11.filter((x) => x.family === 'bounty')) {
    assert.ok(hunterFits(d.ids), `${d.where}: ${d.ids.join(', ')}`);
    assert.ok(d.ids.every((id) => CARD.get(id).draftPool === 'hunter' && CARD.get(id).rounds === 1));
  }
  for (const modeId of ['mode_multi_hard', 'mode_multi_abyss', 'mode_single_hard', 'mode_single_abyss']) {
    const sch = DATA.choices.schedule[modeId].rounds['11'];
    assert.deepEqual(sch.families.map((f) => f.family).sort(), ['bounty', 'shop', 'tactic'], `${modeId} R11`);
    assert.equal(sch.bountyDraft, 'hunter');
  }
  const gd = new GameData(DATA, 'mode_multi_hard');
  const seen = {};
  for (let seed = 1; seed <= 200; seed++) {
    const d = generateDraft(gd, createRng(seed * 13 + 11), 11, { stageId: 'act2autochess_m01' });
    seen[d.family] = (seen[d.family] || 0) + 1;
    if (d.family !== 'bounty') continue;
    assert.ok(hunterFits(d.cards.map((c) => c.id)), d.cards.map((c) => c.name).join(', '));
    assert.match(d.eventId, /^bounty_hunter_\d+$/);
  }
  assert.deepEqual(Object.keys(seen).sort(), ['bounty', 'shop', 'tactic'], 'no 道具补给 at R11');
  assert.ok(seen.bounty > seen.tactic, JSON.stringify(seen));
});

test('#2 never offered by a draft (in none of the 27 official bounty drafts): multi-round cards, enemyeffect_3_*, 战术特训, the 鸭爵 set', () => {
  const reasons = {};
  for (const c of CARDS) {
    if (!c.draft) reasons[c.draftExcluded] = (reasons[c.draftExcluded] || 0) + 1;
    assert.equal(c.draft, c.draftPool != null, `${c.effectId}: drafted iff it has a draft kind`);
    if (c.multiRound) assert.equal(c.draftExcluded, c.payout === 'kill' ? 'unseen' : 'perfect', `${c.effectId} ${c.name}`);
    if (/^enemyeffect_3_/.test(c.effectId)) assert.equal(c.draftExcluded, 'unseen', `${c.effectId} ${c.name}`);
  }
  assert.deepEqual(reasons, { perfect: 20, hidden: 4, unseen: 19 });
  const pools = {};
  for (const c of CARDS) if (c.draft) pools[c.draftPool] = (pools[c.draftPool] || 0) + 1;
  assert.deepEqual(pools, { initial: 42, boss: 20, hunter: 24 });
  for (const modeId of [...COOP_BOUNTY_MODES, 'mode_single_hard', 'mode_single_abyss']) {
    for (const r of DATA.choices.schedule[modeId].spRounds) {
      for (const d of drafts(modeId, r, 40)) {
        for (const c of d.cards) {
          const card = CARD.get(c.id);
          assert.ok(card.draft && card.draftPool === bountyDraftKind(r), `${modeId} R${r}: ${c.id} ${c.name}`);
          assert.ok(!card.multiRound && card.payout === 'kill');
        }
      }
    }
  }
});

test('#2 the mode\'s inactive enemy list does not thin the bounty draft (PRTS 卫戍协议：盟约 11/18 note "不影响悬赏决策出场")', () => {
  // 险境 turns off 尖端萨卡兹枯朽战车 and 灼藤 in its waves; their R11 cards (13_8, 12_7) stay in an R11-kind draft there
  const sch = DATA.choices.schedule.mode_multi_normal;
  const data = { ...DATA, choices: { ...DATA.choices, schedule: { ...DATA.choices.schedule, mode_multi_normal: { ...sch, rounds: { ...sch.rounds, 9: { ...sch.rounds['9'], families: [{ family: 'bounty', weight: 1 }], bountyDraft: 'hunter' } } } } } };
  const gd = new GameData(data, 'mode_multi_normal');
  const dropped = ['enemy_1272_nhtank_2', 'enemy_10067_ftsjc'];
  for (const k of dropped) assert.ok(gd.inactiveEnemies.has(k), `${k} is inactive in 险境 waves`);
  const seen = new Set();
  for (const d of drafts('mode_multi_normal', 9, 200, data)) for (const c of d.cards) if (dropped.includes(c.enemyKey)) seen.add(c.enemyKey);
  assert.deepEqual([...seen].sort(), dropped.slice().sort());
});

test('#2 E2E (co-op 绝境, the players\' case): the real R3 draft is an official R3 set, and the picked enemy comes for R3 and R4 at their round scale', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 1, seed: 910 + seed, fake: true }).start();
    const m = h.m;
    assert.ok(h.drive(() => m.phase === PHASE.SP_DRAFT && m.round === 3, { ready: true }), 'the R3 draft');
    assert.equal(m.sp.family, 'bounty', 'R3 of 绝境 is always a bounty draft');
    const names = m.sp.cards.map((c) => c.name).join(', ');
    assert.ok(initialFit(m.sp.cards.map((c) => c.id)), `seed ${seed}: ${names}`);
    for (const c of m.sp.cards) assert.ok(!isBoss(c.enemyKey), `seed ${seed}: ${c.name} is a boss bounty`);
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
