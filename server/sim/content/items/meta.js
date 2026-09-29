// server/sim/content/items/meta.js — prep side of the items (docs/META.md registry API).
//
// The engine built-ins (server/match/builtinMeta.js) already implement most consume-on-equip items and Arts from the
// concrete item's params; they are reviewed and kept (盟约之币, 骑士储蓄罐, 随身身份牌, 精打细算玩偶, 简易通讯机 (tier ≤
// shop level), 见钱眼开玩偶, 人事部文档 (cap 9), 博士投影 (golden now / normal at the next round start), 拟态物质, 信标,
// 商业包装方案 (count from the concrete record: 8 / golden 7)). The Arts' rangeGrid (画卷 = placed tile + the tile in
// front) and the per-round limit are engine rules.
// Overridden / added here (a built-in, when present, is wrapped — never re-implemented):
//   画卷         the copy keeps the target's items; a copied normal item that pairs with an owned one merges and the
//               golden stays in the hand (the built-in equipped the merged golden on the copy, and its live loop over
//               the target's items skipped the item after a merge)
//   紧急调度券   a shop operator leaves its slot only when it was actually granted (built-in cleared the slot first)
//   寻呼模块     the special refresh shows `refresh_cnt` DIFFERENT operators when the pool allows it
//   突变细胞     after the battle the carrier becomes a NORMAL random tier+1 operator; its other equipment goes back to
//               the hand (built-in kept it on the new operator)
//   教鞭 / “神秘顾客”  trap_create_self_choice {choice_event: hunter_band_1}: the bounty comes from the band bounty
//               family `enemyeffect_b_*` (research 04 §7: "offer 3 random enemyeffect_b_* bounties … adds 1 enemy to your
//               next battle, killer gets `coin` funds"); the built-in drew any tier ≤ II kill bounty (incl. 2-round and
//               faction bounties). [ASSUMED simplification, engine: no PERSONAL_CHOOSE overlay] 3 are drawn and one of
//               them is taken at random. Falls back to the built-in when the family is empty.
//   “神秘顾客”  trap_disney_special: when actively destroyed, +count funds and the Art passes to the next alive player
//               (seat order, cyclic)
//   天师古鼎     equip_with_another_gain_coin_when_gain_char: a 【炎】 carrier also holding 炎国短刀 (either quality)
//               gains `count` funds every time the player gains an operator, at most `max` times per round per item

import { itemKeyOf, isCoreBond } from '../support/index.js';
import { metaBonds } from '../support/meta.js';

const int = (v, d = 0) => (Number.isFinite(v) ? Math.trunc(v) : d);

/** Params `{ ...bb, ...bbStr }` of the concrete record's buff with official key `key` (null when absent). */
function buffP(ctx, itemId, key) {
  const rec = itemId ? ctx.gd.item(itemId) : null;
  for (const b of (rec && Array.isArray(rec.buffs) ? rec.buffs : [])) if (b && b.key === key) return { ...(b.bb || {}), ...(b.bbStr || {}) };
  return null;
}

/** 【X】盟约干员 on the prep side: own bonds + 变形同构体 grants, or 调和 (maniShip) members while both bonds are active. */
function pieceIsMember(ctx, piece, bondId) {
  const bonds = metaBonds(ctx, piece);
  if (bonds.includes(bondId)) return true;
  return bonds.includes('maniShip') && isCoreBond(bondId) && ctx.bondActive('maniShip') && ctx.bondActive(bondId);
}

/** Offer size of the personal bounty choice (research 04 §7, [ASSUMED]). */
const OFFER_SIZE = 3;
/** Bounty cards of the band bounty family `enemyeffect_b_*` whose enemy can appear in this mode. */
function bandBounties(ctx) {
  const all = ctx.data && ctx.data.choices && ctx.data.choices.cards && Array.isArray(ctx.data.choices.cards.bounty) ? ctx.data.choices.cards.bounty : [];
  const inactive = ctx.gd.inactiveEnemies instanceof Set ? ctx.gd.inactiveEnemies : new Set();
  return all.filter((c) => c && /^enemyeffect_b_\d+$/.test(String(c.effectId)) && ctx.gd.enemy(c.enemyKey) && !inactive.has(c.enemyKey));
}

function wrap(registry, key, hooks) {
  const base = registry.get(`item:${key}`) || {};
  registry.item(key, { ...base, ...hooks(base) });
}

