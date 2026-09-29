// Left team panel (research 06 §11.1, research 09 §3.1): one row per seat — avatar (band icon once picked), name, LP
// tower, status glyph (… acting / ✓ ready / ⌛ deciding / ⚔ combat / door left / ✕ dead), AI badge, "you" marker, the
// field being watched (eye badge), and emote bubbles.
// Observing (client-side combat, `observe` prop — the official flow): tapping a teammate's avatar expands a mint
// "前往查看" button under the row (when that teammate can be observed now; otherwise the reason is toasted through
// onWatch); while observing, the own row shows a "返回战场" button. Without `observe` (server-run combat) a click
// watches that player's field at once.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Icon, Tooltip } from './components.js';
import { PlayerAvatar, LpTower, GIcon, LocalSprite } from './gameComponents.js';
import { EmoteBubble } from './emotes.js';
import { STATUS_META, sortedPlayers } from './gameLogic.js';
import { localAsset } from '../data.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Official status glyphs (ui/battle) per m.public players[].status; CSS glyph fallback. */
const STATUS_SPRITE = { ready: 'icon_ready', deciding: 'icon_waiting', done: 'icon_complete', dead: 'icon_dead' };

/**
 * @param {{ pub:any, myId:string, watching:string|null, bubbles: Map<string,{id:string,seq:number}>, onWatch:(p:any)=>void,
 *   compact?: boolean, teamLp?: number|null,
 *   observe?: null | { canObserve: (p:any) => { fieldId?: string, reason?: string|null, back?: boolean }, observing: boolean, onBack: () => void } }} props
 */
export function TeamPanel({ pub, myId, watching, bubbles, onWatch, compact = false, observe = null }) {
  const [openPid, setOpenPid] = useState(null);
  const phaseKey = `${pub?.phase}:${pub?.round}`;
  useEffect(() => { setOpenPid(null); }, [phaseKey, watching, observe?.observing]);
  const players = sortedPlayers(pub);
  if (!players.length) return null;
  const click = (p, self) => {
    if (!observe) { onWatch(p); return; }
    if (self) { if (observe.observing) observe.onBack(); setOpenPid(null); return; }
    const t = observe.canObserve(p) || {};
    if (!t.fieldId) { setOpenPid(null); onWatch(p); return; } // the game screen toasts the reason
    setOpenPid((cur) => (cur === p.playerId ? null : p.playerId));
  };
  return html`<aside class=${cx('team', compact && 'team--compact')} aria-label="同盟成员">
    ${players.map((p) => {
      const self = p.playerId === myId;
      const status = p.alive === false ? 'dead' : p.status;
      const meta = STATUS_META[status] || STATUS_META.acting;
      const watched = watching && (watching === p.fieldId || watching === `n:${p.playerId}`);
      const bubble = bubbles?.get(p.playerId);
      const offline = p.connected === false && !p.isBot;
      const open = !!observe && openPid === p.playerId && !self;
      const back = !!observe && self && observe.observing;
      const title = observe ? (self ? (observe.observing ? '返回战场' : '你自己') : `查看 ${p.name} 的战场`) : (self ? '查看自己的阵地' : `查看 ${p.name} 的阵地`);
      return html`<div key=${p.playerId} class=${cx('team__row', self && 'is-self', watched && 'is-watched', p.alive === false && 'is-dead', open && 'is-open')}>
        <button type="button" class="team__btn" onClick=${() => click(p, self)} title=${title} aria-expanded=${observe && !self ? String(open) : undefined}>
          <${PlayerAvatar} player=${p} self=${self} />
          <span class="team__seat num">P${(p.seat ?? 0) + 1}</span>
          ${p.isBot ? html`<span class="team__ai">AI</span>` : null}
          ${self ? html`<span class="team__you"><${Icon} name="user" /></span>` : null}
        </button>
        <div class="team__info">
          <span class="team__name">${p.name || '博士'}</span>
          <div class="team__line">
            <${LpTower} value=${p.lp} size="sm" tone=${Number.isFinite(p.lp) && p.lp <= 5 ? 'danger' : null} />
            <${Tooltip} text=${offline ? '连接已断开' : meta.text} placement="right">
              <span class=${cx('team__status', `is-${meta.tone}`, offline && 'is-offline', (offline || STATUS_SPRITE[status]) && localAsset('ui/battle', offline ? 'icon_lost_connect' : STATUS_SPRITE[status]) && 'has-sprite')} aria-label=${meta.text}>
                ${offline ? html`<${LocalSprite} name="icon_lost_connect" fallback=${html`<${Icon} name="wifiOff" />`} />`
                  : STATUS_SPRITE[status] ? html`<${LocalSprite} name=${STATUS_SPRITE[status]} fallback=${html`<${GIcon} name=${meta.glyph} />`} />`
                  : html`<${GIcon} name=${meta.glyph} />`}
              </span>
            <//>
            ${watched && !self ? html`<span class="team__eye" title="正在查看"><${GIcon} name="eye" /></span>` : null}
          </div>
          ${open ? html`<button type="button" class="btn btn--primary btn--sm team__ob"
            onClick=${() => { setOpenPid(null); onWatch(p); }}><span class="btn__label">前往查看</span></button>` : null}
          ${back ? html`<button type="button" class="btn btn--secondary btn--sm team__back"
            onClick=${() => observe.onBack()}><span class="btn__label">返回战场</span></button>` : null}
        </div>
        ${bubble ? html`<${EmoteBubble} key=${bubble.seq} id=${bubble.id} class="team__bubble" />` : null}
      </div>`;
    })}
  </aside>`;
}
