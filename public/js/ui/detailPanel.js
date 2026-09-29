// Detail panel (click / right-click a piece, shop card, bond member, battle unit or previewed enemy):
// operators — portrait, name, tier, elite, class/subclass and, right under them in the header's right column (no
// scrolling, user playtest #2 item 9), the unit's bonds (阵营 / 盟约: icon, name, member count / next threshold,
// reached tier, active state — tap one for its popup); then stats, range mini-map, skill (the one chosen in the loadout, DESIGN §16: icon, SP info, rich description,
// 已调配 when not the default), elite module (模组: official type icon from the local-client art, else its letter), talents, 特质 (garrison), equipped items; items — icon, tier,
// effect; tokens; enemies — stats, rank, faction tags, abilities. Selling / destroying is the underframe's job in the
// match (research 09 §5, ui/underframe.js): the panel's own 出售 / 销毁 buttons only render for callers that pass
// `editable` + handlers. `side` 'right' docks the panel at the right edge (the game screen picks the side away from a
// selected unit's underframe, gameLogic panelSide).

import { html, Icon, TierChip, MicroLabel, Button, confirmDialog } from './components.js';
import { Img, RichText, UnitThumb, BondGlyph, GIcon } from './gameComponents.js';
import { attackInterval, rangeGridBox, fmtNum, tileKey, chessLoadout, nextThreshold, bondTier } from './gameLogic.js';
import { chessPortraitUrl, skillIconUrl, skillRecordIconUrl, profIconUrl, subProfIconUrl, itemIconUrl, enemyIconUrl, tokenAvatarUrl, factionIconUrl, uiUrl, moduleTypeIconUrl } from './assetUrls.js';
import { data } from '../data.js';
import { attackRangeGrid } from '../../../shared/loadoutRecord.js';
import { moduleBadge } from './loadoutModel.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

const PROF_NAME = { PIONEER: '先锋', WARRIOR: '近卫', TANK: '重装', SNIPER: '狙击', CASTER: '术师', MEDIC: '医疗', SUPPORT: '辅助', SPECIAL: '特种', TOKEN: '召唤物' };
const SP_TYPE = { INCREASE_WITH_TIME: '自动回复', INCREASE_WHEN_ATTACK: '攻击回复', INCREASE_WHEN_TAKEN_DAMAGE: '受击回复', ON_DEPLOY: '被动' };
const SKILL_TYPE = { MANUAL: '自动触发', AUTO: '自动触发', PASSIVE: '被动' };
const EVENT_ICON = { IN_BATTLE: 's_icon_battle', SERVER_GAIN: 's_icon_bond', SERVER_PREP_START: 's_icon_support', SERVER_PREP_FIN: 's_icon_support', SERVER_CHESS_SOLD: 's_icon_gold', SERVER_PRICE: 's_icon_gold', SERVER_REFRESH_SHOP: 's_icon_gold' };
const RANK = { NORMAL: '普通', ELITE: '精英', BOSS: '领袖' };
const DMG = { phys: '物理', arts: '法术', heal: '治疗', true: '真实', none: '无' };

/** Mini range map. */
export function RangeGrid({ grid, class: cls }) {
  const box = rangeGridBox(grid);
  if (!box.cells.size) return html`<span class="t-dim">—</span>`;
  const cells = [];
  for (let r = box.r0; r > box.r0 - box.rows; r--) {
    for (let c = box.c0; c < box.c0 + box.cols; c++) {
      const self = r === 0 && c === 0;
      cells.push(html`<i key=${`${r},${c}`} class=${cx(box.cells.has(tileKey(r, c)) && 'on', self && 'self')}></i>`);
    }
  }
  return html`<div class=${cx('rgrid', cls)} style=${`grid-template-columns:repeat(${box.cols}, var(--rg))`} aria-label="攻击范围">${cells}</div>`;
}

