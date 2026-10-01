// Documentation ⇄ code consistency (docs/DESIGN.md, DATA.md, META.md, SIM.md, README.md, DEPLOY.md, PLAYING.md).
// Every rule the final documentation sweep corrected is checked twice: the code still behaves as the docs now say, and
// the stale wording does not come back. Topics: combat / boss clocks in REAL seconds (overtime after 150 real s,
// m.public.overtimeAt), 联防 helper order (unite.helperOrder, research 08 §5), boss results handed over instead of a
// synthetic zero, reconnect windows (co-op 10 min, solo singleReconnectTime 24 h), g.equip replaceUid + equipped items
// locked, battleId unique per match, solo pause (g.pause / m.public.paused), road-over-floor lanes, module icons from
// local art, 标准 = 战场#01 only; user playtest #3 (DESIGN §17): temp overflow kept until the first prep its player can
// act in (never wiped at the round start), the 回环射手 boomerang and 蕾缪安's shells one by one, the live LP, the detail
// card order and the static game data; user playtest #4 (DESIGN §18): picking by the tile under the pointer and the
// dragged model held under it, a single human untimed, the strategy draft's one countdown, 机变 two taps, knocked-out
// operators and the official element gauges, live stats, the shop-only items, skill summons, 炎佑; user playtest #5
// (DESIGN §19): blocking by contact radius, 联防 forced exit, huge-boss hit areas and 自缚, the element pipeline rules,
// boss-field deployment, the phone prep camera — and the normative §3 / §5.1 / §5.5 / §6.1 / §7 lines that changed; user
// playtest #6 (DESIGN §20): summons placed by hand (start deploy), skill triggers and the operation cooldown, every
// blocker hits what it blocks, push force vs weight, the ASPD floor, the enemies' collider reach, the boss pool floor,
// multi-round bounties lasting two battles, the 联防 counter, the element gauge — and the user's settled decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameData } from '../server/match/gamedata.js';
import { helperOrder } from '../server/match/unite.js';
import { NET_DEFAULTS } from '../server/net.js';
import { SOLO_RECONNECT_FALLBACK_SEC } from '../server/lobby.js';
import { moduleTypeIconUrl } from '../public/js/ui/assetUrls.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR, PHASE } from '../shared/constants.js';
import { PROJECTILE_SPEEDS, BOOMERANG_RETURN_SPEED, ELEMENT, ELEMENT_ORDER, DOWN_STATE, BLOCK_RADIUS, FORCED_EXIT, ASPD_MIN, BOSS_POOL_MIN_HP, AUTO_OP_COOLDOWN, ALLY_COLLIDER_RADIUS } from '../server/sim/constants.js';
import { SKILL_SUMMON_START_DEPLOY } from '../shared/constants.js';
import { MULTI_ROUND_BOUNTY_BATTLES } from '../server/match/choices.js';
import { SELF_BOUND } from '../server/sim/content/bosses.js';
import * as BOARD from '../server/match/board.js';
import * as DAMAGE from '../server/sim/damage.js';
import { SUB } from '../server/sim/professions.js';
import { ENEMY_REACH } from '../public/js/render/pick.js';
import { BAND_TURN_SECONDS } from '../server/match/Match.js';
import { SPINE_EVICT_DELAY_MS, SPINE_QUIET_DELAY_MS } from '../public/js/assets.js';
import { RETRY_DELAYS_MS } from '../public/js/data.js';
import { DATA, makeMatch } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = (p) => readFileSync(join(ROOT, p), 'utf8');
const DESIGN = doc('docs/DESIGN.md');
const META = doc('docs/META.md');
const DATA_MD = doc('docs/DATA.md');
const SIM = doc('docs/SIM.md');
const README = doc('README.md');
const DEPLOY = doc('docs/DEPLOY.md');
const PLAYING = doc('docs/PLAYING.md');
/** The table row of DATA.md whose first cell is `key` (backticked), or ''. */
const dataRow = (key, from = 0) => {
  const i = DATA_MD.indexOf(`| \`${key}\` |`, from);
  return i < 0 ? '' : DATA_MD.slice(i, DATA_MD.indexOf('\n', i));
};

