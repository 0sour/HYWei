# BALANCE.md — difficulty model and measurement (official numbers, no custom tuning)

Owner: match / balance. Tools: `tools/balance.mjs` (competent-board model — now a **measuring** tool only),
`tools/matchrun.mjs` (bot matches). Tests: `test/match/balance.test.js`, `test/match/waves-official.test.js`,
`test/match/waves.test.js`, `test/sim/pathing.test.js`.

**Every enemy number is the official one; the custom balance layer was removed** (user request: rules, numbers, enemy
kinds / counts and routes must follow the official game; research 08 §6–§7, DESIGN §14 corrections):

* waves = the client's `RandomEnemyGenerater` (research 08 §2): a 15-slot type schedule per match (3 types × 3 slots +
  6 SPECIAL, shuffled), one weighted special entry per round, each placeholder ACTION replaced by
  `clamp(roundHalfEven(n·P(t)/P(new)), 1, 5)` units over the same window, the other movement class not spawned — no
  `k` copies, no kept fly placeholders; verified against all 429 official entry × round compositions and the official
  count distribution (同盟 险境 R3 ≤ 10 enemies, R13 ≈ 37 — the old generator averaged 28 / 81);
* stats = the PRTS per-round `enemyScale` table only (`data/config.json`, 终极 ×1.15 speed from R3);
* leader pool = `bloodPoint[difficulty]` (co-op; one pool for the split leaders, no alive-player factor — solo keeps
  ×0.25, flagged [ASSUMED] in data);
* bounties: no extra ×0.7 in solo (the 70 % base is already in `enemyScale`), spawned with the template's first normal
  action (research 08 §5);
* routes = the official 4-direction flow field with crates at cost 1000 (research 08 §3), act1 m02 without crates.

**Removed:** every `enemyHpMul` / `enemyAtkMul` / `enemySpeedMul` / `bossHpMul` of `data/tuning.json` (it now holds only
the `titles.comment_3` rule) and the `flyPlaceholders` knob. `gamedata.js` ignores those keys if an old file carries them.

**Measured with the official numbers** (`node tools/balance.mjs --mode all --difficulty ALL --tuning off`, 2026-09-28):
average capped leaks per board and round R1–R13 (solo 标准 R1–R8) of the competent board of §1.1 —

| mode | old generator, research numbers | old generator, tuned (shipped before) | **official (now)** | LP/rd after 联防 |
|---|---|---|---|---|
| 独立 标准 | 1.3 | 0.6 | **0.17** | (= leaks) |
| 独立 险境 | 1.4 | 0.9 | **0.19** | (= leaks) |
| 独立 绝境 | 1.8 | 1.8 | **0.22** | (= leaks) |
| 独立 终极 | 4.1 | 3.1 | **0.65** | (= leaks) |
| 同盟 标准 | 1.4 | 0.5 | **0.31** | 0.13 |
| 同盟 险境 | 2.3 | 1.3 | **0.49** | 0.01 |
| 同盟 绝境 | 5.0 | 2.7 | **0.80** | 0.10 |
| 同盟 终极 | 6.3 | 4.3 | **1.96** | 0.93 |

The old generator spawned 2–4× the official enemy count (every template enemy × k, plus the other class's
placeholders); the tuning of the previous pass only compensated for that. With the official counts the difficulty
comes out below the old targets — which is the official game's difficulty as far as this model can tell (the model is a
competent, layer-rich board; see §1.2 for what it does not capture). Nothing is tuned from these numbers.

---

## 1. Method — `tools/balance.mjs`

