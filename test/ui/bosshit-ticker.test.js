// Player report after 0.1.0, client part: "隐藏boss还没打就出了造成50%伤害播报". Besides the server's share (fixed in
// server/match/Match.js, test/match/bosshit-ticker.test.js) the ticker strip plays its queue in order, TICKER_MS (5.2 s)
// per line and up to QUEUE_MAX (4) lines behind: in a headless-Chrome run the Final Assault's "超过20%" / "超过80%"
// lines played 2–8 s into the Hidden Core with its leader at 96 % / 53 %. A leader-damage line (BOSS_HIT) now plays
// only during the round it came in (ui/ticker.js tickerLineLive; main.js stamps each line with its type and round).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { tickerLineLive } = await import('../../public/js/ui/ticker.js');

test('tickerLineLive: a BOSS_HIT line plays only in the round it came in; every other line always plays', () => {
  const fa = { type: 'BOSS_HIT', round: 14, text: 'P博士对敌方领袖造成的伤害超过50%!' };
  assert.equal(tickerLineLive(fa, 14), true, 'during the Final Assault');
  assert.equal(tickerLineLive(fa, 15), false, 'the Hidden Core\'s round: the Final Assault\'s line is stale');
  assert.equal(tickerLineLive({ ...fa, round: 15 }, 15), true, 'the Hidden Core\'s own line');
  // solo FUNNY's boss round 9
  assert.equal(tickerLineLive({ ...fa, round: 9 }, 9), true);
  // other lines are not about the leader in play
  for (const type of ['SHOP_LEVEL', 'GOLDEN_CHAR', 'CHAR_DAMAGE', 'CHAR_GIFT', 'CUSTOM', null, undefined]) {
    assert.equal(tickerLineLive({ type, round: 14, text: 'x' }, 15), true, String(type));
  }
  // no round known (an old line, a reconnect before m.public): plays
  assert.equal(tickerLineLive({ type: 'BOSS_HIT', round: null }, 15), true);
  assert.equal(tickerLineLive(fa, null), true);
  assert.equal(tickerLineLive(null, 15), true);
});

test('main.js stamps every ticker line with its type and the round it came in; the strip filters on a round change', () => {
  const main = readFileSync(new URL('../../public/js/main.js', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf("net.on('m.ticker'"), main.indexOf("net.on('m.emote'"));
  assert.match(handler, /type,\s*round:\s*s\.match\?\.public\?\.round/, 'the m.ticker handler keeps type and round');
  const strip = readFileSync(new URL('../../public/js/ui/ticker.js', import.meta.url), 'utf8');
  assert.match(strip, /useStore\(\(s\) => s\.match\?\.public\?\.round/, 'the strip follows m.public.round');
  assert.match(strip, /\}, \[round\]\);/, 'a round change re-filters the queue and the line on screen');
});
