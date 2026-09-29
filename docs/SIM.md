# SIM.md — battle simulation engine reference (server/sim)

Audience: **content authors** (kits, bonds, garrisons, items, bands, enemies, bosses, devices, choices) and the
**match owner** who drives `Battle`. The normative contract is DESIGN.md §5; this file documents the concrete
implementation, every hook and helper, the SkillSpec schema with worked examples, the profession defaults and
the test harness. Everything here is deterministic: the only randomness is `battle.rng()`.

```
server/sim/
  Battle.js        one field (normal / unite / boss / hidden) — public API, hook bus, helpers
  constants.js     TICK, MOVE_SCALE, ATTACK_PAUSE, element numbers, tuning knobs
  rng.js           mulberry32 PRNG (+ int/range/chance/pick/shuffle/weighted)
  grid.js          stage grid, tile semantics, 8-dir A* (no corner cutting), obstacles
  units.js         Unit model + stat aggregation
  buffs.js         Buff model, mod keys, status catalogue
  damage.js        damage / heal pipeline, shields, dodge, element gauges
  targeting.js     range grids (rotated by the unit direction), target filters, priorities
  dir.js           the 4 deploy directions: vectors, rotation, mirror (shared with server/match and browsers)
  projectiles.js   projectile flight & impact
  skills.js        SkillRuntime (SP, charges, triggers, kinds, SkillSpec)
  ai.js            operator attack loop, enemy route following / blocking / attacks
  professions.js   default behaviour per subProfessionId
  snapshot.js      wire format (UnitInfo, snapshot tuples, flags, anim codes)
  simdata.js       data access + normalisation (data/*.json, research fallback)
  content/index.js installContent / setupUnitKit / registerAllMeta
  content/generic.js  generic kit from skill blackboards
  content/kits/tier1..6.js, content/{tokens,bonds,garrisons,items,bands,enemies,bosses,devices,choices}.js  (content phase)
```

---

## 1. Driving a battle (match owner)

```js
import { Battle } from './sim/Battle.js';
const b = new Battle({
  seed, kind: 'normal' | 'unite' | 'boss' | 'hidden', modeId, round,
  stageId | stage,              // data/stages.json id or entry
  rect,                         // optional; defaults: normal rows 9–12 × cols 0–10, unite cols 0–20, boss rows 0–5 × cols 0–20
  timeLimit,                    // game seconds (the match passes 2 × the round's combatTimeLimit, which data gives in
                                // real seconds of the forced-2× battle — DESIGN §4); boss/hidden default Infinity (match force-ends)
  players: [PlayerBattleInput], // DESIGN §5.1
  spawns: [SpawnSpec], routes: [RouteSpec],
  sharedBoss,                   // { hp, maxHp, damage(playerId, amount) } or null
  flags: { layerGainsEnabled, dpInit: 10, dpPerSec: 1, dpMax: 99 },
  fieldId,                      // echoed in snapshots
  enemyOverrides,               // waves.json `overrides` ({ [enemyKey]: { stats: {…partial} } })
  // optional: data (DataSource or raw maps), content ('full'|'generic'|'none'), kits ({baseId: kitFn}),
  // extraContent ([{install(battle)}]), setup(battle) (runs after content install, before deployment),
  // recordEvents (default true), autoFinish (default true), logger, quiet, verbose, devices (false = no stage crates)
});
while (!b.finished) b.step();      // 1 TICK = 1/30 game s; live battles run at the forced 2× = 60 ticks per real second
b.snapshot();  b.drainEvents();   // every 3 ticks for watchers (§8.2 wire format)
b.result();                        // BattleResult (DESIGN §5.1) — see §1.3
b.forceEnd('forced' | 'timeout'); // 'timeout' converts remaining enemies to leaks
b.fieldMeta();                     // { fieldId, kind, rect, stageId, units: UnitInfo[] } for m.field
```

Construction creates every ally unit (not yet deployed) and installs content (kits, then domain modules). The first
`step()` (or `b.start()`) spawns stage crates, deploys all board units for free — per player, **top→bottom then
left→right** (right boss side: right→left in field columns) — firing `deploy {initial:true}` for each, then
`battleStart`. Register hooks before the first step (e.g. `opts.setup(battle)` or right after `new Battle`).

**Tick order:** scheduled callbacks → spawns → DP → buffs (+HP regen) → enemies (attack, move, block) →
enemy tile index → allies (skill tick, attack) → projectiles → auto-redeploys → boss pool sync → `tick` hook →
release hooks/timers of units removed this tick (§1.4) → `time += TICK` → end checks.

### 1.1 Coordinates (PlayerBattleInput units)

`units[].row/col` are **board coordinates** (rows 9–12, cols 2–10) unless `abs: true` (or player
`coords: 'field'`). Mapping:

| field | row | col | direction |
|---|---|---|---|
| normal | row | col + colOffset (0) | unit `dir` (default RIGHT) |
| unite | row | col + colOffset (0 or 8) | unit `dir` |
| boss/hidden, side L | row − 7 when row ≥ 7 (board 9–12 → boss 2–5) | col + colOffset | unit `dir` |
| boss/hidden, side R | same | **20 − col** (mirrored; colOffset ignored) | **mirrored**: RIGHT ↔ LEFT, UP / DOWN unchanged (`battle.mapDir`) |

`rowOffset` on the player overrides the boss row mapping. Unit input `dir` ∈ `'UP'|'RIGHT'|'DOWN'|'LEFT'` (the board
piece's facing, research 09 §1.2; absent/junk ⇒ RIGHT; with `abs` / `coords:'field'` it is a field direction as given).
Token pieces: `{ kind:'token', tokenId, ownerUid, row, col, dir? }`.

**Facing (DESIGN §3, `sim/dir.js`).** Every ally has `unit.dir`; `unit.fwd` = its forward vector `[dRow, dCol]` (UP
`[1,0]`, RIGHT `[0,1]`, DOWN `[−1,0]`, LEFT `[0,−1]`; row 0 is the bottom). Range grids and every relative offset
`[dRow, dCol]` are authored facing RIGHT and rotated: RIGHT `(dr,dc)`, UP `(dc,−dr)`, LEFT `(−dr,−dc)`, DOWN `(−dc,dr)`
(`rotateOffset`; the inverse `toLocal` turns an absolute delta into the unit's frame); `rangeExtend` adds tiles along
+dCol **before** rotating. `unit.facing` (±1) survives only as the derived horizontal sign for sprite flipping (a legacy
`facing = ±1` assignment sets RIGHT / LEFT). Content rules: "身前 k 格" = `frontOf(r, c, dir, k)` (`support.frontTile`);
"左右两格" = `offsetTile(r, c, ±1, 0, dir)` (`support.sideTiles`); kit pushes / pulls use `unit.fwd`; blowers compare
directions (same ⇒ `equal`, reverse ⇒ `opposite`, perpendicular ⇒ `vertical`); board-position rules ("更靠左", "最右边",
"同一行最右边") stay board positions in the player's own frame (mirrored FA side: counted from the field's other end),
independent of the units' directions. Enemies keep their own horizontal facing logic (content/enemies.js frontGuard).
"First tile" tie-breaks relative to a unit (tactical points `findTacticalPoint`, summon tiles `findSummonTile`, the 突袭
landing tile) compare offsets in the unit's facing-RIGHT frame (`localOrder` / `localBefore`; for a RIGHT unit exactly
the old tile-key order), so a rotated layout plays the same (test/sim/facing-invariance.test.js: every chess × 4
directions on an open field). 余 S3's fire wall runs through his tile perpendicular to his direction (his column facing
RIGHT / LEFT, his row facing UP / DOWN; fx `firewall.axis` = `'col'|'row'`).
`carryState: { hpPct, sp, skillActive }` restores unite helpers (HP ratio, SP; `skillActive` restarts a timed skill for a
fresh duration/ammo **without spending a charge** — `unitsEnd` reports `sp: 0` while a skill runs, so pass it through as is).

### 1.2 Enemies, routes, ownership