For every mode (独立 solo / 同盟 multi) × difficulty × round the tool samples whole matches (stage, the 3 factions, bans,
boss, band and lineups all vary with the seed), builds a **competent board for that round**, generates the round's
real wave (`waves.js`: template, the official per-action replacement of the round's pick, enemy scaling, bounties off)
and runs the real
`Battle` with full content (kits, talents, bonds with layers, IN_BATTLE 特质, equipment, bands, summons). Co-op rounds
field **4 boards** against the same wave and then run **联防** exactly like the match (`unite.js`: ≤ 2 perfect helpers,
only the survivors cost their source LP). Boss rounds build the Final Assault fields exactly like `Match.startFinalAssault`
(pairs / `_s` for a lone player, shared pool `GameData.bossPoolHp` = `bloodPoint` (solo ×0.25), merged team LP of 15 per player, leaks' `lpr`,
−1 LP/s after 150 s) and record the pool damage by 150 s, the kill time and the win rate.

Metrics: **capped leaks** = min(leaks, 10) per board and round (what that board alone would lose; the targets below
use it — raw means are dominated by swarm rounds that cap at 10 anyway), **LP/rd after 联防** (co-op), perfect-round
share, the enemies that leak most, clear time; bosses: share of the pool dealt by 150 s, win rate, kill time.

### 1.1 The competent board of round r

| R | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| shop level | 1 | 1 | 2 | 2 | 3 | 3 | 4 | 4 | 4 | 5 | 5 | 6 | 6 | 6 | 6 |
| units | 2 | 4 | 5 | 7 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 |
| elites (精锐) | 0 | 0 | 0 | 0.5 | 1 | 1.5 | 2 | 3 | 3.5 | 4 | 4.5 | 5 | 6 | 6.5 | 7 |
| equipment | 0 | 0.5 | 1 | 1.5 | 2 | 3 | 3.5 | 4 | 5 | 5.5 | 6 | 7 | 8 | 9 | 9 |
| core bond members | – | – | 3 | 3 | 3 | 3 | 3 | 3 | 4 | 5 | 6 | 6 | 6 | 6 | 6 |
| core bond layers | 0 | 2 | 6 | 12 | 20 | 28 | 38 | 50 | 65 | 80 | 95 | 110 | 130 | 150 | 170 |
| add-on layers (each) | 0 | 1 | 4 | 8 | 12 | 17 | 23 | 30 | 38 | 46 | 55 | 65 | 75 | 90 | 100 |

(fractional values: that many on average.) Sources: income 4, 5, 6 … min(3 + r, 12) and upgrade prices 5 / 8 / 11 /
12 / 13 with −1 per round (research 00-INDEX §3) → L2 at R3, L3 at R5, L4 at R7, L5 at R10, L6 at R12; the board is
full from R5; elites ≈ 0 at R3 → 3 at R8 → 6+ at R13; 1–2 add-on bonds; the layer pace reaches Σ active layers ≈ 330
at R14 — the solo Hidden Core threshold is > 350 (research 02 §2.3), i.e. these are boards of players who *regularly*
reach the Hidden Core. Units are drawn from the match's pool (bans respected) with a tier mix per shop level, around a
core bond with enough members, plus the roles a player reads from the wave preview: 2 blockers, anti-air by the share of
flyers, arts dealers by the armour of the enemies (arts anti-air when the flyers are armoured, e.g. 寒霜 DEF 600), a
medic from R5. Equipment: passive combat items of tier ≤ shop level (golden from R7) on the damage dealers. Layers: the
core curve on the core bond, the add-on curve on every other bond the lineup activates. Placement: the bot's layout
planner with rehearsal of its 5 variants (a player adapts the layout to the previewed wave). Not modeled: bounties, 机变
cards, prep-only effects (their value is folded into the curves). `--profile weak|strong` scales elites, items and
layers ×0.6 / ×1.4.

### 1.2 Reference levels (informative — nothing is tuned against them any more)

The previous pass tuned the waves toward: 标准 ≤ 1 capped leak per board and round, 险境 ≤ 2, 绝境 ≈ 2–3.5, 终极 ≈ 3–5.
They are kept only to read the measurement. What the model does NOT capture (so real matches are harder than the
table): imperfect economy and placement, bans hitting the planned bonds, 机变 / bounty choices (bounties add enemies),
the preview being read by a human in 90 s, and losing LP early (fewer rounds to build layers).

---

## 2. What the numbers were checked against (research first)

| Suspect | Research | Verdict |
|---|---|---|
| Enemy multipliers (`config.modes[m].enemyScale`, `k` exponents) | A3 table (PRTS 下半, user-sourced) — 01-core-rules.md A3 / `_criticAddendum.enemyStatMultipliers` | **match exactly** (every mode, every round incl. ABYSS HP k and ×1.08); kept as the base |
| Wave templates / counts | level data (`maxPlayTime`, spawns, routes) — DATA | match the official levels; kept |
| Faction replacement | was: each template enemy × `k` [ASSUMED] | **replaced by the official per-action rule** (research 08 §2.3, client code) |
| Fly placeholders without a FLY faction | was: kept (寒霜 / 暴鸰 / 妖怪, the #1 leak source) [ASSUMED] | **official: the other movement class is not spawned** (research 08 §2.3 + the PRTS screenshots) |
| Faction mixing | was: every round a ground entry + a FLY entry | **official: one entry per round from a 15-slot type schedule** |
| `MOVE_SCALE` 0.5 | every level's `moveMultiplier` 0.5 (05 §2.2) | kept |
| **Combat time limit unit** | `maxPlayTime` read as game seconds [ASSUMED] | **wrong — real seconds; fixed** (§2.1) |
| Boss pool | bloodPoint DATA; co-op "敌方领袖的总生命值不变" | **co-op = bloodPoint, no alive scaling**; solo ×0.25 kept [ASSUMED]; the solo 标准 ×0.6 removed |
| Solo bounties ×0.7 | 上半 11/18 note = the global solo base | **removed** (already in enemyScale) |
| Bounty spawn timing | was: the bounty units appended after the host action's own units | **official: inserted among them at floor((i+1)·len/(n+1)), then the list spread over the window** (client `_InsertSpActionToNormal` + `_CalculateActionPredelay`, decoded; `waves.js withBounties`) |
| 联防 spawn timing | was: owner k at +min(0.5·k, 5) s, each owner's units over the whole window [ASSUMED] | **official (decoded `_CalculateActionPredelayConsiderUid`): owner k at +0.5·k s, unit step min(max(W/M, 0.05·W), 5 s), M = largest owner group** — a lone leaker's units now come 5 s apart instead of up to 40 s |
| Leader / leader-part multipliers | was: leaders and their parts never scaled | **official: the round multipliers are the ENEMY effects 攻坚装备 / II / III / 补给线 / 急行军 (`enemy_attribute_mul`; `enemy_exclude` = 炎佑 — plus the TIMES tokens for 补给线 — never a leader) ⇒ parts take HP/ATK/speed, the leader ATK/speed; only the leader's HP (the server pool) is exempt** ("领袖单位于服务器的生命值加成不受上述加成影响"). Co-op 终极 R14: leader ATK ×2.14; solo 标准: ×0.7 |
| Ground routes | was: 8-dir A*, m02 crates active | **official 4-dir SPFA + smoothing, crates cost 1000, m02 without crates** (research 08 §3) |
| Income / upgrade curve | R1–R3 VERIFIED, +1/round cap 12 ASSUMED | kept (the model's level curve follows it) |
| Operator stats per tier | chess status T1 E1 L55 … T6 E2 L1, elites E2 + skill 7 (03) — DATA | faithful: power comes from layers, elites and skills, which is why the model carries them |
| Player power in the bots | bots fielded T1-heavy boards with 0–3 elites and 20–70 layers per bond at R13 | bot fixes (§5) |

### 2.1 Combat time limits are real seconds (fidelity fix)

`maxPlayTime` counts **real** seconds of the forced 2× battle. Read as game seconds (the old assumption) the rounds' own
spawn schedules do not fit: R2 spawns its last flyer at 43 s of a 45 s limit, R3 its last enemies at 60–62 s of a 55 s
limit (they could never be killed, or never even spawned). As real seconds (× 2 in game seconds) every limit is ≈ the
last spawn + one flyer crossing of the board (≈ 44 s serpentine at 0.45 tiles/s): R2 43 + 44 ≈ 90, R3 62 + 44 ≈ 110,
R5 38 + 67 ≈ 110 (暴鸰 at 0.3 tiles/s).

| R | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `maxPlayTime` (real s) | 45 | 45 | 55 | 55 | 55 | 70 | 85 | 85 | 95 | 95 | 115 | 115 | 115 |
| last spawn (game s) | 15 | 43 | 62 | 39 | 38 | 42 | 56 | 67 | 75 | 59 | 68 | 60 | 73 |
| slack, old reading | 30 | **2** | **−7** | 16 | 17 | 28 | 29 | 18 | 20 | 36 | 47 | 55 | 42 |
| slack, fixed (× 2) | 75 | 47 | 48 | 71 | 72 | 98 | 114 | 103 | 115 | 131 | 162 | 170 | 157 |

Before the fix 90–100 % of the early "leaks" were enemies still alive (often just spawned) at the limit, not enemies that
reached the objective. `gd.combatTimeLimit(r)` now returns game seconds (`config.combatTimeScale`, default 2); the
player-facing combat countdown is unchanged (= `maxPlayTime` real seconds). Research 00-INDEX §8 #10 should be updated
by its owner.

### 2.2 The fly placeholders (resolved)

The previous pass measured that the kept fly placeholders (寒霜 DEF 600, 暴鸰) were the most frequent leakers and left a
`flyPlaceholders` knob for experiments. The official client settles it: a placeholder whose class differs from the
round's pick is `isValid = false` — not spawned, not sent, not previewed (research 08 §2.3). The knob is gone.

---

## 3. Measurement per round (official numbers)

Capped leaks per board (16 solo samples / 6 co-op matches × 4 boards per round), `--tuning off` (identical: the
tuning file holds only titles), seed 1, rehearsal 5. Leader columns: win rate, share of the pool dealt by 150 s, mean
kill time (8 samples). Re-measured after the review fixes (decoded 联防 timing; leaders take the round ATK / speed
multipliers, their parts all of them): normal rounds unchanged, leader rounds and LP/rd as below.

| mode | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12 | R13 | avg | LP/rd |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 独立 标准 | 0.13 | 0.06 | 0.00 | 0.13 | 0.63 | 0.00 | 0.25 | 0.19 | – | – | – | – | – | 0.17 | 0.17 |
| 独立 险境 | 0.00 | 0.00 | 0.00 | 0.31 | 0.00 | 0.00 | 0.63 | 0.19 | 0.06 | 0.00 | 0.00 | 0.63 | 0.63 | 0.19 | 0.19 |
| 独立 绝境 | 0.00 | 0.00 | 0.00 | 0.00 | 0.38 | 0.00 | 0.00 | 0.25 | 0.63 | 0.50 | 0.44 | 0.63 | 0.00 | 0.22 | 0.22 |
| 独立 终极 | 0.13 | 0.00 | 0.19 | 0.25 | 1.00 | 0.88 | 0.44 | 0.81 | 1.50 | 0.94 | 1.13 | 0.06 | 1.19 | 0.65 | 0.65 |
| 同盟 标准 | 0.00 | 0.54 | 0.00 | 0.00 | 1.13 | 0.00 | 1.25 | 0.13 | 0.88 | 0.04 | 0.00 | 0.04 | 0.00 | 0.31 | 0.13 |
| 同盟 险境 | 0.00 | 0.00 | 0.83 | 0.17 | 0.00 | 0.00 | 0.17 | 0.25 | 1.58 | 0.04 | 0.46 | 2.21 | 0.71 | 0.49 | 0.01 |
| 同盟 绝境 | 0.00 | 0.00 | 0.38 | 1.00 | 0.71 | 1.17 | 0.50 | 0.92 | 1.88 | 2.50 | 0.63 | 0.71 | 0.00 | 0.80 | 0.10 |
| 同盟 终极 | 0.00 | 0.04 | 0.21 | 0.92 | 0.83 | 2.79 | 4.00 | 6.00 | 3.83 | 1.29 | 3.71 | 0.83 | 0.96 | 1.96 | 0.93 |

| mode | 最终攻势 (R14; solo 标准 R9) | 隐秘核心 (R15) |
|---|---|---|
| 独立 标准 | pool 64k · win 50 % · 80 % by 150 s · 89.8 s | – |
| 独立 险境 | pool 169k · win 88 % · 97 % · 19.5 s | pool 237k · win 100 % · 100 % · 22.2 s |
| 独立 绝境 | pool 456k · win 63 % · 86 % · 57.0 s | pool 869k · win 50 % · 70 % · 71.1 s |
| 独立 终极 | pool 899k · win 38 % · 79 % · 42.0 s | pool 1.63M · win 25 % · 48 % · 44.9 s |
| 同盟 标准 | pool 224k · win 100 % · 100 % · 18.0 s | – |
| 同盟 险境 | pool 550k · win 100 % · 100 % · 22.0 s | pool 919k · win 100 % · 100 % · 37.8 s |
| 同盟 绝境 | pool 1.68M · win 88 % · 99 % · 32.6 s | pool 3.42M · win 88 % · 94 % · 100.9 s |
| 同盟 终极 | pool 3.70M · win 88 % · 95 % · 41.9 s | pool 6.08M · win 75 % · 87 % · 92.6 s |

Reading: the early game is easy everywhere (official R1–R3 bring 3–10 enemies); leaks concentrate on the second-half
specials (深池逐火 TIMES embers, stealth 隐形弩手组长 / 重弩突袭者, 疯狂的逐腐兽, 掠海漂移体) and 终极 R6–R11, where co-op
boards still leak 3–6 and 联防 halves the LP cost. Solo leaders (bloodPoint × 0.25 [ASSUMED]) are the hard part of the
solo modes; the solo pool factor is the one open number here (research 08 §8 #2).

Reproduce: `node tools/balance.mjs --mode all --difficulty ALL --tuning off [--bots 5] [--json]`.

---

## 4. The tuning — removed

The previous pass layered per-round enemy HP × s / ATK × √s (all 8 modes, e.g. 同盟 险境 R13 HP × 0.55) and the solo
标准 leader pool × 0.6 on top of the research numbers, to compensate for the old generator's 2–4× enemy counts. Research
08 decoded the official generator, so the compensation is gone together with its cause: `data/tuning.json` keeps only
`titles.comment_3` (坚若磐石 = least LP lost), `gamedata.js` has no multiplier layer (`enemyScale(r)` = the config table,
`bossHpMul()` = 1, `bossPoolHp()` = the official pool). Difficulty questions are now answered by measuring (§3), not by
tuning. `tools/balance.mjs --tuning` remains accepted and has no effect on the numbers.

---

## 5. Bots (server/match/bot.js)

As found the bots lost every merge reward made while buying (the free pick-one offer queued by a merge expires at prep
end; they only looked at offers when the prep opened), levelled late (L2 at R4 … L6 at R13), valued a T6 barely above a
T1 and ignored the 特质 that produce layers — at R13 they fielded T1-heavy boards with 0–3 elites and 20–70 layers per
bond (model: 6 elites, 130 / 75). Changes: offers are taken after every buy loop, the level curve is the competent one
(early levels only with a full board), tier power 10 → 25 (was 19.5 for T6), recurring layer 特质 (every prep /
refresh) and 获得时 layer / economy 特质 add value, and boss rounds are planned against the boss field (the leader
counts as 10 tough enemies with a 30 s dwell on its first tiles, so stationary leaders such as 阿利斯泰尔 get hit).

| mode | as found (before the fixes*) | research + time fix | **tuned** | **official waves (now, seeds 1–5)** |
|---|---|---|---|---|
| 独立 标准 (1 AI) | 6.7 rounds · 3/10 wins · [5 5 9 9 5 7 6 8 4 9] | 8.1 rounds · 5/10 wins · [7 7 9 9 6 8 9 9 8 9] | **8.9 rounds · 9/10 wins · [9 9 9 9 8 9 9 9 9 9]** | **8.8 · 4/5 · [9 9 9 9 8]** |
| 独立 险境 (1 AI) | 6.5 rounds · 1/10 wins · [5 4 11 4 5 9 3 7 3 14] | 8.4 rounds · 1/10 wins · [7 6 13 6 8 11 6 8 5 14] | **10.1 rounds · 3/10 wins · [9 14 14 7 9 11 9 9 5 14]** | **13.2 · 3/5 · [14 14 13 14 11]** |
| 独立 绝境 (1 AI) | 6.9 rounds · 1/10 wins · [5 5 11 5 5 7 3 14 3 11] | 8.6 rounds · 1/10 wins · [7 5 12 8 13 8 6 9 4 14] | **8.6 rounds · 1/10 wins · [7 5 12 8 13 8 6 9 4 14]** | **13.2 · 1/5 · [13 14 13 13 13]** |
| 独立 终极 (1 AI) | 5.0 rounds · 0/10 wins · [4 4 7 3 3 7 3 7 3 9] | 5.9 rounds · 0/10 wins · [5 4 8 5 5 7 4 7 4 10] | **6.1 rounds · 0/10 wins · [5 4 10 5 4 7 4 7 4 11]** | **11.4 · 0/5 · [13 8 13 11 12]** |
| 同盟 标准 (4 AI) | 9.1 rounds · 2/10 wins · [9 4 14 11 9 11 6 8 5 14] | 11.6 rounds · 3/10 wins · [11 8 14 12 13 14 8 11 11 14] | **14.0 rounds · 10/10 wins · [14 14 14 14 14 14 14 14 14 14]** | **14.0 · 5/5 · [14 14 14 14 14]** |
| 同盟 险境 (4 AI) | 6.6 rounds · 0/10 wins · [9 4 8 7 8 6 5 6 4 9] | 9.3 rounds · 0/10 wins · [10 6 12 11 10 7 7 9 9 12] | **11.1 rounds · 2/10 wins · [11 8 14 11 12 7 13 10 11 14]** | **14.0 · 5/5 · [14 14 14 14 14]** |
| 同盟 绝境 (4 AI) | 4.9 rounds · 0/10 wins · [6 4 6 4 6 6 5 4 3 5] | 7.0 rounds · 0/10 wins · [7 5 8 7 7 7 6 8 5 10] | **8.9 rounds · 0/10 wins · [9 6 10 9 9 8 8 11 7 12]** | **11.2 · 0/5 · [12 9 13 10 12]** |
| 同盟 终极 (4 AI) | 5.2 rounds · 0/10 wins · [6 4 6 5 5 6 5 5 4 6] | 6.3 rounds · 0/10 wins · [6 5 7 6 6 7 6 6 5 9] | **7.2 rounds · 0/10 wins · [6 5 9 6 8 7 7 8 6 10]** | **9.8 · 0/5 · [10 7 13 8 11]** |

Official-waves column: `node tools/balance.mjs --mode all --difficulty ALL --bots 5` (rounds passed avg · wins · per
seed), measured before the review's leader-multiplier / 联防-timing fixes (§2; not re-run); the other columns are the
previous pass (old generator), kept for history. \* the bot code of this pass (§5) with the old time reading and no tuning; the originally reported bots (old bot code) survived ≈ 6.5 rounds on 险境 and won 1/20 on 标准.

---

## 6. Match follow-ups shipped with this pass

* Multi-round bounties ("之后的每场作战") also spawn in the Final Assault / Hidden Core, on the owner's half (route to
  its goal), are shown in the boss-round preview, and the boss battle uses up one of their battles (kill coins →
  pending funds for the Hidden Core prep).
* A 驰援 card is never offered when its bond has no chess left in the match's pool (every member banned).
* docs/META.md §2.6 example guards `ctx.source.kind === 'choice'` (its EffectRef reuses the handler's key).
* 坚若磐石 = least LP lost (`titles.comment_3 { stat: 'lpLost', rule: 'min' }` in tuning.json; results.js supports
  `rule: 'min'` among the players still alive).
* 教鞭 / “神秘顾客” stay a random bounty, documented in docs/META.md §2.5.
