# 卫戍协议：盟约 — Web Remake · Architecture & Contracts (DESIGN.md)

This is the **single source of truth** for every implementer. Research lives in `docs/research/` (start with `00-INDEX.md`; where a research file's body and its "Addendum (critic)" disagree, the addendum wins). When this document and research disagree, **this document wins**; when this document is silent, follow research; when both are silent, choose the simplest faithful behaviour and write it down in the module's header comment.

Language: all player-facing text is **Simplified Chinese** (names/descriptions come from official data). Code, comments and identifiers are English.

---

## 0. Product scope (v1)

A faithful, polished, **online co-op** browser remake of Arknights' seasonal auto-chess TD mode 「卫戍协议：盟约」(下半, `act2autochess`).

In scope:
- Title → lobby (nickname, create room / join by 4-letter code or `?room=CODE` link, host picks difficulty, up to 4 players, **AI teammates** can fill seats, ready/start). Solo (独立模拟) and co-op (同盟模拟, 1–4 humans + optional AI).
- Difficulties: 标准 FUNNY, 险境 NORMAL, 绝境 HARD, 终极 ABYSS (solo and multi variants from `modeDataDict`). Training/tutorial mode is out of scope.
- Pre-game: INFO_CHECK briefing (disabled bonds, banned operators, enemy factions, stage) → BAND_CHECK strategy draft (40 bands, random order, 1 skip in co-op) → BATTLE_CHECK.
- Rounds 1–14 (+ hidden 15): prep (shop, hand, board, items, freeze, refresh, level-up, sell, merge + reward pick, ready), 机变 draft rounds, simultaneous auto-combat on each player's own field, 联防 unite phase, LP loss/elimination, Final Assault boss round with merged LP and shared boss HP pool, Hidden Core, settlement with titles.
- Full content: 112 visible chess (+ elites), their default skills and talents, 23 bonds with layers, all 43 特质 (garrison) effect keys, 56 equipment + Arts, 40 bands, 机变 cards, enemy factions/special enemies, 10 bosses, stage devices/terrain (crates, blowers, mire, smog, deep sea, infection).
- Rendering with the real Spine battle chibis (PixiJS 7 + pixi-spine 4), procedural tiles, VFX, damage numbers, real BGM/SFX, emotes, broadcast ticker.
- Reconnect, AI take-over of disconnected players, robust validation of every client intent.

Out of scope v1: matchmaking queue, training/tutorial, DIY (甄选) slots (the 4 DIY chess are removed from the pool), trophies/progression persistence, reporting.

---

## 1. Tech stack

- **Node.js ≥ 18** (tested on 22), ESM (`"type": "module"`), single dependency `ws@8`. No bundler, no TypeScript. JSDoc types where helpful.
- **Server-authoritative simulation.** Clients send *intents*; the server validates, mutates state and pushes state/snapshots.
- **Client:** static files, native ES modules. Vendored libs in `public/vendor/`: `pixi.min.js` (PixiJS **7.4.2** UMD, global `PIXI`), `pixi-spine.js` (**4.0.6** UMD, `PIXI.spine`), `preact.module.js` + `hooks.module.js` + `htm.module.js` (Preact 10 + htm, no build step). No CDN at runtime (LAN play must work offline).
- **Shared code** in `shared/` is imported by both server and browser (pure ESM, no Node APIs).
- Tests: `node --test` (`test/**/*.test.js`). Browser E2E: `puppeteer-core` driving the system Chrome (dev dependency, optional).

Run: `npm install && npm run assets && npm start` → `http://localhost:3000`. Friends on LAN use `http://<host-ip>:3000`. Internet play: a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`) or any Node host (Dockerfile provided).

---

## 2. Repository layout & ownership

```
server/
  index.js                 HTTP static server (gzip for .skel/.atlas/.json/.js/.css), WebSocket upgrade at /ws, boot
  net.js                   session registry, send helpers, per-connection rate limit, message validation (uses shared/protocol.js)
  lobby.js                 rooms (4-letter codes), seats, host, AI seats, ready/start, reconnect tokens, room→Match wiring
  data.js                  loads data/*.json once, builds indexes (getChess, getBond, …); frozen objects
  match/
    Match.js               match state machine, timers, round loop, co-op orchestration, broadcasting views
    PlayerState.js         per-player economy/shop/hand/board/items/bonds/LP state + all prep-intent handlers
    pool.js                SharedPool (copies per base chess), banned/disabled bonds, odds & rolls
    board.js               placement legality, deploy cap, hand/temp management, merge detection & execution
    bondsMeta.js           bond member counting (BOARD / BOARD_AND_DECK / golden), activation tiers, persistent layers
    effectsMeta.js         registry + dispatcher of prep-phase ("SERVER_*") effects: garrisons, bands, items, bonds
    choices.js             机变 draft: card generation per family, pick order, timeouts, application
    waves.js               match enemy factions, per-round spawn list generation, stat scaling, bounties
    unite.js               联防 helper selection, leaked-enemy aggregation, LP attribution
    finalAssault.js        R14/R15 pairing, merged LP, shared boss HP pool, overtime drain
    results.js             settlement stats, titles (评语)
    bot.js                 AI player (plays prep phases; also auto-play for disconnected humans)
  sim/
    Battle.js              one field simulation (normal / unite / boss); public API §5
    constants.js           TICK, conversions, tuning knobs
    rng.js                 seeded PRNG (mulberry32) + helpers
    grid.js                field grid, tile queries, passability, pathfinding (8-dir, no corner cutting)
    units.js               Unit / Operator / Enemy / Token classes, stat aggregation
    buffs.js               Buff model, status catalogue (stun, freeze, cold, sleep, slow, fragile, stealth, …)
    damage.js              damage & heal pipeline, element gauges
    targeting.js           target selection helpers, range tests, priorities
    projectiles.js         projectile flight/impact
    skills.js              skill runtime: SP, triggers, durations, ammo, charges; interprets SkillSpec
    ai.js                  enemy movement/attack AI, operator attack loop
    snapshot.js            compact serialization for clients
    content/
      index.js             installs all content into a Battle (kits, bonds, garrisons, items, bands, enemies, devices)
      kits/tier1.js … tier6.js     operator kits (skill + talents) keyed by base chessId
      tokens.js            summon/token definitions
      bonds.js             battle side of the 23 bonds
      garrisons.js         battle side (IN_BATTLE) garrison effect keys
      items.js             battle side of equipment + Arts
      bands.js             battle side of band (strategy) effects
      enemies.js           enemy ability specs + generic special-type behaviours
      bosses.js            boss scripts (boss_1 … boss_10)
      devices.js           stage devices & special terrain
shared/
  constants.js             enums, phases, areas, error codes, UI-relevant constants
  protocol.js              message catalogue + validators (§8)
  format.js                rich-text description → HTML/plain; number formatting
  rules.js                 pure helpers shared by UI & server (e.g. price display, sell value, bond tier from count)
data/                      generated by tools/build-data.mjs — committed; see docs/DATA.md
public/
  index.html               single page; loads /js/main.js as module
  css/                     theme.css (tokens, fonts), components.css, screens/*.css
  js/
    main.js                boot, router between screens, global store
    net.js                 WebSocket client, reconnect, request/response helpers
    store.js               tiny observable store (state from server + local UI state)
    data.js                fetches /data/*.json, same indexes as server/data.js
    audio.js               BGM/SFX manager (Web Audio), volume settings
    assets.js              asset URLs, image cache, Spine loader with LRU + fallback
    screens/               title.js, lobby.js, room.js, briefing.js, bandDraft.js, game.js, result.js
    ui/                    hud.js, bondStrip.js, bondPopup.js, shopBar.js, teamPanel.js, detailPanel.js,
                           tooltip.js, choiceOverlay.js, rewardOverlay.js, ticker.js, emotes.js, settings.js, toasts.js
    render/                app.js, projection.js, tiles.js, units.js, spine.js, fx.js, interp.js, drag.js, pick.js (API §9)
  vendor/                  pixi, pixi-spine, preact, hooks, htm (copied from node_modules by tools/vendor.mjs)
  assets/                  downloaded art/audio (git-ignored), see docs/ASSETS.md
  fonts/                   self-hosted fonts
tools/
  build-data.mjs           official data + research JSON → data/*.json
  fetch-assets.mjs         downloads/optimizes assets → public/assets + data/assets.json
  vendor.mjs               copies vendor libs from node_modules → public/vendor
test/                      node:test suites; test/e2e/ browser + bot tests
docs/                      DESIGN.md (this), DATA.md, SIM.md, META.md, ASSETS.md, BALANCE.md, DEPLOY.md, PLAYING.md, research/
                           (the wire protocol is normative in shared/protocol.js itself)
```

Ownership rule for parallel agents: **only edit files assigned to you**; if you need a change in someone else's file, write it in your final report instead (the integrator applies it). Shared files (`shared/*`, `docs/DESIGN.md`) are owned by the architect.

---

## 3. Coordinates, fields and geometry

- Every stage is a **19-row × 21-col** grid (`data/stages.json`). **Row 0 is the bottom** row, col 0 is the left. Tile `(r,c)` has world centre `(x=c, y=r)`; 1 tile = 1 world unit. Unit positions are floats in this space.
- Areas (research 05 §2.2):
  - **Normal field** (own board): rows 9–12, cols 2–10. Enemy gates `S` at (9,10) and (12,10) (R1–3 only the lower one); protection objective `E` at (9,2). Col 9 lane is not deployable (tile type decides).
  - **Hand (整备区)**: row 7, cols 0–9 (10 regular slots, index = col). **Temp slots**: row 8, cols 4–8 (5 slots). Hand/temp tiles are never part of a battle.
  - **Partner display** cols 11–18 of rows 9–12 (the unite field uses them).
  - **Boss field**: rows 1–5; left half cols 2–10, right half cols 10–18.
  - Enemy preview pen rows 14–18 × cols 7–13 (row 16 empty): during prep the next round's enemies idle there (upper-gate enemies rows 17–18, lower-gate rows 14–15, ≤ 50 models, spawn-time order) — research 08 §4 / 09 §2.
- Tile semantics come from `data/stages.json` legend: height (LOW/HIGH), buildable (ALL/MELEE/RANGED/NONE), ground-passable, fly-only, special terrain (mire, smog, deepsea, infection). Melee chess may stand only on LOW tiles with buildable ALL/MELEE; ranged chess on ALL/RANGED **and** on LOW ALL/MELEE tiles ("所有行动内远程干员可部署在近战位"). Tokens follow their own `position`.
- **Facing (corrected, see research 09 §1.2):** like standard Arknights, every board piece has a direction `dir ∈ UP|RIGHT|DOWN|LEFT` chosen with the 4-direction deploy wheel after dropping it on a tile (also re-orientable in place); default `RIGHT`; persists across rounds. Range grid entries are `[dRow, dCol]` relative to facing RIGHT and are rotated: RIGHT `(dr,dc)`, UP `(dc,−dr)`, LEFT `(−dr,−dc)`, DOWN `(−dc,dr)` (row 0 = bottom); `rangeExtend` applies along +dCol before rotating. The right-side Final Assault player is mirrored col `c→20−c` with RIGHT↔LEFT (UP/DOWN unchanged).
- **Range test:** an enemy is inside a grid range if the tile containing it (`round(y), round(x)`) is one of the range tiles. Radius ranges (enemies, splash, auras) use Euclidean distance in tiles.
- **Fields at runtime:** a `Battle` receives a **field rect** (rows/cols subset) and the full stage grid. Normal battles use rows 9–12 × cols 0–10; unite uses rows 9–12 × cols 0–20; boss uses rows 0–5 × cols 0–20 (solo boss uses the left half only). Pathfinding never leaves the rect.
- **Speed:** `tilesPerSecond = moveSpeed × MOVE_SCALE` with `MOVE_SCALE = 0.5` (in `sim/constants.js`, tunable).

---

## 4. Time model

- Simulation time is **game seconds**. Fixed step `TICK = 1/30 s`.
- Combat runs at **2× real time** (forced, like the original): 60 ticks per real second — in the browser's runner (§14) or, for server-run fields, the server's accumulator (2 ticks every real 1/30 s, never more than 8 ticks per interval to avoid spirals).
- Combat time limits come from `data/config.json → modes[m].rounds[r].combatTimeLimit` (= the level's `maxPlayTime`; also `modes[m].combatTimeLimit[r]`) and are **real seconds of the forced-2× battle** (verified by the balance pass: spawn schedules exceed the limit when read as game seconds). The server passes `2 × value` game seconds to the Battle (`server/match/gamedata.js → combatTimeLimit`; `config.combatTimeScale`, default 2); the countdown players see equals the data value. When time runs out, living non-boss enemies count as leaked. 联防 uses the round's limit.
- Final Assault / Hidden Core have **no hard stop** and their clocks are real seconds too: the boss level's `levelMaxPlayTime` (120 real s) is only the HUD countdown (`m.public.deadline`; the battle goes on past it), and the overtime drain (`bossOvertimeAfter` 150 / `bossOvertimeDrainPerSec` 1 = official `bossTurnHpReduceTime`) takes 1 team LP per whole **real** second from 150 real s (= 300 game s on the 2× field clock; first point at 151 s — `gamedata.js bossOvertimeDue`). `m.public.overtimeAt` = the ms epoch when the drain starts; both are placed on the field clock.
- **Solo pause** (§14): while `m.public.paused` the running battle's field clock, the HUD `deadline` / `overtimeAt` and every server deadline of the battle stand still; on resume they move on by the paused time. Co-op battles never pause.
- Prep/draft timers are **real seconds**, stored as absolute server deadlines (`Date.now()`-based) and sent to clients as `deadline` (ms epoch) + `serverNow` for clock-offset correction.
- Snapshots to clients: every **3 ticks** (= 20 Hz real) per watched field.

---

## 5. Simulation (server/sim) — engine contract

### 5.1 Battle API (implemented by the sim-core owner; consumed by match & content)

```js
import { Battle } from './sim/Battle.js'
const b = new Battle({
  seed,                       // uint32
  kind,                       // 'normal' | 'unite' | 'boss' | 'hidden'
  modeId, round,
  stage,                      // data/stages.json entry (full 19×21 grid)
  rect: { r0, r1, c0, c1 },   // inclusive field bounds
  timeLimit,                  // game seconds; boss/hidden: Infinity (overtime handled by match)
  players: [ PlayerBattleInput ],   // 1 (normal), 1–2 (unite, boss)
  spawns: [ SpawnSpec ],            // enemy schedule for this field
  routes: [ RouteSpec ],            // from the wave template, resolved to this field
  sharedBoss: SharedBossPool | null,// { hp, maxHp, damage(playerId, amount) } for boss rounds
  flags: { layerGainsEnabled: bool, dpInit: 10, dpPerSec: 1, dpMax: 99 },
})
b.step()                 // advance exactly one TICK
b.finished               // true when: all enemies dead & no spawns pending, or time limit reached, or all players' LP pools say stop (boss: match decides via b.forceEnd())
b.forceEnd(reason)
b.time                   // game seconds elapsed
b.result()               // BattleResult (below), valid once finished
b.snapshot()             // compact full snapshot (§8.4) of this field
b.drainEvents()          // array of client-facing events since last drain (§8.4)
b.on(event, fn, { priority=0, owner } ) / b.off(...)   // hook bus (§5.4)
```

`PlayerBattleInput`:
```js
{ playerId, seat, side: 'L'|'R',
  colOffset,                 // 0 for own field; +8 for the right half in unite/boss
  units: [ { uid, kind: 'chess'|'token', chessId /* golden id if elite */, tokenId?, row, col,
             items: [itemId...],                  // equipped items (golden ids when merged)
             carryState?: { hpPct, sp, skillActive } } ],   // unite: helper units keep end-of-combat state
  bonds: { [bondId]: { count, active, tier, layers } },   // snapshot from bondsMeta at combat start
  bandId, playerEffects: [ EffectRef ],                   // active band/choice/team effects with battle parts
  lpForBoss?: number }
