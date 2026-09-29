// E2E helper: the real server (server/index.js startServer) with the real match engine, but with scaled phase timers
// and a faster combat clock so a browser run can reach the RESULT screen in a few minutes.
//   PORT=… SP_TIMER_SCALE=0.25 SP_COMBAT_SPEED=16 node test/e2e/fastServer.mjs
// Test hook (never used by the real server): SP_START_ROUND = 'boss' | 'hidden' | <round> makes the first round of
// every match that round instead of round 1, and hands every human a starter kit (SP_START_KIT operators: tier-1..3
// visible chess, melee and ranged alternating, into the hand; default 4) plus 20 funds — so a browser test reaches
// the Final Assault / Hidden Core prep at once (test/ui/bossPrep.e2e.test.js).
// SP_START_CHESS=<chessId,…>: the starter kit is exactly these chess (normal or elite ids) instead of the tier-1..3 picks
// (test/ui/loadout-battle.e2e.test.js: a known elite whose chosen skill / module the battle must use).
// SP_IDLE_BOTS=1: AI seats only ready up (no shop, no board) — test/ui/playtest2.real.e2e.test.js observes their battles.
// SP_START_ITEMS=<itemId,…>: the starter kit also puts these items into the hand (test/ui/leftovers.e2e.test.js: three
// distinct equipment items → the equip-replace dialog).
// Not a test file (node --test runs it as a no-op module when NODE_TEST_CONTEXT is set).

import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';

if (!process.env.NODE_TEST_CONTEXT) {
  const timerScale = Number(process.env.SP_TIMER_SCALE) || 1;
  const combatSpeed = Number(process.env.SP_COMBAT_SPEED) || 2;
  const startAt = String(process.env.SP_START_ROUND || '').trim();
  const kitSize = Math.max(0, Math.min(8, Number(process.env.SP_START_KIT ?? 4) || 0));
  // test hook: AI seats buy and place nothing (they only ready up) — their battles are pure leaks, i.e. they last the
  // enemies' whole walk, so a human's quick battle ends first and the human can observe a still running AI field
  const idleBots = process.env.SP_IDLE_BOTS === '1';
  const kitIds = String(process.env.SP_START_CHESS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const kitItems = String(process.env.SP_START_ITEMS || '').split(',').map((x) => x.trim()).filter(Boolean);

  class FastMatch extends Match {
    constructor(opts) {
      super({ ...opts, timerScale, combatSpeed });
      this._jumped = !startAt;
    }

    startRound(r) {
      if (this._jumped) { super.startRound(r); return; }
      this._jumped = true;
      const target = startAt === 'boss' ? this.gd.bossRound : startAt === 'hidden' ? (this.gd.hiddenRound || this.gd.bossRound) : Number(startAt);
      super.startRound(Number.isInteger(target) && target > r ? target : r);
      for (const ps of this.alivePlayers()) if (!ps.isBot) this._starterKit(ps);
    }

    scheduleBotPrep(ps, i = 0) {
      if (!idleBots) { super.scheduleBotPrep(ps, i); return; }
      const round = this.round;
      this.later(this.scaled(400 + i * 100), () => {
        if (this.phase !== 'PREP' || this.round !== round || !ps.alive || ps.ready || !ps.botControlled) return;
        ps.resolveTemp();
        ps.setReady(true);
      });
    }

    /** A few cheap operators in the hand + funds (a test hook: the rounds before were skipped). */
    _starterKit(ps) {
      const all = Object.values(this.data.chess || {}).filter((c) => c && c.visible && !c.isGolden && c.tier <= 3)
        .sort((a, b) => (a.tier - b.tier) || String(a.chessId).localeCompare(String(b.chessId)));
      const melee = all.filter((c) => c.position === 'MELEE');
      const ranged = all.filter((c) => c.position !== 'MELEE');
      const picks = kitIds.map((id) => this.data.chess?.[id]).filter(Boolean);
      for (let i = 0; !kitIds.length && picks.length < kitSize && (melee[i] || ranged[i]); i++) {
        if (melee[i]) picks.push(melee[i]);
        if (ranged[i] && picks.length < kitSize) picks.push(ranged[i]);
      }
      for (const rec of picks) {
        const slot = ps.hand.findIndex((x) => x == null);
        if (slot < 0) break;
        try {
          const taken = this.pool.take(this.gd.baseIdOf(rec.chessId), rec.isGolden ? this.gd.goldenCopies : 1);
          if (!taken && !kitIds.length) continue; // an explicit SP_START_CHESS piece is handed out even when this match bans it
          ps.hand[slot] = ps.newPiece('chess', rec.chessId, { poolCopies: taken });
        } catch { /* keep going: the kit is best effort */ }
      }
      for (const itemId of kitItems) {
        const slot = ps.hand.findIndex((x) => x == null);
        if (slot < 0 || !this.gd.item(itemId)) continue;
        try { ps.hand[slot] = ps.newPiece('item', itemId); } catch { /* best effort */ }
      }
      ps.addFunds(20, { reason: 'income' });
      ps.recompute();
    }
  }

  const srv = await startServer({ port: Number(process.env.PORT) || 0, host: process.env.HOST || '127.0.0.1', quiet: true, MatchClass: FastMatch });
  console.log(`fast server on ${srv.url} (timers ×${timerScale}, combat ${combatSpeed}×${startAt ? `, first round ${startAt}` : ''})`);
  const stop = () => { srv.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
