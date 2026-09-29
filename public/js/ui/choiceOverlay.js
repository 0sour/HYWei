// 机变 draft overlay (research 06 §4.4 / §11.5): family title | description, "倒计时结束后仍未选定将自动分配",
// whose turn ("当前轮到你决策" / "{name} 正在决策…") with countdown, pick order with ✓ / ⌛ / … / door,
// and a 3×2 grid (solo: 3 cards) of cards with icon, title, rich description, tier chip and the taker's
// avatar badge. Clicking an available card on your turn sends g.choice; while it is in flight the card shows a
// "选择中" strip with a sweeping bar (never a spinner over its text — user playtest #3 item 9), dropped as soon as the
// pick shows in m.public (spBusy itself resets when the request settles, ≤ 8 s, or the phase moves on).

import { html, Icon, TierChip, Countdown, MicroLabel } from './components.js';
import { Img, RichText, PlayerAvatar, GIcon } from './gameComponents.js';
import { itemIconUrl, enemyIconUrl, uiUrl } from './assetUrls.js';
import { richTextPlain } from './richText.js';
import { sortedPlayers } from './gameLogic.js';
import { data } from '../data.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * Resolve an sp card to display fields.
 * @param {any} card normalised card ({ idx, takenBy, effectId?, itemId?, id?, name?, desc?, descRaw?, tier?, team?, enemyKey? })
 * @param {string|null} family 'bounty'|'supply'|'shop'|'tactic'
 */
export function resolveSpCard(card, family) {
  const choices = data.get('choices');
  const byEffect = (list, id) => (Array.isArray(list) && id ? list.find((x) => x && x.effectId === id) : null);
  const effectId = card.effectId || (!card.itemId && typeof card.id === 'string' && data.lookup('effects', card.id) ? card.id : null);
  const eff = effectId ? data.lookup('effects', effectId) : null;
  const itemId = card.itemId || (!effectId && typeof card.id === 'string' && data.lookup('items', card.id) ? card.id : null);
  const item = itemId ? data.lookup('items', itemId) : null;
  const bounty = byEffect(choices?.cards?.bounty, effectId);
  const tactic = byEffect(choices?.cards?.tactic, effectId);
  const m = data.get('assets');
  const kind = card.kind === 'item' || item ? 'item' : card.kind === 'bounty' || bounty || family === 'bounty' ? 'bounty' : 'tactic';
  const enemyKey = card.enemyKey || bounty?.enemyKey || eff?.params?.enemy_id || null;
  const team = card.team ?? tactic?.team ?? (eff?.decoIconId === 'icon_team_buff');
  let icon = null;
  if (item) icon = itemIconUrl(m, item);
  else if (kind === 'bounty' && enemyKey) icon = enemyIconUrl(m, enemyKey);
  else if ((card.tacticKind || tactic?.kind) === 'terrain') icon = uiUrl(m, 'buffIcon/icon_stage_buff');
  else if ((card.tacticKind || tactic?.kind) === 'enemyDebuff') icon = uiUrl(m, 'buffIcon/icon_enemy_debuff');
  else icon = uiUrl(m, `buffIcon/${team ? 'icon_team_buff' : 'icon_player_buff'}`);
  return {
    kind,
    name: card.name || item?.name || eff?.name || bounty?.name || tactic?.name || '机变',
    desc: card.descRaw || card.desc || item?.descRaw || item?.desc || eff?.descRaw || eff?.desc || bounty?.desc || tactic?.desc || '',
    tier: Number.isFinite(card.tier) ? card.tier : item?.tier ?? bounty?.tier ?? null,
    icon,
    team: !!team,
    coin: card.coin ?? bounty?.coin ?? eff?.enemyPrice ?? null,
  };
}

/**
 * Whether a card shows the in-flight pick (g.choice sent, no answer yet): only until the pick lands in m.public — the
 * player's pick is known or the card is taken — so it can never outlive the request's effect.
 * @param {number|null} busyIdx @param {{ idx: number, takenBy?: string|null }} card @param {number|null|undefined} mine
 */
export function pickBusy(busyIdx, card, mine) {
  return busyIdx != null && !!card && busyIdx === card.idx && mine == null && !card.takenBy;
}

/**
 * @param {{ pub:any, sp:any, myId:string, solo:boolean, onPick:(idx:number)=>void, busyIdx?:number|null, total?:number|null }} props
 */
