// Broadcast ticker (m.ticker): a strip under the top bar; each line slides in from the right, stays
// TICKER_MS and leaves; queued lines play in order (only the newest QUEUE_MAX are kept).
// A leader-damage line (BOSS_HIT "{0}博士对敌方领袖造成的伤害超过X%!") is news about the leader in play: it is dropped,
// queued or on screen, once the round it came in is over — the queue can lag a line by up to QUEUE_MAX × TICKER_MS, and
// a Final Assault line must never play over the Hidden Core's fresh leader (player report after 0.1.0: "隐藏boss还没打
// 就出了造成50%伤害播报"). Lines carry `type` and `round` from main.js (the m.ticker handler).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { GIcon, RichText } from './gameComponents.js';
import { useStore } from '../store.js';
import { audio } from '../audio.js';

const TICKER_MS = 5200;
const QUEUE_MAX = 4;

/**
 * Whether a ticker line may still play in `round` (m.public.round): every line except a BOSS_HIT line from another
 * round (the Final Assault's lines once the Hidden Core's round started). Lines without a round always play.
 * @param {{ type?: string|null, round?: number|null }|null} line
 * @param {number|null} round
 */
export function tickerLineLive(line, round) {
  if (!line || line.type !== 'BOSS_HIT') return true;
  return line.round == null || round == null || line.round === round;
}

/** Ticker strip bound to store.ticker. */
export function Ticker() {
  const items = useStore((s) => s.ticker);
  const round = useStore((s) => s.match?.public?.round ?? null);
  const seen = useRef(null);
  const queue = useRef([]);
  const roundRef = useRef(round);
  const [cur, setCur] = useState(null);
  const timer = useRef(null);
  roundRef.current = round;

  useEffect(() => {
    const list = Array.isArray(items) ? items : [];
    if (seen.current == null) {
      // lines received before this screen mounted are history, not news
      seen.current = list.length ? list[list.length - 1].id : 0;
      return;
    }
    const fresh = list.filter((t) => t && t.id > seen.current && Date.now() - t.at < 30000);
    if (!fresh.length) return;
    seen.current = fresh[fresh.length - 1].id;
    queue.current = [...queue.current, ...fresh].slice(-QUEUE_MAX);
    if (!cur) next();
  }, [items]);

  // a new round: the last round's leader-damage lines leave the queue and the strip
  useEffect(() => {
    queue.current = queue.current.filter((t) => tickerLineLive(t, round));
    if (cur && !tickerLineLive(cur, round)) next();
  }, [round]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function next() {
    let it = queue.current.shift() || null;
    while (it && !tickerLineLive(it, roundRef.current)) it = queue.current.shift() || null;
    setCur(it);
    clearTimeout(timer.current);
    if (it) {
      audio.sfx('broadcast', { volume: 0.5 });
      timer.current = setTimeout(next, TICKER_MS);
    }
  }

  if (!cur) return null;
  return html`<div class="ticker" role="status" aria-live="polite">
    <div key=${cur.id} class="ticker__line"><${GIcon} name="flag" class="ticker__icon" /><${RichText} text=${cur.text} /></div>
  </div>`;
}