test('combat limits and the boss overtime are REAL seconds (code) and the docs say so', () => {
  const gd = new GameData(DATA, 'mode_multi_hard');
  assert.equal(gd.combatTimeScale, 2);
  assert.equal(gd.combatTimeLimit(1), 2 * gd.combatTimeLimitReal(1), 'Battle limit = 2 × data (game s)');
  assert.equal(gd.bossOvertimeAfterReal, 150);
  assert.equal(gd.bossOvertimeDue(300), 0, 'nothing at 150 real s = 300 game s');
  assert.equal(gd.bossOvertimeDue(302), 1, 'the first point at 151 real s');
  assert.equal(gd.bossOvertimeDue(320), 10, '1 LP per real second');
  assert.equal(gd.bossLevelTime(14), 120, 'the Final Assault countdown (not a hard stop)');
  // DESIGN
  assert.ok(!/overtime −1 LP\/s after 150 s game time/.test(DESIGN), 'DESIGN §6.1: no game-second overtime');
  assert.ok(!/team LP per game second after `bossOvertimeAfter` game s/.test(DESIGN), 'DESIGN §14: no game-second overtime');
  assert.match(DESIGN, /150 real s/);
  assert.match(DESIGN, /overtimeAt/);
  // DATA
  assert.match(dataRow('combatTimeLimit', DATA_MD.indexOf('`rounds[r]`:')), /\*\*real\*\* seconds/, 'rounds[r].combatTimeLimit row');
  assert.match(dataRow('maxPlayTime'), /\*\*real\*\* seconds/, 'waves.json maxPlayTime row');
  assert.match(dataRow('bossOvertimeAfter'), /\*\*real\*\* second/, 'rounds[r].bossOvertimeAfter row');
  assert.match(dataRow('levelMaxPlayTime'), /countdown/);
  // META / SIM / PLAYING
  assert.match(META, /150 real s/);
  assert.match(META, /`m\.public\.overtimeAt`/);
  assert.match(SIM, /2 × the round's combatTimeLimit/);
  assert.match(PLAYING, /120 秒倒计时结束后战斗\*\*继续\*\*/);
});

test('联防 helpers follow unite.helperOrder (units > active bond > standing > seat; LP plays no part) and the docs name it', () => {
  const player = (playerId, seat, lp, units, bond = false) => ({
    playerId, seat, lp, deployCount: units, board: new Map(), layers: {},
    bonds: bond ? { bond_x: { active: true, layers: 5 } } : {},
  });
  const m = { gd: { unite: { maxHelpers: 2 } } };
  const a = player('a', 0, 40, 3);          // most LP, fewest units
  const b = player('b', 1, 1, 5);           // most units
  const c = player('c', 2, 2, 5, true);     // most units + an active bond
  const order = helperOrder(m, [a, b, c], new Map()).map((p) => p.playerId);
  assert.deepEqual(order, ['c', 'b'], 'LP never decides; the first helper (right-hand field) is c');
  assert.ok(!/highest LP, then seat/.test(DESIGN), 'DESIGN §6.1 no longer picks helpers by LP');
  assert.match(DESIGN, /helperOrder/);
  assert.match(META, /unite\.js helperOrder/);
  assert.match(DATA_MD, /server\/match\/unite\.js helperOrder/);
  assert.ok(!/spawn window ≤ 40 % of the limit/.test(META), 'META §7: the 联防 timing is the official one');
});

test('boss results: no synthetic zero for a running boss field (docs), handover documented', () => {
  assert.ok(!/synthetic zero result \(boss\)/.test(DESIGN));
  assert.match(DESIGN, /_bossHandover/);
  assert.match(META, /hands the field to the partner's replica or the server/);
});

test('reconnect windows: co-op 10 min, solo singleReconnectTime 24 h (code, data, every doc)', () => {
  assert.equal(NET_DEFAULTS.reconnectWindowMs, 10 * 60_000);
  assert.equal(SOLO_RECONNECT_FALLBACK_SEC, 86_400);
  assert.equal(DATA.config.constants.singleReconnectTime, 86_400);
  assert.match(DESIGN, /singleReconnectTime/);
  assert.match(DESIGN, /24 h/);
  assert.match(META, /singleReconnectTime/);
  assert.match(dataRow('constants'), /singleReconnectTime/);
  for (const [name, text] of [['README', README], ['DEPLOY', DEPLOY], ['PLAYING', PLAYING]]) {
    assert.match(text, /24 小时/, `${name}: solo resume window`);
    assert.match(text, /10 分钟/, `${name}: co-op window`);
  }
  assert.ok(!/断线 10 分钟内可重连，掉线期间 AI 托管/.test(README), 'README: a dropped seat is not AI-played unless 暂离');
});

test('equipment: g.equip replaceUid and locked equipped items are in the contract docs', () => {
  assert.match(DESIGN, /`g\.equip \{itemUid, targetUid, replaceUid\?\}`/);
  assert.match(DESIGN, /equipped items are locked/);
  assert.match(META, /g\.equip\s*\n?\s*\{ itemUid, targetUid, replaceUid \}/);
  assert.match(README, /已配发的装备锁定在干员身上/);
  assert.match(PLAYING, /已配发的装备锁定在干员身上/);
});

test('battleId is unique per match although field ids repeat (code) and DESIGN §14 says so', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 2, bots: 1, seed: 4242, fake: true, clientCombat: true, captureFrames: false });
  h.autoHumans();
  const byId = new Map(); // battleId → 'round|fieldId'
  h.onSend.push((pid, msg) => {
    if (msg.t !== 'b.start') return;
    const key = `${msg.spec && msg.spec.round}|${msg.fieldId}`;
    if (!byId.has(msg.battleId)) byId.set(msg.battleId, key);
    else assert.equal(byId.get(msg.battleId), key, 'one battleId never names two battles');
  });
  h.start();
  h.run(() => h.ended != null || h.m.round >= 4, { maxSteps: 2e6 });
  h.m.dispose();
  const keys = [...byId.values()];
  assert.ok(keys.length >= 4, `battles seen (${keys.length})`);
  assert.equal(new Set(keys).size, keys.length, 'every battle has its own id');
  const own = [...byId].filter(([, k]) => k.endsWith('|n:p_0')).map(([id]) => id);
  assert.ok(own.length >= 2 && new Set(own).size === own.length, 'the same fieldId gets a new battleId every round');
  for (const [id, key] of byId) {
    const round = key.split('|')[0];
    assert.ok(id.split('.')[1] === round, `${id}: <prefix>.<round>.<seq>[.<fieldId>]`);
    assert.ok(id.length <= 64, 'protocol ids are ≤ 64 chars');
  }
  assert.match(DESIGN, /`<prefix>\.<round>\.<seq>\.<fieldId>`/);
});

