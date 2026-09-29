// server/match/choices.js — 机变 (SP draft) card generation and application (DESIGN §6.1, research 01 A4,
// data/choices.json).
//
// Generation (generateDraft): the family is a weighted pick from choices.schedule[modeId].rounds[r].families; the card
// count is `cards` (co-op 6, solo 3):
//   bounty  悬赏决策  distinct cards.bounty entries with tier ∈ bountyTiers whose enemy exists and is active in the mode
//   supply  道具补给  random normal EQUIP shop items with tier in supplyTiers [lo, hi] (duplicates allowed)
//   shop    机密商店  random normal EQUIP shop items of any tier I–VI (duplicates allowed); FREE — the official card
//                     text is "无需消耗资金，获得装备补给" (research 01 A4/04 addendum), so the price is 0
//   tactic  战术决策  distinct cards.tactic entries; terrain cards only for the match stage; a 驰援 card
//                     (single_special_choice_gain_bond_chess) or a 盟誓 card (global_special_choice_bond_addlayer)
//                     only while at least one of its bonds is live in this match (opts.bondAvailable = Match.bondLive:
//                     not in the mode's static inactive list — 标准 turns off 拉特兰 / 阿戈尔 / 卡西米尔 / 奥术 … —
//                     and still with chess in the pool); a card acting only on dead bonds would do nothing
// Application (applyCard): a registered `choice:<effectId>` handler (content) wins; otherwise the family default:
//   bounty → the picker's bounty list (waves.js adds the enemies to the next `rounds` battles; kill payout to the
//            killer via the Battle, perfect payout at settlement when the picker's own battle was perfect)
//   supply / shop → the item goes to the picker's hand (overflow temp)
//   tactic → by effect buff key (data/effects.json):
//     global_special_choice_gain_equip {count,pool}     `count` items from the server pool
//     global_special_choice_bond_addlayer {count,bond_list} layers +count to each bond (无需激活)
//     global_special_choice_gain_coin {count}           funds
//     global_special_choice_refresh_free {count}        free refreshes (stack)
//     single_special_choice_gloden_equip_chess {count}  next `count` bought items become golden   (EffectRef)
//     single_special_choice_gloden_char_chess {count}   next `count` bought operators become elite (EffectRef)
//     single_special_choice_gain_bond_chess {count,bond} `count` random chess of the bond (≤ shop level)
//     auto_chess_change_map {alias: 0|1}                device toggles on the picker's board (deploy legality) + battle
//     anything else (env_gbuff…, enemy_attribute_mul…)  a battle EffectRef for the sim content (playerEffects)
//   cards with `team: true` apply to the picker AND every alive teammate ("若存在其他队友则他们也获得").

import { weightedPick } from './waves.js';

export const FAMILY_NAMES = { bounty: '悬赏决策', supply: '道具补给', shop: '机密商店', tactic: '战术决策' };

function scheduleFor(gd, round) {
  const sch = gd.choices.schedule && gd.choices.schedule[gd.modeId];
  const r = sch && sch.rounds && sch.rounds[String(round)];
  if (r && typeof r === 'object') return r;
  // fallback: a supply draft
  return { families: [{ family: 'supply', weight: 1 }], cards: gd.isSolo ? 3 : 6, supplyTiers: [1, Math.min(6, 1 + Math.floor(round / 3))], bountyTiers: [1, 2] };
}

function formatCount(gd) {
  const f = gd.choices.format || {};
  const multi = f.multi && Number.isInteger(f.multi.cards) ? f.multi.cards : 6;
  const solo = f.solo && Number.isInteger(f.solo.cards) ? f.solo.cards : 3;
  return gd.isSolo ? solo : multi;
}

function eligibleItems(gd, lo, hi) {
  const out = [];
  for (let t = lo; t <= hi; t++) for (const id of gd.shopItemsByTier[t] || []) out.push(id);
  return out;
}

function itemCard(gd, id) {
  const it = gd.item(id);
  return { kind: 'item', id, name: it ? it.name : id, desc: it ? it.desc || '' : '', tier: it && Number.isInteger(it.tier) ? it.tier : 1, price: 0 };
}

/**
 * Build the draft cards for an SP round.
 * @returns {{ family: string, name: string, desc: string, eventId: string|null, cards: object[] } | null}
 */