```

`SpawnSpec`: `{ time, enemyKey, routeIndex, count=1, interval=0, mods: { hpMul, atkMul, defMul, speedMul }, sourcePlayerId?, bounty?: { coins, ownerPlayerId } , tag?: 'escort'|'boss'|'bounty' }`

`BattleResult`:
```js
{ time, reason: 'cleared'|'timeout'|'forced',
  perPlayer: { [playerId]: {
     killed, total,                       // enemies attributed to this player's field/half
     leaked: [ { enemyKey, mods, lpr, sourcePlayerId } ],   // for unite aggregation & LP
     perfect: bool,                       // no leaks
     layerGains: { [bondId]: n },         // IN_BATTLE gains (0 if flags.layerGainsEnabled false)
     coins: n,                            // bounty coins earned
     damageDealt: n, bossDamage: n, healingDone: n, deaths: n,
     unitsEnd: [ { uid, hpPct, sp, alive } ] } },
  bossHpLeft? }
```

### 5.2 Units & stats

`Unit` fields (minimum): `id` (int, unique per battle), `side` ('ally'|'enemy'), `kind` ('op'|'token'|'enemy'|'device'), `defId`, `ownerId` (playerId; enemies: the field owner / source), `x, y`, `tileR, tileC` (ops), `dir` (allies: UP|RIGHT|DOWN|LEFT deploy direction, §3; `sim/dir.js`), `facing` (derived horizontal sign +1 / −1: LEFT ⇒ −1), `hp`, `alive`, `sp`, `buffs[]`, `statusFlags`, `blocking[]` (ops), `blockedBy` (enemies).

Base stats (from data): `maxHp, atk, def, res` (0–100), `aspd` (100 base), `bat` (base attack time, s), `blockCnt`, `rangeGrid` (ops) / `rangeRadius` (enemies, 0 = melee), `moveSpeed`, `massLevel`, `weight`, `lpr` (enemies), `dmgType` ('phys'|'arts'|'heal'|'true'), `motion` ('WALK'|'FLY'), `cost`, `respawnTime`, `spRecovery`.

**Aggregation** (`units.js`, recomputed lazily when buffs change):
- `ATK = (base + Σflat) × (1 + Σpct) × Πmul` — same shape for `maxHp`, `def`; `res = clamp((base + Σflat) × Πmul, 0, 100)`; `aspd = clamp(100 + Σaspd + base-100, 10, 600)`.
- `interval = bat × (1 + ΣbatPct) × 100 / aspd` (blackboard `base_attack_time` is treated as `batPct`, e.g. −0.3 → 70%).
- Changing `maxHp` keeps the HP **ratio**.
- Stats are rounded only for display; the sim keeps floats.

**Elite (精锐) chess** have their own stats in data (golden chess id). The module bonus is already folded into data stats by build-data.

### 5.3 Buffs & statuses

`Buff = { key, source, duration /*s, Infinity*/, stacks=1, maxStacks=1, refresh: 'replace'|'extend'|'stack', mods, flags, onTick?, onExpire?, tags[] }`

- `mods` keys (all optional, additive within a key): `atkFlat, atkPct, atkMul, defFlat, defPct, defMul, hpFlat, hpPct, hpMul, resFlat, resMul, aspd, batPct, blockCnt, rangeExtend (tiles), moveMul, dmgDealtMul (multiplicative, e.g. 1.2), dmgTakenMul, physTakenMul, artsTakenMul, trueTakenMul, defIgnoreFlat, defIgnorePct, resIgnoreFlat, resIgnorePct, dodgePhys, dodgeArts, healingDealtMul, healingTakenMul, spRecoveryFlat, spRecoveryMul, maxTargets (+n), shield (absorbs damage; consumed)`.
- `flags`: `stun, freeze, sleep, silence (no skills), disarm (no attacks), stealth (untargetable by enemies/ops unless blocked or revealed), invulnerable, unblockable, levitate, fear (enemy: cannot attack), taunt (+aggro), cold`.
- **Status catalogue** (`buffs.js`, keys used by content): `stun`, `freeze` (stun + res −15), `cold` (aspd −30; a second cold while cold ⇒ freeze 3 s unless immune), `sleep` (stun; ends on damage? no: in AK sleep = untargetable & unable to act; keep AK: untargetable & inactive), `slow` (moveMul), `bind` (moveMul 0), `fragile` (dmgTakenMul), `artsFragile` (artsTakenMul), `silence`, `fear`, `burnGauge`/`necrosis`/`neural` element gauges (see damage), `stealth`, `reveal`.
- Immunities from enemy data (`stunImmune`, `silenceImmune`, `sleepImmune`, `frozenImmune`, `levitateImmune`) are honoured by `applyStatus`.

### 5.4 Hook bus (the only way content plugs in)

`battle.on(name, handler, { priority, owner })`; handlers run in descending priority, then registration order. Handlers receive a mutable `ctx`. Events:

| name | ctx | notes |
|---|---|---|
| `battleStart` | `{}` | after initial deployment |
| `deploy` | `{ unit, initial }` | ops/tokens/enemies spawn |
| `tick` | `{ dt }` | every tick after movement & attacks |
| `beforeAttack` | `{ attacker, targets }` | may modify `targets` |
| `attack` | `{ attacker, targets, isSkill }` | an attack was performed |
| `hit` | `{ source, target, dmg }` | before mitigation; mutate `dmg` (DamageInfo) |
| `damaged` | `{ source, target, amount, type, dmg }` | after application |
| `heal` | `{ source, target, amount }` | before application (mutable amount) |
| `kill` | `{ killer, victim }` | victim hp reached 0 |
| `death` | `{ unit }` | unit removed (ops may redeploy later) |
| `skillStart` / `skillEnd` | `{ unit, skill }` | |
| `ammoUsed` | `{ unit, left }` | per ammo consumed |
| `spGain` | `{ unit, amount }` | mutable |
| `statusApplied` | `{ source, target, status, duration }` | after immunity check |
| `blocked` | `{ blocker, enemy }` | enemy became blocked |
| `enemySpawn` / `enemyLeak` | `{ enemy }` | |
| `battleEnd` | `{ result }` | may add layer gains / coins |

DamageInfo: `{ amount (pre-mitigation), type: 'phys'|'arts'|'true'|'element', element?: 'burn'|'necrosis'|'neural'|'apoptosis', atkScale, defIgnoreFlat, defIgnorePct, resIgnoreFlat, resIgnorePct, mul (multiplier), canDodge, isSkill, isSplash, tags[] }`.

Engine helpers (content must use these, never touch internals): `battle.dealDamage(source, target, dmgInfo)`, `battle.heal(source, target, amount, {overheal=false})`, `battle.applyStatus(target, key, { duration, source, value })`, `battle.addBuff(unit, buff)`, `battle.removeBuff(unit, key)`, `battle.spawnToken(ownerUnit|playerId, tokenId, row, col, opts)`, `battle.spawnEnemy(enemyKey, { routeIndex, pos, mods, tag })`, `battle.addProjectile({ from, to|target, speed, onHit, visual })`, `battle.unitsInGrid(unit, grid)`, `battle.enemiesInRadius(x, y, r)`, `battle.alliesInRadius(x, y, r, ownerId?)`, `battle.addLayers(playerId, bondId, n, reason)` (no-op when gains disabled; records into result), `battle.addCoins(playerId, n)`, `battle.fx(kind, params)` (client VFX event), `battle.rng()` (never `Math.random`), `battle.getPlayer(playerId)` (bonds/band/effects view), `battle.redeploy(unit)`, `battle.after(seconds, fn)` (scheduled callbacks), `battle.every(seconds, fn)`.

### 5.5 Combat rules (engine)

- **Initial deployment** at t=0, free, order top→bottom then left→right (right-side boss player: right→left). Deploy effects fire (`deploy` with `initial: true`). Then `battleStart`.
- **DP**: per player, start 10, +1/s, cap 99; used only for auto-redeploy (dead op: after `respawnTime`, if its tile is free and DP ≥ cost ⇒ redeploy with full HP, SP = initSp). A knocked-out operator stays **down** on its tile from the knock-out until it redeploys (b.snap `down`, §18.3: counting / waiting for DP / its tile taken); summons, devices and enemies leave at once.
- **Blocking**: a ground op with free capacity blocks a ground, non-unblockable enemy whose position enters its tile (|dx|,|dy| ≤ 0.5). Enemy uses `blockCnt` capacity (default 1). Blocked enemies stop moving and attack their blocker if melee (or anyone in range if ranged, blocker first). Blocker death frees its enemies.
- **Operator attacks**: every `interval` s if a valid target exists; targets = up to `maxTargets` (default 1) from `unitsInGrid(rangeGrid)`, priority: (1) units it blocks (melee), (2) profession/trait priorities (e.g. fly-first snipers, `trait` text parsed by build-data into `targetPriority`), (3) enemy with the **least remaining path distance** to its goal, ties → earliest spawned. Melee (no ranged trait) cannot hit FLY enemies. Stealthed enemies can't be targeted unless blocked or revealed. Ranged ops fire projectiles (speed ~12 tiles/s, instant for melee/arts-beam classes as data indicates); damage applies on impact.
- **Healers** (`dmgType heal`): target the ally in range with the lowest HP% below 100%; do nothing otherwise (SP still regenerates).
- **Enemy AI**: follow the route (checkpoints; WALK paths recomputed on the grid when devices change); when blocked stop & fight; ranged enemies (`rangeRadius > 0`) attack ops within radius: priority blocker → highest taunt → **latest deployed**; they pause movement for `ATTACK_PAUSE = 0.35 s` per attack. FLY enemies ignore blocking and ground obstacles, follow their checkpoint route.
- **Damage**: phys `max(A − max(0, D×(1−defIgnorePct) − defIgnoreFlat), 0.05·A)`; arts `max(A × (1 − R'/100), 0.05·A)` with `R' = max(0, R×(1−resIgnorePct) − resIgnoreFlat)`; true = A. Then × `dmgDealtMul` (source) × `dmgTakenMul` & type-specific taken multipliers (target) × `dmg.mul`; shields absorb; dodge checks for phys/arts. Element damage fills a gauge (1000; enemy leaders 2000) × `elemTakenMul` × (1 − 损伤抵抗/100), 损伤抵抗 = data `epResistance` (PRTS 元素). A full gauge bursts with the side-specific official effects (sim/constants.js `ELEMENT`; operators: 灼燃 1200 arts + RES −20, 神经 stun 10 s then 1000 true, 凋亡 15 s of 阻回 (`noSp`: no SP gain of any kind) + 静默 with −1 SP/s and 100 arts/s, 侵蚀 DEF −100 then 800 phys; enemies: the "·我方" terms). Every burst starts a **爆发冷却** = its duration (灼燃 / 神经 / 侵蚀 10 s — enemies' 侵蚀 8 s — 凋亡 15 s) during which NO element of the unit fills or can be recovered; when it ends every gauge of the unit resets (§18.3).
- **Leak**: an enemy reaching its goal is removed, counted as leaked for its field owner (`sourcePlayerId` for unite). LP accounting is done by the match, not the battle.
- **End**: all spawns done and no enemies alive ⇒ `cleared`; `time ≥ timeLimit` ⇒ `timeout` (remaining enemies = leaked). Boss battles end when the shared boss pool reaches 0 (victory) or the match forces an end (team LP 0).

### 5.6 Skills (skills.js + kits)

SP: `spType` `INCREASE_WITH_TIME` (+`spRecovery`/s), `INCREASE_WHEN_ATTACK` (+1 per attack), `INCREASE_WHEN_TAKEN_DAMAGE` (+1 per hit taken); starts at `initSp`; no SP gain while a duration skill is active. `maxChargeTime > 1` ⇒ charges.

Auto-trigger rules (`skillTrigger.rule` in data): `DEFAULT` (SP ready AND about to attack/heal AND an enemy/injured ally inside the **initial** range), `TAKE_DAMAGE` (on taking damage), `SP_FULL` (immediately), `CUSTOM_RANGE` (enemy inside the custom grid), `SEARCH` (an enemy inside the initial range, checked every tick — no attack needed), special ids. PASSIVE skills are always on.

**SkillSpec** (authored per chess in `sim/content/kits/tierN.js`; values come from the chess's skill blackboard at its level — normal Lv4, elite Lv7 — so a spec is a *function of the blackboard*):
```js
// kits map: baseChessId -> (bb, chess) => Kit
export default {
  chess_char_1_01: (bb, chess) => ({
    skill: {
      kind: 'duration' | 'ammo' | 'instant' | 'charges' | 'passive' | 'toggle',
      duration: bb.duration,            // duration kind
      ammo: bb['attack@trigger_time'],  // ammo kind
      mods: { atkPct: bb.atk, batPct: bb.base_attack_time },    // applied while active
      targeting: { maxTargets, rangeGrid, priority: 'fly'|'ranged'|'lowestHp'|'highestHp'|... },
      attack: { dmgType, atkScale, splashRadius, hits, projectile: 'arrow'|'bolt'|'none'|'beam', onHit(ctx) },
      onStart(ctx) {}, onEnd(ctx) {},    // bursts, summons, heals, statuses (use engine helpers only)
    },
    talents: [ { install(battle, unit) {} } ],   // passive/conditional talents via hooks
    trait: { ... }                              // optional overrides of profession trait behaviour
  }),
}
```
The kit loader passes `bb` = flattened blackboard `{ key: value }` of the chess's skill (normal or elite), and `chess` = data record (for talents' blackboards). Missing kit ⇒ a **generic kit** derived from blackboard keys (atk/attack_speed/def/max_hp/base_attack_time/atk_scale/max_target/duration/ammo) so every chess always works.

Profession traits (default behaviours implemented once in the engine, keyed by `subProfessionId`): e.g. `fastshot` (fly priority), `aoesniper`/`splashcaster` (splash 1.1 tiles), `chain` caster (bounce ×3, −15%), `funnel`, `blastcaster`, `physician` (single heal), `ringhealer` (aoe heal), `bard` (aura heal, no attack), `slower` (slow on hit), `loopshooter` (回环射手: a boomerang out to the target and back, attacks again only once it is caught — §17.4), `underminer`, `instructor`, `lord` (ranged attack ×0.8 when not melee), `centurion`/`fighter`/`musha`/`swordmaster`/`reaper` etc., `protector`/`guardian`/`fortress`/`duelist`, `pioneer`/`charger`/`tactician`/`bearer`/`agent`, `executor`, `merchant`, `hookmaster`, `pusher`, `stalker`, `geek`, `dollkeeper`, `traper`, `craftsman`, `summoner` … (build-data provides the list of subprofessions present in the pool; the sim-core owner implements all present ones with simplified faithful behaviour).

---

## 6. Match & meta (server/match)

### 6.1 State machine (Match.js)

```
LOBBY(room) → INFO_CHECK (co-op 25 s; solo and any single-human match untimed (§18.2); all ready ⇒ skip; the operator loadout (§16) locks when it ends) → BAND_DRAFT (co-op: random order, ONE countdown — `BAND_TURN_SECONDS` 30 s per turn = m.public.deadline, AI seats pick at once, 1 skip each, a strategy a teammate already took is refused (队友已选), timeout ⇒ the strategy the player highlights (`g.bandFocus`) while free, else band_bldsk, else the first free one; solo: free pick, no timer, no skip; a single human: untimed) → BATTLE_CHECK (3 s)
→ loop r = 1..lastRound:
     ROUND_START   (income, upgrade price −1 (floor 0), temp NOT wiped — what overflowed after the last prep's deadline is shown in this
                    prep (§6.2 temp overflow), unfrozen shop slots rerolled, frozen kept, <进入休整期时> effects)
     [SP_DRAFT]    (if r ∈ spRounds: 机变 draft; co-op 30 s first picker / 16 s others; solo 3 cards; solo / single human untimed;
                    a card is picked with two taps, §18.2)
     PREP          (co-op: timer from config, ends when all alive humans+bots ready; solo / single human: untimed, ends on ready)
     PREP_END      (<休整期结束时> effects; unfrozen shop cleared; temp overflow: Ready is blocked while temp is non-empty; at the deadline
                    the temp pieces due at this prep are resolved (chess sold back, items / summon stacks destroyed) — pieces that arrived
                    after Ready or during the <休整期结束时> effects wait for the next prep (§6.2 tempDue))
     COMBAT        (one Battle per alive player, all in parallel, 2×; watchers get snapshots; solo: pausable, §14 Solo pause)
     UNITE         (co-op only, if ≥1 leaked & ≥1 perfect: ≤2 perfect helpers in `unite.js helperOrder` order (research 08 §5 / PRTS 帮助:
                    most units on the field > an active bond > most standing units > seat; the pair ordered by units > active bond >
                    Σ active layers > standing > seat, the first one on the right-hand field) fight the union of leaks; no layer gains)
     SETTLE        (LP −min(leaks,10) per player (unite survivors to their source); eliminations; layer gains applied; coins; broadcast)
   R14 FINAL_ASSAULT (merged team LP; pairs by seat; shared boss pool; 120 real s countdown, no hard stop; overtime −1 team LP per
                    real s after 150 real s (§4, m.public.overtimeAt); no layer gains)
   R15 HIDDEN_CORE  (if difficulty ≥ NORMAL and Σ activated layers > 350 solo / 1200 co-op and team LP > 1)
→ RESULT (per-player stats, titles, rounds passed, victory/defeat)
```
Solo FUNNY has 9 rounds (boss at R9); everything is read from `data/config.json → modes[modeId]`.

### 6.2 Player state (PlayerState.js) — authoritative per player

```js
{ playerId, seat, name, isBot, connected,
  alive, lp, bandId,
  funds, shop: { level, upgradePrice, slots: [ Slot ], frozen: bool, freeRefreshes: n, rewardOffer: null | { slots:[Slot], tier } },
  hand: [ Piece|null ×10 ], temp: [ Piece|null ×5 ],
  board: Map<'r,c', Piece>,                          // chess & token pieces on the normal field
  bonds: { [bondId]: { count, active, tier, layers } },  // layers persist all match
  effects: [ EffectRef ],                             // band/choice/team/garrison persistent effects & counters
  counters: { refreshes, buys, sells, … },
  stats: { … for results } }
Slot  = { kind:'chess'|'item', id, price, sold:false, frozen }
Piece = { uid, kind:'chess'|'item'|'token', id /* chessId (golden id if elite) | itemId | tokenId */,
          items:[itemPiece...] (chess only, max 2), count (token stacks), ownerUid (tokens), boughtRound, meta:{} }
```

Intent handlers (validate → mutate → recompute bonds → push private view): `buy(slot)`, `refresh()`, `freeze()`, `levelUp()`, `sell(uid)`, `move(uid, to)`, `equip(itemUid, targetUid, replaceUid?)`, `useArt(itemUid, row, col)`, `destroy(uid)`, `pickReward(idx)`, `pickChoice(idx)`, `setReady(bool)`. Every handler rejects when the phase forbids it (only PREP allows board/shop mutations; SP_DRAFT allows `pickChoice` only; reward pick allowed in PREP). Invalid intents return `error` with a code from `shared/constants.js → ERR` — the server never throws on bad input.

Equipment (research 04 §2 + addendum, 09 §1.2): 2 slots per chess; a third item on a full carrier replaces the equipped item `replaceUid` names (the replace dialog's pick, official `UseEquipUp.unloadInstId`; absent ⇒ the oldest; a uid not equipped on the target ⇒ `BAD_TARGET`, nothing changes) and the replaced item is destroyed. Equipped items are otherwise **locked**: `destroy` (销毁) accepts hand / temp items only (`BAD_TARGET 'equipped items are locked'`); equipment goes back to the hand only when its carrier merges or is sold (a sale is refused with `HAND_FULL` when there is no room for it).

Economy/shop/pool/merge/hand rules: exactly as research 00-INDEX §3–§4 (income `min(3+r,12)`; prices by tier; refresh 1; freeze toggles all; sell +1; items not sellable; upgrade prices per mode with −1/round; shared pool copies 12/14/18/16/8/5 (缪尔赛思 4) across all players; elite = 3 copies; odds = copy-weighted draw over unbanned visible chess with tier ≤ level; merge 3 (风丸 2) → elite to hand + reward offer of 3 free chess of tier `min(level+1, 6)`; purchase completing a merge allowed with full hand; full hand blocks buy; overflow to temp; temp blocks ready).

**Temp overflow (临时整备区, row 8; user playtest #3 item 3).** Passive gains that find the hand full (merge elites, grants, battle-result rewards, equipment returned by a merged / sold carrier) overflow into the 5 temp slots, and Ready is refused while any is occupied (official "直到溢出情况排除才可开始进行作战"). A temp piece is resolved — a chess sold back to the pool with its summons removed, items / summon stacks destroyed — only at the deadline of the **first prep in which its player could act on it** (`PlayerState.tempDue(piece)` vs `prepsEnded`; every write into a temp slot goes through `_putTemp`, which records it): a piece that arrived during a prep before Ready is due at that prep's end; one that arrived after Ready or during the `<休整期结束时>` effects, or outside PREP (COMBAT, 联防, SETTLE — battle-result grants, a SETTLE merge's elite, returned equipment —, the next ROUND_START, 机变) is kept, visible and usable (move to a free hand slot, place, equip, use, destroy, sell) through the **next** prep. Un-readying (`setReady(false)`) makes whatever arrived while ready due at the current prep. ROUND_START no longer wipes temp (it used to destroy what SETTLE had put there before the player ever saw it). A merge's elite always goes to the hand, overflowing into temp (also outside PREP); it takes a freed board tile of a consumed copy only when the hand and temp are both full. `server/match/audit.js` (`tools/matchrun.mjs --check`) tracks the arrivals itself and flags any temp piece that outlives its due prep. The UI frames the row on the board with the rule (§17.5).

### 6.3 Bonds & layers (bondsMeta.js)

- `count` = number of **distinct base chess** on the board carrying the bond (`BOARD`); `BOARD_AND_DECK` bonds also count the hand; 绝技 counts elites on board; 调和 adds +1 to each core bond count, etc. (research 02).
- `tier` from thresholds; `active = tier ≥ 1`.
- `layers[bondId]` persist all match; gains come from garrisons/bands/items/choices/bond effects; IN_BATTLE gains are collected from `BattleResult.layerGains` at SETTLE (disabled in unite/boss/hidden).
- Σ activated layers (hidden-core check) = Σ layers over bonds that are active at the moment of the check (end of R14 prep, per research).

### 6.4 Prep-phase effect dispatcher (effectsMeta.js)

A registry mapping **effect keys** → handler objects `{ onRoundStart, onPrepEnd, onGain(piece), onSold(piece), onRefresh, onPrice(slot), onBuy, onMerge, onLevelUp, onBattleResult }`. Sources: garrison `SERVER_*` keys (per chess on board or hand as the key requires), band effects, item meta effects, bond meta effects (助力, 远见, 奇迹, 投资人…), choice/team cards. Content owners register handlers; the dispatcher owns ordering and the 投资人 "获得时 ×2/×3" multiplier.

### 6.5 Waves (waves.js)

Per match: pick stage (weighted among the mode's `config.modes[m].stages`, weight 50 each: 标准 FUNNY = 战场#01 `act1autochess_m01` only, 险境 NORMAL = 8 stages, 绝境 / 终极 = 7 without 战场#01 — `waves.js setupMatchWaves`, `test/match/stagepick.test.js`), 3 of 6 typed enemy factions, disabled bond set (3 core + 4 add-on for NORMAL+, per research), boss (weighted), hidden boss. Per round: wave template (by mode & round) → replace placeholders per research 05 §3.2 algorithm → apply stat multipliers (research 00-INDEX §5 `atk ×base×1.1^k`, `hp ×base×1.2^k`, ABYSS speed ×1.15 from R3) → `SpawnSpec[]` + routes resolved on the stage. *(Superseded by the official generator — §14 "Corrections from research 08/09" and the waves.js header.)* A player's normal battle (and the bot rehearsal) runs `withBounties(gd, round, wave, bounties, playerId)`: the bounty units inserted among their host action's own units, which are re-timed around them (client order); `previewOf` keeps one entry per action (`wave.spawns` + `bountySpawns`).

### 6.6 AI players (bot.js)

Deterministic-ish heuristic player used for (a) AI teammates, (b) auto-play for disconnected humans (only auto-ready + auto-picks, not shopping, unless "AI 托管" is toggled), (c) tests. Strategy: pick a band; each prep: level up on schedule, buy chess that raise bond counts or complete merges, sell leftovers, place melee on road tiles nearest the enemy path, ranged on highland/others, equip items to highest-tier ops, ready. A bot's whole prep — shop decisions and layout planning (`botPrepBeginSteps`, 25–70 ms late in a 4-bot match), the layout rehearsal and `botPrepEndSteps` — runs in wall-clock slices of `botSliceMs` (8 ms) per scheduler callback on a real host (step generators that yield between whole actions, never with a transient board; the same actions in the same order, so decisions are unchanged; at once in virtual time).

---

## 7. Content modules (server/sim/content + match/effectsMeta handlers)

Each domain file `server/sim/content/{tokens,bonds,garrisons,items,bands,enemies,bosses,devices,choices}.js` exports `install(battle)` (battle side; called once per Battle by `content/index.js → installContent`) and `registerMeta(registry)` (prep side; called once at server boot by `match/effectsMeta.js`, API documented in `docs/META.md`). Kits live in `content/kits/tier1..6.js` (`export default { [baseChessId]: (bb, chess) => Kit }`). Content must be **data-driven from blackboards** (numbers never hard-coded when a blackboard key exists). Every effect gets at least one unit test in `test/content/*.test.js` using the `test/helpers/battleHarness.js` harness (provided by sim-core).

- kits: all 112 visible chess + hidden ones used by effects (盟约·辅助干员), default skill + talents + trait specifics; tokens.
- bonds: 23 (battle + meta), exact per-layer formulas from research 02.
- garrisons: 43 effect keys (IN_BATTLE via hooks; SERVER_* via meta registry).
- items: 56 equipment (+golden) + 3 Arts; 变形同构体 bond grant; VI-tier set/combos.
- bands: 40 strategies (meta + battle).
- enemies: special-type behaviours (FLY, TIMES, ELEMENT, DOT, INVISIBLE, REFLECTION, SPECIAL) and notable individual abilities from `data/enemies.json`; bosses 1–10 scripted; devices/terrain.
- choices: 机变 families (悬赏决策 bounties, 道具补给, 机密商店, 战术决策 team/personal buffs).

---

## 8. Network protocol (shared/protocol.js is normative)

Transport: one WebSocket per tab at `/ws`, JSON text frames `{ t: '<type>', ...payload }`. Client requests may carry `rid` (request id); the server's direct reply echoes `rid` (`ok` or `error`). Server pushes have no `rid`. Max frame 64 KB inbound; rate limit 40 msgs/s per connection (excess dropped with `error RATE`).

### 8.1 Session & lobby
C→S: `hello {name, token?, version}` · `room.create {mode:'solo'|'coop', difficulty}` · `room.join {code}` · `room.leave` · `room.ready {ready}` · `room.setDifficulty {difficulty}` (host) · `room.addBot` / `room.removeBot {seat}` (host) · `room.start` (host) · `room.loadout {entries}` (§16: any time in the lobby / room and during INFO_CHECK, then `WRONG_PHASE`; heavy rate-limit bucket; the match exposes it as `m.private.loadout`) · `ping {c}`
S→C: `welcome {playerId, token, name, serverNow}` · `room.state {code, hostId, mode, difficulty, seats:[{seat, playerId, name, isBot, ready, connected}|null ×4]}` · `room.closed {reason}` · `pong {c, s}` · `error {rid?, code, msg}` · `ok {rid}`

Platform additions (implemented): `welcome.{resumed, version}`, `room.state.inMatch`, `error.detail`; `room.closed.reason ∈ 'timeout'|'shutdown'`; WebSocket close codes 4001 (session taken over by another socket — client must not auto-reconnect), 4002 (no hello in time), 1008 (flooding), 1001 (shutdown). The host's `room.start` counts as the host being ready. After any (re)`hello` the server pushes `room.state` and, if a match runs, the match resends `m.public`/`m.private` (+`m.field`, or the field's `b.start` under client-side combat). **Reconnect window:** a dropped session stays resumable for 10 min (`net.js NET_DEFAULTS.reconnectWindowMs`; co-op seats keep playing their last lineup meanwhile, §6.6); a session that drops while its **solo** room's match runs stays resumable for the official `config.constants.singleReconnectTime` (86 400 s = 24 h; lobby option `soloReconnectWindowMs`; research 01 §1 "24小时内随时返回") — the untimed solo run simply waits. Only when the window expires does the drop become `match.onLeave` (co-op: 中途退出 = elimination; solo: the run ends `'abandoned'`). The client keeps its token in sessionStorage plus a recent-token list in localStorage, so reopening the tab resumes. Everything lives in server memory: a server restart ends every room and run. The lobby⇄match interface (constructor opts, `start/handle/onDisconnect/onReconnect/onLeave/dispose`) is documented verbatim at the top of `server/match/Match.js` and is normative. `server/data.js` provides `getData()` + index getters (`getChess`, `getBond`, `getGarrison`, `getItem`, `getBand`, `getEffect`, `getEnemy`, `getWave`, `getStage`, `getBoss`, `getToken`, `getConfig`, `getMode`). Note: the skill trigger rule lives at `chess.skill.trigger.rule` in data.

### 8.2 Match
C→S (all carry `rid`): `g.infoReady` · `g.band {bandId}` · `g.bandSkip` · `g.bandFocus {bandId?}` (the strategy highlighted in the draft screen — what a timed-out turn takes; absent / null clears it; `WRONG_PHASE` outside BAND_DRAFT, `ALREADY` after the pick, `BAD_TARGET` for a band not allowed; §18.2) · `g.buy {slot}` · `g.refresh` · `g.freeze` · `g.levelUp` · `g.sell {uid}` · `g.move {uid, to:{area:'board', row, col}|{area:'hand', idx}, dir?}` · `g.equip {itemUid, targetUid, replaceUid?}` (`replaceUid`: which equipped item a third one replaces, §6.2) · `g.art {itemUid, row, col, dir?}` (`dir` ∈ UP|RIGHT|DOWN|LEFT from the deploy wheel, §3; absent ⇒ `to.dir`, then RIGHT; `g.move` onto the piece's own tile re-orients it; board pieces in `m.private` / `m.field {prep:true}` carry `dir`) · `g.destroy {uid}` (hand / temp items only; equipped items are locked, §6.2) · `g.reward {idx}` · `g.choice {idx}` · `g.ready {ready}` · `g.emote {id}` · `g.watch {fieldId}` · `g.autoplay {on}` · `g.pause {on}` (solo battles only, §14 Solo pause) · `g.unitStats {seq?}` (ROUND_START / SP_DRAFT / PREP, else `WRONG_PHASE`; eliminated: `ELIMINATED`) → push `m.unitStats` (§18.5) · `g.leave`
S→C:
- `m.public` — full public state on every change (throttled ≤ 10/s): `{ phase, round, lastRound, deadline, serverNow, modeId, difficulty, stageId, factions, disabledBonds, bannedChess, bossId, hiddenBossId?, teamLp?, bossHp?:{hp,max}, overtimeAt? /* FA / HC: ms epoch the overtime drain starts, §4 */, paused /* solo pause, §14 */, draft?:{order,turn,picks,skipsLeft,turnDeadline,turnSeconds /* one turn's length, 0 untimed; deadline = turnDeadline (§18.2) */,untimed}, sp?:{family,cards,turn,picks}, players:[{playerId, seat, name, isBot, connected, alive, lp, bandId, shopLevel, boardCount, ready, bonds:[{bondId,count,active,tier,layers}], fieldId, status, pendingLp? /* COMBAT / 联防 of a normal round: the LP the player's own battle will cost at settlement so far, min(lpCapPerRound, counted leaks) — omitted when 0 and in every other phase (§17.5 live LP) */}] , fields:[{fieldId, kind, players:[playerId...]}] }`
- `m.private` — the recipient's full PlayerState view (§6.2 minus server-only data) on every change.
- `m.field` — field meta when watching starts: `{ fieldId, kind, rect, stageId, units: [UnitInfo] }` (the units on the field, knocked-out operators waiting to redeploy included — `Battle.fieldMeta`, §18.3)
- NOTE: game time in `b.snap`/`b.ev` is carried as **`gt`** (the frame's `t` is the message type).
- `b.snap` — `{ fieldId, gt, units: [[id, x, y, hp, maxHp, sp, spMax, flags, anim]] , dp, killed, total, down?, elem? }` 20 Hz. Optional, only when non-empty (§18.3): `down: [[id, respawnAt (game s), respawnTime (s), state]]` — knocked-out operators waiting to redeploy, `state` 0 counting | 1 timer done, waiting for DP | 2 timer done, its tile taken (sim/constants.js `DOWN_STATE`); `elem: [[id, element, fill 0..1, cooldownEnd (game s), cooldown (s)]]` — the one gauge a unit shows: the fullest (ties by the official element id 神经 < 侵蚀 < 灼燃 < 凋亡), during a 爆发冷却 the bursting element with fill 1 and the cooldown numbers (else 0, 0)
- `b.ev` — `{ fieldId, ev: [ ... ] }` event tuples: `['spawn', UnitInfo]`, `['atk', srcId, tgtId, projKind]`, `['dmg', tgtId, amount, type]`, `['heal', tgtId, amount]`, `['skill', id, on:0|1]`, `['die', id, reason]` (reason `'killed'`, `'retreat'`, `'expired'` …; only `'killed'` plays an operator's knock-down sound), `['status', id, key, on]`, `['fx', kind, x, y, extra]`, `['layer', playerId, bondId, n]`, `['bounty', playerId, coins]`, `['deploy', id]`
- `m.toast {kind, text}` · `m.ticker {text}` · `m.emote {playerId, id}` · `m.result {...}`
- `m.unitStats {seq, round, units: [unitStatsEntry]}` — the answer to `g.unitStats` (`seq` echoed): every own board operator / summon by uid with `{id, uid, defId, hp, alive, maxHp, atk, def, res, interval, blockCnt, moveSpeed, base: {…same}}` (shared/protocol.js `unitStatsEntry`) as its next battle starts (§18.5)

`UnitInfo = { id, kind, side, ownerId, defId, name, tier, golden, spine, avatar, x, y, facing, dir, maxHp, skillIndex?, moduleId? }` (`dir` = the ally's deploy direction; the renderer picks the model (Back for UP, mirrored for LEFT) and the ground wedge from it; `skillIndex` = the ally's equipped skill (§16): the renderer plays that skill's Spine clip (`anims.skills[i]`) and the audio its own ON_SKILL_START sound; `moduleId` = an elite ally's equipped module (uniEquipId | 'none'); both also on the prep-scouting `m.field` units (`Match.prepFieldMeta`), so a teammate's unit shows its owner's loadout in the detail card).

### 8.3 Exact view shapes (normative for match ⇄ UI)

`m.private`:
```js
{ playerId, seat, alive, lp, funds, bandId, ready, canReady /* false while temp non-empty */,
  shop: { level, maxLevel: 6, upgradePrice, refreshPrice /* effective (0 when a free refresh is available) */, freeRefreshes,
          frozen, slots: [ { kind: 'chess'|'item', id, price, basePrice, sold } | null ],
          rewardOffer: null | { tier, slots: [ { kind: 'chess', id, price: 0, sold } ] } },
  hand:  [ Piece | null ],   // length 10, index = hand slot
  temp:  [ Piece | null ],   // length 5
  board: [ Piece & { row, col, dir } ],   // dir ∈ UP|RIGHT|DOWN|LEFT (§3; bench pieces carry none)
  deployCap, deployCount,
  bonds: [ { bondId, count, active, tier, layers, thresholds, countsHand } ],   // sorted: active first, then layers desc
  effects: [ { id, name, desc, iconKind: 'band'|'choice'|'team'|'item'|'garrison', iconId, counter? } ],
  nextEnemies: [ { enemyKey, count, tag } ],   // preview of the upcoming round's wave (after waves.js generation)
  stats: { dmgDealt, kills, leaks, gold, refreshes, merges } }
Piece = { uid, kind: 'chess'|'item'|'token', id, golden: bool, tier, items: [ { uid, id } ] /* chess only */, count /* token stacks */, ownerUid /* token */ }
```
`m.public.players[].status` ∈ `'acting' | 'ready' | 'deciding' | 'combat' | 'done' | 'helping' | 'left' | 'dead'`.
`m.public.fields[]`: `{ fieldId, kind: 'normal'|'unite'|'boss'|'hidden', players: [playerId…], live: bool }` — `fieldId` is `'n:<playerId>'` for normal fields, `'u'` for the unite field, `'b1'`/`'b2'` for boss fields. Clients `g.watch` a fieldId; default = own field (or the unite/boss field they are in).
`flags` bitmask: 1 blocked, 2 stunned, 4 frozen, 8 stealth, 16 skillActive, 32 shielded, 64 invulnerable, 128 cold, 256 sleep, 512 flying.
`anim` small int: 0 idle, 1 move, 2 attack, 3 skill, 4 die, 5 stun, 6 deploy.

---

## 9. Client rendering contract (public/js/render)

`import { createFieldView } from './render/app.js'`

```js
const view = await createFieldView(canvasHost /* HTMLElement */, { data, assets, audio })
view.setStage(stage)                         // draw tiles (procedural), devices
view.setCamera(kind /* 'prep'|'normal'|'unite'|'boss' */, { rect, side })  // animates camera
view.setPrep(privateState, { editable })     // render hand/temp/board pieces as chibis (spine or fallback); editable enables drag
view.enterBattle(fieldMeta)                  // switch to battle rendering for m.field
view.pushSnapshot(snap) ; view.pushEvents(ev)   // interpolated rendering (100 ms buffer)
view.highlightTiles(tiles, style)            // legal/illegal placement, range preview
view.on('pieceDragStart'|'pieceDrop'|'pieceDragEnd'|'pieceClick'|'pieceHover'|'tileHover', fn)
   // pieceDrop: { uid, target: {area:'board',row,col}|{area:'hand',idx}|{area:'outside', clientX, clientY} }
   // area 'outside' lets the DOM UI decide: released off the grid or over DOM covering the canvas (the shop bar), mouse
   //   and touch alike — there is no drag-to-sell, the piece goes back
   // the drop target, its highlight and tileHover while dragging = the tile under the POINTER; an item dropped on a
   //   tile equips the unit standing on it (§18.1)
view.pieceScreenRect(uid)                    // the drawn body's rect { left, top, right, bottom, width, height, x, y } (tooltips / overlays)
view.tileScreen(row, col)                    // { x, y, s, poly } client px of a tile top (direction wheel geometry)
view.holdPiece(uid, {row,col}|null)          // keep a dropped piece on a tile while its direction is chosen
view.setPieceDir(uid, dir)                   // show a prep piece facing UP|RIGHT|DOWN|LEFT (wheel preview / stored dir)
view.resize() ; view.destroy()
```
Visuals: oblique perspective board (tilted ~30°, trapezoid tiles), raised highland blocks with side faces, road/floor/forbidden styles per research 07 §7, pulsing red gates, blue objective, dashed hand pads. Units: Spine (Front/Back rule, feet anchored, shadow sprite), elite gold outline glow, tier chip, HP bar (green ally / red enemy), SP bar (skill ready glow), status icons, the element icon right of the bars (§18.3); damage numbers (phys orange-white, arts purple, true white, heal green); projectiles drawn per kind, hit sparks and melee slashes, skill activation bursts and auras (§17.3); death fade for enemies, summons and devices — a knocked-out operator stays on its tile in its held Die pose under a redeploy ring (§18.3); leak flash at the objective. Fallback when Spine missing/failed: avatar in a rarity-coloured diamond with bob/lunge tweens. 60 fps target with ≤ 120 units. Picking (which unit a press / hover / dropped item is on) and the drag target follow one rule, `render/pick.js` — the tile under the pointer (§18.1); the Spine store never hands out a skeleton whose unload is in flight (§17.1).

---

## 10. Client UI (screens & components)

Look & feel: research 06 §11–§12 (near-black green-grey panels, mint `#4ed8af` accents, gold prices, bracket frames, hexagon badges, bond discs, 7-segment countdown). Fonts: Noto Sans SC (Google Fonts with local fallback), Bender/Novecento self-hosted for numerals and Latin micro-labels.

Screens: **Title** (season art backdrop, 开始 → nickname), **Lobby** (独立模拟 / 同盟模拟 → create or join; recent rooms), **Room** (4 seats, invite code + copy link, difficulty picker (host), add/remove AI, ready, start), **Briefing** (INFO_CHECK: stage, factions, disabled bonds, banned chess, boss silhouette, ready x/4), **Band draft** (grid of 40 bands with icon/name/LP/effect; turn order list; skip), **Game** (Pixi field + DOM HUD: top bar with round/phase capsule/LP (live during the own battle, §17.5)/timer/ready; bond strip + popups; left team panel with LP/status/emote bubbles, click to watch; bottom shop bar (level card, 3–5 chess cards, item card, funds, refresh, freeze, collapse); detail panel on click/hover (header with bonds, then 特质 — the operator's own effect — right under it, 特性, stats (live: the battle's own numbers / the start-of-battle ones in prep, §18.5), skill, module, equipped items, talents: §17.5); enemy preview drawer (next round enemies with counts, factions); 机变 overlay (two taps, §18.2); merge reward overlay; phase banners; ticker; toasts; emote wheel; settings (volume, quality, show damage numbers)), **Result** (victory/defeat, rounds, per-player lineup, stats, titles, back to room).