function Stat({ k, v, sub }) {
  return html`<div class="dstat"><span class="dstat__k">${k}</span><b class="dstat__v num">${v}</b>${sub ? html`<small>${sub}</small>` : null}</div>`;
}

function Section({ title, micro, children, class: cls }) {
  return html`<section class=${cx('dsec', cls)}>
    <h4 class="dsec__title">${title}${micro ? html`<${MicroLabel}>${micro}</${MicroLabel}>` : null}</h4>
    ${children}
  </section>`;
}

function ItemRow({ itemId }) {
  const it = data.lookup('items', itemId);
  return html`<div class="ditem">
    <${UnitThumb} kind="item" id=${itemId} size="sm" />
    <div class="ditem__text"><b>${it?.name || itemId}</b><${RichText} text=${it?.descRaw || it?.desc || ''} class="ditem__desc" /></div>
  </div>`;
}

/**
 * The unit's bonds right under the header: icon, name, the player's member count / next threshold, reached tier.
 * @param {{ bondIds: string[], bonds?: any[], onBond?: (bondId: string) => void }} props
 */
export function BondChips({ bondIds, bonds = [], onBond = null }) {
  const ids = Array.isArray(bondIds) ? bondIds.filter((b) => typeof b === 'string') : [];
  if (!ids.length) return null;
  const mine = new Map((Array.isArray(bonds) ? bonds : []).filter((b) => b && typeof b.bondId === 'string').map((b) => [b.bondId, b]));
  return html`<div class="dbonds dbonds--top" role="list" aria-label="所属盟约">
    ${ids.map((id) => {
      const rec = data.lookup('bonds', id);
      const e = mine.get(id) || null;
      const th = Array.isArray(e?.thresholds) && e.thresholds.length ? e.thresholds : Array.isArray(rec?.thresholds) ? rec.thresholds : [];
      const count = Number.isFinite(e?.count) ? e.count : 0;
      const tier = Number.isFinite(e?.tier) ? e.tier : bondTier(count, th, rec?.maxCount ?? null);
      const active = e ? !!e.active : tier > 0;
      const next = nextThreshold(count, th);
      const cap = next ?? th[th.length - 1] ?? null;
      const label = `${rec?.name || id}：在场 ${count}${cap != null ? `/${cap}` : ''}${active ? `，已激活 ${tier} 阶` : '，未激活'}`;
      const body = html`
        <${BondGlyph} bondId=${id} class="dbond__icon" />
        <span class="dbond__name">${rec?.name || id}</span>
        <span class=${cx('dbond__count', 'num', next == null && count > 0 && 'is-max')}>${count}${cap != null ? html`<small>/${cap}</small>` : null}</span>
        ${th.length ? html`<span class="dbond__tiers" aria-hidden="true">${th.map((_, i) => html`<i key=${i} class=${i < tier ? 'on' : ''}></i>`)}</span>` : null}`;
      return onBond
        ? html`<button key=${id} type="button" role="listitem" class=${cx('dbond', active && 'is-active', rec?.isCore && 'is-core')} title=${label} aria-label=${label}
            data-bond=${id} onClick=${() => onBond(id)}>${body}</button>`
        : html`<span key=${id} role="listitem" class=${cx('dbond', active && 'is-active', rec?.isCore && 'is-core')} title=${label} data-bond=${id}>${body}</span>`;
    })}
  </div>`;
}

/**
 * 特性 text of the record the unit fights with (DESIGN §16: `lo.record` = the chosen module's traitOverride, or the
 * no-module traitBase for 不装备 — data `trait` is the default module's).
 */
function traitText(c, golden, lo) {
  const t = (lo?.record || c).trait || {};
  const base = t.descRaw || t.desc || '';
  if (!golden || lo?.record !== c) return base;
  return t.moduleDescRaw || base;
}