export function generateDraft(gd, rng, round, { stageId = null, bondAvailable = null } = {}) {
  const sch = scheduleFor(gd, round);
  const fams = Array.isArray(sch.families) && sch.families.length ? sch.families.map((f) => [f.family, f.weight]) : [['supply', 1]];
  let family = weightedPick(rng, fams) || 'supply';
  const n = Number.isInteger(sch.cards) && sch.cards > 0 ? Math.min(sch.cards, 6) : formatCount(gd);
  const opts = { stageId, bondAvailable };
  let cards = buildCards(gd, rng, family, n, sch, opts);
  if (!cards.length && family !== 'supply') { family = 'supply'; cards = buildCards(gd, rng, family, n, sch, opts); }
  if (!cards.length) return null;
  cards.forEach((c, i) => { c.idx = i; c.family = family; });
  const famInfo = gd.choices.families && gd.choices.families[family];
  const events = sch.events && Array.isArray(sch.events[family]) ? sch.events[family] : [];
  const eventId = events.length ? events[Math.floor(rng() * events.length)] : null;
  return { family, name: famInfo && famInfo.name ? famInfo.name : FAMILY_NAMES[family] || family, desc: famInfo && famInfo.desc ? famInfo.desc : '', eventId, cards };
}

/** Bond granted by a 驰援 tactic card (effect buff single_special_choice_gain_bond_chess), else null. */
export function reinforcementBond(gd, effectId) {
  const eff = gd.effect(effectId);
  const buffs = eff && Array.isArray(eff.buffs) ? eff.buffs : [];
  const b = buffs.find((x) => x && x.key === 'single_special_choice_gain_bond_chess');
  return b && b.bbStr && typeof b.bbStr.bond === 'string' ? b.bbStr.bond : null;
}

/**
 * Bonds a tactic card only acts on: the 驰援 bond (single_special_choice_gain_bond_chess) and the bonds of a 盟誓 card
 * (global_special_choice_bond_addlayer bond_list). null when the card does anything else (it is always useful).
 */
export function cardTargetBonds(gd, effectId) {
  const eff = gd.effect(effectId);
  const buffs = eff && Array.isArray(eff.buffs) ? eff.buffs.filter(Boolean) : [];
  if (!buffs.length) return null;
  const out = [];
  for (const b of buffs) {
    const bs = b.bbStr || {};
    if (b.key === 'single_special_choice_gain_bond_chess' && typeof bs.bond === 'string') out.push(bs.bond);
    else if (b.key === 'global_special_choice_bond_addlayer') out.push(...String(bs.bond_list || '').split(',').map((x) => x.trim()).filter(Boolean));
    else return null;
  }
  return out.length ? out : null;
}

function buildCards(gd, rng, family, n, sch, { stageId = null, bondAvailable = null } = {}) {
  const cardsData = gd.choices.cards || {};
  if (family === 'bounty') {
    const tiers = Array.isArray(sch.bountyTiers) && sch.bountyTiers.length ? sch.bountyTiers : [1, 2];
    const pool = (Array.isArray(cardsData.bounty) ? cardsData.bounty : []).filter((c) => c && tiers.includes(c.tier) && gd.enemy(c.enemyKey) && !gd.inactiveEnemies.has(c.enemyKey));
    const pick = pool.slice();
    rng.shuffle(pick);
    return pick.slice(0, n).map((c) => ({
      kind: 'bounty', id: c.effectId, name: c.name, desc: c.desc || '', tier: c.tier, coin: c.coin, payout: c.payout,
      rounds: c.rounds, enemyKey: c.enemyKey, count: c.count,
    }));
  }
  if (family === 'supply' || family === 'shop') {
    let lo = 1;
    let hi = 6;
    if (family === 'supply' && Array.isArray(sch.supplyTiers) && sch.supplyTiers.length === 2) [lo, hi] = sch.supplyTiers;
    let list = eligibleItems(gd, lo, hi);
    if (!list.length) list = eligibleItems(gd, 1, 6);
    const out = [];
    for (let i = 0; i < n && list.length; i++) out.push(itemCard(gd, list[Math.floor(rng() * list.length)]));
    return out;
  }
  if (family === 'tactic') {
    // a card whose every target bond is dead in this match (mode-inactive, or no chess left in the pool) does nothing
    const bondOk = (c) => {
      if (typeof bondAvailable !== 'function') return true;
      const bonds = cardTargetBonds(gd, c.effectId);
      return !bonds || bonds.some((b) => !!bondAvailable(b));
    };
    const pool = (Array.isArray(cardsData.tactic) ? cardsData.tactic : []).filter((c) => c && (c.kind !== 'terrain' || (stageId && c.stageId === stageId)) && gd.effect(c.effectId) && bondOk(c));
    const pick = pool.slice();
    rng.shuffle(pick);
    return pick.slice(0, n).map((c) => ({ kind: 'tactic', id: c.effectId, name: c.name, desc: c.desc || '', tier: null, team: !!c.team, tacticKind: c.kind }));
  }
  return [];
}

/** Public card view. */
export function cardView(c) {
  const v = { idx: c.idx, kind: c.kind, id: c.id, name: c.name, desc: c.desc, tier: c.tier ?? null };
  if (c.kind === 'bounty') Object.assign(v, { coin: c.coin, payout: c.payout, rounds: c.rounds, enemyKey: c.enemyKey, count: c.count });
  if (c.kind === 'item') v.price = 0;
  if (c.kind === 'tactic') Object.assign(v, { team: c.team, tacticKind: c.tacticKind });
  return v;
}