export function registerMeta(registry) {
  // 紧急调度券 — use_equip_reward_random_char_chess_in_shop {count}
  wrap(registry, 'chess_item_2_02_e', () => ({
    onEquip(ctx, ev) {
      const p = buffP(ctx, ev.item && ev.item.id, 'use_equip_reward_random_char_chess_in_shop') || {};
      const n = Math.max(1, int(p.count, 1));
      const tried = new Set();
      for (let k = 0; k < n; k++) {
        const slots = ctx.shopSlots();
        const idx = slots.map((s, i) => (s && s.kind === 'chess' && !s.sold && !tried.has(i) ? i : -1)).filter((i) => i >= 0);
        if (!idx.length) break;
        const i = ctx.rng.pick(idx);
        const got = ctx.grantChess(slots[i].id);
        if (got) ctx.setShopSlot(i, null);
        else { tried.add(i); k--; }
      }
    },
  }));

  // 寻呼模块 — use_equip_reward_special_goods_char_chess {refresh_cnt, choice_cnt}
  wrap(registry, 'chess_item_4_01_e', () => ({
    onEquip(ctx, ev) {
      const p = buffP(ctx, ev.item && ev.item.id, 'use_equip_reward_special_goods_char_chess') || {};
      const n = Math.max(1, int(p.refresh_cnt, 3));
      const bonds = new Set(ctx.pieceBonds(ev.target.uid));
      const maxTier = ctx.shopLevel();
      const shares = (id) => { const c = ctx.gd.chess(id); return !!(c && Array.isArray(c.bonds) && c.bonds.some((b) => bonds.has(b))); };
      const ids = [];
      for (let k = 0; k < n; k++) {
        const id = ctx.rollChess({ maxTier, filter: (x) => shares(x) && !ids.includes(x) }) || ctx.rollChess({ maxTier, filter: shares });
        if (id) ids.push(id);
      }
      if (ids.length) ctx.offerChess(ids, { source: 'item' });
    },
  }));

  // 突变细胞 — char_chess_transformation_equip
  wrap(registry, 'chess_item_5_08_e', () => ({
    onBattleResult(ctx) {
      const { piece, holder } = ctx.source;
      if (!piece || !holder) return;
      const tier = Math.min(6, ctx.gd.tierOf(holder.id) + 1);
      const id = ctx.rollChess({ tier });
      if (!id) return;
      const others = (ctx.piece(holder.uid)?.items || holder.items || []).filter((it) => it && it.uid !== piece.uid);
      ctx.destroyPiece(piece.uid);
      for (const it of others) {
        if (ctx.destroyPiece(it.uid)) ctx.grantItem(it.id, { source: 'mutation' });
      }
      ctx.transform(holder.uid, ctx.gd.baseIdOf(id));
    },
  }));

  // 教鞭 / “神秘顾客” — trap_create_self_choice {choice_event}: a band bounty (enemyeffect_b_*) for the next battle
  for (const key of ['chess_item_6_03_m', 'chess_item_6_01_m']) {
    wrap(registry, key, (base) => ({
      onArt(ctx, ev) {
        const cards = bandBounties(ctx);
        if (!cards.length) { if (typeof base.onArt === 'function') base.onArt.call(base, ctx, ev); return; }
        const offer = ctx.rng.shuffle(cards.slice()).slice(0, OFFER_SIZE);
        const card = ctx.rng.pick(offer);
        if (!card || !ctx.addBounty(card)) { ev.error = 'BAD_TARGET'; ev.detail = 'no bounty available'; }
      },
    }));
  }

  // 画卷 — trap_copy_front_char: copy the operator in range (elite status included) with its equipment. A copied
  // normal item that completes a pair with an owned one merges at once and the golden stays in the hand (research 04
  // addendum "两个同名道具（无论是否被装备）会自动合并…并自动返回整备区"); the built-in equipped that golden on the copy.
  wrap(registry, 'chess_item_6_02_m', () => ({
    onArt(ctx, ev) {
      const target = (ev.targets || []).find((p) => p && p.kind === 'chess');
      if (!target) { ev.error = 'BAD_TARGET'; ev.detail = 'no operator in range'; return; }
      const copy = ctx.grantChess(target.id, { requirePool: false, source: 'item:chess_item_6_02_m' });
      if (!copy) { ev.error = 'HAND_FULL'; return; }
      // snapshot first: a merge detaches the original's copy of the item from `target.items` while we iterate
      // (the built-in's live loop then skipped the next item)
      for (const itemId of (target.items || []).map((it) => it.id)) {
        const got = ctx.grantItem(itemId, { source: 'item:chess_item_6_02_m' });
        const holder = got ? ctx.piece(copy.uid) : null;
        if (got && got.id === itemId && holder && holder.kind === 'chess') ctx.equipDirect(got.uid, holder.uid);
      }
    },
  }));

  // “神秘顾客” — trap_create_self_choice (bounty above) + trap_disney_special {count}
  wrap(registry, 'chess_item_6_01_m', () => ({
    onDestroy(ctx, ev) {
      if (!ev || ev.reason !== 'player') return;
      const item = ev.item || ctx.source.piece;
      const p = buffP(ctx, item && item.id, 'trap_disney_special') || {};
      const n = int(p.count, 1);
      if (n > 0) ctx.addFunds(n, 'item');
      const mates = ctx.teammates();
      if (!mates.length || !item) return;
      const seat = Number.isInteger(ctx.seat) ? ctx.seat : 0;
      const dist = (t) => { const s = Number.isInteger(t.seat) ? t.seat : 0; return ((s - seat) % 64 + 64) % 64 || 64; };
      const next = mates.slice().sort((a, b) => dist(a) - dist(b))[0];
      if (next) next.grantItem(item.id, { source: 'item' });
    },
  }));

  // 天师古鼎 — equip_with_another_gain_coin_when_gain_char {count, max} {other_equip, bond}
  wrap(registry, 'chess_item_6_03_e', (base) => ({
    onGain(ctx, ev) {
      if (typeof base.onGain === 'function') base.onGain.call(base, ctx, ev);
      if (!ev || ev.kind !== 'chess' || !ev.piece) return;
      const { piece, holder } = ctx.source;
      if (!piece || !holder) return;
      const p = buffP(ctx, piece.id, 'equip_with_another_gain_coin_when_gain_char');
      if (!p) return;
      const bond = typeof p.bond === 'string' && p.bond ? p.bond : 'yanShip';
      const others = String(p.other_equip || '').split(',').map((s) => itemKeyOf(s.trim())).filter(Boolean);
      const fresh = ctx.piece(holder.uid) || holder;
      const carries = (fresh.items || []).some((it) => it && it.uid !== piece.uid && others.includes(itemKeyOf(it.id)));
      if (!carries || !pieceIsMember(ctx, fresh, bond)) return;
      const k = `cauldron:${piece.uid}:${ctx.round}`;
      if (ctx.counter(k) >= Math.max(0, int(p.max, 3))) return;
      ctx.incCounter(k);
      ctx.addFunds(int(p.count, 2), 'item');
    },
  }));
}