`SpawnSpec = { time, enemyKey, routeIndex, count=1, interval=0, mods:{hpMul,atkMul,defMul,resMul,speedMul}, sourcePlayerId?,
bounty?:{coins, ownerPlayerId}, tag?:'boss'|'part'|'escort'|'bounty', ownerPlayerId?, pos?:[r,c], route?:RouteSpec, countInTotal? }`.
`RouteSpec` accepts data/waves.json routes (`{motion, start, end, checkpoints:[[r,c]…], steps:[{t:'move',p},{t:'wait',s},{t:'disappear'},{t:'appear',p}]}`)
and research routes (`{m, s, e, cp:[['MOVE',r,c]…]}`). `spawnsFromTemplate(waveEntry, {mods})` (simdata.js) converts a
template into `{ routes, spawns, maxPlayTime, overrides, extraRoutes }` (non-spawn `action` entries are skipped; `unharmful`
and `tag:'part'` spawns don't count in `total`).

WALK legs pathfind on the stage grid inside the rect with the official flow field (grid.js: 4-direction SPFA from the
destination, crates cost 1000, then Bresenham line-of-sight smoothing — research 08 §3.4). Among equal-length routes the
one crossing the fewest non-blockable tiles (floor / gate lanes) wins, and a smoothed segment never cuts across floor
the grid route does not walk (user playtest #2 item 2; test/sim/pathing-blockable.test.js). Enemies re-path whenever
an obstacle changes (`grid.version`), after a displacement and when 诱导 ends; the smoothed chain is only line-of-sight
clear from a tile centre, so an enemy re-planning off-centre first steps back to its tile centre when the straight line
to its first waypoint would cut a tile it cannot walk or a crate (a pushed enemy never clips a fence corner or breaks
the decorative crate on it — act1 m03 (11,5); test/sim/pathing.test.js). If crates cut every path the enemy walks through them, gets blocked by the crate
and destroys it. FLY legs fly straight between checkpoints. `disappear` hides
the enemy (untargetable, not in snapshots), `wait` pauses, `appear` teleports.

**Enemy attacks:** blocked melee enemies hit their blocker; enemies with `rangeRadius > 0` **and `applyWay` ≠ `MELEE`**
attack allies within the radius (a MELEE enemy only ever hits its blocker — data/enemies.json already zeroes their
`rangeRadius`, the engine enforces it for any source; content may set `enemy.profile.melee = false`) (blocker → highest taunt → latest deployed; stealthed and `untargetable` allies are skipped for ranged shots)
and pause `ATTACK_PAUSE` (0.35 s) after each unblocked attack; `fear`/`disarm` stop attacks; `dmgType 'none'` enemies
never attack; `dmgType 'heal'` enemies heal the lowest-HP% enemy in their radius instead. Content can take over an
enemy's attack: `enemy.profile.deferHit` = the engine makes the attack (target, timing, the `'atk'` event) but deals no
damage — the content's `attack` handler resolves it (帝国炮火先兆者's shells landing 3 s later, `content/enemies.js
kitShell`); `enemy.profile.shot` = the `'atk'` event's projectile kind (`'mortar'`: no projectile drawn). Crates (stage devices with
role `crate`, 100 HP) are ground obstacles; an enemy forced through one is blocked by it and destroys it. A device is
present when data/stages.json says `active: true` (this wins over the level file's `hidden`: act1 m02's crates);
research stages without `active` use `!hidden`. Active platforms/mounds (射击台, act1 m03) [ASSUMED, DATA §15.11] are
ground obstacles, and an operator standing on one is elevated (`unit.ground = false`: never blocks).

**Ownership** (`enemy.ownerId`, used for `killed/total` and leak attribution): `ownerPlayerId` if given, else the
player whose half contains the spawn tile (cols ≥ 11 = right half / player with colOffset 8 or side R). A leak is
recorded for the player whose half contains the goal it reached, with `sourcePlayerId` preserved for unite LP.

### 1.3 BattleResult