test('stages: 标准 = 战场#01 only (data) and the docs say so; road-over-floor lanes documented', () => {
  for (const id of ['mode_multi_funny', 'mode_single_funny']) assert.deepEqual(DATA.config.modes[id].stages, ['act1autochess_m01'], id);
  assert.ok(!DATA.config.modes.mode_multi_hard.stages.includes('act1autochess_m01'), '绝境 has no 战场#01');
  assert.match(DESIGN, /标准 FUNNY = 战场#01/);
  assert.match(dataRow('stages'), /战场#01 only/);
  assert.match(PLAYING, /标准模拟固定为「战场#01」/);
  // 战场#01 lower gate: the col-8 road, not the col-9 floor lane (grid.js blockable-ground preference)
  const path = DATA.stages.act1autochess_m01.groundPaths['9,10->9,2'];
  assert.ok(path.some(([r, c]) => r === 10 && c === 8) && !path.some(([r, c]) => r === 10 && c === 9), 'col-8 road');
  assert.match(dataRow('groundPaths` / `groundPathsWithDevices'), /road-over-floor/);
  assert.match(SIM, /fewest non-blockable tiles/);
});

test('module type icons come from the local-client art, case-insensitively (code + DESIGN §13)', () => {
  const local = { groups: { module: { 'PRI-X': { path: 'a.png' }, 'isw-a': { path: 'b.png' } } } };
  assert.equal(moduleTypeIconUrl(local, 'PRI-X'), 'a.png');
  assert.equal(moduleTypeIconUrl(local, 'ISW-α'), 'b.png', 'Greek letter → Latin file name');
  assert.equal(moduleTypeIconUrl(null, 'PRI-X'), null, 'no local art ⇒ lettered fallback');
  assert.match(DESIGN, /moduleTypeIconUrl/);
  assert.match(DESIGN, /`ISW-α` → `isw-a`/);
});

test('solo pause: g.pause {on} is solo-only and m.public.paused follows (code) — documented everywhere', () => {
  assert.equal(validateC2S({ t: 'g.pause', on: true }), null, 'protocol knows g.pause {on}');
  const co = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 1, bots: 1, seed: 7, fake: true });
  co.start();
  assert.equal(co.m.handle('p_0', { t: 'g.pause', on: true }).error, ERR.WRONG_PHASE, 'co-op battles never pause');
  assert.equal(co.m.publicView().paused, false);
  co.m.dispose();
  const solo = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 7, fake: true });
  solo.start();
  assert.equal(solo.m.handle('p_0', { t: 'g.pause', on: true }).error, ERR.WRONG_PHASE, 'no battle running yet');
  assert.deepEqual(solo.m.handle('p_0', { t: 'g.pause', on: false }), { ok: true }, 'on: false is always accepted');
  solo.m.dispose();
  assert.match(DESIGN, /`g\.pause \{on\}`/);
  assert.match(DESIGN, /\*\*Solo pause/);
  assert.match(META, /`m\.public\.paused`|`paused`\n?\(solo pause/);
  assert.match(README, /暂停（独立模拟）/);
  assert.match(PLAYING, /同盟模拟的作战不能暂停/);
});

test('temp overflow (user playtest #3 item 3): kept through the round start, resolved at the deadline of the first prep its player can act in (code) — every doc says so', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 4343, fake: true }).start();
  const m = h.m;
  const ps = h.ps('p_0');
  // distinct plain equipment (two identical ones would merge)
  const plain = Object.values(DATA.items).filter((i) => i.itemType === 'EQUIP' && !i.isGolden && i.kind === 'passive').map((i) => i.itemId ?? i.id);
  assert.ok(plain.length > ps.hand.length);
  h.toPrep(1);
  assert.ok(h.drive(() => m.phase === PHASE.SETTLE && m.round === 1), 'SETTLE of R1');
  ps.hand.fill(null);
  plain.slice(0, ps.hand.length).forEach((id, i) => { ps.hand[i] = ps.newPiece('item', id); });
  const late = ps.newPiece('item', plain[ps.hand.length]);
  assert.equal(ps.stow(late), 'temp', 'a gain after the battle with a full hand overflows into temp');
  h.toPrep(2);
  assert.ok(ps.temp.includes(late), 'not wiped at the round start');
  assert.equal(ps.tempDue(late), ps.prepsEnded, 'due at the end of this prep — the first one its player can act in');
  assert.equal(ps.privateView().canReady, false, 'it blocks Ready');
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT && m.round === 2, { ready: false }), 'the prep deadline passes');
  assert.ok(!ps.temp.includes(late), 'resolved at that deadline');
  m.dispose();
  assert.ok(!/temp hand wiped/.test(DESIGN), 'DESIGN §6.1: the round start no longer wipes temp');
  assert.match(DESIGN, /PlayerState\.tempDue/);
  assert.ok(!/temp wiped \(reward offers/.test(META) && !/wiped at the round start/.test(META), 'META §1 / rules');
  assert.match(META, /PlayerState\.tempDue/);
  assert.ok(!/下一回合开始时自动销毁/.test(PLAYING), 'PLAYING §3: no round-start destruction');
  assert.match(PLAYING, /保留到\*\*下一个休整期\*\*/);
});