/**
 * Apply a picked card to a player (registry override → family default). Team tactic cards are applied to every
 * alive teammate as well.
 * @param {import('./Match.js').Match} m
 * @param {import('./PlayerState.js').PlayerState} ps
 */
export function applyCard(m, ps, card) {
  const targets = card.kind === 'tactic' && card.team ? [ps, ...m.alivePlayers().filter((p) => p !== ps)] : [ps];
  for (const p of targets) {
    const ev = { card: { ...card }, family: card.family, picker: ps.playerId, forTeammate: p !== ps };
    const handled = m.dispatcher.runKey(p, `choice:${card.id}`, 'onChoicePick', { kind: 'choice', card }, ev);
    if (!handled) applyDefault(m, p, card);
    // every other source observes the pick (the card's own key already ran above)
    m.dispatch(p, 'onChoicePick', ev, { skipKey: `choice:${card.id}` });
    p.recompute();
  }
}

function applyDefault(m, ps, card) {
  const gd = m.gd;
  if (card.kind === 'bounty') {
    const src = (gd.choices.cards && Array.isArray(gd.choices.cards.bounty) ? gd.choices.cards.bounty : []).find((c) => c.effectId === card.id) || card;
    m.addBounty(ps, src);
    return;
  }
  if (card.kind === 'item') {
    ps.acquireItem(card.id, { source: 'choice' });
    return;
  }
  if (card.kind !== 'tactic') return;
  const eff = gd.effect(card.id);
  const buffs = eff && Array.isArray(eff.buffs) ? eff.buffs : [];
  let handled = false;
  let battle = false;
  for (const b of buffs) {
    const bb = b.bb || {};
    const bs = b.bbStr || {};
    const count = Number.isInteger(bb.count) ? bb.count : 1;
    switch (b.key) {
      case 'global_special_choice_gain_equip': {
        for (let i = 0; i < count; i++) {
          const id = m.rollItemId({ pool: bs.pool });
          if (id) ps.acquireItem(id, { source: 'choice' });
        }
        handled = true;
        break;
      }
      case 'global_special_choice_bond_addlayer': {
        const bonds = String(bs.bond_list || '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const bid of bonds) ps.addLayers(bid, count, { requireActive: false, reason: 'choice' });
        handled = true;
        break;
      }
      case 'global_special_choice_gain_coin':
        ps.addFunds(count, { reason: 'choice' });
        handled = true;
        break;
      case 'global_special_choice_refresh_free':
        ps.shop.freeRefreshes += count;
        ps.dirty();
        handled = true;
        break;
      case 'single_special_choice_gloden_equip_chess':
        addRef(ps, card, eff, 'effect:builtin_next_buy_golden_item', { counter: count, battle: false });
        handled = true;
        break;
      case 'single_special_choice_gloden_char_chess':
        addRef(ps, card, eff, 'effect:builtin_next_buy_elite', { counter: count, battle: false });
        handled = true;
        break;
      case 'single_special_choice_gain_bond_chess': {
        for (let i = 0; i < count; i++) {
          const id = m.pool.roll(m.rngMeta, { maxTier: Math.max(1, ps.shop.level), filter: (cid) => { const c = gd.chess(cid); return !!(c && Array.isArray(c.bonds) && c.bonds.includes(bs.bond)); } })
            || m.pool.roll(m.rngMeta, { maxTier: 6, filter: (cid) => { const c = gd.chess(cid); return !!(c && Array.isArray(c.bonds) && c.bonds.includes(bs.bond)); } });
          if (id) ps.acquireChess(id, { source: 'choice' });
        }
        handled = true;
        break;
      }
      case 'auto_chess_change_map': {
        for (const [alias, v] of Object.entries(bb)) if (alias.includes('#')) ps.deviceOverrides[alias] = Number(v) !== 0;
        ps.invalidateDeployMap();
        battle = true;
        break;
      }
      case 'global_special_choice_all_activated':
        break;
      default:
        battle = true;
    }
  }
  if (battle || !handled) addRef(ps, card, eff, `choice:${card.id}`, { battle: true });
}

function addRef(ps, card, eff, key, { counter = null, battle = true } = {}) {
  const id = `${card.id}#${ps.m.nextUid()}`;
  ps.effects.push({
    id, key, name: card.name, desc: card.desc, iconKind: card.team ? 'team' : 'choice', iconId: eff && eff.decoIconId ? eff.decoIconId : card.id,
    counter, battle, params: eff && eff.params ? { ...eff.params } : {}, data: { effectId: card.id, tacticKind: card.tacticKind ?? null },
  });
  ps.dirty();
}
