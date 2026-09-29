# META.md — match & meta engine (server/match)

Audience: **content authors** writing prep-side ("SERVER_*") effects in `server/sim/content/*.js → registerMeta(registry)`,
the **UI owner** consuming `m.public` / `m.private` / `m.result`, and anyone driving matches in tests or tools.
Normative contracts stay in DESIGN.md §6 and §8; this file documents the implementation and every assumption it makes.

```
server/match/
  Match.js         state machine, timers, round loop, co-op orchestration, views (the lobby⇄match interface is at the top)
  PlayerState.js   per-player economy / shop / hand / board / items / bonds / LP + every prep intent handler
  gamedata.js      typed, defaulted view of data/*.json (config tunables with research defaults) + the balance layer
                   (data/tuning.json, §3.1)
  pool.js          SharedPool (copies per base chess, across players), per-match bans, copy-weighted rolls
  board.js         placement legality from the stage legend, slot helpers, deployment order
  bondsMeta.js     bond counting modes, tiers, 调和 / 独行 / 助力 / 绝技, layers
  effectsMeta.js   MetaRegistry + EffectDispatcher + the handler ctx (this document, §2)
  builtinMeta.js   engine built-ins (consume-on-equip items, Arts, EffectRefs used by 机变 defaults)
  choices.js       机变 draft cards + family defaults
  waves.js         stage / factions / bosses per match, per-round spawns, bounties, 联防 wave, preview
  unite.js         联防 planning and LP attribution
  finalAssault.js  pairing, boss pool, hidden-core condition
  fields.js        FieldRunner: battle pacing (2×), snapshots, per-field error isolation
  results.js       m.result rows, titles, trophies, rewards
  bot.js           AI player (AI teammates, departed humans, "AI 托管")
  scheduler.js     RealScheduler / VirtualScheduler
  StubMatch.js     the old platform stub (platform tests only)
```

---

## 1. Match flow

```
LOBBY → INFO_CHECK (co-op 25 s, solo untimed; all humans confirmed ⇒ next) → BAND_DRAFT → BATTLE_CHECK (3 s)
→ for r = 1..lastRound (+ hidden):
     ROUND_START (2 s)  income + pending coins, upgrade price −1 (r > 1, floor 0), temp wiped (reward offers earned after
                        the last prep — a SETTLE merge — are kept for this prep),
                        shop reroll (frozen slots kept in place, then unfrozen), the round's wave generated (preview),
                        onRoundStart dispatch
     [SP_DRAFT]         r ∈ modes[m].spRounds (机变)
     PREP               onPrepStart; co-op timer rounds[r].prepTime, solo untimed; ends when every alive seat is ready
     (prep end)         onPrepEnd, temp auto-resolved, reward offers expire, unfrozen shop cleared, funds lost
                        (band_cannot keeps them), boss round: Σ activated layers recorded for the hidden-core check
     COMBAT             one Battle per alive player (FieldRunner, 2× game speed; limit = 2 × maxPlayTime game s, §3)
     UNITE              co-op, ≥ 1 leaker and ≥ 1 perfect player (§4)
     SETTLE (3 s)       LP, coins, layers, bounties, eliminations, onBattleResult
   boss round  → FINAL_ASSAULT (instead of COMBAT/UNITE/SETTLE)   hidden round → HIDDEN_CORE
→ RESULT (m.result to every human, then onEnd once)
```