```js
{ time, reason: 'cleared'|'timeout'|'forced', killed, total, errors, unspawned?: [{enemyKey,time,tag}], bossHpLeft?,
  perPlayer: { [playerId]: { killed, total, perfect,
      leaked: [{ enemyKey, mods, lpr, sourcePlayerId, tag, counted, boss?, spawned }],
      layerGains: {bondId: n}, coins, damageDealt, bossDamage, healingDone, deaths,
      unitsEnd: [{ uid, id, defId, hpPct, sp, skillActive, alive }],
      unitStats: [{ id, uid, defId, name, kind, dmg, kills, heal, taken, attacks }] } } }
```
- `cleared`: no spawns pending and no enemy alive (or the shared boss pool reached 0). A boss/hidden battle **with a
  `sharedBoss`** ends only when the pool reaches 0 or on `forceEnd` (DESIGN §5.5) — an emptied field keeps running
  (the h07_04 pair leader has no wait step and can walk into the objective: the leak costs its `lpr`, then the field
  idles while another field may still empty the pool or the match's overtime drain — team LP, from 150 real s — ends it); without a pool
  (sandboxes, tools) it still ends `cleared` when empty. `timeout`: `time ≥ timeLimit` —
  every living non-boss enemy becomes a leak; spawns that never happened are dropped from `total` and listed in `unspawned`.
- `leaked[].counted = false` for `notCountInTotal`/`unharmful`/boss parts (LP rules: normal rounds count only `counted`
  leaks, cap 10; boss rounds use `lpr`). `perfect = no counted leak`.
- `battleEnd {result}` fires before the result is frozen: handlers may still call `addLayers`/`addCoins`.

### 1.4 Robustness

Every content callback (hooks, buffs, timers, kits, projectiles, skill callbacks) runs inside try/catch: the error is
logged once per (label, unit, message) into `battle.errors` and the battle continues. Engine-phase errors
(`internal:*`) are counted separately; after 200 of them the battle force-ends as a timeout. `step()` never throws.

Guarantees content can rely on (pinned by `test/sim/robustness.test.js`):
- **Re-entrancy.** `forceEnd()` called while a step runs (from any hook/callback) is deferred to the end of the current
  phase: the remaining phases are skipped, `time` does not advance and the result is built once (never mutated later).
  Enemies/units created by hooks during the enemy loop or the buff pass start acting next tick. A skill `onEnd` that runs
  because its unit is dying cannot redeploy it (use the `death` hook). `gainSp` / `dealDamage` re-read cost and stats
  after their `spGain` / `hit` hooks.
- **Recursion.** Hook emits and content callbacks share one nesting counter; deeper than `MAX_HOOK_DEPTH` (32) the
  handler/callback is skipped and a `hookDepth:*` content error is logged (deterministic — no stack overflow). Its message
  lists the open frames (`chain: hit(enemy_x→chess_y) > damaged(chess_y) > …`) so the looping pair is named; see the
  re-entrancy rule in §5. A tripped guard is always a content bug, never a limit to raise.
- **Bad numbers.** Helpers sanitize their inputs: DP flags and non-boss `timeLimit` (0/NaN ⇒ 60 s) fall back to defaults;
  unit rows/cols are coerced to integers (junk ⇒ unit skipped); `spawnEnemy` mods must be finite ≥ 0 (else ×1), the spawn
  point is clamped into the rect; `spawnDevice`/`spawnToken`/`relocate` accept only integer in-rect free tiles
  (`spawnToken` returns null and leaves nothing behind when the tile is busy, `relocate` only moves living deployed allies,
  `redeploy {tile}` refuses a non-integer / out-of-rect / occupied tile without falling back to the home tile);
  non-finite `hp`/`stats`/`duration`/`extend`/`addAmmo`/`addCharge`/`addLayers`/`addCoins`/`spCostMul` values are ignored;
  aggregated stats that overflow (stacked `*Mul`) fall back to base values; a revive written by a `kill` handler is
  clamped to max HP (NaN/≤ 0 ⇒ the unit dies with hp 0); projectiles with non-finite coordinates are re-aimed at their
  origin; a NaN shared-boss pool shows the boss at full HP and counts 0 damage.
- **Runaway content.** At most `MAX_ALIVE_ENEMIES` (600) living enemies per field (`spawnEnemy` returns **null** beyond —
  content must handle it); a SpawnSpec `count` is capped the same way and `time: Infinity` spawns are never scheduled.
- **Movement.** Route legs outside the rect are clamped onto it (h07_01's extra fly route runs along row 6, outside the
  boss rect: without the clamp the flyer hovered at the border forever). An enemy that gains `unblockable`/`levitate`
  through a plain buff is released by its blocker on its next update.
- **Listener hygiene.** When a unit is removed for good (enemy killed/leaked, token expired or dead, device destroyed,
  permanent retreat) its hooks and periodic `every` timers registered with `{ owner: unit }` are dropped at the end of
  that step — after its own `death`/`enemyLeak` handlers ran; one-shot `after` callbacks still run. Register global
  handlers without an owner (or with a longer-lived owner) if they must outlive the unit.

---

## 2. Units

`Unit` fields: `id, side ('ally'|'enemy'), kind ('op'|'token'|'enemy'|'device'), defId, def (normalised), name, ownerId
(playerId), uid (board piece), ownerUnit (tokens), x, y (floats; x = col, y = row), tileR, tileC (allies), homeR, homeC
(board tile: auto-redeploys land there), dir ('UP'|'RIGHT'|'DOWN'|'LEFT'; getters `fwd` = forward vector, `facing` =
horizontal sign ±1 for sprites only), hp, alive, deployed, removed, hidden, base {…}, buffs[],
rangeKeys / rangeKeySet (current range, absolute tile keys `r × 21 + c`), baseRangeKeys (initial range, §7.1),
extraRangeKeys (content extra targets, `battle.setExtraRange`), blocking[] (allies), blockedBy (enemies), motion
('WALK'|'FLY' enemies), profile, skill (SkillRuntime), kit, items (itemIds), lpr/mods/tag/bounty/sourcePlayerId (enemies),
stats {dmg,kills,heal,taken,attacks}, mem {} and trait {} (free scratch space), persist {redeployMul, …}.`
Getters: `s` (aggregated stats), `maxHp`, `atk`, `hpRatio`, `sp`, `spMax`, `canAct`, `isFlying`, `statusFlags` (UF bits),
`dmgType`, `weight`.

`unit.s` (lazy, recomputed after any buff change): `maxHp, atk, def, res, aspd, bat, interval, blockCnt, moveSpeed,
rangeExtend, baseRangeExtend (its permanent part: persist + never-expiring buffs), massLevel (base + ΣmassFlat, ≥ 0 —
`unit.weight`), maxTargets (+n), taunt, dodgePhys, dodgeArts, defIgnoreFlat/Pct, resIgnoreFlat/Pct, dmgDealtMul,
physDealtMul, artsDealtMul, dmgTakenMul, physTakenMul, artsTakenMul, trueTakenMul, elemTakenMul, healingDealtMul,
healingTakenMul, atkScaleMul, spRecovery, spCostFlat, redeployMul, hpRegen, shield, flags{…}`.

Aggregation: `ATK/DEF/maxHp = (base + Σflat) × (1 + Σpct) × Πmul`; `res = clamp((base + ΣresFlat) × ΠresMul, 0, 100)`;
`aspd = clamp(base + Σaspd, 10, 600)`; `interval = bat × (1 + ΣbatPct) × 100 / aspd`; `moveSpeed = (base + ΣmoveFlat) × ΠmoveMul`;
tiles/s = `moveSpeed × MOVE_SCALE (0.5)`. A maxHp change keeps the HP ratio. Elite stats (module included) come from data.

---

## 3. Buffs, mods, statuses

`battle.addBuff(unit, { key, duration=Infinity, refresh='replace'|'extend'|'stack'|'independent'|'keep', stacks, maxStacks,
mods, flags, onTick(ctx), interval, onExpire(ctx), onRemove(ctx), tags, shield, shieldHits, persist, visible, data, allowDead })`
- `replace`: new instance replaces the old; `extend`: keep the longer remaining time, take the new mods; `stack`: +stacks
  up to maxStacks, timer reset; `independent`: separate timers, at most `maxStacks` alive (oldest dropped); `keep`: ignore.
- Additive mods scale with stacks (`value × stacks`), `*Mul` mods multiply (`value ^ stacks`).
- `onTick({battle, unit, buff, dt})` every tick, or every `interval` s. `persist: true` survives death/redeploy.
- `shield` = HP absorbed (consumed, buff removed when empty); `shieldHits` = number of damage instances fully negated.
- `visible: true` emits `['status', id, key, 1/0]` client events. `battle.removeBuff(unit, key|buff)`.

**Mod keys** — additive: `atkFlat atkPct defFlat defPct hpFlat hpPct resFlat aspd batPct blockCnt rangeExtend
defIgnoreFlat defIgnorePct resIgnoreFlat resIgnorePct dodgePhys dodgeArts spRecoveryFlat maxTargets taunt hpRegen
hpRegenRatio spCostFlat moveFlat massFlat` (重量 levels: 失重 = `massFlat: −1`; never edit `base.massLevel`);
multiplicative: `atkMul defMul hpMul resMul moveMul dmgDealtMul dmgTakenMul physTakenMul artsTakenMul trueTakenMul
elemTakenMul healingDealtMul healingTakenMul spRecoveryMul redeployMul atkScaleMul physDealtMul artsDealtMul`.
A `rangeExtend` on a `persist` never-expiring buff is **permanent**: it also widens the initial range (§7.1).
**Flags:** `stun freeze sleep silence disarm stealth invulnerable unblockable levitate fear cold reveal bind noHeal
untargetable blockFly noMove noSp burstLock hidden attract`. `taunt: true` as a flag counts as +1 taunt level (DESIGN §5.3).

**Statuses** — `battle.applyStatus(target, key, { duration, source, value, force, refresh, point })` (returns true if
applied); honours enemy/op immunities (`stun`, `silence`, `sleep`, `frozen`, `levitate`, `feared`) unless `force`; fires
`beforeStatus` (cancellable; handlers may also change `ctx.duration` / `ctx.value`), then applies 抵抗 (`resist`, below)
and the 浮空 weight rule, then `statusApplied { source, target, status, duration (final), value, entered }` — `entered`
= the target carried no buff of that status before (a refresh / a weaker "取最高" application is not an entry: "进入…时"). Effects follow the official term table
(`gamedata_const.termDescriptionDict`, `ba.*`). Same-key statuses refresh to the longer duration, except the
"同名效果取最高" ones marked *strongest* below: the strongest value wins, a weaker application never overrides it and,
if it outlasts it, resumes when the strong one expires (pass `refresh` to opt out).

| key | effect | value |
|---|---|---|
| `stun` | cannot act / move; **a stunned operator blocks nothing** (its blocked enemies walk on) | – |
| `freeze` | stun; **enemies** also RES −15 | – |
| `cold` | ASPD −30; a 2nd cold while cold ⇒ `freeze` 3 s (unless frozen-immune) | – |
| `sleep` | 无敌且无法行动: inactive, untargetable, **takes no damage** (unless the attacker profile has `hitSleep` or the damage `ignoreSleep`), blocks nothing | – |
| `slow` | moveMul 1 − value (*strongest*) | default 0.5 |
| `sluggish` (停顿) | moveMul 0.2 | – |
| `bind` (束缚) | cannot move | – |
| `fragile` / `artsFragile` / `physFragile` / `elemFragile` | taken ×(1+value) (*strongest*) | 0.3 / 0.3 / 0.3 / 0.2 |
| `silence` | no skill activation | – |
| `fear` (恐惧) | 无法被阻挡并四散逃跑: enemy cannot attack, is unblockable (released) and does not advance | – |
| `tremble` (战栗) | 被阻挡后无法进行普通攻击: no normal attack **while blocked** (abilities still fire) | – |
| `palsy` (麻痹) | each stack cancels one enemy normal attack (max 3, lasts until consumed) | stacks, default 1 |
| `disarm` | no normal attacks | – |
| `stealth` / `reveal` | untargetable unless blocked / cancels stealth | – |
| `invulnerable` | ignores damage | – |
| `levitate` (浮空) | stun + unblockable (unblocks enemies); **half duration on units with (current) massLevel > 3** | – |
| `attract` (诱导) | 无法被阻挡并向目标位置移动: unblockable (released); the engine walks it (own speed, grid path re-planned on obstacle changes; flyers straight) to `opts.point` (`[r, c]` or `{x, y}`, default the source's tile, clamped to the rect) and keeps it there; stun/bind/sleep stop it; its route re-plans from where it stands when the status ends. A new application moves the point | point |
| `resist` (抵抗) | the control statuses of `RESIST_STATUSES` (晕眩 冻结 寒冷 沉睡 恐惧 战栗 诱导 浮空 束缚 沉默 缴械 停顿 减速) applied to the unit last ×(1 − value); a resisting unit loses one 麻痹 stack every 5 s. **同名效果不叠加** — `battle.resistOf(u)` = the strongest `status: 'resist'` buff (never a product): several sources (灵知, 流明, 寒檀, enemy talents) never compound. *strongest*; a permanent one that survives death is a `persist` buff with `status: 'resist', data: { value }` | 0.5 (≤ 0.95) |
| `taunt` | taunt level +value | 1 |
| `weaken` | atkMul 1 − value (*strongest*) | 0.3 |
| `aspdDown` | aspd + value (*strongest*) | −30 |
| `defDown` / `resDown` | defMul 1 − value / RES −value (*strongest*) | 0.3 / 20 |

Unknown keys become a flag buff `{ [key]: true }`. Flags `noBlock` (blocks nothing) and `tremble` exist for custom buffs;
a custom buff with `flags.sleep` also blocks nothing and is untargetable/invulnerable like the status.

**Element gauges** (`unit.elem = {burn, neural, apoptosis, erosion, necrosis}`; capacity `unit.gaugeMax` = 1000, enemy
leaders (rank BOSS / boss units) 2000): deal `{ type:'element', element, amount }` (fires `elementHit` first; the gauge
gain is × `elemTakenMul` × (1 − 损伤抵抗 / 100), 损伤抵抗 = the target's data `epResistance` — PRTS 元素 "受到的元素损伤 =
损伤值 × (1 − 损伤抵抗 × 0.01)"). A full gauge bursts with the official effects, which depend on the side hit
(constants.js `ELEMENT`):

| element | operator hit by enemies (ba.dt.*) | enemy hit by operators ("·我方" ba.dt.*2) |
|---|---|---|
| `burn` 灼燃 | 1200 arts + RES −20, 10 s lock | 7000 元素伤害 + RES −20, 10 s lock |
| `neural` 神经 | stun 10 s, then 1000 true (10 s lock) | 3 `palsy`, then 6000 元素伤害, 10 s lock |
| `apoptosis` 凋亡 | 15 s: 阻回 (`noSp`: no SP gain of any kind, skills.js) + 静默 (no skill activation), −1 SP/s, 100 arts/s | 15 s: 50 % weaken recovering over the burst, 800 元素伤害/s |
| `erosion` 侵蚀 | permanent DEF −100 (stacking `erosionDown`) then 800 phys, 10 s lock | permanent DEF −120 then 5000 元素伤害, 8 s lock |
| `necrosis` (legacy spare gauge) | 12 s: 100 true/s, ATK −20 % | same |

The lock (`<el>Burst` buff, flag `burstLock`) is the official **爆发冷却**: while it runs NO element of the unit fills or
can be recovered (`battle.reduceElement(unit, amount, el?)` removes nothing) and the bursting gauge shows full; when it
ends EVERY gauge of the unit resets to 0. A burst that is still resolving counts as locked too (`unit.burstPending[el]`,
`burstLocked(unit)` in damage.js — it takes no element): the `elementBurst` hook fires before the lock buff exists, so
fills of that unit are refused until the burst has resolved — an `elementBurst` handler that spreads the element to
neighbours (淤困 parasite) cannot bounce it back into a second burst. `elementView(u, now)` (damage.js) is the one gauge
a unit shows (b.snap `elem`, §9): the fullest one, ties by the official element id (`constants.js ELEMENT_ORDER`: 神经,
侵蚀, 灼燃, 凋亡, then the legacy `necrosis`); during a 爆发冷却 the bursting element with fill 1 and the cooldown's end.
**元素伤害** (element HP damage, e.g. "每秒受到…元素伤害") is the DamageInfo type `'elemental'` (+ optional `element` for the
client colour): no DEF/RES/dodge, × source `dmgDealtMul` × target `dmgTakenMul` × `elemTakenMul`, shields absorb it.

---

## 4. Damage & heal pipeline

`battle.dealDamage(source, target, dmg)` → HP removed. `DamageInfo = { amount, type:'phys'|'arts'|'true'|'elemental'|'element',
element?, defIgnoreFlat, defIgnorePct, resIgnoreFlat, resIgnorePct, mul=1, canDodge (phys/arts), isSkill, isSplash,
isAttack, attackId, ignoreSleep, tags[], cancel }` (`battle.makeDamage(d)` normalises). `attackId` is the same for every
damage instance of one normal attack (all targets, splash, chain, projectile impacts; 0 for non-attack damage) — use it
for "本次攻击" procs that must roll once per attack. **Dodge** from several buffs rolls independently: the unit's
`s.dodgePhys` = 1 − Π(1 − pᵢ) (a single source keeps its exact value).
Order: invulnerable / asleep? → **`hit`** (mutate `dmg`, set `dmg.cancel`) → dodge (`rng()`) → mitigation (phys
`max(A − max(0, D×(1−defIgnorePct) − defIgnoreFlat), 5 %A)`, arts `max(A×(1 − R′/100), 5 %A)`, true = A; source ignore
mods are added) → × source `dmgDealtMul` (× phys/artsDealtMul) × target `dmgTakenMul` × type-taken mul × `dmg.mul` →
shields → HP loss (boss units: routed to `sharedBoss.damage(playerId, amount)`) → if HP ≤ 0: **`fatal`**
(`ctx.prevented = true` keeps the unit at ≥ 1 HP) → **`damaged`** → SP-on-hurt / TAKE_DAMAGE → `kill` + `death`.

`battle.heal(source, target, amount, { overheal=false, self, silent })`: no-op on `noHeal` targets (unless self);
× source `healingDealtMul` × target `healingTakenMul`; **`heal`** hook (mutable amount); capped at max HP; `overheal`
turns the excess into an `overheal` shield. `battle.loseHp(target, amount, {source})` = HP loss ignoring DEF/RES/shields/dodge (流失).

---

## 5. Hook bus

`battle.on(name, fn(ctx, battle), { priority=0, owner, once })` → handle; handlers run in descending priority, then
registration order. `battle.off(handle)` / `battle.off(name, fn)` / `battle.offOwner(owner)` (also cancels timers);
`battle.emit(name, ctx)` (custom events allowed); `ctx.stopPropagation = true` stops later handlers.

| name | ctx | notes |
|---|---|---|
| `battleStart` | `{}` | after the initial deployment |
| `deploy` | `{ unit, initial }` | ops/tokens (initial & redeploy), enemies (`initial:false`), devices |
| `tick` | `{ dt }` | end of every tick |
| `beforeAttack` | `{ attacker, targets, isSkill, profile }` | allies **and** enemies; replace/filter `ctx.targets` |
| `attack` | `{ attacker, targets, isSkill }` | an attack/heal was performed (projectiles may still be in flight) |
| `hit` | `{ source, target, dmg }` | before mitigation; mutate `dmg` (not fired for gauge fills — see `elementHit`). `source` may be null (terrain, bursts) |
| `elementHit` | `{ source, target, dmg }` | before a gauge fill (`dmg.type === 'element'`); mutate `dmg.amount`/`dmg.mul`, set `dmg.cancel` |
| `damaged` | `{ source, target, amount, type, dmg }` | after application (`amount` may be 0 when shielded); element fills too |
| `heal` | `{ source, target, amount, opts }` | mutable `amount` |
| `fatal` | `{ unit, source, dmg, amount, prevented }` | HP would reach 0 — set `prevented` (substitutes, 不屈, 复活 items) |
| `kill` | `{ killer, victim }` | victim HP reached 0 (a handler may revive by restoring HP) |
| `death` | `{ unit, reason:'killed'|'leak'|'retreat'|'merchant'|'expired', killer }` | unit removed |
| `skillStart` / `skillEnd` | `{ unit, skill, reason }` | mutate `skill.ammoLeft` / `skill.timeLeft` in skillStart |
| `ammoUsed` | `{ unit, left, skill }` | per ammo consumed |
| `spGain` | `{ unit, amount, reason:'time'|'attack'|'hurt'|'init'|…, skill }` | mutable `amount` (time gains fire every tick) |
| `beforeStatus` | `{ source, target, status, duration, value, cancel }` | set `cancel` (e.g. 浓缩嗅盐) |
| `statusApplied` | `{ source, target, status, duration, value, entered }` | after immunity check; `duration` = final (after 抵抗 / weight); `entered` = newly started (not a refresh) |
| `blocked` | `{ blocker, enemy }` | enemy became blocked |
| `enemySpawn` / `enemyLeak` | `{ enemy }` | |
| `elementBurst` | `{ source, target, element }` | before the burst's lock/effects; same-element fills of `target` are already refused |
| `dodge` | `{ source, target, dmg }` | an attack was dodged |
| `layerGain` | `{ playerId, bondId, n, reason, source, tile }` | mutable `n` before recording (魔王 +1 …); `tile` = `[r, c]` where `source` stands — or was knocked out this very instant ("被击倒时" gains) — else null (`addLayers` opts.tile overrides) |
| `merchantPay` | `{ unit, cost, cancel }` | a merchant (行商) is about to pay its periodic DP; change `cost` or set `cancel` |
| `battleEnd` | `{ result }` | may still add layer gains / coins |

**Re-entrancy rule for content.** A handler that deals damage from `hit`/`damaged` (counters, reflection, sharing,
"bonus damage on hit") must not react to its own output or to other reactive damage, or two such effects ping-pong
until the nesting guard trips (the guard then skips *every* nested handler, including `kill`/`death` bookkeeping of
content). Respond only to `dmg.isAttack` (normal attacks), tag your damage (`tags: ['counter']`) and skip tagged damage,
or guard with a per-unit flag while dealing it. When the guard trips, the logged error names the open frames
(`chain: hit(enemy_x→chess_y) > damaged(chess_y) > …`).

---

## 6. Engine helpers (content must use these)

| helper | notes |
|---|---|
| `dealDamage(src, tgt, dmg)`, `heal(src, tgt, amount, opts)`, `loseHp(tgt, amount, {source})` | §4 |
| `applyStatus(tgt, key, {duration, source, value, force, point})`, `removeStatus(tgt, key)`, `resistOf(unit)` | §3 |
| `addBuff(unit, buff)`, `removeBuff(unit, key)` | §3 |
| `spawnToken(ownerUnit | playerId, tokenId, row, col, { def, stats, hp, duration, untargetable, dir, kit, force, anySource })` | field tiles; def from data/tokens.json `variants[ownerChessId]` for the owner unit's selected skill / module (`tokenDef`); `dir` defaults to the owner unit's (else the player's: RIGHT, mirrored side LEFT; a legacy `facing` ±1 is still read); returns the token or null (tile busy; or the owner runs a **non-default** skill that does not produce the token — `producesToken` — unless `anySource`: kit install hooks written for the default skill run under every skill). `spawnDevice(key, row, col, { …, dir })` likewise |
| `tokenDef(tokenId, ownerUnit | chessId)`, `producesToken(ownerUnit, tokenId)` | the token def a summon of that owner gets — `getToken(id, owner.defId, owner.def.loadout)`, exact even when two players of one field give the same chess different loadouts (prefer it over an id-only `battle.data.getToken(id, unit.defId)` for summon stats / blackboards); whether the owner's loadout makes the token (DATA.md §14 `sources` has 'skill' or 'talent'; true when the data does not tell: no own variant, player-owned summons) |
| `spawnEnemy(enemyKey, { routeIndex, route, pos, mods, tag, sourcePlayerId, ownerPlayerId, bounty, countInTotal, def })` | returns the enemy, or null past `MAX_ALIVE_ENEMIES`; `def` = inline record (enemies.json shape or normalised) for keys missing from data |
| `spawnDevice(key, row, col, { hp, obstacle, blockCnt, name, def, res, atk, bat, aspd })`, `setObstacle(r, c, on)` | obstacles re-path enemies; spawnDevice returns null outside the rect or on a living unit |
| `isReservedTile(r, c)` | true when a living unit stands there or it is the home tile of an ally piece that has not deployed yet / waits to redeploy — summon tile pickers must skip these (`findTacticalPoint` does) |
| `addProjectile({ from, target | to:{x,y}, speed, onHit(ctx), visual, source, hitDead })` | homing; fizzles if the target dies unless `hitDead` |
| `unitsInGrid(unit, grid, {side, extend})`, `alliesInGrid(unit)`, `enemiesInRadius(x, y, r)`, `alliesInRadius(x, y, r, ownerId?)` | grid offsets are relative to facing RIGHT, rotated by `unit.dir` |
| `allies(ownerId?)`, `aliveEnemies()`, `unitAt(r, c)`, `unitById(id)`, `tileInfo(r, c)`, `lowestHpAllyInRange(unit)` | |
| `addLayers(playerId, bondId, n, reason, {source})`, `addCoins(playerId, n)` | layers are a no-op when `flags.layerGainsEnabled` is false (unite/boss) |
| `getPlayer(playerId)` | `{ playerId, seat, side, colOffset, mirror, dir (default unit direction: RIGHT, mirrored side LEFT), facing (its sign), bonds (live copy, layers updated by addLayers), bandId, playerEffects, lpForBoss, dp, units }` |
| `mapTile(ps, row, col, abs?)` / `mapDir(ps, dir, abs?)` | board → field tile / direction of a player (the FA right-side mirror) |
| `addDp(playerId, n)`, `retreat(unit, {reason, permanent})`, `relocate(unit, r, c)` | |
| `redeploy(unit, { free=true, tile, keepSp })` | immediate (re)deployment of a dead/retreated ally (full HP, `deploy {initial:false}`); `free: false` pays `base.cost` DP (refused without it); `tile: [r, c]` lands on that tile once (home unchanged — later redeploys use the board tile; refused when off-rect or occupied, no fallback); `keepSp` keeps SP/charges (保留技力), restored before `deploy` fires — 突袭 raids, 阿戈尔 revive in place |
| `refreshRange(unit)`, `setExtraRange(unit, keys)`, `rangeChanged(unit)` | rebuild the ranges after changing `unit.rangeGrid` (流形 copies); extra targetable tiles (absolute keys; merged into every later rebuild until set again; `null` clears; never in `baseRangeKeys`): 蕾缪安 wanted, 维娜 S3 |
| `displace(enemy, {x, y}, tiles, {force})` | push/pull along passable tiles; heavier (massLevel) enemies move less; unblocks + re-paths |
| `after(seconds, fn, {owner})`, `every(seconds, fn, {owner, immediate})` | return `{cancel()}`; fn(battle, sched) |
| `fx(kind, params)`, `rng()` (+ `rng.int/range/chance/pick/shuffle/weighted`) | never use Math.random |
| `forceAttack(unit, targets?, { noAmmo })` | an immediate attack with the current profile (hooks, attack SP, a running ammo skill's bullet); `noAmmo: true` = spends no bullet and emits no `ammoUsed` (圣约送葬人 extra attack). Returns true when it attacked |
| `findTacticalPoint(unit)`, `groundPathTiles()` | tactical point (战术点, tactician 援军 / talent tokens): a free (`isReservedTile`) walkable tile of the initial range **on an enemy ground path first** (`groundPathTiles`: grid paths of every non-FLY route, cached per grid version), then nearest (Chebyshev, rows break ties), then the lowest tile key |
| `effectiveProfile(unit)`, `reduceElement(unit, amount, el?)` | |
| `battle.grid` | `tile(r,c)` → `{glyph, key, height:'LOW'|'HIGH', build, pass:'ALL'|'FLY'|'NONE', terrain, special}`, `inRect`, `canStand(r,c,{ranged})`, `groundPassable`, `isLow`, `findPath(sr,sc,er,ec)`, `specialTiles('start'|'end'|…)`; `battle.rect`, `battle.stage` (normalised stage incl. `special` terrain params) |
| `battle.data` | DataSource: `getChess(id, loadout?)`, `getEnemy(key)`, `getToken(id, ownerChessId, ownerLoadout?)`, `getStage(id)`, `getWave(id)` (normalised defs; raw record in `def.raw`; the per-battle loadout view, §12) |

---

## 7. Skills

### 7.1 Runtime rules (skills.js)
- SP types: `time` (+`s.spRecovery`/s), `attack` (+1 per attack), `hurt` (+1 per hit taken); starts at `initSp`; **no SP
  gain while a duration/ammo/toggle skill is active, while stunned, or with the `noSp` flag**. Attack-type SP: attacks made
  by the skill (the pending "next attack" of an instant/charge skill, every shot of a timed skill including the one that
  ends it) recover nothing, so a cost-N skill fires every **N+1** attacks (AK). Charges (`maxChargeTime > 1`):
  SP fills to cost → +1 charge (SP restarts) until charges are full (then SP stays full).
- Triggers (`skill.trigger.rule` in data): `DEFAULT` — ready **and** about to attack/heal **and** an enemy (heal skills:
  an injured ally) inside the **initial** range (`unit.baseRangeKeys`: its own grid + its permanent rangeExtend —
  "攻击范围扩大" modules/talents as persist never-expiring `rangeExtend` buffs; no skill range, no temporary extend, no extra
  keys) — or, checked **every tick**, an enemy (flyers included) inside a content trigger range
  (`unit.skill.addTriggerRange(fn)`, `fn(battle, unit)` → list of ally units (their current range) or tile-key arrays;
  returns an unregister fn; not for heal skills: 海嗣 "攻击范围视为自身攻击范围的延伸", 流形); `TAKE_DAMAGE` — ready and just hit; `SP_FULL` (`ALWAYS`) — immediately;
  `CUSTOM_RANGE` — an enemy inside `trigger.customRangeGrid` (rotated by the unit direction like every grid); `SEARCH` — an enemy inside the INITIAL range, checked every tick (no attack needed; BWIKI "解放者/阵法术师子职业干员 技能1，初始攻击范围内出现敌人后自动释放", research 03 Addendum C1);
  `NEVER` (alias `MANUAL`) — never auto-casts: the kit calls `unit.skill.activate(reason)` itself;
  `GDGLOW_SKILL_2`, `MLYSS_WTRMAN` and any unknown rule behave like DEFAULT. Units that never attack (bard, phalanx,
  librator) check DEFAULT every tick. Silence blocks activation. `gainSp` is ignored while a duration/ammo/toggle skill
  runs (its bar shows the skill), whatever the reason, and — any reason but `'init'` — while the unit has the `noSp`
  flag (阻回: "停止并阻止任意形式的技力回复"; the operators' 凋亡 burst, §3).
- Kinds: `duration` (mods for `duration` s), `ammo` (mods until `ammo` attacks were made, optional duration cap),
  `instant` (onStart + optional one-shot attack override applied to the next attack), `charges` (instant with charges),
  `passive` (always on from deployment, no SP), `toggle` (stays on until death once activated).
- `end()`: `active` turns false, then **onEnd runs while the skill's mods / range are still applied** (finishers and
  end bursts use the skill's stats and range), then they are removed (kept when onEnd re-activated the skill), then
  `skillEnd` fires. `onAttack` ctx carries `noAmmo` (set it to true: this attack spends no bullet, no `ammoUsed` — 流明's
  free heals).
- Runtime helpers on `unit.skill`: `activate(reason, {free})`, `end(reason)`, `stop()`, `addAmmo(n)`, `extend(s)`,
  `addCharge(n)`, `gainSp(n, reason)`, `addTriggerRange(fn)`; fields `sp, spCost (= floor(base×spCostMul + spCostFlat)), spCostMul, charges,
  maxCharges, active, timeLeft, ammoLeft, activations, kind, rule, bb`.

### 7.2 Kits

```js
// server/sim/content/kits/tierN.js
export default {
  [baseChessId]: (bb, chess, def) => Kit,   // bb = flattened blackboard of the SELECTED skill (normal Lv4 / elite Lv7)
};                                           // chess = the record as the unit's loadout makes it (simdata loadoutRecord),
                                             // def = normalised def (def.skill = selected skill, def.talents[].bb, def.loadout)
Kit = {
  skill: SkillSpec | null,      // the chess's DEFAULT skill; null ⇒ unit never casts
  skills: { [skillId]: SkillSpec },          // optional: specs of the other selectable skills (DESIGN §16 operator loadout)
  talents: [{ install(battle, unit) {} }],   // hooks with { owner: unit }; check unit.alive in handlers
  trait: { ...profile overrides },           // e.g. { priority: 'lowDef', maxTargets: 2, splashRadius: 1.2 }
  install(battle, unit) {},                  // optional extra per-unit setup (runs under EVERY selected skill)
}
```
Keys: the data `baseId` (`chess_char_1_01_a`, also used for the elite `_b`), the exact chess id, or the suffix-less id of the
DESIGN §5.6 example (`chess_char_1_01`) — all three are looked up.
Missing kit ⇒ `content/generic.js` builds one from the blackboard (§7.4), so every chess always fights.
Operator loadouts (DESIGN §16): the unit's def is `getChess(chessId, { skillIndex, moduleId })` of its PlayerBattleInput
entry (no loadout fields = the default). The skill spec is `kit.skills[selectedSkillId]` when authored, else `kit.skill`
only when the selected skill is the default one, else the GENERIC spec of the selected skill (its generic install is
chained after the kit's; `kit.skillSource` = 'skills' | 'generic', absent for the default spec) — talents, trait and
`install` always come from the kit, so keep default-skill logic inside `skill` (or check `unit.skill.id`). Under a
non-default skill `spawnToken` refuses summons that skill does not make (琳琅诗怀雅 S1/S3: no 香槟炸弹), and the
tokens.js skill-summon fallback (a table of skill summons, e.g. 迷迭香 S3's two 战术装备) runs while the selected skill
has the generic spec. Summons: `battle.tokenDef(tokenId, unit)` / `battle.spawnToken(unit, …)` resolve the owner's loadout
(token skill of that slot: `variants[owner].bySkill[i]`, module attributes: `.byModule[id]`). Coverage of the selectable
skills: `node tools/kit-coverage.mjs --missing [--tier N] [--strict]`.

### 7.3 SkillSpec schema

```js
{
  kind: 'duration'|'ammo'|'instant'|'charges'|'passive'|'toggle',
  duration,              // s (duration kind; optional cap for ammo)
  ammo,                  // attacks (ammo kind)
  spCost, initSp, charges, spType: 'time'|'attack'|'hurt',   // optional overrides of the data values
  trigger: 'DEFAULT' | { rule, grid },                          // optional override
  heal: bool,            // heal-type skill for the DEFAULT trigger (default: unit is a healer)
  mods: { …mod keys },   // buff while active (instant: only during the pending attack)
  flags: { …flags },
  targeting: { maxTargets, rangeGrid, rangeExtend, priority, allInRange, canHitFly },
  attack: { dmgType, atkScale, healScale, splashRadius, splashScale, hits, projectile, maxTargets, dmgMul,
            chain: {count, falloff, radius, sluggish}, heal: {mode, count, falloff}, onHitStatus: {key, duration, value},
            onHit(ctx),                           // once per attack (main target; target may be null for a splash landing)
            onEachHit(ctx) },                     // per victim: main, every splash / chain victim — ctx += { dealt, kind:'main'|'splash'|'chain', isSplash, isChain, main, attackId }
                                                  // (overrides the profession profile while active; profiles may define onEachHit(b, u, victim, hctx) too)
  onStart(ctx), onEnd(ctx) /* mods & range still applied */, onHit(ctx), onAttack(ctx) /* ctx.noAmmo */, onTick(ctx),
}
ctx = { battle, unit, skill, bb, target?, dealt?, heal?, targets?, dt?, reason?, x?, y? }
```

### 7.4 Generic kit (content/generic.js)
Kind: PASSIVE (or a free skill without duration/ammo) ⇒ passive; AMMO ⇒ ammo; duration > 0 ⇒ duration; duration < 0 ⇒
ammo if an ammo key exists, **toggle only when the text says 持续时间无限** (史尔特尔) — the data also uses −1 for instant/charge
skills (塑心, 妮芙, 夕, 流星, 莱恩哈特 …); else instant (charges when maxChargeTime > 1).
Keys → spec (stat keys prefer the plain key, attack/targeting keys prefer `attack@`: 薄绿 hits for `attack@atk_scale` 1.1,
its `atk_scale` 2.1 is the end burst): `atk→atkPct, def→defPct, max_hp→hpPct` (values > 5 are flat: 史尔特尔 +5000 HP),
`attack_speed→aspd, base_attack_time→batPct, magic_resistance→resMul` (|v| < 1, "法术抗性+60%") or `resFlat`,
`damage_scale→dmgDealtMul, block_cnt→blockCnt, taunt_level→taunt, damage_resistance→dmgTakenMul (1−v)`, positive
`hp_recovery_per_sec(_by_max_hp_ratio)→hpRegen(Ratio)`, `sp_recovery_per_sec→spRecoveryFlat, magic_resist_penetrate_fixed→
resIgnoreFlat, def_penetrate_fixed→defIgnoreFlat, ability_range_forward_extend→targeting.rangeExtend, max_target→
targeting.maxTargets, atk_scale→attack.atkScale, heal_scale→attack.healScale, times→attack.hits, attack@range_radius→
attack.splashRadius, trigger_time/ammo→ammo`.
Text-aware rules: negative atk/def/RES described on enemies debuff the **targets** (aura over the range while a timed skill
runs — 初雪; on hit for bb.duration otherwise — 流星, 莱恩哈特); statuses (`stun cold sleep fear sluggish root unmovable`, ×
`prob`): `attack@` keys on hit, plain keys on hit for instant/charges but **once at start** on ≤ max_target enemies in range
for timed skills (小满), a plain `stun` described "…结束后…晕眩" = self-stun at the end; "立即…造成…" / "技能结束时…造成…" =
one AoE burst of the plain atk_scale at start / end (乌尔比安, 薄绿); "额外造成攻击力N%…" is bonus damage, never the attack
scale (烛煌); "停止攻击…" (duration skills) ⇒ `attack.noAttack` (泡泡, 蛇屠箱, 凯瑟琳, 菲莱, 铃兰); "受到攻击时…攻击力/防御力N%的X伤害"
⇒ counter-damage while the skill is active (星熊, 泡泡; 周围 ⇒ AoE, `aoe_cd` cooldown: 菲莱) via `kit.install`; a non-healer
whose skill "恢复…友方/友军…生命" heals the most injured ally in range on each hit (古米, 瑕光; 所有友军 ⇒ all: 塞雷娅);
`ep_damage_ratio` + "附带…凋亡/灼燃/神经损伤" ⇒ element damage on hit (凋亡 → `apoptosis`; × damage dealt when the text says
"伤害N%的…损伤", else × ATK); "屏障" + `shield_max_hp_ratio`/`hp_ratio` ⇒ decaying self shield at start (砾, 新约能天使);
"立即流失N%当前生命" ⇒ self HP loss at start (宴, 风丸); `hp_ratio` + "恢复/回复…生命" ⇒ self heal at start; `force` ⇒ on-hit
displacement (拖拽/hookmaster pull, else push). **Passive** skills only apply stat mods (timed when the text says "N秒内":
宴 +65 % ATK for 14 s) and the self/counter effects — their scales describe procs that need a kit. Instant skills with
mods/targeting but no attack override apply them to the next attack (the skill range is switched in for that attack).

### 7.5 Worked examples (real operators, numbers from blackboards)

**1. Ammo sniper — 隐现 `chess_char_1_01_a` “解决麻烦”** (bb `atk 0.8, base_attack_time −0.3, attack@trigger_time 14`;
text: prefers ranged enemies, less likely to be targeted; talent: +2 ammo after 20 s on field):
```js
chess_char_1_01_a: (bb, chess, def) => ({
  skill: {
    kind: 'ammo', ammo: bb['attack@trigger_time'],
    mods: { atkPct: bb.atk, batPct: bb.base_attack_time, taunt: -1 },
    targeting: { priority: 'ranged' },
  },
  talents: [{ install(battle, unit) {
    const t = def.talents[0].bb;                          // { self_ammo: 2, duration: 20 }
    battle.on('skillStart', ({ unit: u, skill }) => {
      if (u === unit && battle.time - unit.deployedAt >= t.duration) skill.ammoLeft += t.self_ammo;
    }, { owner: unit });
  } }],
}),
```

**2. Duration ATK buff guard — 幽灵鲨 `chess_char_2_07_a` 肉斩骨断** (bb `atk 0.7, stun 10`: HP never below 1 during the
skill, self-stun 10 s afterwards):
```js
chess_char_2_07_a: (bb) => ({
  skill: {
    kind: 'duration',                                     // duration comes from the data (11 s)
    mods: { atkPct: bb.atk },
    onStart({ battle, unit }) {
      unit.mem.undying = battle.on('fatal', (c) => { if (c.unit === unit) c.prevented = true; }, { owner: unit });
    },
    onEnd({ battle, unit, reason }) {
      battle.off(unit.mem.undying);
      if (reason !== 'death') battle.applyStatus(unit, 'stun', { duration: bb.stun, source: unit });
    },
  },
}),
```

**3. Instant burst caster — 至简 `chess_char_3_13_a` 神工意匠** (bb `atk_scale 1.3, ct 2`; next attack 130 % arts, hits
twice; 2 charges; the funnel profile already ramps damage on the same target):
```js
chess_char_3_13_a: (bb) => ({
  skill: { kind: 'charges', attack: { atkScale: bb.atk_scale, hits: 2, dmgType: 'arts' } },
}),
```
An AoE instant (德克萨斯 剑雨, bb `stun 2`: two hits of 120 % arts around her + stun) uses `onStart` instead:
```js
onStart({ battle, unit, bb }) {
  for (const e of battle.enemiesInRadius(unit.x, unit.y, 1.5)) for (let i = 0; i < 2; i++) {
    battle.dealDamage(unit, e, { amount: unit.s.atk * 1.2, type: 'arts', isSkill: true });
    battle.applyStatus(e, 'stun', { duration: bb.stun, source: unit });
  }
  battle.addDp(unit.ownerId, 10);
}
```

**4. Healer — 调香师 `chess_char_2_14_a` 精调** (bb `atk 1.8, attack_speed −50`, 30 s; the ringhealer profile heals 3 allies):
```js
chess_char_2_14_a: (bb) => ({
  skill: { kind: 'duration', heal: true, mods: { atkPct: bb.atk, aspd: bb.attack_speed } },
}),
```
and 华法琳 紧急包扎 (charges, bb `hp_ratio 0.15`: next heal +15 % of the target's max HP if it is below half):
```js
skill: { kind: 'charges', heal: true, attack: { onHit({ battle, unit, target, bb }) {
  if (target && target.hpRatio < 0.5) battle.heal(unit, target, target.s.maxHp * bb.hp_ratio);
} } },
```

**5. Summoner — 赫默 `chess_char_2_02_a` 医疗无人机** (bb `cnt 1`: gain a medical drone that heals nearby allies for 10 s):
```js
chess_char_2_02_a: (bb) => ({
  skill: {
    kind: 'instant', trigger: 'SP_FULL',
    onStart({ battle, unit }) {
      for (const k of unit.rangeKeys) {                  // first free walkable tile in range, nearest first
        const r = Math.floor(k / 21), c = k % 21;
        if (!battle.unitAt(r, c) && battle.grid.canStand(r, c, { ranged: true })) {
          battle.spawnToken(unit, 'token_10000_silent_healrb', r, c, { duration: 10 });
          break;
        }
      }
    },
  },
}),
```
(the drone's stats come from `tokens.json variants[chess_char_2_02_a]`; it is untargetable and uses the heal profile.)

**6. Tank TAKE_DAMAGE — 古米 `chess_char_1_10_a` 备用军粮** (rule `TAKE_DAMAGE`, bb `heal_scale 1.15`: the next attack
heals a nearby ally for 115 % ATK):
```js
chess_char_1_10_a: (bb) => ({
  skill: {
    kind: 'instant',                                      // trigger comes from data: TAKE_DAMAGE
    attack: { onHit({ battle, unit }) {
      const ally = battle.alliesInRadius(unit.x, unit.y, 1.5, unit.ownerId).sort((a, b) => a.hpRatio - b.hpRatio)[0];
      if (ally) battle.heal(unit, ally, unit.s.atk * bb.heal_scale);
    } },
  },
}),
```

**7. Bond hook example — 精准 3-tier** (`bonds.js`): members + ranged ops ignore 30 % DEF/RES:
```js
export function install(battle) {
  battle.on('battleStart', () => {
    for (const p of battle.players) {
      const bond = p.bonds.preciShip;
      if (!bond?.active || bond.tier < 2) continue;
      for (const u of p.units) if (u.def.bonds?.includes('preciShip') || u.def.position === 'RANGED')
        battle.addBuff(u, { key: 'bond:preci', persist: true, allowDead: true, mods: { defIgnorePct: 0.3, resIgnorePct: 0.3 } });
    }
  });
}
```

**8. Timed follow-ups — 蕾缪安 `chess_char_6_01` S3 礼炮·强制追思** (user playtest #3; bb `attack@emit_offset 0.2`,
`dist_1` / `dist_2`, `proj_atk_scale_1` / `_2`; PRTS S3 note: after the skill ends one bombardment every 0.3 s in lock
order on a random point of the 0.4-side square around each lock mark, ATK cached at the end, ≤ 33 in 10 s). Content that
unfolds over time chains `battle.after` callbacks owned by the unit (they run even if it dies later — check what the
official text says and bail out yourself); random numbers come from `battle.rng`, drawn in the unit's facing frame
(`dir.js rotateOffset`) so a turned board plays alike:
```js
const bombard = (battle, unit, locks) => {
  const atk = unit.s.atk, seq = unit.deploySeq;                        // ATK cached at the skill's end
  const n = Math.min(locks.length, Math.floor(10 / 0.3 + 1e-9));        // ≤ 33 shells
  const fire = (i) => {
    if (!(unit.alive && unit.deployed && unit.deploySeq === seq)) return;  // knocked out: no further shell
    const L = markOf(locks[i]);                                         // follows the enemy / stays where it left
    const [oy, ox] = rotateOffset(battle.rng.range(-spread, spread), battle.rng.range(-spread, spread), unit.dir);
    const x = L.x + ox, y = L.y + oy;
    battle.fx('bombardShell', { x, y, id: unit.id, r: d2, t: 0.3, i });  // the renderer drops a shell there
    battle.after(0.3, () => blast(battle, unit, atk, x, y), { owner: unit });   // lands 0.3 s later [ASSUMED]
    if (i + 1 < n) battle.after(0.3, () => fire(i + 1), { owner: unit });
  };
  if (n > 0) fire(0);
};
```
(`blast` emits fx `'bombard'` at (x, y) and deals `proj_atk_scale_1` / `_2` × the cached ATK to every enemy within
`dist_2`, once each; the full kit is `content/kits/tier6.js lemuen`.)

---

## 8. Professions (server/sim/professions.js)

Profile resolution: `PROFESSION_DEFAULTS[profession] → SUB[subProfessionId] → trait tunables (trait text + data
trait.bb, elites include module upgrades) → data fields (dmgType / attackKind / projectile / canHitFly / targetPriority)
→ kit.trait`. Defaults: SNIPER ranged phys arrow · CASTER ranged arts bolt · MEDIC ranged heal · SUPPORT ranged arts ·
TANK/WARRIOR/PIONEER/SPECIAL melee phys (melee cannot hit FLY). Ranged attacks fly as projectiles
(`constants.js PROJECTILE_SPEEDS`: arrow 14, bolt 11, bomb/lob 8, orb 10, drone 16, enemy 10 tiles/s; boomerang 15 out,
3.75 back = `BOOMERANG_RETURN_SPEED`, PRTS 跃跃); melee/`none` hits are instant. Kit-settable profile flags beyond the
table: `hitSleep` (targets and damages sleeping enemies — "可以攻击沉睡的敌人"), `onEachHit(b, u, victim, hctx)`, `dmgMul`,
`afterHit`, `afterAttack`, `canAttack`, `hitsFn`, `priority`, `blockFly`, `noHeal`, `boomerang` (the projectile stays
`'boomerang'` whatever the data's generic ranged projectile says) (see the header of professions.js).

| sub | behaviour |
|---|---|
| fastshot | FLY first; module `atk_scale` vs FLY |
| closerange, underminer, primcaster, corecaster, ritualist, summoner, counsellor, pioneer, fearless, fighter, protector, guardian, primprotector, executor, duelist | plain profile (numbers from data; skills/talents via kits). underminer module: weaken 10 % ATK 2 s on hit |
| longrange | lowest DEF first |
| aoesniper / splashcaster / blastcaster | splash 1.1 tiles at full damage |
| bombarder | ground-only splash 1.0 + aftershock(s) at 50 % ATK (bb append_atk_scale / times) |
| hunter | 8 bullets (bb value), ×1.2 ATK (bb atk_scale), reloads 1/s after 1 s without attacking; can't attack when empty |
| loopshooter | 回环射手 (user playtest #3): every attack throws a boomerang (`ai.js throwBoomerang`, projectile `'boomerang'`) out to the target at 15 tiles/s — it hits on arrival — and back to the thrower's current position at 3.75 tiles/s without damage (PRTS 跃跃 "投射物飞行速度15，返回时飞行速度3.75"); attacks only while holding it (every boomerang thrown caught — "必须回收全部回旋投掷物才可以进行下一次攻击", `unit.trait.boomerangsOut`) and with the attack cooldown ready, so the real interval is the longer of the two; a target dead mid-flight is not hit (it still flies to the last position and back); knocked out / withdrawn ⇒ lost, a redeployed thrower holds a fresh one; 跃跃 S2's extra boomerangs share the one flight (cnt hits) |
| reaperrange | hits every enemy in range; ×1.5 (bb atk_scale) on the trait front grid (or its own line ahead) — both along its direction |
| chain | chain N (trait text/bb max_target) with −15 % per jump (bb chain.atk_scale), 1.8-tile jumps, sluggish on each hit |
| funnel | drone damage 20 % → +15 %/hit on the same target → 110 % (bb init/delta/max) |
| mystic | stores up to 3 (bb times) attacks while idle, fires them all at once |
| phalanx | no attack & DEF +200 %, RES +20 (bb) while the skill is off; attacks with 1.1 splash while on |
| physician | heal the lowest HP% injured ally in range (a skill `targeting.maxTargets` widens any heal profile) |
| ringhealer | heal 3 allies |
| chainhealer | heal bounces 3× (−25 %, bb chain.*) within 2.5 tiles |
| healer (流明) | heal ×0.8 (bb heal_scale) beyond 2 tiles |
| wandermedic | heal + reduce element gauges by 50 % ATK (bb ep_heal_ratio); also targets uninjured allies with gauge |
| incantationmedic | arts attack; heals the lowest ally in range for 50 % (bb scale) of damage dealt |
| slower | sluggish 0.8 s on hit (bb sluggish) |
| bard | no attack; every second heals allies in range 10 % ATK (bb atk_to_hp_recovery_ratio) |
| craftsman | melee phys (support devices via kit) |
| shotprotector | ranged phys, can hit FLY, blocks 3 |
| fortress | melee single target while blocking, ranged 1.0 splash otherwise |
| unyield / musha / reaper | cannot be healed by others; musha heals itself 50 (bb value) per hit; reaper hits every enemy in range and heals 50 × min(hits, block) |
| centurion / crusher / pusher | hit every blocked enemy at once |
| hammer | 50 % splash (bb atk_scale_2) to others within 1 tile |
| instructor | ×1.2 (bb atk_scale) vs enemies it doesn't block |
| librator | no attack & block 0 while the skill is off; ATK +5 %/s up to +200 % (bb atk / max_stack_cnt), reset at skill end; elite module starts at +100 % (bb init_atk) |
| lord | can hit FLY at range; ×0.8 (bb atk_scale) unless the target is on its tile / the tile in front (along its direction) or blocked by it |
| sword / swordmaster | 2 hits per attack |
| artsfghter | melee arts |
| charger | +1 DP (bb cost) per kill |
| tactician | spawns a 援军 token (70 % HP, 50 % ATK, block 1) on the nearest walkable tile in range at each deployment; ×1.5 vs enemies it blocks |
| agent / hookmaster | can hit FLY (ranged reach); hook displacement comes from skills (generic: `force`) |
| bearer | block 0 while the skill is active |
| alchemist | ranged lob, can hit FLY |
| dollkeeper | fatal damage ⇒ substitute for 20 s (bb duration): block 0, doll HP (its own substitute token's stats, else 50 % max HP: 归溟幽灵鲨); swaps back at full HP; dies if the doll dies |
| geek | loses 1–3 % max HP per second (bb hp_ratio), never lethal on its own |
| merchant | −3 DP every 3 s (bb cost/interval); retreats when DP runs out |
| skywalker | can block FLY enemies |
| stalker | hits every enemy in range; 50 % dodge (bb prob), taunt −1 |
| traper | ranged, ground only |

Unknown subprofessions fall back to the profession default (test `professions.test.js` checks every pool subprofession).

---

## 9. Wire format (snapshot.js, DESIGN §8.2)

- `snapshot()` → `{ fieldId, t, units: [[id, x, y, hp, maxHp, sp, spMax, flags, anim]], dp, killed, total, dps?, boss?, down?, elem? }`.
  `sp/spMax` show remaining duration/ammo as a draining bar while a timed skill is active. Units in DIE state stay 0.8 s.
  `down: [[id, respawnAt, respawnTime, state]]` (only when non-empty) = knocked-out operators waiting to redeploy
  (`Battle.isDown(u)`: reason `'killed'`, deployed at least once, a finite respawn timer; `state` = constants.js
  `DOWN_STATE`: 0 counting, 1 timer done / DP short, 2 timer done / own tile taken); `elem: [[id, element, fill,
  cooldownEnd, cooldown]]` (only when non-empty) = `elementView` of every unit with a gauge or a running 爆发冷却 (§3).
  `fieldMeta()` lists the knocked-out operators too (a client joining mid-battle shows them; DESIGN §18.3).
- `drainEvents()` tuples: `['spawn', UnitInfo]` (first appearance), `['deploy', id]` (every (re)deploy), `['atk', src, tgt, projKind]`
  (`none|arrow|bolt|bomb|lob|orb|drone|enemy|boomerang|chain|chainHeal`; a boomerang's way back has no event — the
  renderer flies it back to the thrower at `BOOMERANG_RETURN_SPEED`; an enemy's `profile.shot` may name another kind,
  e.g. `mortar` for 帝国炮火先兆者, which the renderer does not draw — its fx `bombardShell` is the shell), `['dmg', tgt, amount, type]` (`phys|arts|true|burn|neural|necrosis|apoptosis`),
  `['heal', tgt, amount]`, `['skill', id, 1|0]`, `['die', id, reason]`, `['leak', id]`, `['status', id, key, 1|0]`,
  `['fx', kind, x, y, extra]`, `['layer', playerId, bondId, n]`, `['bounty', playerId, coins]`.
- `UnitInfo = { id, kind, side, ownerId, defId, name, tier, golden, spine, avatar, x, y, facing, dir, maxHp, motion?, boss?, uid?, skillIndex? }` (`skillIndex`: an ally's equipped skill, DESIGN §16)
  (`dir` = the unit direction, allies meaningful, enemies 'RIGHT'; `facing` = its horizontal sign for sprite flipping)
  (`spine`/`avatar` are asset ids from data).
- flags: UF bits (blocked 1, stunned 2, frozen 4, stealth 8, skill 16, shield 32, invuln 64, cold 128, sleep 256, flying 512);
  anim: ANIM codes (idle 0, move 1, attack 2, skill 3, die 4, stun 5, deploy 6).

---

## 10. Testing content (test/helpers/battleHarness.js)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../helpers/battleHarness.js';

test('隐现 S2: 14 shots then the skill ends', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e7, speed: 0 }) } },  // synthetic target
    units: [{ chessId: 'chess_char_1_01_a', row: 10, col: 4 }],                                // board coords
    enemies: [{ key: 'enemy_dummy', pos: [10, 6] }],
    hooks: ['ammoUsed', 'skillEnd'],
  });
  const u = h.unit('chess_char_1_01_a');
  assert.ok(h.runUntil(() => u.skill.activations === 1, 60));
  h.runUntil(() => !u.skill.active, 60);
  assert.equal(h.hooksOf('ammoUsed').length, 14);
  checkInvariants(h.b);
});
```
`makeBattle(opts)` options: `stageId` (default `'flat'`: synthetic open lanes, gates (9,10)/(12,10), goal (9,2); `flat:
{ rows, crates }` to customise) or `stage`; `kind`; `seed`; `units` (board coords, player `p1`; each may carry
`dir: 'UP'|'RIGHT'|'DOWN'|'LEFT'`, default RIGHT — facing tests: test/sim/facing.test.js, test/sim/facing-invariance.test.js,
test/content/facing.test.js)
or `players`; `enemies:
[{ key, time, route (index | RouteSpec), pos, count, interval, mods, tag, bounty, sourcePlayerId }]` or `waveTemplate`
(id or object ⇒ routes, spawns, time limit); `routes` (flat defaults: 0 walk low gate, 1 walk high gate, 2/3 fly);
`timeLimit`; `content` (`'full'|'generic'|'none'`); `kits` (inject `{ baseId: kitFn }`); `defs: { chess, enemies, tokens }`
(extra/override records; build them with `chessRec({...})` / `enemyRec({...})`); `bonds`, `bandId`, `playerEffects`,
`flags`, `sharedBoss`, `setup(battle)`, `hooks` (names to capture; `captureNoisy` to keep tick/hit/damaged/heal/spGain/
attack contexts), `autoFinish` (default: true when enemies are scheduled).
Harness API: `battle`/`b`, `step(n)`, `run(seconds)`, `runUntil(pred | seconds, maxSeconds)`, `runToEnd(max)`,
`unit(uid | chessId | baseId | id)`, `allies()`, `enemies()`, `enemy(key)`, `spawn(key, opts)`, `events` /
`eventsOf(kind)` (client tuples), `hooks` / `hooksOf(name)` (captured ctx copies with `t`), `result()`, `snapshot()`,
`invariants()`. `checkInvariants(b)` (no NaN, hp ∈ [0, maxHp], positions inside the rect, SP/charge bounds, finite skill
timers, occupancy map in sync with deployed allies, block links, DP, finite projectiles and per-player result counters,
no open hook emit between steps), `hashOf(v)`, `flatStage()`, `flatRoutes(kind)` are exported too.

Soaks: `SIM_FUZZ_N=3000 SIM_FUZZ_CHECK_EVERY=3 node --test test/sim/fuzz.test.js` (random real battles) and
`SIM_CHAOS_N=500 SIM_CHAOS_SEED=<n> node --test --test-name-pattern="chaos fuzz" test/sim/robustness.test.js` (content that
abuses every helper from every hook with junk numbers; asserts invariants and zero engine errors).
Normalised defs from `battle.data` are **deep-frozen** (shared by every battle in the process): never mutate `bb`, `def`,
`def.stats` or range grids in a kit — copy them (`{ ...bb }`, `grid.map(…)`).

Rules for content tests: seed everything, prefer synthetic `enemyRec` targets for exact numbers, assert on ids (not unit
objects), and call `checkInvariants` at the end. Run: `node --test test/sim/*.test.js test/content/*.test.js`.

## 11. Tools

`node tools/simrun.mjs --mode mode_multi_normal --round 5 --stage act2autochess_m01 --lineup "角峰@9,7 隐现@10,4 艾丝黛尔*@12,5" --ascii 10`
prints a per-unit damage/DPS/kills/heal table (+ ASCII frames: letters = operators, digits = ground enemies per tile,
`^` = flyers, `■` = crates). `--wave <template>`, `--seed`, `--content generic`, `--hpMul/--atkMul/--speedMul`,
`--time`, `--bossHp`, `--json`, `--events`, or a scenario JSON file (see the file header).

## 12. Data notes (simdata.js)

Defs are normalised from data/*.json (DATA.md) with research JSON as a fallback. Chess: `stats {maxHp, atk, def, res, aspd,
bat, blockCnt, cost, respawnTime, spRecovery, tauntLevel, massLevel, hpRecoveryPerSec}`, `rangeGrid`, `dmgType`,
`attackKind`, `projectile`, `canHitFly`, `targetPriority`, `trait` (text), `traitBb`, `immune` (Set), `skill {id, name,
skillType, durationType, duration, spType, spCost, initSp, maxCharges, rangeGrid, trigger {rule, grid}, bb, description}`,
`talents [{name, description, bb, bbStr, rangeGrid, tokenKey}]`, `raw`. Enemy: `maxHp, atk, def, res, aspd, bat,
rangeRadius, moveSpeed, massLevel, lpr, motion, applyWay, dmgType, immune, tauntLevel, blockCnt, epResistance,
epDamageResistance, hpRecoveryPerSec, notCountInTotal, tags, abilities, skills, talent, raw`. Tokens use
`variants[ownerChessId]` (owner-level stats). `skcom_withdraw` token skills are ignored.
Operator loadouts (DESIGN §16, DATA.md §2.2 / §14): `getChess(id, { skillIndex, moduleId })` = the def with the selected
skill (`def.skill`, its bb / SP / trigger) and, for elites, the module's stats / trait / talents; `def.loadout` = the
resolved loadout `{ skillIndex, moduleId, skillIsDefault, moduleIsDefault, isDefault }` (illegal choices fall back to the
default; cached per loadout; the default loadout is the same object as `getChess(id)`). `getToken(id, ownerChessId,
ownerLoadout)` = the summon for that owner loadout (`bySkill` / `byModule` merged; `def.sources` ⊆ ['talent', 'skill',
'display'] and `def.count` of that loadout — `[]` / `['display']`: the owner does not make it). Every Battle gets a
per-battle view (`withUnitLoadouts`: id-only `getChess(id)` / `getToken(id, owner)` use the loadout the inputs give that
chess id — the first player's when two players of one field differ, `view.loadoutConflicts`); Battle itself always passes
the unit's own loadout (`_createAllyFromInput`, `tokenDef` / `spawnToken`, the dollkeeper substitute), so it is exact.
Assumptions taken here (documented choices): element burst numbers for necrosis/apoptosis; unspawned enemies at timeout
are dropped (not leaks); geek drain is non-lethal; tactician reinforcement stats; displacement distance 0.5 + 0.5·force;
platforms/mounds are ground obstacles that elevate operators; the generic kit maps 凋亡 to `apoptosis` (侵蚀 has no element key
yet — enemy content must pick one); 抵抗 covers the control statuses of `RESIST_STATUSES` (the official term lists 晕眩/寒冷/
冻结/恐惧/诱导…, the rest follow the operator kits that grant it) and caps at 0.95; tactical points prefer enemy path tiles.