function ChessDetail({ chess, piece, unit, snapHp, editable, onSell, bonds, loadout, onBond }) {
  const m = data.get('assets');
  const lo = chessLoadout(chess, loadout, (id) => data.lookup('chess', id));
  const c = chess;
  // stats / talents the unit fights with: the chosen module's (or none — statsBase) for an elite (DESIGN §16)
  const fr = lo?.record || c;
  const s = fr.stats || {};
  const golden = !!(c.isGolden || piece?.golden);
  const interval = attackInterval(s.bat, s.aspd);
  const sk = lo?.skill || c.skill || null;
  // a chosen skill the manifest has no icon for (only the default skills' icons are fetched): its slot letter
  const skIcon = sk && lo && !lo.defaultSkill ? skillRecordIconUrl(m, sk, { empty: false }) : skillIconUrl(m, c);
  const skSlot = sk && Number.isInteger(sk.index) ? `S${sk.index + 1}` : null;
  const garrison = Array.isArray(c.garrisonIds) && c.garrisonIds[0] ? data.lookup('garrisons', c.garrisonIds[0]) : null;
  const items = Array.isArray(piece?.items) ? piece.items : [];
  const sell = c.sellPrice ?? 1;
  return html`
    <div class="dhead">
      <div class=${cx('dhead__art', golden && 'is-golden', `dhead__art--t${c.tier}`)}>
        <${Img} src=${chessPortraitUrl(m, c)} fallback=${html`<${UnitThumb} kind="chess" id=${c.chessId} size="lg" />`} />
      </div>
      <div class="dhead__info">
        <div class="dhead__chips">
          <${TierChip} tier=${c.tier} golden=${golden} size="lg" />
          ${golden ? html`<span class="dtag-elite">精锐</span>` : null}
          ${piece?.kind === 'token' ? html`<span class="dtag-token">召唤物</span>` : null}
        </div>
        <h3 class="dhead__name">${c.name}</h3>
        <span class="dhead__en">${c.appellation || ''}</span>
        <div class="dhead__class">
          <${Img} src=${profIconUrl(m, c.profession)} class="dhead__prof" />
          <span>${PROF_NAME[c.profession] || c.profession || ''}</span>
          <i class="sep"></i>
          <${Img} src=${subProfIconUrl(m, c)} class="dhead__sub" />
          <span>${c.subProfessionName || ''}</span>
          <span class="dhead__pos">${c.position === 'MELEE' ? '近战位' : '远程位'}</span>
        </div>
        ${snapHp ? html`<div class="dhp"><i style=${`width:${Math.max(0, Math.min(100, (snapHp.hp / Math.max(1, snapHp.max)) * 100))}%`}></i><span class="num">${fmtNum(snapHp.hp)} / ${fmtNum(snapHp.max)}</span></div>` : null}
        <${BondChips} bondIds=${c.bonds} bonds=${bonds} onBond=${onBond} />
      </div>
    </div>
    ${c.trait?.desc ? html`<p class="dtrait"><${Icon} name="info" /><${RichText} text=${traitText(c, golden, lo)} /></p>` : null}
    <div class="dstats-wrap">
      <div class="dstats">
        <${Stat} k="生命上限" v=${fmtNum(s.maxHp)} />
        <${Stat} k="攻击" v=${fmtNum(s.atk)} />
        <${Stat} k="防御" v=${fmtNum(s.def)} />
        <${Stat} k="法术抗性" v=${s.res ?? 0} />
        <${Stat} k="攻击间隔" v=${interval ? `${interval.toFixed(2)}s` : '—'} />
        <${Stat} k="阻挡数" v=${s.blockCnt ?? '—'} />
        <${Stat} k="部署费用" v=${s.cost ?? '—'} />
        <${Stat} k="再部署" v=${s.respawnTime != null ? `${s.respawnTime}s` : '—'} />
      </div>
      <div class="drange"><span class="dstat__k">攻击范围</span><${RangeGrid} grid=${attackRangeGrid(fr) || c.rangeGrid} /></div>
    </div>
    ${sk ? html`<${Section} title="技能" micro="SKILL" class="dsec--skill">
      <div class="dskill" data-skill=${sk.skillId || ''}>
        <${Img} src=${skIcon} class="dskill__icon" fallback=${html`<span class="dskill__icon dskill__icon--empty">${skSlot ? html`<b class="num">${skSlot}</b>` : null}</span>`} />
        <div class="dskill__meta">
          <b class="dskill__name">${skSlot && (lo?.choices || 0) > 1 ? html`<span class="dskill__slot num" title=${`技能 ${skSlot}`}>${skSlot}</span>` : null}${sk.name}${lo && !lo.defaultSkill ? html`<span class="dtag-loadout" title="干员调配中选择的技能">已调配</span>` : null}</b>
          <div class="dskill__tags">
            <span class="dsp dsp--${sk.spType === 'INCREASE_WHEN_ATTACK' ? 'atk' : sk.spType === 'INCREASE_WHEN_TAKEN_DAMAGE' ? 'def' : 'time'}">${SP_TYPE[sk.spType] || '技力'}</span>
            <span class="dsp dsp--trig">${SKILL_TYPE[sk.skillType] || '自动触发'}</span>
            ${sk.spType !== 'ON_DEPLOY' && sk.skillType !== 'PASSIVE' ? html`<span class="dsp__num"><${GIcon} name="bolt" />初始 <b class="num">${sk.initSp ?? 0}</b> · 消耗 <b class="num">${sk.spCost ?? 0}</b></span>` : null}
            ${sk.duration > 0 ? html`<span class="dsp__num">持续 <b class="num">${sk.duration}</b>s</span>` : null}
            ${sk.maxChargeTime > 1 ? html`<span class="dsp__num">充能 <b class="num">${sk.maxChargeTime}</b></span>` : null}
          </div>
        </div>
      </div>
      <${RichText} as="p" text=${sk.descRaw || sk.desc} class="dtext" />
    <//>` : null}
    ${golden && lo?.module ? html`<${Section} title="模组" micro="MODULE" class="dsec--module">
      <div class=${cx('dmodule', lo.module.none && 'is-none')} data-module=${lo.module.id}>
        ${!lo.module.none && lo.module.typeName ? html`<span class="dmodule__icon" data-type=${lo.module.typeName}>
          <${Img} src=${moduleTypeIconUrl(data.get('local'), lo.module.typeName)} fallback=${html`<b class="num">${moduleBadge(lo.module)}</b>`} /></span>` : null}
        <b class="dmodule__name">${lo.module.name}</b>
        ${lo.module.typeName ? html`<span class="dmodule__type">${lo.module.typeName}</span>` : null}
        ${!lo.defaultModule ? html`<span class="dtag-loadout" title="干员调配中选择的模组">已调配</span>` : null}
      </div>
    <//>` : null}
    ${Array.isArray(fr.talents) && fr.talents.some((t) => t && t.name && !t.hidden) ? html`<${Section} title="天赋" micro="TALENT">
      ${fr.talents.filter((t) => t && t.name && !t.hidden).map((t, i) => html`<div key=${i} class="dtalent"><b>${t.name}</b><${RichText} text=${t.descRaw || t.desc} class="dtext" /></div>`)}
    <//>` : null}
    ${garrison ? html`<${Section} title="特质" micro="GARRISON">
      <div class="dgarrison">
        <span class="dgarrison__type">
          <${Img} src=${uiUrl(m, `garrisonTypeIcon/${EVENT_ICON[garrison.eventType] || 's_icon_bond'}`)} class="dgarrison__icon" />
          ${garrison.eventTypeDesc || ''}
        </span>
        <${RichText} as="p" text=${garrison.descRaw || garrison.desc} class="dtext" />
      </div>
    <//>` : null}
    ${piece?.kind === 'chess' ? html`<${Section} title="装备" micro=${`EQUIP ${items.length}/2`}>
      ${items.length ? items.map((it) => html`<${ItemRow} key=${it.uid} itemId=${it.id} />`) : html`<p class="t-dim dempty">拖拽装备至该干员以配发（最多 2 件）</p>`}
    <//>` : null}
    ${piece && editable && piece.kind !== 'item' ? html`<div class="dactions">
      <${Button} variant="amber" icon="close" class="dpanel__sell" onClick=${() => onSell(piece, c)}>出售<span class="dsell num">+${sell}</span><//>
    </div>` : null}`;
}

function ItemDetail({ item, piece, editable, onDestroy }) {
  const m = data.get('assets');
  return html`
    <div class="dhead dhead--item">
      <div class=${cx('dhead__icon', item.isGolden && 'is-golden')}><${Img} src=${itemIconUrl(m, item)} fallback=${html`<${GIcon} name="bolt" />`} /></div>
      <div class="dhead__info">
        <div class="dhead__chips"><${TierChip} tier=${item.tier} golden=${item.isGolden} size="lg" />${item.isGolden ? html`<span class="dtag-elite">进阶</span>` : null}
          <span class="dtag-kind">${item.itemType === 'MAGIC' ? '奇术' : '装备'}</span></div>
        <h3 class="dhead__name">${item.name}</h3>
        ${item.flavor ? html`<span class="dhead__flavor">${item.flavor}</span>` : null}
      </div>
    </div>
    <${Section} title="效果" micro="EFFECT"><${RichText} as="p" text=${item.descRaw || item.desc} class="dtext" /><//>
    ${item.itemType === 'MAGIC'
      ? html`<p class="dhint"><${Icon} name="info" />将其拖拽至战场上的格子使用</p>`
      : html`<p class="dhint"><${Icon} name="info" />拖拽至干员身上进行配发（每名干员最多 2 件，配发后无法取下）${item.mergeable ? '；2 件相同装备自动合成进阶装备' : ''}</p>`}
    ${piece && editable ? html`<div class="dactions"><${Button} variant="danger" onClick=${() => onDestroy(piece, item)}>销毁道具<//></div>` : null}`;
}

function EnemyDetail({ enemy, snapHp, count }) {
  const m = data.get('assets');
  const s = enemy.stats || {};
  const types = Array.isArray(enemy.acTypes) ? enemy.acTypes : enemy.acType ? [enemy.acType] : [];
  const factions = data.get('factions')?.types || {};
  const imm = Object.entries(s.immunities || {}).filter(([, v]) => v).map(([k]) => ({ stun: '晕眩', silence: '沉默', sleep: '沉睡', frozen: '冻结', levitate: '浮空' }[k] || k));
  const interval = attackInterval(s.bat, s.aspd);
  return html`
    <div class="dhead dhead--enemy">
      <div class=${cx('dhead__icon', 'dhead__icon--enemy', enemy.rank === 'BOSS' && 'is-boss', enemy.rank === 'ELITE' && 'is-elite')}>
        <${Img} src=${enemyIconUrl(m, enemy.key)} fallback=${html`<${GIcon} name="skull" />`} />
      </div>
      <div class="dhead__info">
        <div class="dhead__chips">
          <span class=${cx('drank', `drank--${(enemy.rank || 'NORMAL').toLowerCase()}`)}>${RANK[enemy.rank] || '普通'}</span>
          <span class="dtag-kind">${s.motion === 'FLY' ? '空中' : '地面'}</span>
          ${count ? html`<span class="dtag-kind num">×${count}</span>` : null}
        </div>
        <h3 class="dhead__name">${enemy.name}</h3>
        <div class="dfactions">${types.map((t) => html`<span key=${t} class="dfaction"><${Img} src=${factionIconUrl(m, factions[t]?.icon)} />${factions[t]?.name || t}</span>`)}</div>
        ${snapHp ? html`<div class="dhp dhp--enemy"><i style=${`width:${Math.max(0, Math.min(100, (snapHp.hp / Math.max(1, snapHp.max)) * 100))}%`}></i><span class="num">${fmtNum(snapHp.hp)} / ${fmtNum(snapHp.max)}</span></div>` : null}
      </div>
    </div>
    <div class="dstats">
      <${Stat} k="生命上限" v=${fmtNum(s.maxHp)} />
      <${Stat} k="攻击" v=${fmtNum(s.atk)} sub=${DMG[s.dmgType] || ''} />
      <${Stat} k="防御" v=${fmtNum(s.def)} />
      <${Stat} k="法术抗性" v=${s.res ?? 0} />
      <${Stat} k="移动速度" v=${s.moveSpeed ?? '—'} />
      <${Stat} k="攻击间隔" v=${interval ? `${interval.toFixed(1)}s` : '—'} />
      <${Stat} k="攻击范围" v=${s.rangeRadius > 0 ? s.rangeRadius : '近战'} />
      <${Stat} k="目标价值" v=${s.lpr ?? 1} />
    </div>
    ${imm.length ? html`<p class="dhint"><${Icon} name="shield" />免疫：${imm.join('、')}</p>` : null}
    ${Array.isArray(enemy.abilities) && enemy.abilities.length ? html`<${Section} title="能力" micro="ABILITIES">
      <ul class="dabil">${enemy.abilities.map((a, i) => html`<li key=${i}><${RichText} text=${typeof a === 'string' ? a : a.textRaw || a.text} /></li>`)}</ul>
    <//>` : enemy.descRaw || enemy.desc ? html`<${Section} title="说明"><${RichText} as="p" text=${enemy.descRaw || enemy.desc} class="dtext" /><//>` : null}`;
}

function TokenDetail({ token, piece }) {
  const m = data.get('assets');
  const s = token.stats || {};
  return html`
    <div class="dhead dhead--item">
      <div class="dhead__icon"><${Img} src=${tokenAvatarUrl(m, token.tokenId)} fallback=${html`<${GIcon} name="target" />`} /></div>
      <div class="dhead__info">
        <div class="dhead__chips"><span class="dtag-token">召唤物</span>${piece?.count > 1 ? html`<span class="dtag-kind num">×${piece.count}</span>` : null}</div>
        <h3 class="dhead__name">${token.name}</h3>
      </div>
    </div>
    <div class="dstats">
      <${Stat} k="生命上限" v=${fmtNum(s.maxHp)} /><${Stat} k="攻击" v=${fmtNum(s.atk)} />
      <${Stat} k="防御" v=${fmtNum(s.def)} /><${Stat} k="阻挡数" v=${s.blockCnt ?? '—'} />
    </div>
    ${token.descRaw || token.desc ? html`<${Section} title="说明"><${RichText} as="p" text=${token.descRaw || token.desc} class="dtext" /><//>` : null}`;
}

/**
 * Resolve what a detail target shows.
 * @param {{ kind:'piece'|'chess'|'item'|'enemy'|'unit'|'token', id?:string, uid?:number, unit?:any, count?:number }} target
 * @param {Map<number, any>} pieces indexPieces(priv)
 */
export function resolveDetail(target, pieces) {
  if (!target) return null;
  if (target.kind === 'piece') {
    const e = pieces?.get(target.uid);
    if (!e) return null;
    const p = e.piece;
    if (p.kind === 'item') { const it = data.lookup('items', p.id); return it ? { type: 'item', item: it, piece: p } : null; }
    if (p.kind === 'token') { const t = data.lookup('tokens', p.id); return t ? { type: 'token', token: t, piece: p } : null; }
    const c = data.lookup('chess', p.id);
    return c ? { type: 'chess', chess: c, piece: p } : null;
  }
  if (target.kind === 'chess') { const c = data.lookup('chess', target.id); return c ? { type: 'chess', chess: c } : null; }
  if (target.kind === 'item') { const it = data.lookup('items', target.id); return it ? { type: 'item', item: it } : null; }
  if (target.kind === 'enemy') { const en = data.lookup('enemies', target.id); return en ? { type: 'enemy', enemy: en, count: target.count } : null; }
  if (target.kind === 'token') { const t = data.lookup('tokens', target.id); return t ? { type: 'token', token: t } : null; }
  if (target.kind === 'unit') {
    const u = target.unit || {};
    const own = Number.isInteger(u.uid) ? pieces?.get(u.uid) : null;
    if (u.side === 'enemy') { const en = data.lookup('enemies', u.defId); return en ? { type: 'enemy', enemy: en, unitId: u.id } : null; }
    const c = data.lookup('chess', u.defId);
    if (c) return { type: 'chess', chess: c, piece: own?.piece || null, unitId: u.id };
    const t = data.lookup('tokens', u.defId);
    if (t) return { type: 'token', token: t, unitId: u.id };
    const en = data.lookup('enemies', u.defId);
    return en ? { type: 'enemy', enemy: en, unitId: u.id } : null;
  }
  return null;
}

/**
 * The panel.
 * @param {{ detail:any, editable:boolean, snapHp?:{hp:number,max:number}|null, onClose:Function, onSell:(piece:any)=>void, onDestroy:(piece:any)=>void,
 *   bonds?: any[], loadout?: any, onBond?: (bondId:string)=>void, side?: 'left'|'right', shopOpen?: boolean }} props
 *   bonds: the owner's m.private.bonds (counts / tiers of the bond chips); loadout: m.private.loadout (DESIGN §16) for
 *   the player's own operators and shop cards; a teammate's unit gets its owner's choice (gameLogic unitLoadout); null
 *   = the defaults
 */
export function DetailPanel({ detail, editable, snapHp, onClose, onSell, onDestroy, bonds = [], loadout = null, onBond = null, side = 'left', shopOpen = false }) {
  if (!detail) return null;
  const sellIt = async (piece, chess) => {
    const golden = piece.golden || chess?.isGolden;
    if (golden) {
      const ok = await confirmDialog({ title: '出售精锐干员', text: `确定要出售精锐干员「${chess?.name || ''}」吗？出售后获得 ${chess?.sellPrice ?? 1} 资金。`, okText: '出售', danger: true });
      if (!ok) return;
    }
    onSell(piece);
  };
  const destroyIt = async (piece, item) => {
    const ok = await confirmDialog({ title: '销毁道具', text: `道具无法出售。确定要销毁「${item?.name || ''}」吗？`, okText: '销毁', danger: true });
    if (ok) onDestroy(piece);
  };
  return html`<aside class=${cx('dpanel', 'brackets', `dpanel--${detail.type}`, side === 'right' && 'dpanel--right', side === 'right' && shopOpen && 'is-shop')} role="dialog" aria-label="详情"
      data-side=${side === 'right' ? 'right' : 'left'}>
    <button type="button" class="dpanel__close" aria-label="关闭" onClick=${onClose}><${Icon} name="close" /></button>
    <div class="dpanel__scroll">
      ${detail.type === 'chess' ? html`<${ChessDetail} chess=${detail.chess} piece=${detail.piece} snapHp=${snapHp} editable=${editable} onSell=${sellIt}
        bonds=${bonds} loadout=${loadout} onBond=${onBond} />` : null}
      ${detail.type === 'item' ? html`<${ItemDetail} item=${detail.item} piece=${detail.piece} editable=${editable} onDestroy=${destroyIt} />` : null}
      ${detail.type === 'enemy' ? html`<${EnemyDetail} enemy=${detail.enemy} snapHp=${snapHp} count=${detail.count} />` : null}
      ${detail.type === 'token' ? html`<${TokenDetail} token=${detail.token} piece=${detail.piece} />` : null}
    </div>
  </aside>`;
}