| Timer (real s, × `opts.timerScale`) | Value |
|---|---|
| INFO_CHECK | `config.timers.infoCheck` 25 |
| band draft turn / whole step | `bandTurn` 12 / `bandDraft` 50 (co-op; solo untimed) |
| BATTLE_CHECK | `battleCheck` 3 |
| 机变 first / other pickers | `spFirst` 30 / `spTurn` 16 (co-op; solo untimed) |
| PREP | `modes[m].rounds[r].prepTime` (co-op; solo untimed) |
| COMBAT / 联防 | `modes[m].rounds[r].combatTimeLimit` (= the level's `maxPlayTime`) real seconds = 2× that in game seconds |
| 最终攻势 / 隐秘核心 | no hard stop: countdown `rounds[r].levelMaxPlayTime` 120 real s; overtime drain from `bossOvertimeAfter` 150 real s, 1 team LP per real s (§3) |
| ROUND_START / after combat / SETTLE | 2 / 1.5 / 3 (presentation delays, `Match.DELAYS`) |
| bot action delay | 0.9 s (+0.35 s per seat) |

`m.public.deadline` is the absolute end of the current timer (ms epoch, 0 = untimed; combat: estimated end at 2×;
最终攻势 / 隐秘核心: the boss level's `levelMaxPlayTime` countdown, 120 real s — the battle goes on past it — with
`m.public.overtimeAt` = when the overtime drain starts, 150 real s; both on the field clock).

### 1.1 Band draft
Co-op: random order (all seats, bots included), one pick per turn, 12 s per turn (timeout ⇒ `bandDraft.timeoutBandId`
华法琳), 50 s cap for the whole step (every unpicked seat gets 华法琳), one skip per player (`g.bandSkip`: the player moves to
the end of the order; refused when nobody is left to pass to), duplicates allowed, band must list the mode type in
`modeTypeList`. Solo: free pick, no timer, no skip. Starting LP = `bands[id].totalHp`.

### 1.2 机变 (SP draft)
Family = weighted pick from `choices.schedule[modeId].rounds[r].families`; cards: co-op 6 shared (each player takes 1,
random order, 30 s first / 16 s others, timeout ⇒ a random remaining card), solo 3 untimed. A 驰援 tactic card
(`single_special_choice_gain_bond_chess`) is only offered while its bond still has chess in this match's pool
(`Match.bondInPool`; a bond whose every member is banned would grant nothing); more generally a 驰援 or 盟誓
(`global_special_choice_bond_addlayer`) card is offered only while one of its bonds is live (`Match.bondLive`: not in
the mode's static `inactiveBondIds` — 标准 has no 拉特兰 / 阿戈尔 / 卡西米尔 / 奥术 … — and with chess in the pool), so
玛恩纳的盟誓 / 莫斯提马的盟誓 / 卡西米尔驰援 never show up in 标准. Card generation and the
family defaults are documented in `choices.js` (bounty / supply / shop / tactic). 机密商店 cards are **free** (official
text "无需消耗资金"). A `choice:<effectId>` registry handler overrides the default application (§2.4).

### 1.3 Disconnects, AI takeover
* Disconnected human: the seat keeps playing its last lineup; drafts auto-resolve at their deadlines, prep auto-readies at
  the deadline (temp sold/destroyed). Nothing is bought for them. A battle the human was authority of goes to the server
  (normal / 联防: re-simulated from t = 0) or, on a boss field, to the partner's replica (DESIGN §14). The session stays
  resumable for 10 min (net.js `reconnectWindowMs`); a **solo** run's for the official `constants.singleReconnectTime`
  (86 400 s = 24 h, lobby.js `soloResumeWindowMs`) — nothing in a solo run is timed, so it simply waits. `onReconnect`
  resends `m.public`, `m.private` and the `b.start` of the field the player is on / watching.
* `g.autoplay { on }` ("AI 托管"): the bot plays the seat (drafts, buying, placement, ready) until turned off.
* `onLeave` (quit / reconnect window expired): 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 /
  §10.3): every copy the seat holds returns to the shared pool at once; the seat leaves the round loop and the Final
  Assault pairing (re-planned when it quits before the boss fight; the boss pool has no alive-player factor, so it does
  not change); its running normal battle is force-ended; a pending band pick
  becomes the default band and a 机变 turn passes on. Status `left`, LP 0, rounds passed = the rounds it had survived.
  When no human is left at all the match ends immediately (`reason: 'abandoned'`); when only eliminated spectators are
  left it ends as `'eliminated'`.

### 1.3a Solo pause
`g.pause { on }` (`Match.setPause`, DESIGN §14 Solo pause): solo matches only (co-op → `WRONG_PHASE`), `on: true` only
while a battle runs (COMBAT / 最终攻势 / 隐秘核心 with a live field, not while the Final Assault is ending); `on: false`
always. While paused (`m.public.paused`) the field clocks, the authority deadlines / release timers, the boss clock
(overtime drain, silence watchdog) and the server pacers stand still; `_resume()` shifts `deadline`, `overtimeAt`, the
fields' `startAt` / `lastProgressAt` and the boss start by the paused time and re-arms the timers. A disconnect or
`onLeave` resumes; the battle phase ending clears it (`pausedMs` totals the paused time).

### 1.4 Watching fields
Client-side combat (the default, DESIGN §14 Spectating; `Match._watchClient`): `g.watch` answers with the field's
`b.start` (a display replica fast-forwarded to the field clock); an alive player may not watch another normal field
while its own normal battle runs (`WRONG_PHASE 'own battle running'`) nor the other pair's boss field (`BAD_TARGET 'other
group hidden'`); eliminated players watch anything. The rest of this section is the legacy server-run mode
(`SP_COMBAT=server`):
`g.watch { fieldId }`: any live field during COMBAT / 联防; while no battle field is up (PREP, drafts, SETTLE)
`'n:<pid>'` returns a one-shot board view — during a battle phase an `'n:<pid>'` id must name a live field
(`BAD_TARGET 'no such field'` otherwise, and the viewer keeps its stream). In the
最终攻势 / 隐秘核心 a player fighting in a boss field may only watch its own field ("两名参与者会处于同一个战场，但无法查看
另一组队友的战场情况" → `BAD_TARGET 'other group hidden'`); eliminated / departed players spectate any field.

### 1.5 AI player (bot.js)
Buys toward a full board first (the cap is 8 from R1; leftover funds are lost), then levels on a curve
(L2 ≈ R3, L3 ≈ R5, L4 ≈ R7, L5 ≈ R10, L6 ≈ R12 — the competent curve of docs/BALANCE.md; free levels always), then
spends the rest on merge progress, bond thresholds around a focus core bond (most owned members, ties → most copies
left in the shared pool), role needs (2 blockers, anti-air when the wave flies, ≤ 2 healers), 特质 that keep adding
layers (every prep / refresh — the layer engines) and items for free carriers; refreshes while a purchase stays
affordable; sells bench chess that neither make the lineup nor build toward something (a live pair, the focus bond,
an elite). The deployed set maximizes unit value + activated bond tiers (exact counting via `computeBonds`). Placement
uses the round's enemy preview: every route is traced over the own board (ground: the stage's device-aware ground
paths; flyers: through their checkpoints) and weighted by its enemies; an exposure model (time on each tile × DPS of
the units covering it, blocker hold time, anti-air only on flying routes) is maximized greedily (blockers, then
damage dealers, then healers). Boss rounds: the player's boss-field template (`Match.bossWaves`) is mapped onto the
own board (rows −7, the right player of a pair mirrored, only the routes that end on its half) and the leader counts
as 10 tough enemies with a 30 s dwell on its first tiles, so the damage dealers reach stationary leaders.
**Rehearsal:** with `opts.botRehearsal = N` (default 3) the bot simulates the N best
distinct layout variants once each with the real `Battle` (a rehearsal seed, no meta dispatch, board restored exactly)
and keeps the one with the fewest leaks; a candidate whose counted leaks already exceed the best finished one's stops
early. A candidate is a whole battle — ≈ 20–300 ms of CPU (late rounds, 4 bots: 0.2–1 s per bot prep, about twice the
CPU of the real battles), so it never runs in one go on a real server: `Match.scheduleBotPrep` runs `botPrepBegin`
(economy + the default layout on the board), then steps the rehearsal in slices of ≤ `opts.botSliceMs` (default 8 ms of
wall clock, checked every 4 ticks; one scheduler callback each, so other rooms' battles and every request keep
flowing), then `botPrepEnd` (the rehearsed layout when it won, temp, Ready). The prep ending first drops the job (the
default layout stays). Virtual time runs it in one go (same decisions). Tests default rehearsal to 0
(`test/match/harness.js`); `tools/matchrun.mjs --rehearsal N` sets it.

---

## 2. Effect registry (content API)

```js
// server/sim/content/bands.js
export function registerMeta(registry) {
  registry.band('band_cannot', {            // 坎诺特 利滚利: +1 fund at round start when ≥ 5 were carried over
    onPrepEnd(ctx) { ctx.setCounter('cannot:left', ctx.funds()); },
    onRoundStart(ctx) {
      const b = ctx.data.bands.band_cannot.params;                    // numbers from data, never hard-coded
      if (ctx.counter('cannot:left') >= (b.capital ?? 5)) ctx.addFunds(b.interest ?? 1, 'band');
    },
  });
}
```

### 2.1 Keys
One handler object per key; a later `register` of the same key **replaces** the earlier one (content registers after
the engine built-ins, so content always wins). Sugar: `registry.band(id, h)`, `.bond`, `.garrison`, `.item`,
`.choice`, `.effect`, `.global`. A bare function registers `{ run: fn }`.

| key | runs for | source (`ctx.source`) |
|---|---|---|
| `global:<name>` | every player, every hook | `{ kind:'global' }` |
| `band:<bandId>` | the band's owner | `{ kind:'band', bandId, band }` |
| `bond:<bondId>` | every player (active or not — check `ctx.bondActive`) | `{ kind:'bond', bondId, bond: {count,active,tier,layers} }` |
| `garrison:<effectKey>` | owners of chess whose garrison has that `effectKey`, on its eventType hook only (§2.3) | `{ kind:'garrison', piece, garrisonId, garrison, bb, bbStr, where }` |
| `item:<itemKey>` | items **equipped** on owned chess (every hook); the item itself for onEquip / onArt / onDestroy | `{ kind:'item', piece, holder, item }` |
| `effect:<id>` | EffectRefs in `ps.effects` whose `key` is this key | `{ kind:'effect', ref }` |
| `choice:<effectId>` | the picker (and teammates for team cards) when the card is applied | `{ kind:'choice', card }` |

`itemKey` = item id without `_a`/`_b` (`chess_item_1_03_e`); Arts have no suffix (`chess_item_6_02_m`).
Normal and golden share the key: read `ctx.gd.item(ctx.source.piece.id).params` (or `ev.item`) for the numbers.

### 2.2 Hooks and events
Every handler method is `(ctx, ev)`; `ev` is shared by all handlers of one dispatch and may be mutated where noted.

| hook | when | `ev` |
|---|---|---|
| `onIncome` | ROUND_START, before the income is credited | `{ round, income, pending }` — write `ev.income` / `ev.pending` (e.g. 老鲤 withholds R1–R2 income until R3) |
| `onRoundStart` | ROUND_START, after income / shop roll | `{ round }` |
| `onPrepStart` | PREP opens (after 机变) | `{ round }` |
| `onPrepEnd` | prep end, before funds are cleared | `{ round }` |
| `onGain` | a chess / item was acquired (buy, reward, grant, merge result) | `{ piece, kind:'chess'|'item', source }` |
| `onSold` | a chess was sold (after refund of copies) | `{ piece, gain }` — **write `ev.gain`** to change the funds paid |
| `onRefresh` | manual refresh | `{ slots, free, price }` (slots mutable, or use `ctx.setShopSlot`) |
| `onPrice` | every price query of a shop slot (views + buy) — must be **pure** | `{ slot, kind, id, price }` — write `ev.price` / `ctx.setPrice` / `ctx.modifyPrice` |
| `onBuy` | after a purchase | `{ piece, slot, price, kind }` (`piece` = owned result, elite after a merge) |
| `onMerge` | chess or item merge | `{ kind, piece, baseId|itemId, consumed:[uid] }` |
| `onLevelUp` | shop level up | `{ level, price }` |
| `onSpend` | a payment's action is complete (buy / refresh / levelUp / reward / effect) | `{ amount, reason, total }` (`total` = funds spent this match) |
| `onBattleStart` | a battle input is built (normal / unite / boss / hidden) | `{ input: PlayerBattleInput, kind, round }` — mutate/replace `ev.input` |
| `onBattleResult` | SETTLE (normal rounds) and after boss fields | `{ result, lpLoss, perfect, unite?|boss? }` |
| `onChoicePick` | a 机变 card was applied (the card's own `choice:` handler runs first, then every source observes) | `{ card, family, picker, forTeammate }` |
| `onEquip` | `g.equip` (item handler only) | `{ item, target, golden, consumed, keep, error }` — see §2.5 |
| `onArt` | `g.art` (item handler only) | `{ item, row, col, targets:[pieces], error, used }` |
| `onDestroy` | an item was destroyed (player / replaced) | `{ item, holder, reason }` |
| `onLayers` | bond layers were added (prep or battle gains) | `{ bondId, from, to, reason }` (milestones: 维多利亚 25, 远见 10, 奇迹 100 …) |

Dispatch order per player: `global` → `band` → `bond` (data order) → garrisons (board in deployment order, then hand)
→ equipped items → EffectRefs (insertion order). Every call is isolated with try/catch (the error is logged once and
counted in `match.dispatcher.errors`); nested dispatches are capped at depth 6.

### 2.3 Garrisons (特质)
The dispatcher calls `handler[hook] ?? handler.run` only on the hook of the garrison's `eventType` (a handler may widen
that per garrison with `garrisonHooks(garrison) → hook[]`, e.g. "<进入休整期时><休整期结束时>"):

| eventType | hook | whose garrisons |
|---|---|---|
| `SERVER_GAIN` 获得时 | `onGain` | the gained piece — run **×2 while 投资人 is active, ×3 at ≥ 100 投资人 layers** |
| `SERVER_PREP_START` 进入休整期时 | `onRoundStart` | owned chess: board, and hand unless `bbStr.conditionkey === 'character_target_inboard'` |
| `SERVER_PREP_FIN` 休整期结束时 | `onPrepEnd` | same |
| `SERVER_REFRESH_SHOP` 刷新时 | `onRefresh` | same |
| `SERVER_CHESS_SOLD` 售出时 | `onSold` | the sold piece |
| `SERVER_PRICE` 购买价格 | `onPrice` | the chess in the priced slot (`ctx.source.where === 'shop'`) |
| `IN_BATTLE` | — | battle side (server/sim/content/garrisons.js `install`) |

```js
// garrisons.js — "<获得时>获得等于当前调度中心等级的【炎】层数（无需激活盟约）"  (SERVER_ADD_BOND_METHOD, add_method shoplv)
registry.garrison('SERVER_ADD_BOND_METHOD', {
  run(ctx, ev) {
    const { bb, bbStr } = ctx.source;                                   // garrison blackboard
    let n = 0;
    if (bbStr.add_method === 'shoplv') n = ctx.shopLevel() * (bb.multi ?? 1);
    else if (bbStr.add_method === 'hand_count') n = ctx.hand().filter((p) => p && p.kind === 'chess').length * (bb.multi ?? 1);
    const requireActive = ctx.source.garrison.desc.includes('已激活');
    ctx.addLayers(bbStr.bond, n, { requireActive });
  },
});
```

### 2.4 The handler context (`ctx`)
Reads: `playerId seat name round phase modeId difficulty isSolo isCoop data (frozen raw data) gd (GameData) rng`
(`rng()`, `rng.int(n)`, `rng.pick(a)`, `rng.chance(p)`, `rng.shuffle(a)` — the match's meta stream, never
`Math.random`), `funds() lp() alive() bandId() shopLevel() bond(id) bonds() bondActive(id) bondCount(id) layers(id)
board() hand() temp() piece(uid) pieceAt(row, col) pieceBonds(uid) garrisonsOf(uid) chessRecord(id) stats() roundStats()
shopSlots() effect(id)` (`piece(uid)` adds `area`, `holderUid`, `idx`; "身前一格" of (r, c) is (r, c + 1)),
counters `counter(k) setCounter(k, v) incCounter(k, n)` (player scope, persistent; prefix keys with your module).

Writes (all validated, never throw on bad input, never make funds / pools negative):

| helper | effect |
|---|---|
| `addFunds(n, reason?)` / `addPendingFunds(n)` / `spendFunds(n)` | funds now / at the next round start / pay (false when short) |
| `addLayers(bondId, n, { requireActive })` | layer gain (`requireActive` = "使已激活的…"); returns layers added; fires onLayers |
| `grantChess(id, { toTemp, golden, requirePool=true, fromPool=true })` | acquire a chess (takes pool copies; with `requirePool` a pool chess with no copy left fails → `null`); merges; fires onGain |
| `grantItem(id, { toTemp })` | acquire an item (merges with an identical normal item) |
| `rollChess({ maxTier, tier, bond, filter })` / `rollItem({ pool, tier, maxTier })` | copy-weighted chess id from the shared pool / item id (choices.json pools) |
| `grantFreeRefresh(n)` | free refreshes (stack) |
| `modifyPrice(delta)` / `setPrice(v)` | onPrice only: edit `ev.price` |
| `promote(uid)` / `transform(uid, chessId)` / `upgradeItem(uid)` | elite in place / replace a chess (keeps tile) / item → golden |
| `destroyPiece(uid)` / `equipDirect(itemUid, chessUid)` | remove a piece (chess copies return, items go back) / attach without equip effects |
| `offerChess(ids, { tier })` | queue a pick-one offer (shown as `shop.rewardOffer`, free) — 寻呼模块 / 信标 style |
| `offerItems(ids, { tier })` | the same for items (slots of kind `'item'`) — 凯瑟琳 定向投放 style |
| `triggerGarrisons(uid, eventType, { asUid })` | run another owned chess's 特质 of that eventType now (铃兰 "触发…的获得时效果"); 投资人 still multiplies SERVER_GAIN; SERVER_PRICE cannot be triggered; depth-capped |
| `setShopSlot(i, { kind, id, price?, frozen? } \| null)` | rewrite a shop slot (special refreshes) |
| `addDeployCap(n)` / `setDeployCapAtLeast(n)` | deploy cap (+effects; 人事部文档 = 9) |
| `setBondCountBonus(bondId, n)` | extra member count for a bond |
| `setDeviceActive(alias, on)` / `setTileOverride(r, c, 'melee'\|'ranged'\|'none')` | terrain changes of this player's board (legality + battle input `deviceOverrides`) |
| `addEffect(ref)` / `removeEffect(id)` / `setEffectCounter(id, v)` | EffectRefs `{ id, key?, name, desc, iconKind, iconId, counter?, battle=true, params?, data?, hidden? }` — shown in `m.private.effects`, passed to battles as `playerEffects` when `battle` |
| `addBounty(card)` | a bounty (choices.json cards.bounty shape) on the next battles |
| `toast(text, kind)` / `ticker(text)` / `giftTicker(fromName, chessId)` | messages |
| `teammates()` / `player(playerId)` | ctx objects of other alive players (team effects) |

### 2.5 Items: consume-on-equip and Arts
Items whose data `kind` starts with `consume_on_equip` resolve through their `item:` handler's `onEquip` and are
destroyed (they never take a slot); set `ev.keep = true` to keep the item equipped instead (博士投影 normal), or
`ev.error = 'BAD_TARGET'` (+ `ev.detail`) to refuse. Without a registered handler the equip is refused
(`BAD_TARGET 'effect not available'`). Arts (`MAGIC`): `g.art` needs a handler; at most `maxArtsPerRound` (2) per round;
`ev.targets` are the pieces under the Art's `rangeGrid` at (row, col); set `ev.error` to refuse, `ev.used = false` to keep it.
Other equipment: 2 slots; a third replaces the equipped item the player picks in the replace dialog — `g.equip
{ itemUid, targetUid, replaceUid }` (research 09 §1.2 `UseEquipUp.unloadInstId`; absent ⇒ the oldest; a `replaceUid` not
equipped on the target ⇒ `BAD_TARGET`, nothing changes) — and the replaced item is destroyed. Equipped items are
otherwise locked (research 04 §2 / addendum: they leave the operator only on promotion, merge or sale): `g.destroy`
refuses them (`BAD_TARGET 'equipped items are locked'`). A second copy of an equipped normal item merges into the golden
item in the hand.

Built-ins (builtinMeta.js, overridable): 盟约之币 / 骑士储蓄罐 (random funds), 随身身份牌 (layers of the target's bonds),
紧急调度券 (take shop chess), 精打细算玩偶 (+funds each round), 简易通讯机 / 拟态物质 (same-bond chess), 见钱眼开玩偶
(+funds next round), 人事部文档 (cap 9), 博士投影 (elite now / at the next round start), 寻呼模块 / 信标 (pick-one
offers; 信标 gifts the original chess to the teammate with the most members of its bonds next round), 商业包装方案 (every
N sells → same-bond chess), 突变细胞 (after battle → random tier+1 chess), 画卷 (copy the operator in range with its
items), 教鞭 / “神秘顾客” (a random bounty is added).

**教鞭 / “神秘顾客” stay a random bounty (deliberate).** The official Arts open a personal 悬赏 choice
("选择一项（特殊）悬赏任务进行挑战", `choice_event hunter_band_1`). The server applies a random bounty instead: content
(server/sim/content/items/meta.js) draws 3 of the band-bounty family `enemyeffect_b_*` and takes one at random (the
built-in fallback: a random tier ≤ II bounty of `cards.bounty`) and adds it with `ctx.addBounty`. A personal choice
overlay would need its own phase / protocol message outside SP_DRAFT (a second, simultaneous draft in co-op, with
timers and AI takeover) for a rarely used Art, while the random pick keeps the risk / reward the item is about. The
bounty then behaves like any other (next battles, 联防 payouts, Final Assault spawns). 神秘顾客's destroy clause (+1
fund, the Art passes to the next alive player) is content too (`onDestroy`).
EffectRefs: `effect:builtin_round_coin`, `effect:builtin_gift`, `effect:builtin_next_buy_golden_item` (整备),
`effect:builtin_next_buy_elite` (升华).

### 2.6 机变 card application
`choice:<effectId>` handler (content) → else the family default (choices.js): bounty → `ctx.addBounty`; supply/shop →
item to the hand; tactic by buff key (`global_special_choice_gain_equip`, `_bond_addlayer`, `_gain_coin`, `_refresh_free`,
`single_special_choice_gloden_equip_chess`, `_gloden_char_chess`, `_gain_bond_chess`, `auto_chess_change_map`); every
other buff becomes a battle EffectRef (`key: 'choice:<effectId>'`, `params` = effect params) for the sim content.
Team cards (`team: true`) apply to every alive teammate as well.

```js
// choices.js — override the 自愈 card: keep it as a battle effect but show a counter
registry.choice('allybuff_select_11', {
  onChoicePick(ctx, ev) {
    // the EffectRef below carries this same key, so this handler also runs (source kind 'effect') on every LATER
    // onChoicePick dispatch — apply the card only when it is the card being applied
    if (ctx.source.kind !== 'choice') return;
    ctx.addEffect({ id: `heal:${ctx.round}`, key: 'choice:allybuff_select_11', name: ev.card.name, desc: ev.card.desc,
                    iconKind: 'team', params: ctx.data.effects.allybuff_select_11.params });
  },
});
```
Any `choice:` handler whose EffectRef reuses its own key must guard like this (or give the EffectRef an `effect:` key).

---

## 3. Rules implemented (summary; details in each module header)

* **Economy**: income `config.economy.income[r]` (= min(3+r, 12)); bounty coins / pending funds credited at the next
  round start; leftover funds lost at prep end except `leftoverFundsKeptByBands`. Chess price by tier (2/3/3/3/4/4),
  items by `price`, refresh 1 (free refreshes first), sell +1 (elite too; items cannot be sold, only destroyed).
* **Shop**: `shopSlots[level]` chess slots + item slot(s), copy-weighted rolls over remaining pool copies of unbanned,
  visible chess with tier ≤ level; item slot: tier by the same shares, uniform item within the tier. Level-up price =
  base per mode, −1 each round start (floor 0), reset to the next base after upgrading; `MAX_LEVEL` at 6. One freeze
  toggle freezes every unsold slot until the next round start; a manual refresh rerolls everything (new slots stay
  frozen). Unfrozen slots are cleared at combat start. Slot positions are stable (frozen slots keep their index).
* **Pool**: copies 12/14/18/16/8/5 (缪尔赛思 4); a normal piece holds 1 copy, an elite 3; displays never reserve copies;
  selling, temp wipes and elimination return exactly what a piece holds (`left + held = cap` always).
* **Hand**: 10 slots filled right→left, 5 temp slots for passive overflow (merge results, grants, returned equipment);
  a full hand refuses buys unless the purchase completes a merge, and withdrawals unless the withdrawn summoner's own
  summon stack frees a slot (a deployed summon withdrawn with no stack of its own left to join is a new card: `HAND_FULL`,
  never temp); temp blocks Ready; temp is resolved (chess sold back to the pool, items destroyed) at the
  prep deadline and at the next round start.
* **Merge**: 3 normal copies (风丸 2) anywhere (board/hand/temp) → elite to the hand (the incoming copy, then temp, hand,
  board copies are consumed); equipment returns to the hand; summons of consumed copies are removed; a reward offer of 3
  free chess of tier min(level+1, 6) (pick 1, expires at prep end; queued when several merges happen). A merge
  completed after the prep (SETTLE / Final Assault effects such as 突变细胞) keeps its offer for the next prep, and with
  a full hand its elite takes a freed board tile of a consumed copy instead of temp (wiped at the round start).
* **Board**: rows 9–12 × cols 2–10, legality from `stages[id].tiles` + devices (board.js); deploy cap 8 (+effects);
  summons don't use slots; board↔hand swaps always allowed. A terrain change (terrain 机变 cards such as 模拟战场演变·
  模式二 "阻隔工事变为射击台", content `setDeviceActive` / `setTileOverride`) is checked at the next `recompute()` (at the
  latest when the battle input is built): a piece left on a tile it may no longer occupy — a melee operator on a new
  射击台 — is withdrawn to the hand (overflow temp: re-placed during the prep; its summons leave with it), a summon back
  onto its stack, with a toast (`PlayerState._evictIllegal`).