Interactions (research 09 §1.2 / §5, which supersede the first draft): shop card, upgrade and 机变 card are two-tap (select → confirm, §18.2); a press / drop goes by the tile under the pointer (§18.1); drag bench↔board — a legal board drop (also onto the piece's own tile) opens the 4-direction deploy wheel (swipe UP/RIGHT/DOWN/LEFT with the rotated range striped orange; release in the centre, ✕ 点击取消 or Esc cancels); tap a unit's tile ⇒ underframe with **出售 +N** (and **撤退** on the board; items/Arts in the hand / temp: **销毁** — equipped items are locked, §6.2) plus its rotated range; no drag-to-sell; drag an item onto a unit's tile ⇒ equip that unit (both slots used ⇒ the replace dialog `ui/equipReplace.js` shows the incoming and the two equipped items; the player picks the one to replace — it is destroyed — `g.equip replaceUid`; cancel changes nothing); Arts are dropped on a tile and get the direction step; right-click or long-press ⇒ detail; `R` refresh, `F` freeze, `D` level-up, `Space` ready (in a solo battle: pause / resume, §14 Solo pause). All actions optimistic-free: UI waits for server state (latency is small).

Audio: autochess BGM per phase, UI SFX (buy/sell/refresh/level/merge/ready/timer), per-unit attack/hit SFX (throttled; an impact plays for a hostile attack's phys / arts / true damage only, never an operator's skill-mode file for a normal attack, ≤ 2 copies of one battle sound — §18.4), boss music in R14/15.

---

## 11. Quality bar & testing

- **No crash paths**: every server handler guarded; a thrown error inside a Battle tick for one field must not kill the match (log, force-end that battle as timeout, continue). Invariants asserted in tests: no NaN/Infinity in any unit field; hp ∈ [0, maxHp]; positions inside rect; battles terminate within `timeLimit + 1 s` (boss: terminate by pool/force); pool copy counts never negative and never exceed caps; funds never negative; hand/temp sizes respected.
- Unit tests per module; content tests per effect; **full-match bot tests**: 1/2/4-player matches of every difficulty with fixed seeds run to RESULT headlessly (fast-forward: no real-time pacing) with zero errors; protocol fuzz (random/invalid intents) never crashes and never corrupts state.
- **Browser E2E** (puppeteer-core + system Chrome): open 2 tabs, create/join room, add AI, play through prep/combat of several rounds, zero console errors, screenshots saved to `test/e2e/out/` for visual review.
- Performance: a normal battle tick with 60 enemies + 10 ops < 0.5 ms; 4 parallel fields at 2× real time < 15% CPU of one core.

---

## 12. Implementation phases

1. **Foundation**: build-data, fetch-assets/vendor, server platform (http/ws/lobby), client shell (screens up to room).
2. **Core**: sim engine + harness; match/meta; render engine; game UI.
3. **Content**: kits, bonds, garrisons, items, bands, enemies/bosses/devices, choices.
4. **Integration & QA**: wire everything, bots, E2E, balance pass, bug-hunt workflows until dry, visual polish.

---

## 13. Local-client art (optional, host-side)

`tools/local-extract/extract.py` (Python: UnityPy + lz4 + Pillow; decodes Arknights' custom **LZ4AK** bundle compression via `aklz4.py`) extracts art that no web source has from a locally installed client (CrossOver Windows build or PlayCover iOS build) into `public/assets/local/**` and writes `data/local-assets.json` (`{ groups: { '<subdir>': { name: { path, w, h, kind } } } }`). Everything here is **optional**: clients must render correctly when the file or any entry is missing (fall back to the web assets / procedural art).
- `map/autochess/TX_autochessi_*` — the real autochess board atlas (`_D` diffuse 2048² with floor tiles, gold-framed high-ground plates, REINFORCEMENTS bench pads, EQUIPMENTS pads, crates, gates; `_N/_M/_E` normal/mask/emission; `common_D` device icons; `BG` backdrop). `map/autochesssand/*` — the sand-theme variant.
- `ui/{common,battle,outer}/*` — every sprite of the three official autochess UI bundles (tier chips I–VI, bond disc rings, frames, banners, HUD pieces, badges, backgrounds, mode art).
- `emoticon/{basic,basic_2}/pic_<id>_battle.png` — the 12 official battle emotes (`shared/constants.js → EMOTES`, `emoteArtPath`).
- `guide/autochess_{home,shop,handbook}_N.png` — the official tutorial pages; stored squashed to 1024² — **display at 16:9**.
- `projectiles/*` — battle projectile sprites.
- `module/<TYPE>` — the official module (uniequip) TYPE icons (white glyphs; keys are the client's mixed-case file names, e.g. `PRI-X`, `mar-x`, `isw-a`), matched **case-insensitively** against a ModuleRecord's `typeName` by `assetUrls.moduleTypeIconUrl(local, typeName)` (Greek type letters map to the file's Latin letter: `ISW-α` → `isw-a`) — shown on the 干员调配 module cards / module info, the detail panel's 模组 row and the shop card's module tag; lettered tiles / type text without them.

---

## 14. Client-side combat (v2 architecture — supersedes the combat-streaming parts of §4, §8.2, §9)

**Why:** like the official client, each player's browser simulates its own battle locally and uploads the result. The server no longer paces battles in real time nor streams `b.snap`/`b.ev` for combat, so a low-power host (e.g. a Windows mini PC) is enough, and combat rendering has no network jitter. Measured (4 human seats, HARD, real sim, in-process): server CPU per combat round ≈ 170–360 ms → ≈ 1 ms; server→client traffic ≈ 2–3.3 MB → ≈ 0.25 MB per round. Browser cost ≈ 0.05–0.1 ms per tick (≈ 3–6 ms per real second at 2×) on the main thread (no worker needed).

**Modes.** `Match` option `clientCombat` (default **on**; env `SP_COMBAT=server` → the legacy server-run + streaming mode, kept as a fallback). `m.public.combatMode` = `'client' | 'server'` tells the UI which one runs.

**Shared deterministic sim.** `server/sim/**` is pure ESM runnable in both Node and browsers. Node-only code (reading `data/*.json` from disk, research fallbacks) lives in `server/sim/nodeData.js`, imported dynamically by `simdata.js` under Node only; the browser injects its own frozen copies of `/data/{chess,enemies,tokens,stages,waves,bonds,items,garrisons,bands,effects}.json` via `setSimData(data)` (`getSimData()` serves them). The HTTP server serves `server/sim/**` read-only at `/sim/` (`.js` only, no listings, `nodeData.js` excluded under any spelling — the on-disk name decides, for case-insensitive hosts) and a generated `/data.js` stand-in of `server/data.js` (the content support module imports `../../../data.js`; in the browser it returns `getSimData()`). A battle is fully described by a JSON **BattleSpec** (`server/sim/spec.js buildBattleSpec`: `{ v, battleId, fieldId, kind, seed, modeId, round, stageId, rect, timeLimit|null, players:[PlayerBattleInput], spawns, routes, flags, enemyOverrides, waveId, bossId, content, boss?: { poolHp, poolMax } }` — the JSON round trip of the Battle options; ±Infinity → ±1e308, spawns at time Infinity dropped) and constructed with `createBattleFromSpec(spec, dataSource, { sharedBoss? })` identically on both sides; **the server builds its own battles from the spec too**, so both run exactly the same input. No wall-clock or `Math.random` inside the sim. Verified: spec-built battles give identical result digests (`resultDigest`) in any construction order; whole client-combat matches are outcome-identical to server-run matches (same seed).

**Authority per field.**
- Normal field: the owning human's client is **authoritative** (if connected).
- Unite field (联防) and boss/hidden pair fields: the lowest-seat **connected human** in that field is authoritative; every other human in (or watching) that field receives the same spec and simulates it locally **for display only**.
- Bots, departed/disconnected players, fields with no connected human: the **server** simulates. Normal and 联防 fields headlessly (`fields.js HeadlessJob`, with a `[gt, killed, total]` progress timeline) in wall-clock slices of `headlessSliceMs` (8 ms) per callback on a real host — never one blocking run per field (3 bot fields ≈ 0.2–0.5 s of CPU at COMBAT start here, seconds on a mini PC); at once in virtual time; the result is released at the battle's natural end on the field clock (so round pacing and the teammates' progress look live). Boss fields in real time without snapshots (`HeadlessPacer`); when no field of a boss round has a connected human the whole round runs server-side as before (FieldRunner with streaming off).
- Takeover: an authority that disconnects or leaves, or misses its deadline (`timeLimit / speed` real s + 15 s grace, normal/联防) loses the field: normal/联防 → the server re-simulates the spec from t = 0 (deterministic: the same result); boss → the partner's replica is promoted (`b.start authoritative: true`), else the server runs it, fast-forwarded to the field clock through a `CreditPool` that only credits damage beyond what the client already reported (the fast-forward is spread over the pacing intervals, ≤ 240 extra ticks each). A boss authority silent for 12 s is handed over the same way. The former authority gets `b.end { reason: 'takeover' }` and keeps displaying.

**Protocol (additions; `shared/protocol.js` is normative).**
- `battleId` = `<prefix>.<round>.<seq>.<fieldId>` (`Match._ccField`; `<prefix>` = the match seed in base 36 plus `-<matchNo>`, the room's match number the lobby passes as `opts.matchNo`; `<seq>` counts every battle of the match; the informational `.<fieldId>` is dropped when the id would exceed the protocol's 64 chars): unique for the whole match although field ids repeat (`n:<pid>` every round, `u`, `b1`/`b2` in both boss rounds), and across the matches of one room. The client runner keys its local battles by it (the same id again = the same battle, no rebuild) and the server matches reports by it, so a late `b.progress` / `b.result` of a finished battle — or one that crossed into the room's next match on the same socket — is ignored instead of being credited to another battle.
- S→C `b.start { battleId, fieldId, kind, spec, authoritative, startAt, serverNow, elapsed, speed, watch, done }` — sent at COMBAT/UNITE/FINAL_ASSAULT/HIDDEN start to every human in the field (联防: to every human; COMBAT and boss rounds: eliminated humans get the first field as a display replica — research 09 "keep-watching auto-observes the first available field"), on `g.watch`, and on reconnect/resync. `elapsed` = game seconds on the field clock (a finished field: its end time); the client fast-forwards to it. `speed` = game seconds per real second (2; tests/tools may speed up).
- C→S `b.progress { battleId, gt, killed, total, leaks?, bossDmg?, by?, done? }` — authoritative clients, ~1 Hz (boss fields 4 Hz). Normal/联防: `leaks` = counted leaks so far. Boss: `bossDmg` = cumulative damage of this field to the shared pool, `by` = the same per player, `leaks` = the field's cumulative LP cost (leaks × `lpr` + leader "扣除目标生命" effects; `spec.js attachLpMeter`). The server applies deltas (never twice). Stale reports (unknown battle, not the authority, after the match ended) are ignored, never answered with an error; the platform never answers a rid-less `b.progress` with an error frame (it would surface as a toast).
- C→S `b.result { battleId, result }` — authoritative client at battle end; `result` = `compactResult(BattleResult)` (the fields the match consumes; ≤ 4 players, ≤ 400 leaks, ≤ 64 unitsEnd, ≤ 160 unitStats, ≤ 40 layer gains; `fitResult` keeps the frame ≤ 60 KB: unit statistics, then leak mods, then — boss only — leak entries go first). Structural checks in `isBattleResult`; `server/net.js` routes `b.*` frames to the match (lobby `routeGame`).
- S→C `b.pool { hp, max, teamLp, acked: { [fieldId]: cumulative damage counted } }` (boss rounds, ≤ 4 Hz; exact numbers, never rounded) — clients reconcile their `LocalBossPool`: displayed pool = server hp − (local cumulative damage − acked). A boss field whose client result is `'cleared'` while < 1 HP is left on the server (float dust of summing both fields) empties the pool.
- S→C `b.end { battleId, fieldId, reason }` — `'cleared'` (pool 0) / `'forced'` (team LP 0): the client calls `battle.forceEnd` and reports; `'takeover'`: stop reporting, keep displaying.
- `m.public.fields[]` gains `progress: { killed, total, done }`; `m.public.combatMode`; `m.public.paused: boolean` (always present; solo pause below).
- `b.snap` / `b.ev` are **not sent for combat** in client mode. `g.watch` rules: see Spectating.

**Result validation (server, `fields.js validateClientResult`).** A client result is accepted only if structurally valid and plausible for its spec: every spec player reported and nobody else; finite numbers; `killed ≤ total ≤ 4·spawns + 100`; every leaked `enemyKey` is in the spec's spawns (multiset bound) or a key the spawned enemies' data mentions (content summons/splits, bounded by the total) — boss fields excepted (their leaks cost team LP through `b.progress`); `counted: false` only for enemies that never count (data `notCountInTotal`, schedule `countInTotal: false`, boss/part entries, content spawns); 联防: leaks + `unspawned` per (enemy, leaker) ≤ what that leaker sent in (nobody's survivors are billed to a teammate); per-bond `layerGains ≤ 60 + 4·round`, none when the spec disables gains, bonds must exist and be named by the player's bond snapshot, band, effects, units or items; `coins ≤ Σ bounty coins of the spawns`; `perfect` consistent with the counted leaks; unit states only for the player's own board uids with hpPct ∈ [0, 1]. The accepted result is **rebuilt** from whitelisted fields (leak mods/tags/sources from the spec — a content-spawned enemy (split, summon) keeps the mods of the schedule entry they equal, i.e. its parent's round multipliers and bounty id, so its 联防 re-entry and bounty match the server run; unit names from server data). Otherwise (or on any exception) the server re-simulates (normal/联防); a boss field is **handed over** instead (below). `SP_VERIFY=all|sample|off` (default `off`): `all` re-simulates every accepted normal/联防 result before accepting it (the server result wins on a digest mismatch); `sample` checks ~1 battle in 8 in a later callback and logs mismatches. `Match.verifyStats = { checked, mismatches, rejected, takeovers }`. Desync between display-only clients and the authority is tolerated: the authoritative outcome is what counts and is broadcast at settlement.

**Boss rounds.** The shared pool (`SharedBossPool`, co-op size = `bloodPoint[difficulty]`, see corrections) lives on the server and is fed by the authorities' `b.progress` damage deltas (attributed per player through `by`, BOSS_HIT tickers as before) and by server-run fields; a server clock (250 ms) applies the overtime drain (−`bossOvertimeDrainPerSec` team LP per whole **real** second past `bossOvertimeAfter` real s, measured on the field clock — `gamedata.js bossOvertimeDue`, §4), the silence watchdog and the end checks: pool 0 → `b.end cleared` (victory), team LP 0 → `b.end forced` (defeat); results are awaited ≤ 6 s (× timerScale) after a forced end. `b.pool` is the live channel for the pool and the team LP: a boss `b.progress` (4 Hz per field) and the team-LP losses never re-mark the whole public state — `m.public` (`bossHp`, `teamLp`, `fields[].progress`) and the players' merged-LP shares (`_syncTeamLp`) refresh at ~1 Hz (`Match._bossPublic`, `BOSS_PUBLIC_MS`), and at once when the round ends. A boss field's `b.result` ends it only when the shared pool is empty or after that `b.end`: any other result — `'forced'` / `'timeout'` at t = 0, `'cleared'` while the pool still holds — and any result failing validation would stop the pair's fight (and, with every field done, end the Final Assault as a defeat), so the field is **handed over** (`Match._bossHandover`) to the partner's display replica (promoted with `b.start authoritative: true`) or, without one, to the server (fast-forwarded to the field clock); the sender gets `b.end takeover` and is never that field's authority again (`f.demoted`). There is no synthetic zero result for a running boss field: a stats-only stand-in (`fields.js syntheticResult`, carrying the damage already credited, never charging LP) only fills a result that cannot be had otherwise — the Final Assault already ending (no result, or an invalid one, within the grace) or a server-run battle whose `result()` threw.

**Solo pause (official `PauseUp` / `ResumeUp`; `Match.setPause`).** C→S `g.pause { on }`: solo matches only (co-op → `WRONG_PHASE 'co-op battles never pause'`), and `on: true` only while a battle runs (COMBAT / FINAL_ASSAULT / HIDDEN_CORE with a live field, not once the Final Assault is ending — else `WRONG_PHASE 'no battle running'`); `on: false` is always accepted. While `m.public.paused` is true everything of the battle is frozen: the field clock (`b.start elapsed`, the boss plausibility budgets and the overtime drain), the authority deadline and the server-run release timers, the boss clock, the HUD `deadline` / `overtimeAt` (shifted by the paused time on resume) and the server-run pacers (FieldRunner / HeadlessPacer skip their intervals); the browser's runner stops its local clock. In solo battles the top bar shows a 暂停 / 继续作战 button (`ui/hud.js PauseButton`, `ui/matchStatus.js pauseAvailable`; `Space` toggles it), a paused overlay offers 继续作战 / 放弃模拟, and the HUD clocks freeze at the pause moment. A disconnect or leave resumes (the server takes the field over — nobody is left to resume it); the battle phase ending drops the pause.

**Spectating (research 09 §3.1 / §6.3).** No live spectating while your own normal battle runs (`g.watch` → `WRONG_PHASE 'own battle running'`; the UI toasts "作战中无法查看队友"). After your own battle ends you see "⌛ 作战结束，等待队友完成作战" with each teammate's live progress (`m.public.fields[].progress`); tapping a teammate's avatar expands **前往查看** → `g.watch` → `b.start` (display replica fast-forwarded to the field clock); the own row shows **返回战场**. Prep: the same flow shows the teammate's board (`m.field` with `prep: true`, unchanged). 联防: every human receives the unite spec (helpers + observers). Final Assault: each human sees its own pair field; the other pair → `BAD_TARGET 'other group hidden'`. In 联防/FA fields the ‹ › pill switches the camera LEFT half / 全景 / RIGHT half ("你自己" / "👁 name" / "全景" / "无人在家"); there is **no** view switcher during normal combat. Eliminated players start each combat phase on the first field (auto-observe) and may watch any field.

**Client runner.** `public/js/battle/runner.js` owns the local Battles: fixed-step clock at the battle speed (60 ticks per real second at 2×, at most `max(8, 4·speed)` ticks per frame, bounded fast-forward of ≤ 240 ticks per frame when far behind; a new battle is caught up silently before it is shown), feeds the existing renderer through the same `snapshot()`/`drainEvents()` wire formats every frame (`view.setLocalFeed` shrinks the interpolation buffer to ~2 frames), publishes the field meta (m.field shape + `local`, `battleId`, `players`, `sides`, `speed`) into `store.match.field` and its state into `store.match.battle` (with `leaks: { [fieldId]: counted leaks so far }` of every normal field it simulates, authoritative or display replica — the settle rule's count, `/sim/spec.js battleProgress`; published in the frame a count changes: the live LP of §17.5), sends `b.progress`/`b.result` when authoritative (results retried once on timeout; a result lost with the socket — the request failed `DISCONNECTED` / `OFFLINE` or timed out twice — is kept and sent again when the session is back online and whenever a `b.start` still names that finished battle `authoritative: true`; the server answers a duplicate `ok` and changes nothing; a server refusal is final), follows `m.public.paused` (solo pause: every local clock stands still, resume shifts it by the paused time), handles `b.pool`/`b.end`, fast-forwards on reconnect/observe, and survives tab backgrounding (a 250 ms interval pump keeps authoritative battles on their clock while hidden; catch-up when visible again; the server deadline + takeover cover extreme cases). Sim content errors are logged as console warnings (the server logs its own). The sim loader fetches the ten data files (one retry each) and fails when any is missing — a battle on partial data would report a plausible wrong result — so the next `b.start` retries and the server's deadline covers the field meanwhile. `public/js/battle/observe.js` holds the observing rules and labels.

**Corrections from research 08/09 (normative):**
- Waves: official generator (research 08 §2): 3 of 6 types, each owns exactly 3 of the 15 round slots, SPECIAL the rest (shuffled per match); per round one type + one weighted special entry (half by round); each template SPAWN **action** becomes `clamp(roundHalfEven(n·P(t)/P(new)), 1, 5)` units over the same window; placeholder actions of the other movement class are skipped. Stage per match from the mode's list (标准 = 战场#01 only, §6.5). No custom balance multipliers (`data/tuning.json` keeps only titles); co-op boss pool = `bloodPoint[difficulty]` unscaled.
- Ground pathing: official SPFA-style 4-direction search from the goal with crates as cost-1000 tiles, then straight-line smoothing (research 08 §3.4). act1 m02 crates #001–#004 inactive in 下半. Remake refinement (user playtest #2): route lengths stay the official ones, but among equal-length routes the one with the fewest non-blockable (floor / gate) tiles wins and smoothing never cuts across floor the grid route does not walk — e.g. 战场#01's lower-gate enemies take the col-8 road, not the col-9 floor lane (server/sim/grid.js header; test/sim/pathing-blockable.test.js).
- Observing: no watching while your own normal battle runs; after it ends (and in prep) tap a teammate → 前往查看 (local replica, fast-forwarded). ‹ › only inside 联防/FA fields; FA: own pair only; eliminated: free.
- Prep interactions: tap a unit → underframe with 出售 +1 (and 撤退 on board); items/Arts → 销毁; shop and upgrade are two-tap (select → confirm; the remake's 机变 cards too, §18.2); strategy draft forbids a strategy already taken by a teammate (队友已选).
- Emotes: 6 themes × 6 battle emotes (research 09 §4.2), image-only bubbles beside the sender avatar, 1 s cooldown, 3 s bubble; `g.emote {id}` with the official emoji id.

---

## 15. Official 3D board scene (v2 visual target)

Findings (2026-09-28): 卫戍协议 levels have no scene bundle (`mapId` null; the official hot-update list contains none). The client **builds the board at runtime** from the stage grid using the map theme `arts/maps/map_autochess` (materials `MT_autochess` (albedo `TX_autochessi_D` 2048², normal `_N`, metallic/gloss `_M`, emission `_E`), `MT_autochess_common` (`common_D/_E`: device/gate icons), `MT_autochess_Transparent` (`Transparent_D/N/M/E`), `MT_autochessi_BG` (`TX_autochessi_BG`)), the background meshes `arts/maps/map_autochess/bkg_mesh.ab` (`S_Background_common`, `S_Background_shadow`) and `arts/maps/common/meshes/s_background_common.ab`, device meshes (`s_common_box_01` crate, `s_wind_device` blower, …), plus the standard gate/objective effects. The level's `options.configBlackBoard` carries the official camera framing (`default_pos_x/y`, `default_size`, `enemy_pos_x/y`, …).

Target: a **real 3D board layer** rendered with three.js (vendored ESM, no CDN) underneath the existing Pixi layer:
- Geometry generated from `data/stages.json` like the official builder: LOW tiles = top quads; HIGH tiles = raised blocks with side walls; forbidden/void, fences, gates (red), objective (blue), hand/temp pads, special terrain; UVs mapped onto the official atlas regions (reuse/extend `public/assets/local/map/autochess/tiles.json`); normal + emission + metallic maps; lighting tuned to match official screenshots (key directional light, ambient/hemisphere, soft contact shadows); official background meshes & texture; device meshes (OBJ exported by `tools/local-extract`) with their textures; animated gate/objective effects.
- One camera model drives both layers: `public/js/render/projection.js` keeps its public API (`worldToScreen`, `screenToWorld`/tile picking, presets, transitions) but derives it from a three.js `PerspectiveCamera` initialised from the official configBlackBoard framing, so Spine units, FX, drag/drop and hit-testing stay aligned with the 3D board.
- Must degrade gracefully: when local-client art or WebGL2 features are missing, fall back to the current 2D atlas board; keep 60 fps (static geometry merged into few draw calls; textures mipmapped; DPR-aware).
- Implemented (`public/js/render/board3d/*`, `render/app.js`): three.js is downloaded only when the local-art manifest lists the board atlas; the built 3D area, the drawn 2D rows and the lit rect follow `viewKind(kind, {rect})` (the field the camera actually shows: a 'prep' camera on rows ≤ 6 = `bossPrep`); the background plane is extended with mirrored copies and the clear colour matches the fog (no visible edge at any aspect); battle crates live in their own group (survive scene rebuilds) and follow the board mode (`switchableBox`: 3D mesh ⇄ 2D box on a mode switch or a lost WebGL context); quality 'low' drops shadows; `?board=2d|3d` overrides. The direction wheel's range stripes sit between the board canvas and the unit canvas.
- Done: Final Assault / Hidden Core prep takes place on your own half of the boss field (research 09 §1.2): pieces shown at boss-field positions (row − 7; right-hand player mirrored col → 20 − col, RIGHT ↔ LEFT), drop targets and wheel directions mapped back to board coordinates (`prepCamera` → `bossPrep` in public/js/ui/gameLogic.js; covered by the playtest2 browser tests).

---

## 16. Operator loadout: skill & module selection (v2.1, user playtest #1)

Official rule (bwiki 盟约, 更新公告 5114): before a match the player cannot change an operator's tier, but can change the **equipped skill and module** of each chess; some non-default choices are stronger. Scope in the remake (no accounts ⇒ everything the chess's status unlocks is selectable):
- **Skills:** any skill unlocked at the chess's status (`evolvePhase`: E1 ⇒ S1–S2, E2 ⇒ S1–S3) at the chess's skill level (normal Lv4, elite Lv7). Default = `defaultSkillIndex`.
- **Modules:** only matter for the elite (golden) chess (`equipLevel` 1, or 3 at T6): any module of that character (or none); default = `defaultUniEquipId`. Normal chess have no module (equipLevel 0).

**Data (`data/chess.json`, built by tools/build-data.mjs):** every chess keeps `skill` (the default, unchanged shape) and gains `skills: [SkillRecord…]` (index, skillId, iconId, name, desc/descRaw, skillType, durationType, duration, spType, spCost, initSp, maxChargeTime, bb (at the chess's skill level), bbStr, rangeGrid, trigger {rule, customRangeGrid} resolved for THAT skill index, isDefault). Golden chess gain `modules: [ModuleRecord…]` = `{ uniEquipId, name, typeName, icon, isDefault, attr: {maxHp, atk, def, res, aspd, cost, blockCnt, respawnTime…} (flat adds at the chess's equipLevel), traitOverride: {desc, descRaw, bb} | null, talentChanges: [{talentIndex, name, desc, bb}] }` plus `statsBase` (stats WITHOUT any module); `stats` stays = stats with the default module (back-compat).

**Loadout wire & state:** the client keeps a per-browser loadout `{ [baseChessId]: { skill: index, module: uniEquipId | 'none' } }` (localStorage) and sends it with C2S `room.loadout { entries }` (validated: known visible chess, legal skill index for that chess's normal AND elite status, legal module id). The lobby stores it on the seat; at match start `Match` receives `seats[].loadout`; `PlayerState` keeps it immutable for the match; board pieces are resolved to `{chessId, skillIndex, moduleId}` when building `PlayerBattleInput.units[]` (fields `skillIndex`, `moduleId`; BattleSpec carries them). Bots use defaults. m.private exposes the effective loadout so the UI (shop cards, detail panel) shows the chosen skill/module.

**Sim:** `simdata` resolves a unit def for `(chessId, skillIndex, moduleId)` (cached): `skill` = the selected SkillRecord; stats = `statsBase` + module attr (elite) ; trait/talents = base with the selected module's overrides. Kit contract (backward compatible): a kit function `(bb, chess) => { skill?, skills?: { [skillId]: SkillSpec }, talents, trait }` receives `chess.skill` = the **selected** skill and `bb` = its blackboard; the loader uses `skills[selectedSkillId]` if present, else `skill` only when the selected skill is the chess's default, else the **generic** skill spec — talents/trait from the kit always apply. Every visible chess must get hand-authored specs for all of its selectable skills (tracked by a coverage test).

**UI:** a 干员调配 screen reachable from the lobby, room and briefing (INFO_CHECK): filter by tier/bond/class, per chess choose skill (icon, name, SP info, desc at Lv4 and Lv7) and elite module (official type icon from the local-client art when extracted (§13), else a lettered tile; name/type, stat bonus, trait/talent changes), 恢复默认, persisted; the chosen skill/module shown on shop cards and in the detail panel (a teammate's unit — 前往查看 in prep, 联防 / 最终攻势 fields, an observed battle — shows **its owner's** skill/module from its UnitInfo `skillIndex` / `moduleId`, `gameLogic.js unitLoadout`) — which also shows the stats, 特性, talents and attack range the unit fights with (`shared/loadoutRecord.js` `loadoutRecord` / `attackRangeGrid`, the same composition the sim's `getChess(id, loadout)` uses; the deploy wheel's range preview too). In battle the renderer plays the equipped skill's own Spine clip and ON_SKILL_START sound (`UnitInfo.skillIndex`; `data/assets.json` lists icons, clips and sounds for every skill index).

---

## 17. User playtest #3 (v2.2): models, picking, FX, rules, HUD

Nine reports from a real co-op session. Where each is handled: #1 lost operator models → §17.1; #2 the LP did not move while enemies entered the own blue gate → §17.5; #3 equipment pushed into the second bench row vanished after the battle → §6.2 temp overflow (server) + §17.5 (UI); #4 蕾缪安 S3 fired every shell at once → §17.4; #5 回环射手 attacked like a fast shooter → §17.4; #6 bullets / skill effects hardly visible → §17.3; #7 a click selected the unit one row lower (equipment too) → §17.2 (superseded by §18.1); #8 the operator's own effect (特质) sat at the bottom of the detail card → §17.5; #9 spinners next to texts → §17.5.

### 17.1 Lost operator models (#1) — the Spine store (`public/js/assets.js RefLru`)

Cause: `PIXI.Assets.unload` is asynchronous (the loader cache entry is dropped and the textures destroyed a microtask later), so a skeleton evicted and re-acquired in the same task came back as the doomed object and turned invisible for good (a tier chip without a body; the dead data stayed cached, so every later copy of that operator was invisible too). It happened at every battle → prep switch: `enterPrepMode → clearViews` made the reference count 0 for an instant, the LRU applied its "no scene on screen" budget (0 bytes) at that instant and dropped the bench models idle since the battle started, then `setPrep` took them back at once. Rules now: an `unload` may return a promise and a load of a key whose unload is still in flight waits for it (`unloadSpineData` returns one; `stats().spine.unloading`); the spine store runs eviction in one pass `SPINE_EVICT_DELAY_MS` (1 s) after a release (a scene switch takes its models back first); the quiet budget applies only after `SPINE_QUIET_DELAY_MS` (3 s) with nothing referenced (lobby / room). The count-cap path (60 skeletons) waits the same way. Tests: `test/render/assets.test.js` (fake `PIXI.Assets` with the same async unload), `test/render/models.browser.test.js` (models alive after long battles, drag / wheel stress).

### 17.2 Picking and the drag target (#7) — superseded by §18.1

v2.2 answered "a click selected the unit one row lower" with body picking: every path took the drawn chibi (a head / body shape per unit, measured from its posed Spine model) and, where two bodies were close, a 1-px render probe of the pixel under the pointer; the dragged ghost stood on the pointer (on touch 0.6 tile above the finger) and an item went to the operator whose sprite was under the plate. User playtest #4 item 1 rejected it ("感觉你想复杂了，地上都画好了一个一个方格，点击对应方格就选中那个方格的人物就行"; the model moved up away from the finger): picking is by the tile under the pointer and the dragged model is held under the pointer (§18.1). The shapes, the probe, the touch lift, `pieceDragOver` and the DOM-side `pickPieceAt` / `equipRetarget` are gone.

### 17.3 Battle FX (#6) — `render/fx.js`, `style.js PROJ`, `textures.js`

- **Projectiles per kind** (`PROJ[kind].look`), sized in tiles × the camera's px per tile (the same on the 3D board and the 2D fallback, 1280×720 to 1920×1080): `arrow` a bright tracer with a glowing head, a muzzle flash aimed at the target and a hit flare; `bolt` / `orb` / `enemy` a glowing ball with a particle trail (arts purple with a burst + shockwave, heal green with a sparkle, enemy red); `bomb` / `lob` a shell on a visible arc with a ground shadow, smoke and embers, exploding on landing (blastcaster shells purple); `drone` a small cyan dart; `boomerang` (回环射手) a spinning boomerang with afterimages that flies out to the moving target at `PROJECTILE_SPEEDS.boomerang` and back to the thrower's **current** position at `BOOMERANG_RETURN_SPEED` (the sim emits no event for the return: the renderer models it; dropped when the thrower's view is gone or dead). A shot lingers 0.08 s in its target so fast shots still read. Flight times use the sim's own speeds, loaded at run time from `/sim/constants.js` (`style.js PROJ` keeps a test-guarded copy: `test/render/fxproj.test.js` fails when they differ), so a shot lands with its damage number.
- **Hits and skills**: a melee blow draws a thick crescent slash swept along the blow (attacker → victim on screen) in the damage-type colour with a white core, plus sparks; skill activation = gold light pillar with a white-hot core, flash, shockwave and hex ring on the ground, rising motes; an active skill keeps a slowly turning hex and a soft glow under the unit. Blasts share one explosion (fireball, flash, shockwave, coloured ring, sparks, smoke; `heavy` kinds — bombard, airstrike, meltdown — add debris and a scorch mark). Beams and chain lightning: glow + body + white core, flare at the target.
- **Anchoring**: an fx whose `extra.id` names a unit is drawn on that unit (following its rendered position) only when the event's (x, y) lies within 0.75 tile of it (or has no position); otherwise at (x, y) — the sim puts the caster in `id` of many area effects. `FX_KINDS` entries flagged `pt` (bombard, bombardShell) always happen at (x, y) (their `id` is the shooter; 蕾缪安's bombard used to explode on herself).
- **蕾缪安 S3 contract**: `'lock' {x, y, id: enemy, src: shooter}` → a reticle following that enemy (its view by `id`), at the spot it left once it is gone; `'bombardShell' {x, y, id: shooter, r, t: flight game s, i}` → a launch streak leaving the shooter and a shell dropping onto (x, y) after `t` (a flight ≥ 0.45 real s climbs out of her first), with a closing warning ring and the blast radius throbbing; it takes the shooter's nearest free lock; `'bombard' {x, y, id: shooter, r}` at the same spot → the heavy explosion and the end of that lock. A lock also ends on the S2 `'crit'` from the same shooter, when the shooter is gone (locks no shell took yet), or `LOCK_T` = 5 game s after that shooter's last lock / shell / bombard (an idle timeout, not an age: ammo grants and stuns stretch an S3 far past 5 s); ≤ 48 reticles.
- **Cost**: particle, projectile and lock records are pooled (the per-frame emitters allocate nothing); a freed particle is a zero-size transparent quad (Pixi's ParticleRenderer ignores `visible`); cosmetic extras (trails, muzzle flashes, afterimages, debris, scorch marks, motes) are off at quality 'low' and at adaptive load level ≥ 2, and trails stop at 75 % of the particle cap. Measured: the 120-unit stress scene and the crowded boss-m02 replay stay at 60 fps with no measurable per-frame increase. The FX atlas is 1024×512 with non-overlapping frames (the old light pillar carried two status icons at its foot). The FX are procedural: the local client's per-weapon projectile sprites are not used (the sim's `arrow` also covers gun snipers, and friends may not have the local art).

### 17.4 回环射手 (#5) and 蕾缪安 S3 (#4) — the sim (official PRTS notes; numbers from the data)

- **回环射手 boomerang** (`professions.js loopshooter`, `ai.js throwBoomerang`; PRTS 跃跃 "投射物飞行速度15，返回时飞行速度3.75", "必须回收全部回旋投掷物才可以进行下一次攻击"): projectile `'boomerang'` (`resolveProfile` keeps it over the data's generic `'arrow'`) flies out at `PROJECTILE_SPEEDS.boomerang` = 15 tiles/s and hits on arrival, then flies back to the thrower's current position at `BOOMERANG_RETURN_SPEED` = 3.75 tiles/s without damage; the thrower attacks only while it holds its boomerang (every one it threw caught) **and** its attack cooldown is ready, so the real interval is the longer of the two. A target that died mid-flight is not hit (the boomerang still flies to its last position and back); a thrower knocked out / withdrawn loses it and a redeployed one holds a fresh one. 跃跃 S2's extra boomerangs share the one flight (cnt hits, the talent rolls per hit). Event contract unchanged: `['atk', thrower, target, 'boomerang']`.
- **蕾缪安 S3 礼炮·强制追思** (`kits/tier6.js lemuen`; PRTS S3 note — the timing is not in the blackboard): one lock every 0.5 s while an enemy is in range (unlocked targets first, then lowest DEF), each costing a round; the lock mark follows its enemy and stays where it left (death / leak). After the skill ends ONE shell every 0.3 s in lock order (PRTS "以0.3s为间隔"), aimed at a random point of the 0.4-side square around its mark (± `attack@emit_offset` 0.2, drawn with the battle rng in her facing frame so a turned board plays alike), landing 0.3 s after it is fired (flight **[ASSUMED]**: the data and PRTS give none; the PRTS count of ≤ 33 fits a first impact one interval after the end); each shell hits every enemy within `dist_2` once — `proj_atk_scale_1` within `dist_1`, else `proj_atk_scale_2` — with the ATK cached when the skill ended; at most 10 s of shells (≤ 33). Knocked out / withdrawn after the end: shells in the air still land, the rest are dropped; knocked out while locking: no bombardment. fx: `'lock'` per lock, `'bombardShell'` when a shell is fired, `'bombard'` at its impact (§17.3).
- Tests: `test/sim/professions.test.js`, `test/content/kits_t1t2.test.js` (跃跃), `test/content/kits_t6.test.js` (shell sequence, spacing, cap, knock-out, rotation invariance).

### 17.5 Game HUD (#2, #3, #8, #9) — `ui/hud.js`, `teamPanel.js`, `underframe.js`, `detailPanel.js`, `data.js`

- **Live LP (#2)**: in a normal round the top bar's LP tower and the own team row show `lp − min(lpCapPerRound, counted leaks)` as soon as the own battle's enemies enter the blue gate — the number in red followed by a −N plate that pops again on every leak, clamped at 0, with a tooltip (`ui/hud.js liveLp` / `pendingLoss` / `pendingTip`). The count is `ownLeaks(local, server)` = the larger of the local runner's `state().leaks[own field]` (§14) and `m.public players[].pendingLp` (§8.2; the authority's `b.progress` leaks, the field's result, the recorded result in 联防) — both only grow within a round, so a paused display replica never freezes the number. The pending part is dropped as soon as the settled `m.private` lands (its `lp` or `stats.leaks` changed; `Match.flush` sends it before the SETTLE `m.public`), the phase leaves COMBAT / 联防 or the round changes — never subtracted twice. 联防: the own battle's count stays on show as an upper bound tagged 联防中 (teammates may still stop part of it; the settled loss can be lower). Teammates' rows use their `pendingLp` (`teamPanel.js rowLp`); server-run fields (bots, taken-over fields) report none before their result is released. Boss rounds are unchanged (the team LP moves live through `b.pool`).
- **Temp row (#3, UI)**: while `m.private temp` holds pieces during the own prep, a dashed red frame surrounds the 临时整备区 row on the board and a label says how many are waiting, what to do and when they go (`underframe.js TempRowNotice` / `tempRowFrame`, placed through `view.tileScreen` — it follows the camera, the mirrored Final Assault prep and the DOM fallback; no pointer events; the label hides while dragging or placing). Its wording follows the server rule (§6.2, `tempRowRule(ready)`): not ready — "放入整备区或战场、配发或使用后才能准备；休整期结束时仍在此处的将被销毁"; ready in PREP (so whatever lies there arrived after Ready) — "已准备就绪后进入的单位保留到下个休整期，届时仍在此处的将被销毁（取消准备则在本休整期结束时销毁）". The 准备就绪 button shows "临时整备区 N 个单位待处理" under it (not only on hover; the effects column moves down a line meanwhile, `.gm.has-readywhy`) and Space toasts the reason (`hud.js TEMP_RULE` / `tempReadyReason`).
- **Detail card order (#8)** (`detailPanel.js CHESS_SECTIONS`): header (portrait, name, tier, class, bonds) → **特质** (the operator's own effect — garrison trigger chip such as 休整期结束时 + description, a compact gold block, visible without scrolling at 1920×1080, 1280×720, iPhone 14 and 640×360) → 特性 (class trait) → stats (a compact 4×2 grid) + attack range → 技能 → 模组 → 装备 → 天赋. On phones ≤ 460 px tall the portrait is shorter and the romanised name is hidden.
- **Busy indicators and texts (#9)**: every text of the game (operators, skills, bonds, items, enemies, 特质 …) is static data, `/data/*.json` loaded once per page and never fetched during a match; the "spinners" the player saw were busy indicators of requests in flight next to texts — and the 特质 chip's type icon: it was picked by the trigger, so every <休整期开始时 / 结束时> 特质 showed the spoked 特异化 glyph (it reads like a loading spinner) before its text; the chip now shows the garrison's own official `eventTypeIcon` (`detailPanel.js garrisonTypeIconKey`: crossed swords 作战能力, gold 整备能力, chain link 持续 / 单次叠加, spokes only for 特异化). Now: no `cursor: wait / progress` anywhere; a loading `Button` keeps its icon and shows a thin sweeping bar along its bottom edge after 250 ms (no spinner ring); a 机变 card in flight shows a 选择中 strip until the pick appears in `m.public` (`choiceOverlay.js pickBusy`); the 作战结束，等待队友完成作战 hourglass is still; the hexagon `Spinner` is kept for genuine loading screens only (entering the match, the field view, connecting, guide images, the first 干员调配 load, which says the data loads once per page). `main.js warmGameData` downloads every in-match file (`gameComponents GAME_FILES`) in the background once the player is in a room, and the match screen waits for them; `data.js` retries a transient failure (network error, HTTP 5xx / 408 / 429) after 600 ms and 2 s (`RETRY_DELAYS_MS`) — a 404 or invalid JSON is final.
- Tests: `test/ui/playtest3.test.js`, `test/match/runner.test.js` (live leak counts), `test/match/temp.test.js` (§6.2), `test/docs-consistency.test.js`.

---

## 18. User playtest #4 (v2.3): picking by tile, confirms, timers, battle state, content

Thirteen reports after playing v2.2. Where each is handled: #1 picking should simply follow the tiles and the dragged model moved away from the finger → §18.1; #2 a confirm step for 机变 picks → §18.2; #3 a countdown although playing alone → §18.2; #4 the strategy draft's 10 s turn out of step with the top-right countdown → §18.2; #5 the special 维式重锤 and 突变细胞 were sold in the shop → §18.6; #6 纯烬艾雅法拉's skill sound rang outside her skill → §18.4; #7 the operator card showed fixed numbers → §18.5; #8 no official element gauges → §18.3; #9 knocked-out operators vanished instead of lying on their tile with a redeploy ring → §18.3; #10 the enemy drones' behaviour → §18.6; #11 赫默's drone deployed at the start instead of by her skill → §18.6; #12 the 炎佑 dragon returned to a fixed point and its flame was no continuous jet → §18.6; #13 once in a while a huge piece of UI covered the screen for a second or two → §18.7.

### 18.1 Picking by tile, the model under the pointer (#1) — `render/pick.js`, `render/app.js`, `render/drag.js`

- **One rule**: the ground tile under the pointer decides (`render/projection.js pickTile`, raised tops first). Prep presses / clicks / right-click / long-press / drag starts / hover (`app.js pieceAt`) and the enemy preview pen (`penUnitAt`) take the unit standing on that tile (board, bench row 7, temp row 8; `pick.js pickOnTile`). An empty tile selects nothing; a press on a unit's head drawn over the tile behind it is a press on that tile; a raised tile in front hides the near 0.17–0.24 tile of the one behind it, and a press there is on the raised tile — what is drawn. Several units on one tile (the pen's clusters, a piece held for a moment): the nearest to the pointer's point on the tile, ties → the front-most.
- **Battle** (`app.js battleUnitAt` → `pickBattle`): an ally on the tile under the pointer — a knocked-out operator lying on its tile (§18.3) included. An enemy within `ENEMY_REACH` 0.6 tile [ASSUMED], using whichever is nearer: its ground position from the pointer's point on the ground, or its drawn body on screen (the upright line from its feet up to its head, in its px per tile) — so a press on a tall enemy's or the boss's torso or head picks it; a flying enemy uses its drawn body only. When an ally tile and an enemy both qualify the nearer (in tiles) wins; ties → the ally, then the front-most. Dead and dying units are not picked (a knocked-out operator waiting on its tile is).
- **Drag**: the dragged unit is held under the pointer, mouse and touch alike — its drawn (lifted) feet `DRAG_HOLD_TILES` = 0.45 tile (in its own px per tile) below the pointer [ASSUMED: the v2.1 offset], so the pointer rests on the chibi; an item plate is centred on the pointer. The drop target, its highlight, `tileHover` and the direction wheel's tile are the tile under the pointer. An item dropped on a tile equips the unit on that tile (`ui/gameLogic.js canPlace` / `dropIntent`; an empty tile says 请将装备拖拽至干员身上). A release over DOM covering the canvas (the shop bar) is `'outside'`: the piece goes back.
- **Touch**: the field canvas cancels `touchend` (`app.js onTouchEnd`, non-passive). A tap's compatibility mouse events and click came after `touchend`, hit-tested at the finger again — on the underframe the tap had just opened over the unit's tile (clamped under the top bar for rows 11–12 at 844×390), which pressed 撤退 / 出售.
- **Notched phones**: the shop bar keeps its place at the bottom edge instead of rising by the bottom safe-area inset (`css/devices.css .gm__hud > .shopbar`): raised by it the bar covered ~3/4 of bench pads 2–9 at 844×390 with the iPhone insets (23 % of those tiles left free, 71 % now — as without insets), and bench pieces are pressed and dropped on by their tile.
- Removed: the pixel probe (`drawnAt`, `hoverProbeAt`), body shapes (`pickShape`, `PROBE_MARGIN`, `BODY_H`), `TOUCH_LIFT_TILES`, the drag `dropPoint` hook, `pieceDragOver`, `ui/gameLogic.js pickPieceAt` / `equipRetarget`. `UnitView.bounds()` is a plain body rectangle again (tooltips and `pieceScreenRect` only).
- Tests: `test/render/pick.test.js`, `drag.test.js`, `unitview.test.js`, `test/ui/gameLogic.test.js`, `test/ui/playtest4.test.js` (shop bar); browser: `test/render/models.browser.test.js` (every tile of every board, high ground, bench and temp; battle allies and enemies incl. torso and head; the model under the pointer at every drag step; the wheel on the pointer's tile; equipment by tile; phone touch incl. the ghost click and the shop-bar release), `test/render/downelem.browser.test.js` (a knocked-out operator picked on its tile), `test/ui/playtest2.e2e.test.js` (the top-row tile under the bond strip; the notched phone's bench).

### 18.2 Confirms and timers (#2, #3, #4) — `ui/choiceOverlay.js`, `server/match/Match.js`, `screens/bandDraft.js`

- **机变 cards take two taps** (like the shop's cards): the stateful `ChoiceOverlay` wraps the pure `ChoiceView`. A first tap on a pickable card (bounty = extra enemies, 道具补给 / 机密商店 items, tactics) only selects it — gold frame, a 确认选择 · 再次点击 strip, the other cards dimmed, 确认选择 in the header; a second tap on it, or 确认选择, sends `g.choice`. Another card moves the selection; Esc or a press elsewhere drops it; so do the card being taken, the turn moving on and a pick in flight. Cards stay buttons (Tab / Enter). The other picks were already two-step (晋升奖励 in the shop bar, the strategy draft's 确认选择, 确认替换).
- **A single human is untimed** (`Match.loneHuman`: exactly one human seat at the start → `Match.soloUntimed`): 独立模拟 and a 同盟 room started alone or with AI teammates only publish no INFO_CHECK / BAND_DRAFT / SP_DRAFT / PREP deadline, and BATTLE_CHECK / ROUND_START / SETTLE run silently — the timers only ever made humans wait on each other. The co-op rules stay (shuffled draft order and skip, 6 机变 cards, 联防); pause stays solo-only; a disconnected lone human's match waits (the co-op reconnect window then ends it as abandoned). `Countdown` (`ui/components.js`) renders nothing without a deadline (it used to draw a `--` COUNTDOWN placeholder that only a CSS rule hid).
- **The strategy draft has ONE countdown**: every turn lasts `Match.BAND_TURN_SECONDS` = 30 s [ASSUMED] (× timerScale; `data/config.json timers.bandTurn` says the same — the official data only has the whole BAND_CHECK step, 50 s, now informational) and `m.public.deadline` IS the current turn's end (= `draft.turnDeadline`; `draft.turnSeconds` = the turn length, 0 untimed), so the step header and the picker's row show the same number. No step cap: the turns bound the step (≤ (seats + skips) × 30 s). AI seats pick at once. The draft screen reports its highlighted strategy (`g.bandFocus`); a turn that runs out takes it while it is allowed and free (`Match.timeoutBand`), else 华法琳 (`band_bldsk`), else the first free strategy (`defaultBand`, 队友已选 never). The selection starts on that default and the tip always names what a timeout gives ("每位博士有 30 秒，超时将自动选择当前选中的「X」"; untimed: "本局不限时"). `server/match/audit.js` checks it (deadline = the turn's, 30 s; nothing timed for a single human).
- Tests: `test/ui/playtest4.test.js`, `test/ui/bandDraft.test.js`, `test/match/draft.test.js`, `test/ui/gameLogic.test.js` (`phaseTotalSeconds` = the turn), `test/match/hardening.test.js` (the audit), `test/ui/mock.e2e.test.js` (two taps). Browser tests that need a timed co-op briefing now seat two humans (`test/ui/loadout.e2e.test.js`); a single human's 机变 is picked by the test itself (`test/ui/playtest2.real.e2e.test.js`), and the real-server drafts wait for BAND_DRAFT before picking (a client left in the briefing let its 30 s turns run out).

### 18.3 Knocked-out operators and element gauges (#9, #8) — `sim/Battle.js`, `sim/damage.js`, `render/interp.js`, `render/units.js`

- **Knocked out, not gone**: `Battle.snapshot()` lists `down: [[id, respawnAt, respawnTime, state]]` (§8.2) for operators knocked out (reason `'killed'`, not withdrawn), deployed at least once and with a finite respawn timer; `state` = sim/constants.js `DOWN_STATE` (0 counting, 1 timer done but DP < cost, 2 timer done but the home tile is taken — the official auto-redeploy rule, research 01 §4.3). `Battle.isDown(u)`; `fieldMeta()` lists them too, so a client joining mid-battle (reconnect, observer, replica) shows them. The renderer (`interp.js downAt`, `app.js syncBattle`, `units.js setDown`) keeps such an operator's view on its tile: its Spine Die clip plays once and holds its last frame (a collapsed / kneeling pose), lightly greyed (tint 0xb4b4b4, alpha 0.92), under a **redeploy ring** above the head — a dark disc with a mint arc filling as the timer runs and the seconds left (game s); timer done: a full pulsing amber ring "DP" (waiting for DP) or red "!" (its tile taken). The `deploy` event plays the Start clip and restores the normal look; a view created for an operator already down starts on the held pose; leaving the list without a redeploy fades it out. Summons, devices and enemies vanish as before. [ASSUMED] look: the official knocked-down / ring art is in no extracted autochess bundle.
- **Element gauges, official rules** (PRTS 元素 / 术语释义; `damage.js`): gain × `elemTakenMul` × (1 − 损伤抵抗 / 100), 损伤抵抗 = data `epResistance` (EP_RESISTANCE; it used to read `epDamageResistance` as a fraction). A burst's **爆发冷却** (= its duration: 灼燃 / 神经 / 侵蚀 10 s — enemies' 侵蚀 8 s — 凋亡 15 s; the operators' 侵蚀 had none) locks EVERY element of the unit — nothing fills or recovers (`reduceElement`) — and its end resets EVERY gauge (`burstLocked(unit)` takes no element). 神经 applies the stun (operators) / 3 麻痹 (enemies) before its damage, 侵蚀 its DEF cut before its damage; the operators' 凋亡 burst holds 阻回 (`noSp`: `skills.js gainSp` refuses SP of every kind — time, attack, hurt, granted) + 静默, −1 SP/s and 100 arts/s.
- **The gauge on screen** (official display: one icon, the "当前损伤元素"): `damage.js elementView(u, now)` → b.snap `elem` (§8.2): the fullest gauge, ties by the official element id (`constants.js ELEMENT_ORDER`: 神经 < 侵蚀 < 灼燃 < 凋亡); during a 爆发冷却 the bursting element, refilling over the cooldown. `interp.js` appends it to the unit's tuple; `units.js` draws it right of the HP / SP bars — operators: the element's disc with its glyph; enemies: a smaller plain disc of the element colour (official rule) — with a white ring for the remaining 元素值 (1 − fill). One procedural 512×576 atlas (`textures.js hudRings` / `ringArc`, 49 arc frames and the discs), sprites made on first use and hidden when idle. The burst's lock status (`burnBurst`, `neuralBurst` …) is not repeated in the status row while the element icon shows it (only a feed without `elem`, e.g. an older recording, shows it there). [ASSUMED] placement (the official draws it under the model, the remake's bars are above the head) and size (0.3 tile, enemies ×0.8).
- Recordings (`tools/record-battle.mjs`) carry both keys, so the render demo shows them. Tests: `test/sim/downelem.test.js`, `test/sim/combat.test.js`, `test/render/downring.test.js`, `test/render/interp.test.js`, `test/render/downelem.browser.test.js`.

### 18.4 Battle sounds (#6) — `public/js/audio.js`, `tools/assets/audio.mjs`

- Cause: every `'atk'` — heals included — made its source the target's "last attacker", and any later damage on that target (enemy projectiles, element fills, DoTs) played that unit's `hit`; 纯烬艾雅法拉 (who only heals) had her S3 impact (`p_imp_gtshpbrnch_s`, bank ON_ABILITY_HIT.attack.2) as `hit` in the manifest, so it rang all the time.
- Now only a hostile `'atk'` (from the other side) authors the target's next impact: it plays once, within 2.5 s real [ASSUMED], and only for phys / arts / true damage; heals and chain bounces never author one. An operator's skill-mode file (official names `_d` / `_h` / `_s`; the normal attack's end in `_n`) never plays for a normal attack (`normalAttackSfx`). At most 2 overlapping copies of one battle sound (`SfxLimiter`; official banks `maxSoundAllowed` 2 — a third copy is skipped, not the oldest stopped [ASSUMED]).
- Manifest: `tools/assets/audio.mjs pickUnitSfx(banks, { operator, projectile })` picks normal-mode banks for operators — the plain `attack` / `combat` ability first, never a bank with a skill-mode file — with the operator's own projectile banks (`ON_PROJECTILE_BORN` / `_HIT.projectile_chr_<name>`, `tools/assets/plan.mjs`) as fallbacks; enemies and tokens are unchanged. 56 operators' picks changed (e.g. agoat2 `hit` → `p_imp_gtshpbrnch_n`, nearl2 `attack` → `p_atk_goldspear_n`, whitw2 → `p_atk_whtolfdrksl_n`). Loop-bank skill sounds still play once (open).
- Tests: `test/ui/audio.test.js`, `test/assets.test.js`.

### 18.5 Live operator stats (#7) — `ui/detailPanel.js`, `battle/runner.js`, `Match.unitStats`

- **Battle**: `battleRunner.unitStats(id, fieldId)` reads the local sim's last computed stats (`unit._s`, never the lazy `unit.s`, so looking cannot shift the sim) and the detail card re-reads it 4× a second: current HP / max HP, ATK, DEF, RES, attack interval, block (enemies also move speed). `battleRunner.unitIdOf(uid, ownerId, fieldId?)` maps an own board piece to its battle unit, so a card opened in prep and left open into the battle turns live.
- **Prep**: C→S `g.unitStats {seq?}` → `m.unitStats {seq, round, units}` (§8.2): `Match.unitStats` builds a Battle from the player's battle input after the `onBattleStart` meta (dispatched with `ev.preview: true` and no `spawns` — handlers must not change the match then, docs/META.md), with the flags of the battle it previews (a normal round gains IN_BATTLE layers from its start; the Final Assault is previewed as a normal field without them), starts it (initial deployment + battleStart hooks), reads it and drops it — never stepped, so skills and timed effects are not in it [ASSUMED display]; cached per input (≈ 0.3–0.7 ms a build). `screens/game.js` asks 120 ms after any `m.private` / phase change while an own board unit's card is open and keeps the newest answer only.
- The card colours each value against the unit's base — green when it helps (a shorter interval is up), red when it hurts — with the difference beside it, the base in the tooltip and a 实时 / 开战时 tag. The shape is `shared/protocol.js unitStatsEntry`. Tests: `test/match/unitStats.test.js`, `test/match/runner.test.js`, `test/ui/playtest4.test.js`.

### 18.6 Shop-only items, drones, summons, 炎佑 (#5, #10, #11, #12) — `tools/build-data.mjs`, `sim/simdata.js`, `sim/content/*`

- **#5 not sold in the shop**: the official `trapShopChessDatas` has `hideInShop` false for all 56 normal items, so an explicit sourced list (`tools/build-data.mjs SHOP_EXCLUDED_ITEMS` → items.json `shopExcluded` / `shopExcludedBy`) marks the effect-only items: 战栗 / 坚固 / 加速 / 灼燃维式重锤 (the 维多利亚 bond every 25 layers, 洛洛's 定制品) and 突变细胞 (the 昆图斯 strategy 不稳定要素; user playtest #4 first-hand). `sim/simdata.js isShopItem` is the one predicate for every shop-item draw — the shop's item slot, 道具补给 / 机密商店 cards, `pool_equip_normal` / `_shop_1` / `_kathe` / `_narant`, `Match.rollItemId` — so 51 normal items are sold (the plain 维式重锤 still is). 洛洛's 定制品 (`pool_equip_rockr`) = the same 4 special hammers as `pool_equip_vict`, uniform [ASSUMED]. The item card says 调度中心不出售 · 获取途径：… (`detailPanel.js ItemDetail`). Other strategy-granted items stay on sale (no source says otherwise; 变形同构体 / 骑士储蓄罐 / 盟约之币 appear in an official 机密商店 screenshot).
- **#10 drones** (stats and ranges = enemy_database level 0, re-derived by `test/data.test.js`; behaviour per PRTS): 暴鸰 makes no normal attack — one bomb on its target and the 8 tiles around it (100 % ATK, splash ignores camouflage), then its speed ×2 (final); 帝国炮火先兆者 / 中枢先兆者 fire a shell per attack that lands 3 s later at the target's spot and hits every ally within 1.2 for 100 % of the ATK at launch, with no source (`content/enemies.js kitShell`; new `ai.js enemyAttack` hooks `profile.deferHit` — content resolves the hit in its `attack` handler — and `profile.shot`, the `'atk'` kind: `'mortar'` draws no projectile; fx `bombardShell`); 假想敌：黑云 grabs within `range_radius` × 2.5 (3.75) at most 3 flyers (nearest first [ASSUMED], 0.5 s delay [ASSUMED]), both held 4 s, ammo capped by enemies.json `sp.maxSp` (3; new `sp` from enemy_database spData), 全弹发射 = one 130 % hit per ammo on random allies anywhere on the field; “萨科塔之眼” never attacks flying allies; 萨科塔 self-fear speed final ×1.5. Unchanged (already right): 妖怪 / 妖怪MKII / 威龙 / 寒霜 / 法术大师A1·A2 / 御4 / 护障 / 护障·P / 远眺.
- **#11 skill summons are not prep pieces**: tokens.json `placeable` = `tokenDisplayType` DEFAULT **and** made by a talent (海嗣, 狼群, 流形). 赫默's 医疗探机 and 巫恋's 诅咒娃娃 appear only when the skill fires (their kits place them); `PlayerState.grantTokensFor` just grants the placeable ones.
- **#12 炎佑** (PRTS “炎佑” 级别0(卫戍协议), `content/tokens.js yanyouKit`): it flies after the highest-aggro targetable enemy of the whole field (operator order) and hovers 0.25 tile [ASSUMED] from it (a second 炎佑 of 9 炎 0.8 row beside the first); **with no enemy on the field it stays where it is** (user playtest #4; PRTS says it then tracks a random tile). 祛恶之焰 (模式乙): fires like a normal attack when its 15 s cooldown is full, locks that attack's first target and channels up to 20 s — each second (the first at once) 60 % ATK arts to every enemy within 1.0 of the target, no normal attacks meanwhile — ending when the target is gone or 炎佑 is silenced (inferred); the cooldown then runs again [ASSUMED]. Every damage it deals adds burn = 20 % ATK (flame ticks included, official 下半 notice); 元素脆弱 aura of radius 1.5 around itself; it ignores element damage; ATK / HP = the template 600 / 12000 **plus** 30 % of the 炎 operators' sums (PRTS 最终加算; the 9-炎 ×1.5 on the whole ATK [ASSUMED]). The flame is drawn as one continuous jet (`render/fx.js _flame`): the sim emits fx `yanyouFlame {x, y, id: dragon, target, r, n, dur: 1}` once per game second, and each tick re-aims and extends the dragon's jet — a stream of fire from the dragon onto its locked target with a burning disc of radius `r` following the target — which burns `dur` + 0.2 s and goes out when no tick comes or the dragon is gone.
- Tests: `test/content/playtest4_summons.test.js`, `enemies_bosses.test.js`, `tokens_devices.test.js`, `bonds_core.test.js`, `choices.test.js`, `test/data.test.js`, `test/match/pool.test.js`, `test/render/fxflame.test.js`, `test/ui/playtest4.test.js` (item card).

### 18.7 The occasional giant UI flash (#13) — `render/fx.js pop`

The first in-battle layer gain of each bond (b.ev `'layer'`) pops that bond's icon over the field (`FxSystem.pop`). The icon is `PIXI.Texture.from(url)` — a 1×1 placeholder until its image has loaded — and the pop sized the sprite from it (46 / 1): the bond icon was drawn ~5000 px across the whole screen for the pop's 1.4 s, once per bond per page (73 official garrisons gain layers in battle, e.g. 送葬人's). Now it is sized (46 px along its longer side) only once its texture is valid, hidden until then. Found by sampling long real-server sessions every 80 ms (DOM boxes > 25 % of the viewport, images drawn > 300 px, Pixi objects > 25 % or showing a whole atlas page, CSS scale ≥ 2); every other large object seen is a designed full-screen layer. Tests: `test/render/fxpop.test.js`, `test/render/flash.browser.test.js`.