export function ChoiceOverlay({ pub, sp, myId, solo, onPick, busyIdx = null, total = null }) {
  if (!sp) return null;
  const fam = data.get('choices')?.families?.[sp.family] || null;
  const players = new Map(sortedPlayers(pub).map((p) => [p.playerId, p]));
  const myTurn = solo || sp.turnPid === myId;
  const mine = sp.pickOf.get(myId);
  const turnName = players.get(sp.turnPid)?.name || '队友';
  const special = /_s$/.test(String(sp.family || ''));
  const order = solo ? [] : sp.order;
  return html`<div class="spov" role="dialog" aria-label="机变阶段">
    <div class="spov__veil" aria-hidden="true"></div>
    <div class="spov__inner">
      <header class="spov__head">
        <div class="spov__titles">
          <${MicroLabel} tone="mint">CONTINGENCY // 机变阶段</${MicroLabel}>
          <h2 class=${cx('spov__title', special && 'is-special')}>${sp.name || fam?.name || '机变'}<span class="spov__bar">|</span><span class="spov__desc"><${RichText} text=${sp.desc || fam?.desc || '选择一项'} /></span></h2>
          ${!solo ? html`<p class="spov__sub">倒计时结束后仍未选定将自动分配</p>` : html`<p class="spov__sub">选择一项（无时间限制）</p>`}
        </div>
        <div class="spov__turn">
          ${mine != null ? html`<span class="spov__turntxt is-done"><${Icon} name="check" />已完成选择</span>`
            : myTurn ? html`<span class="spov__turntxt is-mine">当前轮到你决策</span>`
            : html`<span class="spov__turntxt">${turnName} 正在决策…<${Icon} name="hourglass" /></span>`}
          ${!solo && !sp.untimed ? html`<${Countdown} deadline=${pub?.deadline} total=${total ?? undefined} size="sm" />` : null}
        </div>
      </header>
      ${order.length ? html`<div class="spov__order" aria-label="决策顺序">
        ${order.map((pid, i) => {
          const p = players.get(pid);
          const picked = sp.pickOf.has(pid);
          const cur = sp.turnPid === pid && !picked;
          const left = p?.status === 'left';
          return html`<div key=${pid} class=${cx('spov__who', cur && 'is-cur', picked && 'is-done', pid === myId && 'is-self')}>
            <span class="spov__idx num">${i + 1}</span>
            <${PlayerAvatar} player=${p || { name: '?' }} size="sm" self=${pid === myId} />
            <span class="spov__wname">${p?.name || '博士'}</span>
            <span class="spov__wstate">${left ? html`<${Icon} name="exit" />` : picked ? html`<${Icon} name="check" />` : cur ? html`<${Icon} name="hourglass" />` : html`<${Icon} name="dots" />`}</span>
          </div>`;
        })}
      </div>` : null}
      <div class=${cx('spov__grid', sp.cards.length <= 3 && 'spov__grid--3')}>
        ${sp.cards.map((card) => {
          const r = resolveSpCard(card, sp.family);
          const taker = card.takenBy ? players.get(card.takenBy) : null;
          const can = myTurn && mine == null && !card.takenBy && busyIdx == null;
          const busy = pickBusy(busyIdx, card, mine);
          return html`<button key=${card.idx} type="button" class=${cx('spcard', `spcard--${r.kind}`, card.takenBy && 'is-taken', card.takenBy === myId && 'is-mine', can && 'is-pickable', busy && 'is-busy')}
              aria-busy=${busy ? 'true' : undefined}
              disabled=${!can} onClick=${() => can && onPick(card.idx)} aria-label=${r.name} title=${`${r.name}\n${richTextPlain(r.desc)}`}>
            <span class="spcard__glow" aria-hidden="true"></span>
            ${r.tier ? html`<${TierChip} tier=${r.tier} size="md" class="spcard__tier" />` : null}
            <span class="spcard__icon"><${Img} src=${r.icon} fallback=${html`<${GIcon} name=${r.kind === 'bounty' ? 'target' : 'bolt'} />`} /></span>
            <span class="spcard__body">
              <b class="spcard__name">${r.name}</b>
              <${RichText} text=${r.desc} class="spcard__desc" />
              <span class="spcard__tags">
                ${r.team ? html`<span class="spcard__tag spcard__tag--team">全队获得</span>` : null}
                ${r.kind === 'bounty' && r.coin ? html`<span class="spcard__tag spcard__tag--coin">赏金 ${r.coin}</span>` : null}
              </span>
            </span>
            ${taker ? html`<span class="spcard__taker" title=${`${taker.name} 已选择`}><${PlayerAvatar} player=${taker} size="sm" /><span>${card.takenBy === myId ? '你' : taker.name}</span></span>` : null}
            ${busy ? html`<span class="spcard__busy" role="status">选择中</span>` : null}
          </button>`;
        })}
      </div>
    </div>
  </div>`;
}