* **Bonds**: bondsMeta.js (BOARD distinct, BOARD_AND_DECK, 绝技 elites, 调和 +1, 独行 downward, 助力 upper tiers,
  变形同构体 grants). Σ activated layers for the hidden core = Σ layers of active bonds at the boss round's prep end.
* **Waves**: waves.js header (stage/factions/boss per match, faction replacement per round with `k` copies, scaling by
  `enemyScale[r]` × the tuning layer §3.1, bounties, boss templates, 联防 routing). Multi-round bounties ("之后的每场作战")
  also spawn in the Final Assault / Hidden Core, on the owner's half of the boss field (a route ending at its goal); the
  boss battle then uses up one of the bounty's battles and its kill coins go to pending funds.
* **Combat time limit**: data `combatTimeLimit` (the level's `maxPlayTime`) counts REAL seconds of the forced 2×
  battle; the Battle / 联防 limit is `gd.combatTimeLimit(r)` = 2 × that in game seconds (`config.combatTimeScale`,
  default 2). Read as game seconds the rounds' own spawn schedules would not fit (R2's last flyer spawns at 43 s of
  45 s, R3's at 62 s of 55 s); × 2 every limit ≈ last spawn + one flyer crossing. docs/BALANCE.md §2.1.
* **SETTLE**: LP −min(counted leaks, 10) (after 联防: survivors attributed to their source, same cap); IN_BATTLE layer
  gains applied; kill-bounty coins (paid by the Battle to the killer — a 联防 helper included) and perfect-bounty coins
  (own phase perfect) go to pending funds; bounty rounds decrement; LP ≤ 0 ⇒ eliminated (all copies back to the pool).
* **Final Assault / Hidden Core**: finalAssault.js header. Boards are passed in board coordinates; the sim maps board
  rows 9–12 onto boss rows 2–5 (`BOSS_ROW_OFFSET` −7, matching every stage's boss rows) and mirrors the right side.
  Pool (`finalAssault.js bossPoolHp`, research 08 §6 #7): co-op = `bloodPoint[difficulty]` as is — one pool shared by
  every boss field, no alive-player factor ("敌方领袖的总生命值不变"); solo = × `bossHpScale.solo` (0.25 [ASSUMED]); leaders
  are never scaled by `enemyScale`. The merged team LP loses leaks (`lpr`), the overtime drain
  (`bossTurnHpReduceTime` 150 counts REAL seconds, like the boss level's 120 s maxPlayTime that runs out first — the
  battle goes on — so 1 LP per real second from 150 real s = 300 game s on the 2× field clock; `gd.bossOvertimeDue`)
  and leader "扣除目标生命" effects (the sim's `lpLoss` hook: boss_7 Doom, 斥退 …); after every change it is written back
  to the alive players as shares of the LP each brought in (`lpAtFinal`, largest remainder), so `lp` in m.public /
  m.private / m.result is what is left (Σ = team LP).
  Client-side combat (DESIGN §14): a boss field's reports are plausibility-bounded on the SERVER's field clock — the
  credited pool damage of one field ≤ the whole pool per `BOSS_MIN_CLEAR_GS` (5) game s (20 %/s; the balance model's
  fastest mean kills run ≈ 5 %/s per field), its LP cost ≤ 10 + 1 per game s; reports are cumulative, so what exceeds
  the budget is credited later (the boss clock re-applies the latest report), never lost. A boss field's `b.result` ends
  it only when the pool is empty or after the match's `b.end`; any other (a 'forced' result at t = 0, 'cleared' while
  the pool holds, a result failing validation) hands the field to the partner's replica or the server, and the sender is
  never its authority again (`f.demoted`). Every boss field run by the server (takeover, or nobody connected at the
  start) publishes its own damage as `b.pool.acked[fieldId]` (its CreditPool total), so the display replica of a
  reconnecting / watching human stays in sync.

### 3.1 Balance layer (data/tuning.json)
`data/config.json` is generated and stays research-faithful. There is **no custom balance** any more (DESIGN §14
corrections, research 08 §6): enemy numbers are the official ones (the PRTS `enemyScale` table, leader pool =
`bloodPoint`). `data/tuning.json` (hand-maintained, loaded as `data.tuning`, layered on the config by gamedata.js only)
keeps just the result-title rules:

```jsonc
{ "titles": { "comment_3": { "stat": "lpLost", "rule": "min" } } }   // merged over config.titles
```
The former `enemyHpMul` / `enemyAtkMul` / `enemySpeedMul` / `bossHpMul` / `flyPlaceholders` knobs were removed; a
tuning file that still carries them is ignored (`gd.bossHpMul()` always returns 1). `tools/balance.mjs --tuning off`
drops the file (titles only, so the numbers are the same). Titles: `rule: 'min'` ranks the players still alive by the
smallest stat (坚若磐石 "目标生命值损失最少" = least `lpLost`). docs/BALANCE.md has the balance measurements.

---

## 4. 联防 (Unite)
Planned after the normal combats, at the end of the COMBAT_END pause from the players still in (`Match._afterCombat`, so a
player who quit during the last field or the pause is neither a helper nor a leaker whose enemies re-enter; unite.js):
helpers = `unite.js helperOrder` (research 08 §5, PRTS 卫戍协议/帮助 §联防阶段): ≤ `unite.maxHelpers` (2) perfect players
chosen by most units on the field (downed included) > an active bond > most standing units > seat; the pair ordered by
units > active bond > Σ active layers > standing > seat (LP plays no part), the first one on the right-hand field
(colOffset +8, where escaped_multi enters), the other colOffset 0; the escaped template of that size routes the leaked
enemies by slot class; helpers' operators carry
`{ hpPct, sp, skillActive }` from `unitsEnd` ("阵地以其当前状态"); an operator dead at the end of the helper's own combat
stays out of the 联防 battle with its summons [ASSUMED: the sim has no "start undeployed with a running redeploy timer"
input]; `flags.layerGainsEnabled = false`; time limit = the round's combat limit.
Every enemy still alive at the end (leaked again, or never spawned before the limit) costs its **source** player 1 LP.
A client-run 联防 result may bill a survivor only to a leaker who sent that enemy in — a split / summon only to a leaker
who sent in its parent, ≤ the parents' data offspring count (磨砻 2, 烹泉 4 …; fields.js offspringPerParent).

---

## 5. Views (DESIGN §8.2 / §8.3) and deviations

`m.public` (throttled ≤ 10/s, only sent when it changed) carries the DESIGN fields plus: `drawnDisabledBonds` (the 3+4
drawn set; `disabledBonds` = drawn ∪ the mode's static list), `hiddenBossId`, `bossRound`, `hiddenRound`, `spRound`,
`combatMode` (`'client'` | `'server'`), `fields[].progress { killed, total, done }` (teammates' progress UI), `paused`
(solo pause, §1.3a),
`players[].autoplay`, and per phase: `draft { order, turn, picks, skipsLeft, turnDeadline, untimed }` (BAND_DRAFT),
`sp { family, name, desc, eventId, cards:[{ idx, kind:'bounty'|'item'|'tactic', id, name, desc, tier, coin?, payout?,
rounds?, enemyKey?, count?, price?, team?, tacticKind? }], order, turn, picks:{pid: idx}, taken:{idx: pid}, untimed }`
(SP_DRAFT), `teamLp` / `bossHp {hp,max}` (Final Assault on), `overtimeAt` (最终攻势 / 隐秘核心: ms epoch when the
overtime drain starts; `deadline` = the level's 120 s countdown), `unite { helpers, leakers }` (UNITE).
`players[].status`: INFO_CHECK ready/deciding · drafts ready (picked) / deciding (their turn) / acting (waiting) ·
PREP ready/acting · COMBAT/boss combat/done · UNITE helping/done · others done · `left` / `dead` override.

`m.private` = DESIGN §8.3 exactly (sent per player whenever it changed). `nextEnemies` = the current round's wave
(+ the player's bounty enemies, tag `bounty`; boss rounds: the player's boss field, tag `boss`, + its bounties).

`m.field` = `{ fieldId, kind, rect, stageId, units, live }`; during prep `g.watch 'n:<pid>'` returns a one-shot board
view with `prep: true` (scouting a teammate).

**`b.snap` / `b.ev` game time**: every frame is `{ t: '<type>', … }`, so the snapshot's game time (DESIGN `b.snap.t`)
is sent as **`gt`** (game seconds); `b.ev` carries the same `gt`. The client reads `gt` (`render/interp.js frameTime`,
used by `normalizeSnapshot`). Legacy server-run mode only: client-side combat sends no `b.snap` / `b.ev`.

`m.result` (unicast to every human, `playerId` = the recipient) = `{ victory, roundsPassed, hiddenReached,
hiddenCleared, reason: 'victory'|'defeat'|'eliminated'|'abandoned'|'error', teamLp (merged Final Assault LP, null before
it; players[].lp are the alive players' shares), modeId, difficulty, stageId, bossId,
hiddenBossId, seed, durationMs, players:[{ playerId, seat, name, isBot, left, alive, victory (the team won AND this
player was still in at the end), roundsPassed,
eliminatedRound, lp, bandId, lineup:[{ id, golden, tier, row, col, items }], bonds, stats:{ dmgDealt, kills, leaks, gold,
refreshes, merges, itemsEquipped, bossDamage, activatedLayers, lpLost, perfectRounds }, title:{ id, name, picId, text }|null,
trophies, reward }] }`. Trophies and 卫戍认证 follow each row's OWN rounds passed (research 06 §6 / §10.4): the
Hidden-Core trophy row only for the players still in when it was cleared — a teammate eliminated or departed earlier
gets the table value of its own rounds. `onEnd(summary)` receives the same object (without `t`, plus `errors`).

`m.emote { playerId, id }`: `id` must be one of `shared/constants.js EMOTES` (`BAD_MSG` otherwise, also when `handle()`
is called without protocol validation); 1 per second per player (`RATE`).

Tickers (`m.ticker { text, id, type, priority, playerId }`) from `config.broadcasts`: SHOP_LEVEL, GOLDEN_CHAR,
CHAR_DAMAGE (per board unit per battle, highest threshold; summons created in battle once per unit type — a client
result may only name the unit types its lineup can field, fields.js validateClientResult), BOSS_HIT (20/50/80 % of the
pool per player), CHAR_GIFT (to the
receiver only), plus CUSTOM texts (eliminations, 联防, hidden core).

---

## 6. Testing & tools

* `test/match/fakeBattle.js` — scriptable DESIGN §5.1 Battle (`FakeBattle.script = (battle) => plan`); inject with
  `new Match({ …, BattleClass: FakeBattle })`.
* `test/match/harness.js` — `makeMatch(opts)` (virtual scheduler, captured frames, `drive()` for human decisions,
  `toPrep(r)`, `checkInvariants(m)`, `give()/giveItem()` scenario helpers).
* `VirtualScheduler({ instantCombat })`: `advance(ms)`, `runNext()`, `runUntil(pred)`, `runAll()`; with
  `instantCombat` (default) battles run synchronously, so a full match takes milliseconds of wall time.
* Suites: pool, board, economy, merge, bonds, draft, combat (FakeBattle), finalAssault, connection, meta, waves,
  results, fullmatch (fullmatch*.test.js, parallel files, runner fullmatchRun.js — REAL sim: solo × 4 difficulties, co-op
  2/3/4 incl. AI, 20 seeds each; `MATCH_SEEDS=n` to change),
  fuzz (random valid-shaped intents + connection churn), lobby-integration (real server + sockets), realtime (the real
  server + lobby + Match with RealScheduler and the REAL sim: 2 scripted websocket humans + 2 AI from the room to the
  prep of round 4 — drafts, 机变, buying/placing, combat snapshots `gt`, watching, 联防, throttled m.public), bot (field
  model, layout planner, rehearsal side-effect freedom, economy/bench regression).
  `node --test test/match/*.test.js`
* `node tools/matchrun.mjs --mode coop --difficulty HARD --players 4 --seeds 20` — per-round balancing summary / aggregate
  (`--check` audit, `--errors` per-source error table, `--lp N` / `--layers N` to reach late rounds, `--rehearsal N`).
* `node tools/balance.mjs --mode multi --difficulty NORMAL` — the competent-board difficulty model (docs/BALANCE.md):
  per round leaks / LP after 联防 / clear time of representative boards against the real waves, boss damage by 150 s
  and kill time; `--tuning off` (research numbers), `--legacy-time`, `--profile weak|strong`, `--bots N`, `--json`.
  Tests: `test/match/balance.test.js` (tuning layer, model), `test/match/followups.test.js`.

## 7. Assumptions (all documented in module headers)
* Unite helper choice: `unite.js helperOrder` (§4; selection units > active bond > standing units > seat, the pair
  units > active bond > Σ active layers > standing > seat; the ranks marked 存疑 in PRTS). Unite enemies re-enter with
  their original stats on the official 联防 spawn timing (waves.js `buildUniteWave`, DATA.md §15 #22).
* A manual refresh while frozen keeps the new slots frozen until the next round start.
* Level-up does not add slots until the next roll (refresh / round start).
* Buying a second copy of an equipped normal item merges into the golden item in the hand (not equipped).
* Promotions by effects (升华, 博士投影) keep the equipment; merges return it.
* Chess granted by effects need a free pool copy unless `requirePool: false` (then they hold 0 copies).
* Boss-round `local` pack spawns (boss parts) all spawn; content scripts (bosses.js) decide their behaviour.
* The Final Assault ends as a defeat when every field finished with the boss pool above 0 (boss escaped).
* Combat limits are real seconds (× 2 in game seconds) — see §3; research 00-INDEX §8 #10 assumed game seconds.
* Emotes faster than 1/s answer `RATE`.
* 中途退出 = elimination at once (research); a quitter's operators already fighting in a shared field (联防, boss
  field) finish that battle, its LP already merged into the team LP stays there.
* After the LP merge (Final Assault) the per-player LP shown is a share of the team LP ∝ the LP each player brought in.
* A 联防 helper's operators dead at the end of its own combat do not take part in the 联防 battle.
* A merge completed after the prep (SETTLE effects) keeps its reward offer for the next prep; with a full hand its elite
  takes a freed board tile (a prep merge still overflows into temp).