test('回环射手 boomerang and 蕾缪安 S3 shells (user playtest #3 items 4–5): code and SIM / DESIGN agree', () => {
  assert.equal(PROJECTILE_SPEEDS.boomerang, 15, 'PRTS 跃跃: out 15');
  assert.equal(BOOMERANG_RETURN_SPEED, 3.75, 'PRTS 跃跃: back 3.75');
  assert.equal(SUB.loopshooter.projectile, 'boomerang');
  assert.equal(typeof SUB.loopshooter.canAttack, 'function', 'attacks only while holding the boomerang');
  assert.match(SIM, /boomerang 15 out,\s*3\.75 back/);
  assert.ok(!/next attack waits for the boomerang \(2 × distance \/ 10 s\)/.test(SIM), 'SIM §8: the old lob rule is gone');
  assert.match(SIM, /`none\|arrow\|bolt\|bomb\|lob\|orb\|drone\|enemy\|boomerang\|chain\|chainHeal`/);
  assert.match(DESIGN, /BOOMERANG_RETURN_SPEED/);
  // 蕾缪安: one shell every 0.3 s after the skill (PRTS), fx 'bombardShell' then 'bombard' — the kit's constants
  const kit = readFileSync(join(ROOT, 'server/sim/content/kits/tier6.js'), 'utf8');
  assert.match(kit, /const LEMUEN_SHELL_INTERVAL = 0\.3;/);
  assert.match(kit, /battle\.fx\('bombardShell'/);
  assert.match(DESIGN, /'bombardShell' \{x, y, id: shooter, r, t: flight game s, i\}/);
  assert.match(DESIGN, /ONE shell every 0\.3 s in lock order/);
  assert.match(SIM, /S3 礼炮·强制追思/);
});

test('lost models, live LP, detail card order, static game data (user playtest #3): code and DESIGN §17 agree', () => {
  assert.match(DESIGN, /### 17\.2 Picking and the drag target \(#7\) — superseded by §18\.1/);
  assert.equal(SPINE_EVICT_DELAY_MS, 1000);
  assert.equal(SPINE_QUIET_DELAY_MS, 3000);
  assert.match(DESIGN, /`SPINE_EVICT_DELAY_MS` \(1 s\)/);
  assert.match(DESIGN, /`SPINE_QUIET_DELAY_MS` \(3 s\)/);
  assert.deepEqual([...RETRY_DELAYS_MS], [600, 2000]);
  assert.match(DESIGN, /after 600 ms and 2 s \(`RETRY_DELAYS_MS`\)/);
  const panel = readFileSync(join(ROOT, 'public/js/ui/detailPanel.js'), 'utf8');
  assert.match(panel, /CHESS_SECTIONS = Object\.freeze\(\['head', 'garrison', 'trait', 'stats', 'skill', 'module', 'equip', 'talents'/);
  assert.match(DESIGN, /`detailPanel\.js CHESS_SECTIONS`\): header .* → \*\*特质\*\*/);
  assert.match(panel, /export function garrisonTypeIconKey\(garrison\)/);
  assert.match(DESIGN, /official `eventTypeIcon` \(`detailPanel\.js garrisonTypeIconKey`/);
  assert.match(DESIGN, /pendingLp\? \/\* COMBAT \/ 联防 of a normal round/);
  assert.match(DESIGN, /`ownLeaks\(local, server\)`/);
  assert.match(PLAYING, /顶栏的目标生命值会\*\*立即\*\*显示扣除后的数值/);
  assert.match(README, /漏怪时顶栏的目标生命值实时减少/);
});

test('user playtest #4 (DESIGN §18): picking by tile, timers, 机变 two taps, down / element state, content — code and every doc agree', () => {
  // #1 the tile under the pointer; the dragged model held under the pointer (no touch lift, probe or body shapes)
  assert.equal(ENEMY_REACH, 0.6);
  const app = readFileSync(join(ROOT, 'public/js/render/app.js'), 'utf8');
  assert.match(app, /export const DRAG_HOLD_TILES = 0\.45;/);
  assert.ok(!/TOUCH_LIFT_TILES|drawnAt|pickShape|pieceDragOver/.test(app), 'no touch lift, pixel probe or body shapes (user playtest #4 item 1)');
  assert.match(DESIGN, /`DRAG_HOLD_TILES` = 0\.45 tile/);
  assert.match(DESIGN, /`ENEMY_REACH` 0\.6 tile/);
  assert.match(DESIGN, /render\/pick\.js/);
  assert.ok(!/pieceDragOver'\|/.test(DESIGN), 'DESIGN §9: no pieceDragOver event');
  assert.match(README, /按地上的方格/);
  for (const [name, text] of [['README', README], ['PLAYING', PLAYING]]) {
    assert.ok(!/画面上实际画出的干员/.test(text), `${name}: no body picking`);
    assert.ok(!/模型抬高到手指上方|模型在手指上方/.test(text), `${name}: no touch lift`);
  }
  // #3 a single human is untimed outside battles (code + docs)
  const lone = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 1, bots: 1, seed: 8, fake: true }).start();
  assert.equal(lone.m.soloUntimed, true);
  assert.equal(lone.m.publicView().deadline, 0, 'no briefing countdown');
  lone.m.dispose();
  assert.match(DESIGN, /solo and any single-human match untimed/);
  assert.match(META, /solo \/ single human untimed/);
  assert.match(PLAYING, /只有你一名玩家/);
  // #4 one countdown: BAND_TURN_SECONDS per turn (code = data = docs)
  assert.equal(BAND_TURN_SECONDS, 30);
  assert.equal(DATA.config.timers.bandTurn, BAND_TURN_SECONDS);
  assert.match(DESIGN, /`BAND_TURN_SECONDS` 30 s per turn = m\.public\.deadline/);
  assert.match(META, /`Match\.BAND_TURN_SECONDS` 30/);
  assert.match(PLAYING, /\*\*每人 30 秒\*\*/);
  assert.ok(!/12 s\/turn/.test(DESIGN) && !/`bandTurn` 12/.test(META) && !/每人 12 秒/.test(PLAYING), 'the old 12 s turn is gone');
  assert.match(META, /`ev\.preview` true/, 'META: onBattleStart handlers must not change the match for the stats preview');
  // #2 机变 two taps
  assert.match(PLAYING, /选卡要\*\*点两次\*\*/);
  assert.match(README, /机变选卡/);
  // #8 / #9 element gauges (爆发冷却) and knocked-out operators
  assert.equal(ELEMENT.erosion.ally.duration, 10, 'operators\' 侵蚀 burst has its 10 s cooldown');
  assert.deepEqual(ELEMENT_ORDER.slice(0, 4), ['neural', 'erosion', 'burn', 'apoptosis']);
  assert.deepEqual({ ...DOWN_STATE }, { COUNTING: 0, WAIT_DP: 1, WAIT_TILE: 2 });
  assert.match(DESIGN, /\*\*爆发冷却\*\*/);
  assert.match(DESIGN, /`down: \[\[id, respawnAt \(game s\), respawnTime \(s\), state\]\]`/);
  assert.match(SIM, /`burstLocked\(unit\)` in damage\.js/);
  assert.match(SIM, /损伤抵抗 = the target's data `epResistance`/);
  assert.ok(!/800 phys; no lock/.test(SIM), 'SIM §3: operators\' 侵蚀 locks too');
  assert.match(SIM, /`down: \[\[id, respawnAt, respawnTime, state\]\]`/);
  // #5 / #11 / #12 data rules
  const special = DATA.items.chess_item_4_09_e_a;
  assert.ok(special.shopExcluded && special.shopExcludedBy, '灼燃维式重锤 is never sold');
  assert.match(dataRow('shopExcluded`, `shopExcludedBy'), /isShopItem/);
  assert.match(PLAYING, /突变细胞只来自昆图斯的策略/);
  // (#11 revisited by user playtest #6: the drone is a hand piece again, still only on the field when her skill fires)
  assert.equal(DATA.tokens.token_10000_silent_healrb.placeable, true, '赫默\'s drone is a hand piece (user playtest #6)');
  assert.match(dataRow('displayType`, `placeable'), /manually deployable summon/);
  assert.ok(!/ATK\/HP are \*\*replaced\*\*/.test(DATA_MD), 'DATA: 炎佑 stats are added (最终加算)');
  assert.match(DESIGN, /with no enemy on the field it stays where it is/);
});

test('user playtest #5 (DESIGN §19): blocking, 联防 forced exit, huge bosses, element pipeline, maps, phone camera — code and every doc agree', () => {
  const sec = (n) => DESIGN.slice(DESIGN.indexOf(`## ${n}.`), DESIGN.indexOf(`## ${n + 1}.`) > 0 ? DESIGN.indexOf(`## ${n + 1}.`) : undefined);
  const S19 = sec(19);
  assert.match(DESIGN, /## 19\. User playtest #5 \(v2\.4\)/);
  for (let i = 1; i <= 9; i++) assert.match(S19, new RegExp(`### 19\\.${i} `), `§19.${i}`);
  for (let i = 1; i <= 11; i++) assert.match(S19.slice(0, S19.indexOf('### 19.1')), new RegExp(`#${i} `), `the intro maps report #${i}`);
  // #4 blocking: the contact radius (code = §5.5 = SIM)
  assert.deepEqual({ ...BLOCK_RADIUS }, { ground: 0.70709997, fly: 0.8944, device: 0.4472 });
  const s55 = DESIGN.slice(DESIGN.indexOf('### 5.5'), DESIGN.indexOf('### 5.6'));
  assert.match(s55, /ground 0\.7071/);
  assert.match(s55, /takes the enemy over when its blocker dies, is withdrawn or is stunned/);
  assert.ok(!/whose position enters its tile \(\|dx\|,\|dy\| ≤ 0\.5\)/.test(s55), '§5.5: the old same-tile block rule is gone');
  assert.match(SIM, /taken over by another operator in contact with room, else they walk on/);
  // #2 联防: carryState { down: true } → FORCED_EXIT (code = §5.1 / §5.5 / §6.1 / §18.3)
  assert.equal(FORCED_EXIT, 'forcedExit');
  assert.match(DESIGN, /carryState\?: \{ hpPct, sp, skillActive \} \| \{ down: true \}/);
  assert.match(DESIGN, /or `FORCED_EXIT`, entering 联防 knocked out/);
  assert.match(sec(6), /knocked out at the end of its own combat enters down/);
  assert.match(PLAYING, /作战结束时已被击倒的干员在原位倒地/);
  // #10 huge bosses: hit areas (§3), 自缚 (§7)
  assert.equal(SELF_BOUND.length, 7);
  assert.match(sec(3), /data `hitArea`/);
  assert.match(sec(3), /`sim\/body\.js`/);
  assert.match(sec(3), /中点判定/);
  assert.match(sec(7), /`content\/bosses\.js SELF_BOUND`/);
  assert.match(PLAYING, /自缚、无法被阻挡/);
  // #3 elements: one hasHp, the pipeline guard, 脆弱 vs 元素伤害, element healing per type
  assert.equal(typeof DAMAGE.hasHp, 'function');
  for (const f of ['server/sim/content/kits/tier5.js', 'server/sim/content/kits/tier6.js', 'server/sim/content/items/battle.js']) {
    assert.ok(!/const hasHp = /.test(readFileSync(join(ROOT, f), 'utf8')), `${f}: no local hasHp copy`);
  }
  assert.match(s55, /元素伤害 takes 元素脆弱 \(`elementalTakenMul`\) alone, not `dmgTakenMul`/);
  assert.match(SIM, /lowers element\s+`el`, or every element type, each by `amount` on its own/);
  assert.match(PLAYING, /无来源伤害/);
  // audit rows as corrected by the reviews
  assert.match(S19, /卢西恩 ATK 700 \(solo 600\)/);
  assert.match(S19, /T2 1\.5 % max HP of HP and element per s with ≥ 4 operators on the field \(elite ≥ 2/);
  assert.match(S19, /特制水上平台 are ×64/);
  assert.match(S19, /756×366 CSS px/);
  assert.ok(!/1\.5\/2 % max HP|×68|830×381|1500 \/ 750/.test(S19), '§19: no refuted audit figure');
  // #7 boss-field deploy: the board row shift has one name, the opposite of prepfield's
  assert.equal(BOARD.BOARD_ROWS_ABOVE_BOSS, 7);
  assert.equal(BOARD.BOSS_ROW_SHIFT, undefined, 'board.js: no BOSS_ROW_SHIFT (render/prepfield.js has the opposite sign)');
  assert.match(PLAYING, /关底战场上的半场/);
  // #9 phone prep camera: §18.1's v2.3 figures superseded
  assert.match(sec(18), /superseded by §19\.8/);
  assert.ok(!/71 % now/.test(DESIGN), 'DESIGN §18.1: the v2.3 notched-phone figure is not current');
  assert.ok(!/71 % now/.test(readFileSync(join(ROOT, 'public/css/devices.css'), 'utf8')), 'devices.css: no stale figure');
  // #1 / #5 / #4 player guide
  assert.match(PLAYING, /\*\*立刻接替阻挡\*\*/);
  assert.match(PLAYING, /召唤物在所有干员之后/);
  assert.match(PLAYING, /近地悬浮/);
  // integration QA residuals (the melee-only blocked-first rule is superseded by §20.3 — the user's "阻挡了就一定要能打到",
  // checked in the §20 test); the forced-out timer is re-read after battleStart; the gauge intake's 5 % floor; the boss
  // field's devices
  assert.match(S19, /Ranged operators on melee tiles[^\n]*superseded by §20\.3/);
  assert.match(s55, /after which the forced-out operators' timers are re-read/);
  assert.match(SIM, /Right after `battleStart`\s+its timer is re-read/);
  assert.match(s55, /max\(0\.05, 1 − 损伤抵抗\/100\)/);
  assert.match(SIM, /max\(5 %, 1 − 损伤抵抗 \/ 100\)/);
  // the user's follow-up: the boss field's row-6 blowers show in the normal views (code = §19.7); the 联防 timer restart
  // is confirmed (§19.3)
  assert.match(S19, /吹风机原版道中也该有/);
  assert.match(S19, /the boss field's \(6,5\) \/ \(6,9\) on the wall under the bench/);
  assert.ok(!/the boss field's devices are drawn with the boss field only/.test(DESIGN), '§19.7: the QA hiding rule is gone');
  const layout = readFileSync(new URL('../public/js/render/board3d/layout.js', import.meta.url), 'utf8');
  assert.ok(!/BOSS_WALL_ROW/.test(layout), 'no boss-field device filter in the 3D board');
  assert.match(S19, /进联防复活时间确实是重新算/);
  assert.ok(!/its full redeploy timer \[ASSUMED\]/.test(DESIGN), 'the full 联防 timer is no longer [ASSUMED]');
});

test('user playtest #6 (DESIGN §20): summons, skill triggers, blocking, push force, enemies, boss pool, bounties, element gauge — code and every doc agree', () => {
  const sec = (n) => DESIGN.slice(DESIGN.indexOf(`## ${n}.`), DESIGN.indexOf(`## ${n + 1}.`) > 0 ? DESIGN.indexOf(`## ${n + 1}.`) : undefined);
  const sub = (a, b) => DESIGN.slice(DESIGN.indexOf(`### ${a}`), DESIGN.indexOf(`### ${b}`));
  const S20 = sec(20);
  assert.match(DESIGN, /## 20\. User playtest #6 \(v2\.5\)/);
  for (let i = 1; i <= 9; i++) assert.match(S20, new RegExp(`### 20\\.${i} `), `§20.${i}`);
  const intro = S20.slice(0, S20.indexOf('### 20.1'));
  for (let i = 1; i <= 19; i++) assert.match(intro, new RegExp(`#${i} `), `the intro maps report #${i}`);
  const s55 = DESIGN.slice(DESIGN.indexOf('### 5.5'), DESIGN.indexOf('### 5.6'));
  const s56 = DESIGN.slice(DESIGN.indexOf('### 5.6'), DESIGN.indexOf('## 6.'));
  const s209 = S20.slice(S20.indexOf('### 20.9'));
  // the user's settled decisions (2026-10-01): code = §20 = §20.9 table (with the one-line flips) = SIM / PLAYING / META
  assert.equal(SKILL_SUMMON_START_DEPLOY, true, '#1/#2: a placed skill summon deploys once at the battle start (PRTS)');
  assert.match(s209, /SKILL_SUMMON_START_DEPLOY = false/);
  assert.match(s55, /a skill's placed summon \(赫默 医疗探机, 巫恋 诅咒娃娃\) included, once and free/);
  assert.match(SIM, /deploys once at the battle start/);
  assert.match(PLAYING, /医疗探机、诅咒娃娃开战时也在摆放的位置免费部署一次/);
  assert.match(sec(18), /#11 skill summons are not prep pieces\*\* — \*\*superseded by §20\.1/);
  assert.match(s209, /token_10041_cathy_catsld/, '凯瑟琳\'s device stays a hand card');
  for (const [name, text] of [['build-data', readFileSync(join(ROOT, 'tools/build-data.mjs'), 'utf8')], ['DATA.md', DATA_MD]]) {
    assert.ok(!/question to the user|awaits the user's confirmation/.test(text), `${name}: the 凯瑟琳 question is settled`);
  }
  assert.equal(MULTI_ROUND_BOUNTY_BATTLES, 2, '#4: multi-round bounties last two battles (the user\'s call)');
  assert.match(s209, /MULTI_ROUND_BOUNTY_BATTLES = null/);
  assert.match(META, /MULTI_ROUND_BOUNTY_BATTLES = null` restores the official red "每场"/);
  assert.match(PLAYING, /官方的「多轮悬赏」（原文写「之后的每场作战」）在这里也按「接下来两场作战」处理/);
  assert.ok(!/红字「每场」的是多轮悬赏/.test(PLAYING), 'PLAYING: no 每场 card any more');
  assert.equal(ALLY_COLLIDER_RADIUS, 0.25, '#12: ranged enemies reach an operator by its 0.25 collider');
  assert.match(s209, /ALLY_COLLIDER_RADIUS = 0/);
  assert.match(sec(3), /centre distance ≤ `rangeRadius` \+ 0\.25/);
  assert.match(s55, /whose 0\.25 collider touches their radius/);
  assert.match(SIM, /centre distance ≤ `rangeRadius` \+ `ALLY_COLLIDER_RADIUS` 0\.25/);
  assert.match(S20, /reach 2\.2 → 2\.45 \(13 → 21 tiles around it\)/);
  // #17: every blocker hits what it blocks (code: no melee gate; §5.5 = §19.2 superseded = §20.3 = SIM = PLAYING)
  assert.match(s209, /gate `Battle\.blockedTargets` \/ `sortEnemyTargets` blocked-first on a melee position again/);
  assert.match(s55, /\*\*Every blocker\*\* — melee units/);
  assert.match(s55, /\(1\) the enemies it blocks \(every blocker, in range or not, §20\.3\)/);
  assert.ok(!/melee units only, in range or not|a ranged operator on a melee tile blocks but attacks only what its range holds/.test(DESIGN), '§5.5: the melee-only rule is gone');
  assert.match(SIM, /\*\*every blocker\*\* — melee units/);
  assert.ok(!/targets by its range alone: no/.test(SIM), 'SIM: the melee-only rule is gone');
  assert.match(PLAYING, /\*\*阻挡了就一定能打到\*\*/);
  const battleSrc = readFileSync(join(ROOT, 'server/sim/Battle.js'), 'utf8');
  assert.ok(!/meleeUnit/.test(battleSrc) && !/export function meleeUnit/.test(readFileSync(join(ROOT, 'server/sim/targeting.js'), 'utf8')), 'no melee gate in the engine');
  // #15 / #16: skill triggers and the 3 s operation cooldown (code = §5.6 = §19.2 superseded)
  assert.equal(AUTO_OP_COOLDOWN, 3);
  assert.match(s56, /`SKILL_RANGE` \(a MANUAL skill with a 技能范围 of its own/);
  assert.match(s56, /\*\*every MANUAL skill\*\* of the class and never an AUTO skill/);
  assert.match(s56, /`AUTO_OP_COOLDOWN` \(3 s\) after its previous cast and after the unit's battle-start deployment/);
  assert.match(sec(19), /灰毫 S2 专注轰击 — \*\*superseded by §20\.2\*\*/);
  assert.ok(!/so her S1 is TAKE_DAMAGE and S2 stays DEFAULT/.test(DESIGN), '§19.2: 灰毫 S2 is TAKE_DAMAGE now');
  assert.ok(!/the battle-start part is left out/.test(readFileSync(join(ROOT, 'server/sim/constants.js'), 'utf8')), 'AUTO_OP_COOLDOWN comment');
  assert.match(DATA_MD, /13 MANUAL skills \(26 normal \+ elite records\)/);
  assert.match(sub('20.2', '20.3'), /180 % \(精锐 200 %\)/, '#8: the elite shield ratio');
  // #14 / #17: push force vs weight, ASPD floor, 孤立 (code = §5.2 / §5.3 / §5.4 = §20.3)
  assert.equal(ASPD_MIN, 20);
  assert.match(sec(5), /`aspd = clamp\(100 \+ Σaspd \+ base-100, 20, 600\)`/);
  assert.match(sec(5), /isolated \(孤立: no friendly selector picks it/);
  assert.match(sec(5), /`battle\.push\(e, force, \{ from, dir, fixed, fixedAngle, inward, effect \}\)`/);
  assert.match(sec(19), /锏 S3 归于宁静 \(added by §20\.3\)/);
  // #5: the boss pool floor and the verdict (code = §5.5 = §14 = §6.1)
  assert.equal(BOSS_POOL_MIN_HP, 1);
  assert.match(s55, /A pool holding less than 1 HP is empty \(`constants\.js BOSS_POOL_MIN_HP`/);
  assert.match(sec(14), /the first one the server registers decides the verdict \(`Match\._finalEnding`\)/);
  assert.match(sec(6), /team LP 0 ⇒ defeat at once \(PRTS 直接失败\)/);
  // #7 / #19: the 联防 counter (§17.5 revised, §8.2, §14) and the promotion reward (§6.2)
  assert.match(sec(17), /\*\*revised by §20\.6\*\*/);
  assert.ok(!/the own battle's count stays on show as an upper bound tagged 联防中/.test(DESIGN), '§17.5: the frozen 联防 count is gone');
  assert.match(sec(8), /uniteLeft\? \/\* 联防: the leaker's enemies still standing/);
  assert.match(sec(14), /`b\.progress \{ battleId, gt, killed, total, leaks\?, left\?, bossDmg\?, by\?, done\? \}`/);
  assert.match(sec(6), /3 \*\*different\*\* free chess of tier `min\(level\+1, 6\)`/);
  assert.match(S20, /105 cards: 56 next-battle incl\. 源石虫·特训, 42 two-battle, 7 multi-round/);
  // #11 / #9 / #13: the gauge look (§18.3 / §19.5 superseded, §8.2 fill), model scale and fear (§9, §5.3, §2)
  assert.match(sec(18), /superseded by §20\.8/);
  assert.match(sec(19), /The gauge's look is the official icon \+ white bar since §20\.8/);
  assert.match(sec(8), /rounded DOWN and kept at 0\.01–0\.99 outside a burst/);
  assert.match(sec(9), /enemies\.json `modelScale`/);
  assert.match(sec(2), /fear\.js +恐惧 movement of enemies/);
  // the 机变 card and the card tap (§10 = §18.2 = §20.7)
  assert.match(sec(10), /a tap anywhere on the card, its confirm strip included, is the card's tap/);
  assert.match(sec(18), /Each card shows its full effect text \(§20\.7\)/);
  // README: the test count stays in the right order of magnitude
  assert.match(README, /约 27\d0 项/);
});
