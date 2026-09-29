// server/sim/Battle.js — one field simulation (normal / unite / boss / hidden). Public API: DESIGN §5.1.
//
//   const b = new Battle({ seed, kind, modeId, round, stage|stageId, rect, timeLimit, players, spawns, routes,
//                          sharedBoss, flags, fieldId?, data?, content?, recordEvents?, logger? })
//   b.step(); b.finished; b.forceEnd(reason); b.time; b.result(); b.snapshot(); b.drainEvents(); b.on/off(...)
//
// Construction creates every ally unit (undeployed) and installs content (kits + domain modules). The first
// step() (or an explicit start()) deploys everything (top→bottom, left→right; mirrored for the right boss side),
// fires `deploy` (initial) for each unit and then `battleStart`.
// Tick order: scheduled callbacks → spawns → DP → buffs → enemies (attack, move, block) → enemy index →
//   allies (skill tick, attack) → projectiles → redeploys → boss sync → `tick` hook → release hooks of removed units →
//   time += TICK → end checks. A forceEnd() requested mid-step ends the step after the current phase (docs/SIM.md §1.4).
// Board → field coordinates: units are given in board coordinates (rows 9–12, cols 2–10). Normal/unite:
//   (row, col + colOffset). Boss/hidden: row − 7 when row ≥ 7 (board rows → boss rows 2–5); side 'R' mirrors
//   the column (col → 20 − col) and mirrors the direction (RIGHT ↔ LEFT, UP / DOWN kept). Every ally has a direction
//   `dir` (UP|RIGHT|DOWN|LEFT, default RIGHT — PlayerBattleInput unit `dir`, sim/dir.js) that rotates its range grid.
//   `abs: true` on a unit (or player `coords: 'field'`) = field tiles (and field directions).
// Robustness: every content callback and every step phase is wrapped; errors are logged once per key and the
// battle continues. After MAX_INTERNAL_ERRORS the battle force-ends as a timeout.

import { TICK, ROWS, COLS, DP_DEFAULTS, DOWN_STATE, MAX_BATTLE_TIME, MAX_INTERNAL_ERRORS, COLD_FREEZE_DURATION, OBSTACLE_DEVICES, EVENT_BUFFER_CAP, BOSS_ROW_OFFSET, MAX_HOOK_DEPTH, MAX_ALIVE_ENEMIES, LEVITATE_HALF_WEIGHT, RESIST_DEFAULT, RESIST_PALSY_DECAY } from './constants.js';
import { GEO } from '../../shared/constants.js';
import { createRng } from './rng.js';
import { Grid } from './grid.js';
import { Unit } from './units.js';
import { makeBuff, STATUS, RESIST_STATUSES } from './buffs.js';
import { dealDamage as pipeDamage, heal as pipeHeal, applyHpLoss, makeDamageInfo, reduceElement, palsyBuff, elementView } from './damage.js';
import { absoluteRangeKeys, canTargetEnemy } from './targeting.js';
import { normDir, mirrorDir, localOrder, localBefore } from './dir.js';
import { ProjectileSystem } from './projectiles.js';
import { SkillRuntime } from './skills.js';
import { updateAlly, updateEnemy, compileRoute, remainingDistance, effectiveProfile, performAttack, acquireTargets } from './ai.js';
import { resolveProfile } from './professions.js';
import { unitInfo, snapshotUnits } from './snapshot.js';
import { toDataSource, normalizeRoute, normalizeStage, normalizeToken, normalizeEnemy } from './simdata.js';
import { installContent, setupUnitKit } from './content/index.js';

const DEFAULT_RECTS = { normal: GEO.NORMAL_RECT, unite: GEO.UNITE_RECT, boss: GEO.BOSS_RECT, hidden: GEO.BOSS_RECT };
let hookSeq = 0;
let schedSeq = 0;

/** Finite number or the default (content may pass undefined/NaN/Infinity/strings to helpers). */
const fin = (v, d) => { const n = typeof v === 'number' ? v : (v == null || v === '' ? NaN : Number(v)); return Number.isFinite(n) ? n : d; };

function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}

const FALLBACK_ENEMY = Object.freeze({
  type: 'enemy', id: 'enemy_unknown', key: 'enemy_unknown', name: '未知敌人', rank: 'NORMAL', maxHp: 2000, atk: 200, def: 100, res: 0,
  aspd: 100, bat: 2, rangeRadius: 0, moveSpeed: 1, massLevel: 1, lpr: 1, motion: 'WALK', applyWay: 'MELEE', dmgType: 'phys',
  immune: new Set(), tauntLevel: 0, blockCnt: 1, epResistance: 0, epDamageResistance: 0, hpRecoveryPerSec: 0, notCountInTotal: false,
  tags: [], abilities: [], skills: [], talent: {}, spine: 'unknown', avatar: 'unknown', raw: {},
});

export class Battle {
  constructor(opts = {}) {
    this.opts = opts;
    this.seed = (Number(opts.seed) >>> 0) || 1;
    this.rng = createRng(this.seed);
    this.kind = opts.kind ?? 'normal';
    this.modeId = opts.modeId ?? null;
    this.round = opts.round ?? 0;
    this.fieldId = opts.fieldId ?? null;
    this.logger = opts.logger ?? console;
    this.recordEvents = opts.recordEvents !== false;
    /** When false the battle only ends by time limit / boss pool / forceEnd (tests, sandboxes). */
    this.autoFinish = opts.autoFinish !== false;
    this.data = toDataSource(opts.data);
    let stage = opts.stage ?? (opts.stageId ? this.data.getStage(opts.stageId) : null);
    if (stage && !stage._norm) stage = normalizeStage(stage.id ?? opts.stageId, stage);
    this.stage = stage || { id: 'empty', rows: [], devices: [] };
    this.stageId = this.stage.id ?? opts.stageId ?? null;
    this.rect = { ...(opts.rect ?? DEFAULT_RECTS[this.kind] ?? GEO.NORMAL_RECT) };
    { // a malformed rect (non-integers, inverted, off the stage) falls back to the kind's default field
      const R = this.rect;
      const ok = [R.r0, R.r1, R.c0, R.c1].every(Number.isInteger) && R.r0 >= 0 && R.c0 >= 0 && R.r1 < ROWS && R.c1 < COLS && R.r0 <= R.r1 && R.c0 <= R.c1;
      if (!ok) this.rect = { ...(DEFAULT_RECTS[this.kind] ?? GEO.NORMAL_RECT) };
    }
    this.grid = new Grid(this.stage, this.rect);
    const bossLike = this.kind === 'boss' || this.kind === 'hidden';
    // A bad limit (0, negative, NaN — e.g. a missing config row) must not turn a normal round into an endless one:
    // non-boss kinds fall back to 60 s; only boss/hidden (or an explicit Infinity) run without a limit.
    const tl = Number(opts.timeLimit);
    this.timeLimit = opts.timeLimit == null || !(tl > 0) ? (bossLike ? Infinity : 60) : tl;
    this.flags = { layerGainsEnabled: this.kind === 'normal', ...DP_DEFAULTS, ...(opts.flags || {}) };
    // DP knobs may arrive as undefined/null/strings (e.g. a template without `dp`): never let them poison DP with NaN.
    for (const k of ['dpInit', 'dpPerSec', 'dpMax']) {
      const v = Number(this.flags[k]);
      this.flags[k] = this.flags[k] != null && Number.isFinite(v) && v >= 0 ? v : DP_DEFAULTS[k];
    }
    this.sharedBoss = opts.sharedBoss ?? null;
    this.routes = (opts.routes ?? []).map((r) => normalizeRoute(r));
    /** Per-template enemy overrides `{ [enemyKey]: { stats: {…partial} } }` (waves.json `overrides`). */
    this.enemyOverrides = opts.enemyOverrides ?? {};
    this.dt = TICK;
    this.time = 0;
    this.tickCount = 0;
    this.finished = false;
    this.reason = null;
    this.started = false;
    /** @type {Unit[]} every unit ever created */
    this.units = [];
    /** @type {Unit[]} alive enemies (compacted each tick) */
    this.enemies = [];
    /** @type {Unit[]} every ally unit (ops, tokens, devices; dead included) */
    this.allyUnits = [];
    this._hooks = Object.create(null);
    this._emitDepth = 0;
    this._frameName = new Array(MAX_HOOK_DEPTH).fill(null);   // open hook/callback frames (diagnostics, _chain)
    this._frameOwner = new Array(MAX_HOOK_DEPTH).fill(null);
    this._frameCtx = new Array(MAX_HOOK_DEPTH).fill(null);
    this._toRelease = [];   // permanently removed units whose hooks / periodic timers are dropped at step end
    this._sched = [];
    this._evq = [];
    this.projectiles = new ProjectileSystem(this);
    this._occ = new Array(ROWS * COLS).fill(null);
    this._eb = new Array(ROWS * COLS);
    for (let i = 0; i < this._eb.length; i++) this._eb[i] = [];
    this._ebUsed = [];
    this._idSeq = 0;
    this._attackSeq = 0;   // DamageInfo.attackId of normal attacks (one id per attack, all its damage instances)
    this._deploySeq = 0;
    this._spawnSeq = 0;
    this._enemiesDirty = false;
    this.killed = 0;
    this.total = 0;
    this.leakedCount = 0;
    this.errors = [];
    this.errorCount = 0;
    this._errKeys = new Set();
    this._result = null;
    this._skills = { onDamaged: (u) => { if (u.skill) u.skill.onDamaged(); } };
    this.remainingDistance = (e) => remainingDistance(this, e);

    // ---- players
    this.players = [];
    this._perPlayer = Object.create(null);
    for (const p of opts.players ?? []) if (p && typeof p === 'object') this._addPlayer(p);

    // ---- spawns
    this._pending = [];
    for (const s of opts.spawns ?? []) if (s && typeof s === 'object') this._safe(() => this._queueSpawn(s, true), 'queueSpawn');
    this._pending.sort((a, b) => a.time - b.time || a.seq - b.seq);

    // ---- content
    this.contentMode = opts.content ?? 'full';
    this._safe(() => installContent(this, { mode: this.contentMode, extra: opts.extraContent }), 'installContent');
    for (const u of this.allyUnits) if (!u.kit) this._setupUnit(u);
    if (typeof opts.setup === 'function') this._safe(() => opts.setup(this), 'opts.setup');
  }

  // =============================================================================================================
  // players & units

  _addPlayer(p) {
    const bossLike = this.kind === 'boss' || this.kind === 'hidden';
    const side = p.side === 'R' ? 'R' : 'L';
    const mirror = bossLike && side === 'R';
    const ps = {
      playerId: p.playerId,
      seat: p.seat ?? this.players.length,
      side,
      colOffset: Number(p.colOffset) || 0,
      rowOffset: p.rowOffset,
      coords: p.coords ?? 'board',
      mirror,
      facing: mirror ? -1 : 1,
      // default direction of this player's units on this field (the FA right side is mirrored: RIGHT ↔ LEFT)
      dir: mirror ? 'LEFT' : 'RIGHT',
      half: mirror || (Number(p.colOffset) || 0) >= 8 ? 'R' : 'L',
      bonds: clone(p.bonds ?? {}),
      bandId: p.bandId ?? null,
      playerEffects: clone(p.playerEffects ?? []),
      lpForBoss: p.lpForBoss ?? null,
      dp: this.flags.dpInit,
      units: [],
      input: p,
    };
    this.players.push(ps);
    this._perPlayer[ps.playerId] = {
      killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, coins: 0,
      damageDealt: 0, bossDamage: 0, healingDone: 0, deaths: 0, unitsEnd: [], unitStats: [],
    };
    const late = [];
    for (const u of p.units ?? []) {
      try {
        const unit = this._createAllyFromInput(ps, u);
        if (unit && unit.kind === 'token' && !unit.ownerUnit && u.ownerUid != null) late.push([unit, u]);
      } catch (e) { this._internalError('createUnit', e); }
    }
    // a token piece listed before its owner (board order is top→bottom) is linked once every unit exists, and takes
    // the owner-level variant (elite owners: `_b` stats) of the owner's loadout (DESIGN §16)
    for (const [t, inp] of late) {
      const owner = ps.units.find((x) => x.kind === 'op' && x.uid === inp.ownerUid);
      if (!owner) continue;
      t.ownerUnit = owner;
      const def = inp.def ? null : this._tokenDef(inp.tokenId ?? inp.chessId, owner, null);
      if (!def || def === t.def) continue;
      const st = def.stats;
      t.def = def; t.defId = def.id; t.name = def.name; t.rangeGrid = def.rangeGrid;
      Object.assign(t.base, {
        maxHp: st.maxHp, atk: st.atk, def: st.def, res: st.res, aspd: st.aspd, bat: st.bat, blockCnt: st.blockCnt, spRecovery: st.spRecovery,
        tauntLevel: st.tauntLevel, massLevel: st.massLevel, hpRecoveryPerSec: st.hpRecoveryPerSec, cost: st.cost, respawnTime: st.respawnTime,
      });
      t.markDirty();
      t.hp = t.s.maxHp;
    }
  }

  /** Board → field tile for a player (see header). */
  mapTile(ps, row, col, abs = false) {
    if (abs || ps.coords === 'field') return [row, col];
    const bossLike = this.kind === 'boss' || this.kind === 'hidden';
    let r = row;
    if (ps.rowOffset != null) r = row + ps.rowOffset;
    else if (bossLike && row >= 7) r = row + BOSS_ROW_OFFSET;
    const c = ps.mirror ? (col <= 10 ? COLS - 1 - col : col) : col + ps.colOffset;
    return [r, c];
  }

  /**
   * Board direction → field direction for a player (DESIGN §3): as given (default RIGHT) except on the mirrored Final
   * Assault right side, where RIGHT ↔ LEFT (UP / DOWN unchanged). `abs` / field coordinates are taken as they are.
   */
  mapDir(ps, dir, abs = false) {
    const d = normDir(dir);
    return ps && ps.mirror && !abs && ps.coords !== 'field' ? mirrorDir(d) : d;
  }

  _createAllyFromInput(ps, inp) {
    // coerce (a string row would otherwise concatenate: "10" + -7 → "10-7"); non-integers never deploy
    const row = Number(inp.row), col = Number(inp.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) { this.log(`bad tile ${inp.row},${inp.col} for ${inp.chessId ?? inp.tokenId}`); return null; }
    const [r, c] = this.mapTile(ps, row, col, !!inp.abs);
    const dir = this.mapDir(ps, inp.dir, !!inp.abs);
    if (inp.kind === 'token') {
      const owner = inp.ownerUid != null ? ps.units.find((x) => x.uid === inp.ownerUid) : null;
      const def = this._tokenDef(inp.tokenId ?? inp.chessId, owner, inp.def);
      if (!def) { this.log(`unknown token ${inp.tokenId}`); return null; }
      const u = this._makeAlly(ps, def, 'token', r, c, { uid: inp.uid, ownerUnit: owner, dir });
      u.carry = inp.carryState ?? null;
      return u;
    }
    // the unit's own loadout (DESIGN §16): an entry without loadout fields is the DEFAULT — never another player's
    // choice for the same chess id in a multi-player field (the per-battle data view maps id-only lookups)
    const def = this.data.getChess(inp.chessId, { skillIndex: inp.skillIndex ?? null, moduleId: inp.moduleId ?? null });
    if (!def) { this.log(`unknown chess ${inp.chessId}`); return null; }
    const u = this._makeAlly(ps, def, 'op', r, c, { uid: inp.uid, dir });
    u.items = [...(inp.items ?? [])];
    u.carry = inp.carryState ?? null;
    return u;
  }

  /**
   * Token def: an inline def (PlayerBattleInput `def`, spawnToken `opts.def`) as given, else the data record's variant
   * for the owner — `owner` = the owning ally unit (its chess and its selected skill / module: getToken(id,
   * owner.defId, owner.def.loadout), DESIGN §16), a chess id, or null.
   */
  _tokenDef(tokenId, owner, inline) {
    if (inline) return normalizeToken(tokenId, inline);
    if (!this.data.getToken) return null;
    if (owner && typeof owner === 'object') return this.data.getToken(tokenId, owner.defId ?? null, owner.def?.loadout ?? null);
    return this.data.getToken(tokenId, owner ?? null);
  }

  _makeAlly(ps, def, kind, r, c, extra = {}) {
    const st = def.stats;
    const u = new Unit({
      id: ++this._idSeq, side: 'ally', kind, def, defId: def.id, name: def.name, ownerId: ps ? ps.playerId : null,
      uid: extra.uid ?? null, ownerUnit: extra.ownerUnit ?? null, x: c, y: r, tileR: r, tileC: c,
      dir: extra.dir != null ? normDir(extra.dir) : extra.facing != null ? normDir(extra.facing) : ps ? ps.dir : 'RIGHT',
      base: {
        maxHp: st.maxHp, atk: st.atk, def: st.def, res: st.res, aspd: st.aspd, bat: st.bat, blockCnt: st.blockCnt,
        moveSpeed: 0, spRecovery: st.spRecovery, tauntLevel: st.tauntLevel, massLevel: st.massLevel,
        hpRecoveryPerSec: st.hpRecoveryPerSec, cost: st.cost, respawnTime: st.respawnTime,
      },
    });
    u.alive = false;
    u.deployed = false;
    u.items = [];
    u.rangeGrid = def.rangeGrid;
    u.player = ps;
    this.units.push(u);
    this.allyUnits.push(u);
    if (ps) ps.units.push(u);
    return u;
  }

  /** Resolve kit/profile/skill for a unit (called by content/index.js; safe to call again). */
  _setupUnit(u, kit = null) {
    if (!kit) {
      try { kit = setupUnitKit(this, u, this.contentMode); } catch (e) { this._internalError('setupUnitKit', e); kit = null; }
    }
    u.kit = kit || {};
    u.profile = resolveProfile(u.def, u.kit.trait || null);
    if (u.def.untargetable) this.addBuff(u, { key: 'trait:untargetable', flags: { untargetable: true }, persist: true, allowDead: true });
    const spec = u.kit.skill || null;
    u.skill = new SkillRuntime(this, u, u.def.skill, spec, u.def.skill?.bb ?? {});
    if (u.profile.install && !u._profInstalled) {
      u._profInstalled = true;
      this._safe(() => u.profile.install(this, u), 'profile.install', u);
    }
    for (const t of u.kit.talents || []) {
      if (t && typeof t.install === 'function') this._safe(() => t.install(this, u), 'talent.install', u);
    }
    if (typeof u.kit.install === 'function') this._safe(() => u.kit.install(this, u), 'kit.install', u);
    return u.kit;
  }

  // =============================================================================================================
  // lifecycle

  start() {
    if (this.started) return;
    this.started = true;
    this._safe(() => this._spawnStageDevices(), 'stageDevices');
    for (const ps of this.players) {
      const order = ps.units.filter((u) => u.kind === 'op' || u.kind === 'token').slice().sort((a, b) =>
        b.homeR - a.homeR || (ps.mirror ? b.homeC - a.homeC : a.homeC - b.homeC) || a.id - b.id);
      for (const u of order) this._safe(() => this._deploy(u, { initial: true }), 'initialDeploy', u);
    }
    this.emit('battleStart', {});
  }

  step() {
    if (this.finished || this._stepping) return; // re-entrant step() from a hook is a no-op
    // forceEnd() requested while stepping (content hook, repeated engine errors) is deferred to the end of the
    // current phase: the remaining phases are skipped and the result is built once, so nothing mutates it later.
    this._stepping = true;
    try {
      if (!this.started) this._phase('start', () => this.start());
      const dt = this.dt;
      this._phase('scheduled', () => this._runScheduled());
      this._phase('spawns', () => this._processSpawns());
      this._phase('dp', () => {
        for (const ps of this.players) ps.dp = Math.min(this.flags.dpMax, ps.dp + this.flags.dpPerSec * dt);
      });
      this._phase('buffs', () => this._tickBuffs(dt));
      this._phase('enemies', () => {
        // enemies spawned by hooks during this loop start moving next tick (a leak hook that spawns an enemy which
        // leaks at once would otherwise loop forever inside a single tick)
        const list = this.enemies;
        for (let i = 0, n = list.length; i < n && !this._endReq; i++) {
          const e = list[i];
          if (!e.alive) continue;
          try { updateEnemy(this, e, dt); } catch (err) { this._internalError('updateEnemy', err); }
          this._clampPos(e);
        }
      });
      this._compactEnemies();
      this._phase('enemyIndex', () => this._buildEnemyIndex());
      this._phase('allies', () => {
        const list = this.allyUnits;
        for (let i = 0; i < list.length && !this._endReq; i++) {
          const u = list[i];
          if (!u.alive || !u.deployed) continue;
          try {
            if (u.skill) u.skill.tick(dt);
            if (u.alive && u.kind !== 'device') updateAlly(this, u, dt);
          } catch (err) { this._internalError('updateAlly', err); }
        }
      });
      this._phase('projectiles', () => this.projectiles.update(dt));
      this._phase('redeploy', () => this._checkRedeploys());
      this._phase('boss', () => this._bossSync());
      if (this._hooks.tick) this._phase('tickHook', () => this.emit('tick', { dt }));
      this._compactEnemies();
      if (this._toRelease.length) this._releaseRemoved();
      if (!this._endReq && !this.finished) {
        this.tickCount++;
        this.time = this.tickCount * dt; // no floating drift over long battles
        this._phase('endCheck', () => this._checkEnd());
      }
    } finally {
      this._stepping = false;
    }
    if (this._endReq && !this.finished) {
      try { this.forceEnd(this._endReq); } catch (e) { this._handlerError('internal:forceEnd', null, e); this._hardFinish(this._endReq); }
    }
  }

  /** Last-resort finish when building the normal result threw (never throws itself). */
  _hardFinish(reason) {
    if (this.finished) return;
    this.finished = true;
    this.reason = reason === 'timeout' ? 'timeout' : 'forced';
    this._endReq = null;
    try { this._result = this._buildResult(); } catch { this._result = { time: this.time, reason: this.reason, perPlayer: {}, killed: this.killed, total: this.total, errors: this.errorCount }; }
    this.projectiles.clear();
  }

  /** Run until finished or `maxSeconds` of game time elapsed. Returns the result when finished. */
  runToEnd(maxSeconds = MAX_BATTLE_TIME) {
    const limit = this.time + maxSeconds;
    while (!this.finished && this.time < limit) this.step();
    return this.finished ? this.result() : null;
  }

  _phase(name, fn) {
    if (this.finished || this._endReq) return;
    try { fn(); } catch (e) { this._internalError(name, e); }
  }

  _checkEnd() {
    if (this.finished) return;
    if (this.sharedBoss && this.sharedBoss.hp <= 0) { this._finish('cleared'); return; }
    // A boss / hidden field with a shared pool ends only when the pool is empty or the match forces an end (DESIGN
    // §5.5) — never merely because it emptied: the h07_04 pair leader (official route: no wait) can walk into the
    // objective, and the field then idles while another field may still empty the pool or the overtime drain ends it.
    const poolHolds = !!this.sharedBoss && (this.kind === 'boss' || this.kind === 'hidden');
    if (this.autoFinish && !poolHolds && !this._pending.length && !this.enemies.some((e) => e.alive) && this.started) {
      if (!this._hasPendingEnemySchedules()) { this._finish('cleared'); return; }
    }
    if (this.time >= this.timeLimit - 1e-9) { this._timeout(); return; }
    if (this.time >= MAX_BATTLE_TIME) { this._timeout(); return; }
  }

  _hasPendingEnemySchedules() {
    for (const s of this._sched) if (!s.cancelled && s.holdsBattle) return true;
    return false;
  }

  _timeout() {
    // Remaining non-boss enemies on the field count as leaked (DESIGN §5.5). Spawns that never happened before the
    // limit are dropped: they are removed from `total` and reported in `result().unspawned` (not leaks).
    for (const e of this.enemies) {
      if (!e.alive || e.isBoss) continue;
      this._recordLeak(e, true);
    }
    this.unspawned = [];
    for (const p of this._pending) {
      if (p.precounted) {
        this.total--;
        const pp = this._pp(p.ownerPlayerId ?? this._ownerForTile(p.pos ?? this._routeFor(p.routeIndex, p.route)?.start));
        if (pp) pp.total--;
      }
      this.unspawned.push({ enemyKey: p.enemyKey, time: p.time, tag: p.tag ?? null, sourcePlayerId: p.sourcePlayerId ?? null });
    }
    this._pending = [];
    this._finish('timeout');
  }

  forceEnd(reason = 'forced') {
    if (this.finished) return;
    if (this._stepping) { if (!this._endReq) this._endReq = reason; return; } // finalised when step() unwinds
    this._endReq = null;
    if (!this.started) this.start();
    if (this.finished) return;
    if (reason === 'timeout') this._timeout();
    else this._finish('forced');
  }

  _finish(reason) {
    if (this.finished) return;
    this.finished = true;
    this.reason = reason;
    this._endReq = null;
    const res = this._buildResult();
    this._result = res;
    this.emit('battleEnd', { result: res });
    // re-sync fields that battleEnd handlers may have changed (layer gains / coins live in perPlayer objects)
    for (const pid of Object.keys(res.perPlayer)) {
      const pp = res.perPlayer[pid];
      pp.perfect = !pp.leaked.some((l) => l.counted !== false);
    }
    this.projectiles.clear();
  }

  _buildResult() {
    const perPlayer = {};
    for (const ps of this.players) {
      const pp = this._perPlayer[ps.playerId];
      pp.perfect = !pp.leaked.some((l) => l.counted !== false);
      pp.unitsEnd = ps.units.filter((u) => u.kind === 'op').map((u) => ({
        uid: u.uid, id: u.id, defId: u.defId,
        hpPct: u.alive ? Math.max(0, Math.min(1, u.hp / u.s.maxHp)) : 0,
        sp: u.skill && !u.skill.noSkill ? Math.round(u.skill.sp * 100) / 100 : 0,
        skillActive: !!(u.skill && u.skill.active && u.skill.kind !== 'passive'),
        alive: !!u.alive,
      }));
      pp.unitStats = ps.units.map((u) => ({
        id: u.id, uid: u.uid, defId: u.defId, name: u.name, kind: u.kind,
        dmg: Math.round(u.stats.dmg), kills: u.stats.kills, heal: Math.round(u.stats.heal), taken: Math.round(u.stats.taken), attacks: u.stats.attacks,
      }));
      perPlayer[ps.playerId] = pp;
    }
    const res = { time: Math.round(this.time * 1000) / 1000, reason: this.reason, perPlayer, killed: this.killed, total: this.total, errors: this.errorCount };
    if (this.unspawned && this.unspawned.length) res.unspawned = this.unspawned;
    if (this.sharedBoss) res.bossHpLeft = Math.max(0, this.sharedBoss.hp);
    return res;
  }

  /** BattleResult (valid once finished; a provisional result before). */
  result() {
    if (this._result) return this._result;
    return this._buildResult();
  }

  // =============================================================================================================
  // hook bus

  on(name, fn, opts = {}) {
    if (typeof fn !== 'function') return null;
    const h = { name, fn, priority: Number(opts.priority) || 0, owner: opts.owner ?? null, seq: ++hookSeq, removed: false, once: !!opts.once };
    const list = this._hooks[name] ?? (this._hooks[name] = []);
    let i = list.length;
    while (i > 0 && list[i - 1].priority < h.priority) i--;
    list.splice(i, 0, h);
    return h;
  }

  off(nameOrHandle, fn) {
    if (nameOrHandle && typeof nameOrHandle === 'object') {
      const h = nameOrHandle;
      h.removed = true;
      const list = this._hooks[h.name];
      if (list) {
        const i = list.indexOf(h);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) delete this._hooks[h.name];
      }
      return;
    }
    const list = this._hooks[nameOrHandle];
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) if (!fn || list[i].fn === fn) { list[i].removed = true; list.splice(i, 1); }
    if (!list.length) delete this._hooks[nameOrHandle];
  }

  /** Remove every hook and scheduled callback registered with `owner`. */
  offOwner(owner) {
    for (const name of Object.keys(this._hooks)) {
      const list = this._hooks[name];
      for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) { list[i].removed = true; list.splice(i, 1); }
      if (!list.length) delete this._hooks[name];
    }
    for (const s of this._sched) if (s.owner === owner) s.cancelled = true;
  }

  hasHook(name) { return !!this._hooks[name]; }

  emit(name, ctx) {
    const list = this._hooks[name];
    if (!list) return ctx;
    // Recursion guard: handlers that re-trigger their own event (damaged → dealDamage → damaged …) would otherwise
    // recurse until a stack overflow, whose depth (and thus the outcome) depends on the machine — not deterministic.
    if (this._emitDepth >= MAX_HOOK_DEPTH) {
      this._handlerError(`hookDepth:${name}`, null, new Error(`hook nesting deeper than ${MAX_HOOK_DEPTH}; handlers skipped — ${this._chain(name)}`));
      return ctx;
    }
    const arr = list.length === 1 ? [list[0]] : list.slice();
    const d = this._emitDepth++;
    this._frameCtx[d] = ctx;
    try {
      for (const h of arr) {
        if (h.removed) continue;
        this._frameName[d] = name;
        this._frameOwner[d] = h.owner;
        try { h.fn(ctx, this); } catch (e) { this._handlerError(`hook:${name}`, h.owner, e); }
        if (h.once) this.off(h);
        if (ctx && ctx.stopPropagation) break;
      }
    } finally {
      this._emitDepth--;
    }
    return ctx;
  }

  /**
   * The open hook/callback frames (outermost first) — names the loop when the nesting guard trips, e.g.
   * "chain: hit(enemy_1430_lrrook) > damaged(chess_char_3_18_a) > hit(enemy_1430_lrrook) > … > damaged".
   */
  _chain(last) {
    const id = (u) => (u && typeof u === 'object' ? (u.defId ?? u.name ?? '?') : u == null ? '' : String(u));
    const lab = (i) => {
      const o = this._frameOwner[i];
      let who = id(o);
      const c = this._frameCtx[i];
      if (!who && c && typeof c === 'object') { // global handler: show the units of the event instead
        const a = c.source ?? c.attacker ?? c.killer ?? null, t = c.target ?? c.unit ?? c.victim ?? c.enemy ?? null;
        who = a || t ? `${id(a)}→${id(t)}` : '';
      }
      return `${this._frameName[i]}${who ? `(${who})` : ''}`;
    };
    const n = this._emitDepth;
    const parts = [];
    for (let i = 0; i < Math.min(n, 4); i++) parts.push(lab(i));
    if (n > 12) parts.push('…');
    for (let i = Math.max(4, n - 8); i < n; i++) parts.push(lab(i));
    parts.push(last);
    return `chain: ${parts.join(' > ')}`;
  }

  // =============================================================================================================
  // scheduling

  after(seconds, fn, opts = {}) {
    const s = { due: this.time + Math.max(0, Number(seconds) || 0), fn, owner: opts.owner ?? null, interval: 0, seq: ++schedSeq, cancelled: false, holdsBattle: !!opts.holdsBattle };
    s.cancel = () => { s.cancelled = true; };
    this._sched.push(s);
    return s;
  }

  every(seconds, fn, opts = {}) {
    const iv = Math.max(TICK, Number(seconds) || TICK);
    const s = { due: this.time + (opts.immediate ? 0 : iv), fn, owner: opts.owner ?? null, interval: iv, seq: ++schedSeq, cancelled: false, count: 0, holdsBattle: false };
    s.cancel = () => { s.cancelled = true; };
    this._sched.push(s);
    return s;
  }

  _runScheduled() {
    if (!this._sched.length) return;
    const now = this.time + 1e-9;
    let due = this._sched.filter((s) => !s.cancelled && s.due <= now);
    if (!due.length) { if (this._sched.some((s) => s.cancelled)) this._sched = this._sched.filter((s) => !s.cancelled); return; }
    due.sort((a, b) => a.due - b.due || a.seq - b.seq);
    for (const s of due) {
      if (s.cancelled) continue;
      if (s.interval > 0) {
        let n = 0;
        while (s.due <= now && !s.cancelled && n++ < 8) {
          s.count++;
          this._safe(() => s.fn(this, s), 'every', s.owner);
          s.due += s.interval;
        }
        if (s.due <= now) s.due = this.time + s.interval;
      } else {
        s.cancelled = true;
        this._safe(() => s.fn(this, s), 'after', s.owner);
      }
    }
    this._sched = this._sched.filter((s) => !s.cancelled);
  }

  // =============================================================================================================
  // spawns

  _queueSpawn(s, precount) {
    if (Number(s.time) === Infinity) return; // "never" — not scheduled, not counted
    // capped: a bogus count (Infinity, 1e9) would otherwise hang the constructor / exhaust memory
    const count = Math.min(MAX_ALIVE_ENEMIES, Math.max(1, Math.floor(fin(s.count ?? 1, 1)) || 1));
    const interval = Math.max(0, fin(s.interval, 0));
    const def = this.data.getEnemy(s.enemyKey);
    for (let i = 0; i < count; i++) {
      const p = {
        time: Math.max(0, fin(s.time, 0)) + i * interval, enemyKey: s.enemyKey, routeIndex: s.routeIndex ?? 0, route: s.route ?? null,
        mods: s.mods ?? null, sourcePlayerId: s.sourcePlayerId ?? null, bounty: s.bounty ?? null, tag: s.tag ?? null,
        ownerPlayerId: s.ownerPlayerId ?? null, pos: s.pos ?? null, seq: ++this._spawnSeq, countInTotal: s.countInTotal,
      };
      p.counted = p.countInTotal ?? (!(def && def.notCountInTotal) && p.tag !== 'boss' && p.tag !== 'part');
      if (precount && p.counted) {
        this.total++;
        const owner = p.ownerPlayerId ?? this._ownerForTile(p.pos ?? this._routeFor(p.routeIndex, p.route)?.start);
        const pp = this._pp(owner);
        if (pp) pp.total++;
        p.precounted = true;
      }
      this._pending.push(p);
    }
  }

  _processSpawns() {
    const now = this.time + 1e-9;
    while (this._pending.length && this._pending[0].time <= now) {
      const p = this._pending.shift();
      this._safe(() => this.spawnEnemy(p.enemyKey, { ...p, _precounted: p.precounted }), 'spawnEnemy');
    }
  }

  _routeFor(idx, explicit = null) {
    if (explicit) return normalizeRoute(explicit);
    return this.routes[idx] ?? this.routes[0] ?? this._defaultRoute();
  }

  _defaultRoute() {
    if (this._defRoute !== undefined) return this._defRoute;
    const starts = this.grid.specialTiles('start');
    const ends = this.grid.specialTiles('end');
    this._defRoute = starts.length && ends.length ? { motion: 'WALK', start: starts[0], end: ends[0], checkpoints: [] } : null;
    return this._defRoute;
  }

  _ownerForTile(tile) {
    if (!this.players.length) return null;
    if (this.players.length === 1 || !tile) return this.players[0].playerId;
    const c = Array.isArray(tile) ? tile[1] : tile.c;
    const half = c >= 11 ? 'R' : 'L';
    return (this.players.find((p) => p.half === half) ?? this.players[0]).playerId;
  }

  /**
   * Spawn an enemy now. opts: { routeIndex, route, pos:[r,c], mods:{hpMul,atkMul,defMul,resMul,speedMul}, tag,
   * sourcePlayerId, ownerPlayerId, bounty:{coins,ownerPlayerId}, countInTotal }
   */
  spawnEnemy(enemyKey, opts = {}) {
    if (this.enemies.length >= MAX_ALIVE_ENEMIES && this.aliveEnemies().length >= MAX_ALIVE_ENEMIES) {
      this._handlerError('spawnEnemy', null, new Error(`more than ${MAX_ALIVE_ENEMIES} living enemies; spawn of ${enemyKey} refused`));
      return null;
    }
    // opts.def: an inline record (data/enemies.json shape, or an already normalised EnemyDef) for keys absent from data
    let def = null;
    if (opts.def && typeof opts.def === 'object') {
      try { def = opts.def.type === 'enemy' && opts.def.immune instanceof Set ? opts.def : normalizeEnemy(enemyKey, opts.def); } catch (e) { this._handlerError('spawnEnemy.def', null, e); }
    }
    if (!def) def = this.data.getEnemy(enemyKey);
    if (!def) { this.log(`unknown enemy ${enemyKey}`); def = { ...FALLBACK_ENEMY, id: enemyKey, key: enemyKey }; }
    const ov = this.enemyOverrides[def.key] ?? this.enemyOverrides[enemyKey];
    if (ov && ov.stats) {
      const st = ov.stats;
      def = { ...def,
        maxHp: Math.max(1, fin(st.maxHp ?? st.hp, def.maxHp)), atk: Math.max(0, fin(st.atk, def.atk)), def: Math.max(0, fin(st.def, def.def)),
        res: Math.max(0, fin(st.res, def.res)), moveSpeed: Math.max(0, fin(st.moveSpeed, def.moveSpeed)),
        bat: Math.max(0.1, fin(st.bat, def.bat)), aspd: fin(st.aspd, def.aspd) || def.aspd,
        rangeRadius: Math.max(0, fin(st.rangeRadius, def.rangeRadius)), massLevel: fin(st.massLevel, def.massLevel),
        lpr: fin(st.lpr, def.lpr), blockCnt: Math.max(1, fin(st.blockCnt, def.blockCnt)) };
    }
    const route = opts.route ? normalizeRoute(opts.route) : this._routeFor(opts.routeIndex ?? 0);
    let start = opts.pos ?? route?.start ?? [this.rect.r0, this.rect.c1];
    if (!Array.isArray(start) || !Number.isFinite(start[0]) || !Number.isFinite(start[1])) start = route?.start ?? [this.rect.r0, this.rect.c1];
    const R = this.rect; // spawn inside the field (same bounds as _clampPos)
    start = [Math.max(R.r0 - 0.5, Math.min(R.r1 + 0.5, start[0])), Math.max(R.c0 - 0.5, Math.min(R.c1 + 0.5, start[1]))];
    // multipliers: finite and ≥ 0 (hp > 0), anything else counts as 1
    const mm = (v, pos = false) => { const n = fin(v, 1); return n < 0 || (pos && n <= 0) ? 1 : n; };
    const m0 = opts.mods || {};
    const m = { hpMul: mm(m0.hpMul, true), atkMul: mm(m0.atkMul), defMul: mm(m0.defMul), resMul: mm(m0.resMul), speedMul: mm(m0.speedMul) };
    const e = new Unit({
      id: ++this._idSeq, side: 'enemy', kind: 'enemy', def, defId: def.key ?? enemyKey, name: def.name,
      x: start[1], y: start[0], motion: def.motion,
      base: {
        maxHp: def.maxHp * (m.hpMul ?? 1), atk: def.atk * (m.atkMul ?? 1), def: def.def * (m.defMul ?? 1), res: def.res * (m.resMul ?? 1),
        aspd: def.aspd, bat: def.bat, blockCnt: 0, moveSpeed: def.moveSpeed * (m.speedMul ?? 1), spRecovery: 0,
        tauntLevel: def.tauntLevel, massLevel: def.massLevel, hpRecoveryPerSec: def.hpRecoveryPerSec, rangeRadius: def.rangeRadius,
      },
    });
    e.alive = true;
    e.deployed = true;
    e.blockWeight = def.blockCnt ?? 1;
    e.lpr = def.lpr;
    e.mods = opts.mods ?? null;
    e.tag = opts.tag ?? null;
    e.bounty = opts.bounty ?? null;
    e.sourcePlayerId = opts.sourcePlayerId ?? null;
    e.ownerId = opts.ownerPlayerId ?? this._ownerForTile(start);
    e.spawnX = e.x; e.spawnY = e.y;
    e.spawnSeq = ++this._spawnSeq;
    e.deploySeq = ++this._deploySeq;
    e.deployedAt = this.time;
    e.atkCd = 0;
    e.pauseUntil = -Infinity;
    e.profile = { noAttack: def.dmgType === 'none', maxTargets: 1, atkScale: 1 };
    e.route = { legs: route ? compileRoute(route, this.rect) : [], legIdx: 0, pts: null, ptIdx: 0, suffix: null, version: -1, waitLeft: null };
    if (!e.route.legs.length) {
      const end = this.grid.specialTiles('end')[0];
      if (end) e.route.legs.push({ t: 'move', r: end[0], c: end[1], final: true });
    }
    e.counted = opts.countInTotal ?? (!def.notCountInTotal && e.tag !== 'boss' && e.tag !== 'part');
    if (e.counted && !opts._precounted) {
      this.total++;
      const pp = this._pp(e.ownerId);
      if (pp) pp.total++;
    }
    if (e.tag === 'boss') {
      e.isBoss = true;
      if (this.sharedBoss) { e.bossPool = this.sharedBoss; this._syncBossHp(e); }
    }
    e.hp = e.bossPool ? e.hp : e.s.maxHp;
    this.units.push(e);
    this.enemies.push(e);
    this._ev(['spawn', unitInfo(e)]);
    if (this._hooks.deploy) this.emit('deploy', { unit: e, initial: false });
    if (this._hooks.enemySpawn) this.emit('enemySpawn', { enemy: e });
    return e;
  }

  // =============================================================================================================
  // deployment / death / redeploy

  /**
   * Deploy `u` on its home tile, or on `tile` ([r, c]: a one-off landing tile — the home stays the tile of later
   * redeploys). `keepSp` = { sp, charges } restored right after the skill reset, before the `deploy` hook fires.
   */
  _deploy(u, { initial = false, carry = null, tile = null, keepSp = null } = {}) {
    if ((u.alive && u.deployed) || u._removing) return false;
    const R0 = tile ? tile[0] : u.homeR, C0 = tile ? tile[1] : u.homeC;
    if (!this.grid.inRect(R0, C0)) {
      this.log(`${u} at ${R0},${C0} is outside the field rect; not deployed`);
      if (!tile) u.removed = true;
      return false;
    }
    const k = R0 * COLS + C0;
    const occ = this._occ[k];
    if (occ && occ !== u && occ.alive && occ.deployed) { this.log(`tile ${R0},${C0} occupied; ${u} not deployed`); return false; }
    const first = u.deploySeq === 0;
    u.alive = true;
    u.deployed = true;
    u.removed = false;
    u.hidden = false;
    u.x = C0; u.y = R0; u.tileR = R0; u.tileC = C0;
    u.blocking = [];
    u.deploySeq = ++this._deploySeq;
    u.deployedAt = this.time;
    u.atkCd = 0;
    u.lastAttackAt = -Infinity;
    u.elem.burn = u.elem.neural = u.elem.necrosis = u.elem.apoptosis = u.elem.erosion = 0;
    u.ground = this.grid.isLow(R0, C0) && !this._elevated?.has(k);
    u.markDirty();
    u.hp = u.s.maxHp;
    const cs = initial ? (carry ?? u.carry) : null;
    if (cs && Number.isFinite(cs.hpPct)) u.hp = Math.max(1, u.s.maxHp * Math.max(0.01, Math.min(1, cs.hpPct)));
    this._occ[k] = u;
    this._refreshRange(u); // also rebuilds baseRangeKeys (initial range incl. permanent rangeExtend)
    if (!u.skill) this._setupUnit(u);
    u.skill.reset(cs);
    const sk = u.skill;
    if (keepSp && !sk.noSkill && sk.kind !== 'passive' && !sk.active) {
      sk.charges = Math.max(0, Math.min(sk.maxCharges, Math.floor(fin(keepSp.charges, 0))));
      sk.sp = Math.max(0, Math.min(sk.spCost, fin(keepSp.sp, 0)));
      if (sk.charges >= sk.maxCharges) sk.sp = sk.spCost;
    }
    if (first) this._ev(['spawn', unitInfo(u)]);
    this._ev(['deploy', u.id]);
    if (this._hooks.deploy) this.emit('deploy', { unit: u, initial });
    return true;
  }

  /** Mark `unit` dead (hp reached 0). Fires `kill` then `death`. */
  kill(unit, killer = null) {
    if (!unit || !unit.alive) return;
    unit.hp = 0;
    if (this._hooks.kill) this.emit('kill', { killer, victim: unit });
    // a nested kill/retreat inside the handlers already removed it: a later handler's hp write must not stick
    if (!unit.alive) { if (!unit.bossPool) unit.hp = 0; return; }
    if (unit.hp > 0 && !unit.bossPool) { // revived by a kill handler (clamped: a handler may write any number)
      unit.hp = Math.min(unit.hp, unit.s.maxHp);
      return;
    }
    unit.hp = 0; // NaN / negative writes from handlers
    this._remove(unit, 'killed', killer);
  }

  /** Withdraw an ally without a kill (it may redeploy after its respawn time). */
  retreat(unit, { reason = 'retreat', permanent = false } = {}) {
    if (!unit || !unit.alive || unit.side !== 'ally') return;
    this._remove(unit, reason, null, permanent);
  }

  _remove(unit, reason, killer = null, permanent = false) {
    unit.alive = false;
    unit.removeReason = reason;
    unit.deployed = false;
    unit.deathAt = this.time;
    // while the removal bookkeeping runs, a skill onEnd handler must not redeploy the unit (it would come back
    // alive but without its tile in _occ, its buffs wiped and a respawn timer pending) — redeploy from `death` instead
    unit._removing = true;
    if (unit.skill && unit.skill.active) {
      this._safe(() => unit.skill.end('death'), 'skill.end', unit);
      unit.skill.active = false;
    }
    unit._removing = false;
    if (unit.side === 'ally') {
      this.releaseBlocked(unit);
      const k = unit.tileR * COLS + unit.tileC;
      if (this._occ[k] === unit) this._occ[k] = null;
      // keep persistent buffs only
      const kept = [];
      for (const b of unit.buffs) {
        if (b.persist) kept.push(b);
        else if (b.visible || b.status) this._ev(['status', unit.id, b.status ?? b.key, 0]);
      }
      unit.buffs = kept;
      unit.markDirty();
      if (unit.kind === 'op' && !permanent) {
        if (reason === 'killed') { const pp = this._pp(unit.ownerId); if (pp) pp.deaths++; }
        const mul = unit.persist.redeployMul * unit.s.redeployMul;
        unit.respawnAt = this.time + Math.max(0, unit.base.respawnTime * mul);
      } else {
        unit.removed = true;
      }
      if (unit.kind === 'device' && unit.obstacle) this.grid.setObstacle(unit.tileR, unit.tileC, false, unit.obstacleKind);
    } else {
      unit.removed = true;
      this._unblock(unit);
      this._enemiesDirty = true;
      if (reason === 'killed') {
        if (unit.counted) {
          this.killed++;
          const pp = this._pp(unit.ownerId);
          if (pp) pp.killed++;
        }
        if (killer) killer.stats.kills++;
        if (unit.bounty && unit.bounty.coins > 0) {
          const payee = killer && killer.side === 'ally' && killer.ownerId != null ? killer.ownerId : (unit.bounty.ownerPlayerId ?? unit.ownerId);
          this.addCoins(payee, unit.bounty.coins);
        }
      }
    }
    // the reason ('killed' | 'retreat' | 'expired' | …) lets the client keep the knock-down sound for real knock-outs
    if (reason !== 'leak') this._ev(['die', unit.id, reason]);
    if (this._hooks.death) this.emit('death', { unit, reason, killer });
    if (unit.removed) this._toRelease.push(unit);
  }

  /**
   * Drop hooks and periodic timers (`every`) owned by permanently removed units (killed/leaked enemies, expired
   * tokens, destroyed devices). Runs at the end of the step, so the unit's own death/leak handlers still fire;
   * one-shot `after` callbacks are kept (they run once and are gone). Without this, per-enemy content hooks pile up
   * and every emit walks the handlers of every enemy that ever spawned.
   */
  _releaseRemoved() {
    const set = new Set();
    for (const u of this._toRelease) if (u.removed && !u.alive) set.add(u);
    this._toRelease = [];
    if (!set.size) return;
    for (const name of Object.keys(this._hooks)) {
      const list = this._hooks[name];
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        if (h.owner != null && set.has(h.owner)) h.removed = true;
        else list[w++] = h;
      }
      list.length = w;
      if (!w) delete this._hooks[name];
    }
    for (const sc of this._sched) if (sc.interval > 0 && sc.owner != null && set.has(sc.owner)) sc.cancelled = true;
  }

  /**
   * Immediately redeploy a dead (or retreated) ally. opts:
   *   free=true   no DP cost (false: pays `base.cost`, refused when the player lacks the DP)
   *   tile=[r,c]  land on this in-rect tile instead of the home tile (the home stays the tile of later redeploys);
   *               refused (false) when the tile is outside the rect or a living unit stands there — no fallback
   *   keepSp      keep the SP / charges the unit had (保留技力): restored before the `deploy` hook fires
   * Returns true when the unit was deployed (full HP, `deploy {initial:false}` fires).
   */
  redeploy(unit, { free = true, tile = null, keepSp = false } = {}) {
    if (!unit || unit.side !== 'ally' || unit.alive || unit.removed) return false;
    let at = null;
    if (tile != null) {
      if (!Array.isArray(tile) || !Number.isInteger(tile[0]) || !Number.isInteger(tile[1]) || !this.grid.inRect(tile[0], tile[1])) return false;
      at = [tile[0], tile[1]];
    }
    const k = at ? at[0] * COLS + at[1] : unit.homeR * COLS + unit.homeC;
    const occ = this._occ[k];
    if (occ && occ.alive && occ !== unit) return false;
    const ps = this.getPlayer(unit.ownerId);
    const cost = unit.base.cost;
    let paid = 0;
    if (!free) {
      if (!ps || ps.dp + 1e-9 < cost) return false;
      paid = Math.min(ps.dp, cost);
      ps.dp = Math.max(0, ps.dp - cost); // paid before `deploy` fires (handlers see the new DP)
    }
    const sk = unit.skill;
    const keep = keepSp && sk && !sk.noSkill && sk.kind !== 'passive' ? { sp: sk.sp, charges: sk.charges } : null;
    if (this._deploy(unit, { initial: false, tile: at, keepSp: keep })) return true;
    if (paid > 0 && ps) ps.dp = Math.min(this.flags.dpMax, ps.dp + paid);
    return false;
  }

  _checkRedeploys() {
    for (const u of this.allyUnits) {
      if (u.alive || u.removed || u.kind !== 'op') continue;
      if (this.time + 1e-9 < u.respawnAt) continue;
      const k = u.homeR * COLS + u.homeC;
      const occ = this._occ[k];
      if (occ && occ.alive && occ !== u) continue;
      const ps = this.getPlayer(u.ownerId);
      const cost = u.base.cost;
      if (!ps || ps.dp + 1e-9 < cost) continue;
      ps.dp = Math.max(0, ps.dp - cost);
      this._deploy(u, { initial: false });
    }
  }

  /** Leak: an enemy reached its goal. */
  leak(e) {
    if (!e || !e.alive || e.side !== 'enemy') return;
    this._recordLeak(e, false);
    this._remove(e, 'leak');
    this._ev(['leak', e.id]);
    if (this._hooks.enemyLeak) this.emit('enemyLeak', { enemy: e });
  }

  _recordLeak(e, timeout) {
    const owner = timeout ? e.ownerId : this._ownerForTile([Math.round(e.y), Math.round(e.x)]) ?? e.ownerId;
    const pp = this._pp(owner) ?? this._pp(e.ownerId);
    if (pp) {
      pp.leaked.push({ enemyKey: e.defId, mods: e.mods ?? null, lpr: e.lpr ?? 1, sourcePlayerId: e.sourcePlayerId ?? e.ownerId, tag: e.tag ?? null, counted: !!e.counted || e.isBoss, boss: e.isBoss || undefined, spawned: true });
      if (e.counted || e.isBoss) pp.perfect = false;
    }
    if (e.counted) this.leakedCount++;
  }

  // =============================================================================================================
  // blocking

  /** Try to block enemy `e` at its current tile. Returns true if it became blocked. */
  _checkBlock(e) {
    if (e.blockedBy || e.hidden || !e.alive) return !!e.blockedBy;
    const f = e.s.flags;
    if (f.unblockable || f.levitate || f.fear) return false;
    const r = Math.round(e.y), c = Math.round(e.x);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return false;
    const u = this._occ[r * COLS + c];
    if (!u || !u.alive || !u.deployed || u.hidden || u.s.flags.noBlock || u.s.flags.sleep) return false;
    if (e.isFlying && !(u.s.flags.blockFly || (u.profile && u.profile.blockFly))) return false;
    if (!e.isFlying && !u.ground) return false;
    const cap = u.s.blockCnt;
    if (cap <= 0) return false;
    let used = 0;
    for (const x of u.blocking) used += x.blockWeight ?? 1;
    const w = e.blockWeight ?? 1;
    if (used + w > cap) return false;
    e.blockedBy = u;
    u.blocking.push(e);
    e.moving = false;
    if (this._hooks.blocked) this.emit('blocked', { blocker: u, enemy: e });
    return true;
  }

  _unblock(e) {
    const bl = e.blockedBy;
    if (!bl) return;
    const i = bl.blocking.indexOf(e);
    if (i >= 0) bl.blocking.splice(i, 1);
    e.blockedBy = null;
  }

  /** Release every enemy blocked by ally `u` (death, retreat, block count drop, substitution…). */
  releaseBlocked(u) {
    if (!u || !u.blocking || !u.blocking.length) return;
    for (const e of u.blocking) if (e.blockedBy === u) e.blockedBy = null;
    u.blocking = [];
  }

  // =============================================================================================================
  // buffs & statuses

  addBuff(unit, b) {
    if (!unit || (!unit.alive && !b.allowDead)) return null;
    const buff = makeBuff(b);
    const list = unit.buffs;
    let idx = -1;
    for (let i = 0; i < list.length; i++) if (list[i].key === buff.key) { idx = i; break; }
    if (idx >= 0 && buff.refresh !== 'independent') {
      const old = list[idx];
      switch (buff.refresh) {
        case 'keep':
          return old;
        case 'stack':
          old.stacks = Math.min(old.stacks + buff.stacks, Math.max(old.maxStacks, buff.maxStacks));
          old.maxStacks = Math.max(old.maxStacks, buff.maxStacks);
          old.timeLeft = buff.duration;
          old.duration = buff.duration;
          if (buff.mods) old.mods = buff.mods;
          if (buff.flags) old.flags = buff.flags;
          unit.markDirty();
          return old;
        case 'extend':
          old.timeLeft = Math.max(old.timeLeft, buff.duration);
          old.duration = Math.max(old.duration, buff.duration);
          if (buff.mods) old.mods = buff.mods;
          if (buff.flags) old.flags = buff.flags;
          if (buff.shield > old.shield) old.shield = buff.shield;
          if (buff.shieldHits > old.shieldHits) old.shieldHits = buff.shieldHits;
          unit.markDirty();
          return old;
        default:
          list[idx] = buff;
          unit.markDirty();
          return buff;
      }
    }
    if (buff.refresh === 'independent') {
      const same = list.filter((x) => x.key === buff.key);
      if (same.length >= buff.maxStacks) {
        const oldest = same.reduce((a, c) => (a.seq < c.seq ? a : c));
        this._removeBuffAt(unit, list.indexOf(oldest), true);
      }
    }
    list.push(buff);
    unit.markDirty();
    if (buff.visible || buff.status) {
      const key = buff.status ?? buff.key;
      if (list.filter((x) => (x.status ?? x.key) === key).length === 1) this._ev(['status', unit.id, key, 1]);
    }
    return buff;
  }

  removeBuff(unit, keyOrBuff) {
    if (!unit) return 0;
    let n = 0;
    for (let i = unit.buffs.length - 1; i >= 0; i--) {
      const b = unit.buffs[i];
      if (b === keyOrBuff || b.key === keyOrBuff) { this._removeBuffAt(unit, i, true); n++; }
    }
    return n;
  }

  _removeBuffAt(unit, i, callRemove = true) {
    const b = unit.buffs[i];
    if (!b) return;
    unit.buffs.splice(i, 1);
    unit.markDirty();
    if ((b.visible || b.status)) {
      const key = b.status ?? b.key;
      if (!unit.buffs.some((x) => (x.status ?? x.key) === key)) this._ev(['status', unit.id, key, 0]);
    }
    if (callRemove && b.onRemove) this._safe(() => b.onRemove({ battle: this, unit, buff: b }), 'buff.onRemove', unit);
  }

  _tickBuffs(dt) {
    const units = this.units;
    for (let i = 0, n = units.length; i < n; i++) { // units created by onTick handlers start ticking next tick
      const u = units[i];
      if (!u.alive || u.removed) continue;
      if (u.buffs.length) {
        const arr = u.buffs.slice();
        for (const b of arr) {
          if (!u.alive) break;
          if (u.buffs.indexOf(b) < 0) continue;
          if (b.onTick) {
            if (b.interval > 0) {
              b._acc += dt;
              let n = 0;
              while (b._acc >= b.interval - 1e-9 && n++ < 8) {
                b._acc -= b.interval;
                this._safe(() => b.onTick({ battle: this, unit: u, buff: b, dt: b.interval }), 'buff.onTick', u);
              }
            } else this._safe(() => b.onTick({ battle: this, unit: u, buff: b, dt }), 'buff.onTick', u);
          }
          if (b.timeLeft !== Infinity) {
            b.timeLeft -= dt;
            if (b.timeLeft <= 1e-9) {
              const i = u.buffs.indexOf(b);
              if (i >= 0) {
                this._removeBuffAt(u, i, false);
                if (b.onExpire) this._safe(() => b.onExpire({ battle: this, unit: u, buff: b }), 'buff.onExpire', u);
              }
            }
          }
        }
      }
      // natural HP regeneration
      if (u.alive && u.deployed && !u.bossPool) {
        const regen = u.s.hpRegen;
        if (regen > 0 && u.hp < u.s.maxHp) {
          u._regenAcc = (u._regenAcc ?? 0) + regen * dt;
          if (u._regenAcc >= 1 || u.hp + u._regenAcc >= u.s.maxHp) {
            this.heal(u, u, u._regenAcc, { self: true, silent: true, regen: true });
            u._regenAcc = 0;
          }
        }
      }
    }
  }

  /**
   * Apply a catalogue status. opts: { duration, source, value, force, refresh, point } — returns true when applied.
   * Honours enemy immunities (stun/silence/sleep/frozen/levitate/feared) unless `force`. `beforeStatus` handlers may
   * cancel it or change `duration` / `value`. Official rules (buffs.js STATUS): 抵抗 (the `resist` status) shortens the
   * RESIST_STATUSES by its value (default half; applied after `beforeStatus`); 浮空 lasts half as long on units heavier
   * than LEVITATE_HALF_WEIGHT (current massLevel); 冻结's RES cut hits enemies only; 麻痹 adds stacks; "同名效果取最高"
   * statuses (`valued`) keep the strongest value — a weaker application only extends past the stronger one's end (it
   * then resumes); other statuses refresh to the longer duration. 诱导 (`attract`) walks the enemy to `point`
   * ([r, c] or {x, y}; default the source's tile — a new application moves the point). A stunned/sleeping operator
   * releases the enemies it blocks; a feared/levitated/unblockable/attracted enemy is released by its blocker.
   * `statusApplied` reports the final duration and `entered` (the target did not carry the status before).
   */
  applyStatus(target, key, opts = {}) {
    if (!target || !target.alive) return false;
    const tpl = STATUS[key] || { flags: { [key]: true } };
    let duration = opts.duration == null ? Infinity : Number(opts.duration);
    let value = opts.value;
    if (!(duration > 0)) return false;
    const immune = target.def && target.def.immune;
    if (!opts.force && tpl.immune && immune && immune.has(tpl.immune)) return false;
    if (this._hooks.beforeStatus) {
      const c = this.emit('beforeStatus', { source: opts.source ?? null, target, status: key, duration, value, cancel: false });
      if (c.cancel || !target.alive) return false;
      const d = Number(c.duration);
      if (d === Infinity || (Number.isFinite(d) && d > 0)) duration = d;
      else if (Number.isFinite(d) && d <= 0) return false;
      value = c.value;
    }
    if (RESIST_STATUSES.has(key)) {
      const rv = this.resistOf(target);
      if (rv > 0) duration *= 1 - rv;
    }
    if (key === 'levitate' && target.s.massLevel > LEVITATE_HALF_WEIGHT) duration /= 2;
    if (!(duration > 0)) return false;
    if (key === 'cold' && target.findBuff('cold') && !(immune && immune.has('frozen'))) {
      this.applyStatus(target, 'freeze', { duration: COLD_FREEZE_DURATION, source: opts.source, force: opts.force });
      if (!target.alive) return false;
    }
    const source = opts.source ?? null;
    let entered = true;
    for (const b of target.buffs) if ((b.status ?? b.key) === key) { entered = false; break; }
    if (tpl.palsy) {
      this.addBuff(target, { ...palsyBuff(value ?? 1), duration, source });
    } else if (tpl.valued != null && typeof tpl.mods === 'function' && opts.refresh == null) {
      this._applyValuedStatus(target, key, tpl, duration, value ?? tpl.valued, source);
    } else {
      const mods = tpl.enemyOnlyMods && target.side !== 'enemy' ? null : typeof tpl.mods === 'function' ? tpl.mods(value) : (tpl.mods || null);
      const b = this.addBuff(target, { key, duration, refresh: opts.refresh ?? 'extend', mods, flags: tpl.flags || null, status: key, visible: true, source });
      if (tpl.attract && b) this._setAttractPoint(target, b, opts.point ?? value, source);
    }
    const f = tpl.flags;
    if (f && target.side === 'enemy' && (f.levitate || f.unblockable || f.fear)) this._unblock(target);
    if (f && target.side === 'ally' && f.noBlock) this.releaseBlocked(target);
    if (this._hooks.statusApplied) this.emit('statusApplied', { source, target, status: key, duration, value, entered });
    return true;
  }

  /** 抵抗 of a unit: share of a resisted status's duration removed (0 = none; the `resist` status value, ≤ 0.95). */
  resistOf(unit) {
    if (!unit || !unit.buffs.length) return 0;
    let r = 0;
    for (const b of unit.buffs) {
      if (b.status !== 'resist') continue;
      const v = Number.isFinite(b.data?.value) ? b.data.value : RESIST_DEFAULT;
      if (v > r) r = v;
    }
    return Math.min(0.95, r);
  }

  /** 诱导 target point of an `attract` status buff (enemy walks there; see ai.js moveAttracted). */
  _setAttractPoint(target, buff, point, source) {
    let r = null, c = null;
    if (Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])) { r = point[0]; c = point[1]; }
    else if (point && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y)) { r = point.y; c = point.x; }
    else if (source && Number.isFinite(source.x) && Number.isFinite(source.y)) { r = source.y; c = source.x; }
    if (r == null) { if (!buff.data.attract) buff.data = { ...buff.data, attract: null }; return; }
    const R = this.rect;
    r = Math.max(R.r0, Math.min(R.r1, Math.round(r)));
    c = Math.max(R.c0, Math.min(R.c1, Math.round(c)));
    buff.data = { ...buff.data, attract: { r, c, pts: null, i: 0, ver: -1 } };
  }

  /** "同名效果取最高": keep the strongest value; a weaker one that outlasts it resumes afterwards (buff.data.tail). */
  _applyValuedStatus(target, key, tpl, duration, value, source) {
    const strength = (v) => Math.abs(Number.isFinite(v) ? v : tpl.valued);
    const make = (v, dur, tail) => ({
      ...(tpl.buff || null),   // extra buff fields of the status (抵抗: the 麻痹 decay tick)
      key, duration: dur, refresh: 'replace', mods: tpl.mods(v), flags: tpl.flags || null, status: key, visible: true, source,
      data: { value: v, tail },
      onExpire: ({ battle, unit, buff }) => {
        const t = buff.data.tail;
        if (t && t.until - battle.time > 1e-6 && unit.alive) battle.addBuff(unit, make(t.value, t.until - battle.time, null));
      },
    });
    const old = target.buffs.find((b) => b.key === key && b.status === key);
    if (!old) { this.addBuff(target, make(value, duration, null)); return; }
    const oldV = old.data && Number.isFinite(old.data.value) ? old.data.value : tpl.valued;
    const oldEnd = this.time + old.timeLeft, newEnd = this.time + duration;
    const oldTail = old.data && old.data.tail;
    const longerTail = (a, b) => (!a ? b : !b ? a : (b.until > a.until ? b : a));
    if (strength(value) > strength(oldV) + 1e-12) {
      // stronger: takes over now; the weaker old one (or its tail) resumes if it lasts longer
      const tail = longerTail(oldEnd > newEnd ? { value: oldV, until: oldEnd } : null, oldTail && oldTail.until > newEnd ? oldTail : null);
      this.addBuff(target, make(value, duration, tail));
    } else if (strength(value) < strength(oldV) - 1e-12) {
      // weaker: never overrides; remembered as the tail when it outlasts the running one
      if (newEnd > oldEnd && (!oldTail || newEnd > oldTail.until)) old.data = { ...old.data, value: oldV, tail: { value, until: newEnd } };
    } else if (duration > old.timeLeft) {
      old.timeLeft = duration;
      old.duration = Math.max(old.duration, duration);
    }
  }

  removeStatus(target, key) { return this.removeBuff(target, key); }

  // =============================================================================================================
  // damage / heal

  dealDamage(source, target, dmg) {
    try { return pipeDamage(this, source, target, dmg); } catch (e) { this._internalError('dealDamage', e); return 0; }
  }

  heal(source, target, amount, opts = {}) {
    try { return pipeHeal(this, source, target, amount, opts); } catch (e) { this._internalError('heal', e); return 0; }
  }

  /**
   * HP loss that ignores DEF/RES, dodge and shields (流失). May kill. opts: { source, silent, tags, from } — `from` = the
   * DamageInfo this loss derives from (damage passed on to a leader, split, shared…): its tags are inherited and it is
   * kept as `dmg.origin`, so `damaged` handlers that skip their own tagged damage also skip what it turned into.
   */
  loseHp(target, amount, { source = null, silent = false, tags = null, from = null } = {}) {
    if (!target || !target.alive || !(amount > 0)) return 0;
    const t = ['hpLoss'];
    for (const list of [from && from.tags, tags]) if (Array.isArray(list)) for (const x of list) if (!t.includes(x)) t.push(x);
    return applyHpLoss(this, source, target, amount, { type: 'true', tags: t, noSp: true, silent, origin: from ?? null });
  }

  reduceElement(target, amount, element = null) { return reduceElement(target, amount, element); }

  makeDamage(d) { return makeDamageInfo(d); }

  // =============================================================================================================
  // queries

  _buildEnemyIndex() {
    for (const k of this._ebUsed) this._eb[k].length = 0;
    this._ebUsed.length = 0;
    for (const e of this.enemies) {
      if (!e.alive || e.hidden) continue;
      const r = Math.round(e.y), c = Math.round(e.x);
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
      const k = r * COLS + c;
      const b = this._eb[k];
      if (!b.length) this._ebUsed.push(k);
      b.push(e);
    }
  }

  /** Targetable enemies standing on any of `keys` (absolute tile keys). */
  enemiesInKeys(keys, attacker, profile) {
    const out = [];
    if (!keys) return out;
    for (let i = 0; i < keys.length; i++) {
      const b = this._eb[keys[i]];
      if (!b || !b.length) continue;
      for (const e of b) if (e.alive && canTargetEnemy(attacker, e, profile)) out.push(e);
    }
    return out;
  }

  /** Allies (not devices) within tiles `keys`, sorted by HP ratio (lowest first) that need healing. */
  injuredAlliesInKeys(keys, healer, includeElement = false) {
    const out = [];
    if (!keys) return out;
    const set = keys instanceof Set ? keys : (healer && healer.rangeKeys === keys && healer.rangeKeySet ? healer.rangeKeySet : new Set(keys));
    for (const a of this.allyUnits) {
      if (!a.alive || !a.deployed || a.hidden || a.kind === 'device') continue;
      if (!set.has(a.tileR * COLS + a.tileC)) continue;
      if (a !== healer && (a.s.flags.noHeal || (a.profile && a.profile.noHeal))) continue;
      const injured = a.hp < a.s.maxHp - 1e-6;
      const elem = includeElement && (a.elem.burn + a.elem.neural + a.elem.necrosis + a.elem.apoptosis + a.elem.erosion) > 0;
      if (injured || elem) out.push(a);
    }
    out.sort((a, b) => a.hpRatio - b.hpRatio || a.deploySeq - b.deploySeq);
    return out;
  }

  lowestHpAllyInRange(unit) {
    const l = this.injuredAlliesInKeys(unit.rangeKeys, unit);
    return l[0] ?? null;
  }

  /** Units of the opposite side (or `side`) whose tile is inside `grid` offsets relative to `unit`. */
  unitsInGrid(unit, grid, { side = null, extend = 0 } = {}) {
    const keys = absoluteRangeKeys(grid || unit.rangeGrid || [[0, 0]], Math.round(unit.y), Math.round(unit.x), unit.dir, extend);
    const want = side ?? (unit.side === 'ally' ? 'enemy' : 'ally');
    const set = new Set(keys);
    const out = [];
    const list = want === 'enemy' ? this.enemies : this.allyUnits;
    for (const x of list) {
      if (!x.alive || !x.deployed || x.hidden) continue;
      if (set.has(Math.round(x.y) * COLS + Math.round(x.x))) out.push(x);
    }
    return out;
  }

  /** Allies inside `unit`'s current range (for auras). */
  alliesInGrid(unit) {
    const set = unit.rangeKeySet || new Set(unit.rangeKeys || []);
    return this.allyUnits.filter((a) => a.alive && a.deployed && !a.hidden && a.kind !== 'device' && set.has(a.tileR * COLS + a.tileC));
  }

  enemiesInRadius(x, y, r) {
    const out = [];
    const r2 = r * r + 1e-9;
    for (const e of this.enemies) {
      if (!e.alive || e.hidden) continue;
      const dx = e.x - x, dy = e.y - y;
      if (dx * dx + dy * dy <= r2) out.push(e);
    }
    return out;
  }

  alliesInRadius(x, y, r, ownerId = null, { includeDevices = false } = {}) {
    const out = [];
    const r2 = r * r + 1e-9;
    for (const a of this.allyUnits) {
      if (!a.alive || !a.deployed || a.hidden) continue;
      if (!includeDevices && a.kind === 'device') continue;
      if (ownerId != null && a.ownerId !== ownerId) continue;
      const dx = a.x - x, dy = a.y - y;
      if (dx * dx + dy * dy <= r2) out.push(a);
    }
    return out;
  }

  /** Alive deployed allies (ops + tokens), optionally of one player. */
  allies(ownerId = null) {
    return this.allyUnits.filter((a) => a.alive && a.deployed && a.kind !== 'device' && (ownerId == null || a.ownerId === ownerId));
  }

  aliveEnemies() { return this.enemies.filter((e) => e.alive); }

  unitAt(r, c) { const u = this._occ[r * COLS + c]; return u && u.alive ? u : null; }
  unitById(id) { return this.units.find((u) => u.id === id) ?? null; }
  tileInfo(r, c) { return this.grid.tile(r, c); }

  getPlayer(playerId) { return this.players.find((p) => p.playerId === playerId) ?? null; }
  _pp(playerId) { return playerId == null ? null : this._perPlayer[playerId] ?? null; }

  /**
   * Recompute a unit's absolute range tile keys: `rangeKeys` / `rangeKeySet` = current range (skill range override +
   * rangeExtend) ∪ `unit.extraRangeKeys` (content extra targets — setExtraRange); `baseRangeKeys` = the INITIAL range
   * of the DEFAULT skill trigger: the unit's own grid + its permanent rangeExtend (`s.baseRangeExtend`: persistent,
   * never-expiring buffs — talents, modules, bonds), no skill range, no temporary extend, no extra keys. Rebuilt on
   * deploy / relocate / skill range switches and whenever either extend changes (rangeChanged).
   */
  _refreshRange(u) {
    const tg = u.skill && u.skill.active ? u.skill.spec.targeting : null;
    const grid = (tg && tg.rangeGrid) || u.rangeGrid || [[0, 0]];
    const ext = u.s.rangeExtend + ((tg && tg.rangeExtend) || 0);
    u._rangeExtend = u.s.rangeExtend;
    u._baseExtend = u.s.baseRangeExtend;
    const keys = absoluteRangeKeys(grid, u.tileR, u.tileC, u.dir, ext);
    const set = new Set(keys);
    const extra = u.extraRangeKeys;
    if (extra) for (const k of extra) if (!set.has(k)) { set.add(k); keys.push(k); }
    u.rangeKeys = keys;
    u.rangeKeySet = set;
    if (u.kind !== 'device') u.baseRangeKeys = absoluteRangeKeys(u.rangeGrid || [[0, 0]], u.tileR, u.tileC, u.dir, u.s.baseRangeExtend);
    if (u.skill) u.skill._trigKeys = null; // CUSTOM_RANGE trigger grid is relative to the tile
  }

  /** True when a buff changed the unit's rangeExtend (total or permanent part) since its range was last built. */
  rangeChanged(u) {
    return u._rangeExtend !== undefined && (u._rangeExtend !== u.s.rangeExtend || u._baseExtend !== u.s.baseRangeExtend);
  }

  /** Public: rebuild a unit's range after content changed `unit.rangeGrid` (流形 copies) or its tile keys. */
  refreshRange(unit) {
    if (!unit || unit.side !== 'ally' || !unit.alive || !unit.deployed) return false;
    this._refreshRange(unit);
    return true;
  }

  /**
   * Extra targetable tiles merged into the unit's range (蕾缪安 wanted targets, 维娜 S3, …): absolute tile keys
   * (row × COLS + col), kept across every later range rebuild until content sets them again (null / [] clears).
   * Not part of `baseRangeKeys` (the DEFAULT trigger range) — see SkillRuntime.addTriggerRange for that.
   */
  setExtraRange(unit, keys) {
    if (!unit || unit.side !== 'ally') return false;
    const out = [];
    const seen = new Set();
    for (const k of keys || []) if (Number.isInteger(k) && k >= 0 && k < ROWS * COLS && !seen.has(k)) { seen.add(k); out.push(k); }
    unit.extraRangeKeys = out.length ? out : null;
    if (unit.alive && unit.deployed) this._refreshRange(unit);
    return true;
  }

  // =============================================================================================================
  // content helpers

  /**
   * Token def of `tokenId` as `owner` (an ally unit: its chess + selected skill / module; or a chess id) summons it —
   * the def spawnToken uses. For content that reads summon stats / skill blackboards: exact in a multi-player field
   * where two players give the same chess different loadouts (an id-only `data.getToken(id, chessId)` is not).
   */
  tokenDef(tokenId, owner = null) {
    return this._tokenDef(tokenId, owner, null);
  }

  /**
   * Whether an operator's selected skill / module produces `tokenId` (DESIGN §16, DATA.md §14 `sources`): false only
   * when the owner's own tokens.json variant says so (`sources` without 'skill' / 'talent' — e.g. 琳琅诗怀雅 S1/S3 make
   * no 香槟炸弹, 赫默 S1 no 医疗探机); true when the data does not tell (no owner variant, inline defs, tokens of
   * other chess).
   */
  producesToken(owner, tokenId, def = null) {
    if (!owner || typeof owner !== 'object' || owner.kind !== 'op') return true;
    const d = def ?? this.tokenDef(tokenId, owner);
    const src = d && Array.isArray(d.sources) ? d.sources : null;
    if (!src || src.includes('skill') || src.includes('talent')) return true;
    const vs = this.data.rawToken?.(tokenId)?.variants;
    const id = String(owner.defId ?? '');
    return !(vs && typeof vs === 'object' && (vs[id] || vs[id.replace(/_b$/, '_a')]));
  }

  /**
   * Spawn (and deploy) a token. `owner` = ally unit or playerId. Returns the token unit or null. The def is the owner's
   * variant for its selected skill / module (`opts.def` = an inline def instead). While an operator runs a NON-default
   * skill, a summon that skill does not produce (producesToken) is refused unless `opts.anySource`: hand-authored kit
   * install hooks are written for the default skill and run under every skill (琳琅诗怀雅 S1/S3 would drop 香槟炸弹);
   * under the default skill the kit stays the authority.
   */
  spawnToken(owner, tokenId, row, col, opts = {}) {
    const ownerUnit = owner && typeof owner === 'object' ? owner : null;
    const pid = ownerUnit ? ownerUnit.ownerId : owner;
    const ps = this.getPlayer(pid) ?? (ownerUnit ? ownerUnit.player : null);
    const def = opts.def ? normalizeToken(tokenId, opts.def) : this._tokenDef(tokenId, ownerUnit, null);
    if (!def) { this.log(`unknown token ${tokenId}`); return null; }
    if (!opts.def && !opts.anySource && ownerUnit && ownerUnit.def?.loadout?.skillIsDefault === false && !this.producesToken(ownerUnit, tokenId, def)) {
      this.log(`${ownerUnit.defId} (skill ${ownerUnit.def?.loadout?.skillIndex ?? '?'}) does not produce ${tokenId}`);
      return null;
    }
    if (!Number.isInteger(row) || !Number.isInteger(col) || !this.grid.inRect(row, col)) return null;
    const occ = this._occ[row * COLS + col];
    if (occ && occ.alive && !opts.force) return null;
    const dir = opts.dir != null ? normDir(opts.dir) : opts.facing != null ? normDir(opts.facing) : ownerUnit ? ownerUnit.dir : ps ? ps.dir : 'RIGHT';
    const u = this._makeAlly(ps, def, 'token', row, col, { ownerUnit, dir });
    if (opts.stats) for (const [k, v] of Object.entries(opts.stats)) if (Number.isFinite(v)) u.base[k] = v;
    this._setupUnit(u, opts.kit ?? null);
    if (opts.untargetable) this.addBuff(u, { key: 'trait:untargetable', flags: { untargetable: true }, persist: true, allowDead: true });
    if (!this._deploy(u, { initial: false })) {
      // tile still busy (a unit stands there even with `force`): drop the half-built token and its hooks
      u.removed = true;
      this.offOwner(u);
      return null;
    }
    if (opts.hp != null && Number.isFinite(Number(opts.hp))) u.hp = Math.max(1, Math.min(u.s.maxHp, Number(opts.hp)));
    if (opts.duration > 0 && Number.isFinite(Number(opts.duration))) this.after(Number(opts.duration), () => { if (u.alive) this.retreat(u, { reason: 'expired', permanent: true }); }, { owner: u });
    return u;
  }

  /**
   * Spawn a stage device (e.g. crates). opts: { hp, obstacle, obstacleKind, blockCnt, name, def, res, atk, bat, aspd }.
   * An `obstacle` device is an obstacle-like tile by default (`obstacleKind` 'crate': enemies route around it at cost
   * 1000 and, when it is the only way, walk into it, get blocked by it and break it — research 08 §3.1); 'block' makes
   * the tile impassable.
   */
  spawnDevice(key, row, col, opts = {}) {
    // Devices are ally-side units on a field tile: never outside the rect, never on top of a living unit.
    if (!Number.isInteger(row) || !Number.isInteger(col) || !this.grid.inRect(row, col)) return null;
    const occ = this._occ[row * COLS + col];
    if (occ && occ.alive) return null;
    const hp = fin(opts.hp, 100);
    const bat = fin(opts.bat, 1), aspd = fin(opts.aspd, 100);
    const def = {
      type: 'device', id: key, baseId: key, name: opts.name ?? key, tier: 0, golden: false, profession: 'DEVICE', subProf: null,
      stats: { maxHp: hp > 0 ? hp : 100, atk: Math.max(0, fin(opts.atk, 0)), def: Math.max(0, fin(opts.def, 0)), res: Math.min(100, Math.max(0, fin(opts.res, 0))), aspd: aspd > 0 ? aspd : 100, bat: bat > 0 ? bat : 1, blockCnt: Math.max(0, fin(opts.blockCnt, 99)), cost: 0, respawnTime: 0, spRecovery: 0, tauntLevel: -1, massLevel: 0, hpRecoveryPerSec: 0 },
      rangeGrid: [[0, 0]], skill: null, talents: [], spine: key, avatar: key,
    };
    const u = this._makeAlly(null, def, 'device', row, col, opts.dir != null ? { dir: opts.dir } : {});
    u.ownerId = null;
    u.kit = {};
    u.profile = { noAttack: true, maxTargets: 0 };
    u.skill = new SkillRuntime(this, u, null, null, {});
    u.obstacle = !!opts.obstacle;
    u.obstacleKind = opts.obstacleKind === 'block' ? 'block' : 'crate';
    u.alive = true;
    u.deployed = true;
    u.ground = true;
    u.markDirty();
    u.hp = u.s.maxHp;
    u.deploySeq = ++this._deploySeq;
    u.deployedAt = this.time;
    u.rangeKeys = [];
    this._occ[row * COLS + col] = u;
    if (u.obstacle) this.grid.setObstacle(row, col, true, u.obstacleKind);
    this._ev(['spawn', unitInfo(u)]);
    if (this._hooks.deploy) this.emit('deploy', { unit: u, initial: !this.started });
    return u;
  }

  _spawnStageDevices() {
    if (this.opts.devices === false) return;
    for (const d of this.stage.devices || []) {
      // data/stages.json `active` = present at match start (= not hidden in the 下半 level file: act1 m02 starts with no
      // crates, research 08 §3.3); research stages have no `active` ⇒ `hidden` decides.
      const act = d.raw && typeof d.raw.active === 'boolean' ? d.raw.active : !d.hidden && d.active !== false;
      if (!act) continue;
      if (d.role === 'platform' || d.role === 'mound') {
        // 射击台 / mounds [ASSUMED, research 08 §8 #1]: hard-block ground movement; an operator standing on one is elevated
        // (does not block) — the match lets ranged operators deploy there (deployTiles.rangedOnly).
        if (!this.grid.inRect(d.row, d.col)) continue;
        this.grid.setObstacle(d.row, d.col, true);
        (this._elevated ??= new Set()).add(d.row * COLS + d.col);
        continue;
      }
      const spec = OBSTACLE_DEVICES[d.key] ?? (d.role === 'crate' ? { hp: d.stats?.maxHp ?? 100, name: d.name } : null);
      if (!spec) continue;
      if (!this.grid.inRect(d.row, d.col)) continue;
      if (this._occ[d.row * COLS + d.col]) continue;
      this.spawnDevice(d.key, d.row, d.col, { hp: spec.hp, obstacle: true, name: spec.name });
    }
  }

  /** Toggle a ground obstacle (enemies re-read their flow field). `kind` 'block' (default, impassable) | 'crate'. */
  setObstacle(r, c, on, kind = 'block') { this.grid.setObstacle(r, c, on, kind); }

  addProjectile(p) { return this.projectiles.add(p); }

  /** Move an ally to another tile (keeps state). */
  relocate(unit, r, c) {
    // only a living, deployed ally moves, and only onto an integer tile of this field (a dead unit left in _occ
    // would later "block" from a tile it no longer stands on once it redeploys at home)
    if (!unit || unit.side !== 'ally' || !unit.alive || !unit.deployed) return false;
    if (!Number.isInteger(r) || !Number.isInteger(c) || !this.grid.inRect(r, c)) return false;
    const k = r * COLS + c;
    if (this._occ[k] && this._occ[k] !== unit && this._occ[k].alive) return false;
    const ok = unit.tileR * COLS + unit.tileC;
    if (this._occ[ok] === unit) this._occ[ok] = null;
    this.releaseBlocked(unit);
    if (unit.obstacle) this.grid.setObstacle(unit.tileR, unit.tileC, false, unit.obstacleKind);
    unit.tileR = r; unit.tileC = c; unit.x = c; unit.y = r;
    unit.ground = this.grid.isLow(r, c) && !this._elevated?.has(k);
    this._occ[k] = unit;
    if (unit.obstacle) this.grid.setObstacle(r, c, true, unit.obstacleKind);
    this._refreshRange(unit); // current + base range, CUSTOM_RANGE trigger keys
    return true;
  }

  /**
   * Displace an enemy (hook/push). dir = {x,y} (normalised internally), distance in tiles. Heavier enemies move
   * less: effective = distance × clamp(1 − 0.25·(massLevel − force), 0, 1) (current massLevel: 失重 counts).
   */
  displace(e, dir, distance, { force = 1 } = {}) {
    if (!e || !e.alive || e.side !== 'enemy' || e.isBoss) return 0;
    const len = Math.hypot(dir.x, dir.y);
    if (!(len > 0)) return 0;
    const eff = distance * Math.max(0, Math.min(1, 1 - 0.25 * Math.max(0, e.s.massLevel - force)));
    if (eff <= 0) return 0;
    const ux = dir.x / len, uy = dir.y / len;
    let moved = 0;
    const stepLen = 0.1;
    while (moved + 1e-9 < eff) {
      const nx = e.x + ux * stepLen, ny = e.y + uy * stepLen;
      const r = Math.round(ny), c = Math.round(nx);
      const ok = e.isFlying ? this.grid.inRect(r, c) : this.grid.groundPassable(r, c);
      if (!ok) break;
      e.x = nx; e.y = ny; moved += stepLen;
    }
    if (moved > 0) {
      this._unblock(e);
      if (e.route) e.route.pts = null;
      this.fx('displace', { x: e.x, y: e.y, id: e.id });
    }
    return moved;
  }

  /**
   * A tile a summon must not take: a living unit stands on it, or it is the home tile of an ally piece that has not
   * deployed yet or waits to redeploy (a token parked there would keep that unit off the field for the whole battle).
   */
  isReservedTile(r, c) {
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
    const u = this._occ[r * COLS + c];
    if (u && u.alive) return true;
    for (const a of this.allyUnits) {
      if (!a.alive && !a.removed && a.homeR === r && a.homeC === c && (a.kind === 'op' || a.kind === 'token')) return true;
    }
    return false;
  }

  /**
   * Tactical point (战术点) for tactician reinforcements: a free (isReservedTile) walkable ground tile of the unit's
   * initial range (baseRangeKeys), on an enemy ground path first (groundPathTiles — where a player would put the
   * blocker), then nearest to the unit (Chebyshev; the smaller sideways offset — in the unit's facing-RIGHT frame, so
   * its forward line — breaks ties), then the lowest local (row, col) offset (sim/dir.js localOrder: for a RIGHT-facing
   * unit exactly the lowest tile key). The choice turns with the unit's direction. null when none.
   */
  findTacticalPoint(unit) {
    if (!unit) return null;
    const onPath = this.groundPathTiles();
    let best = null, bp = 2, bd = Infinity, bo = null;
    for (const k of unit.baseRangeKeys || unit.rangeKeys || []) {
      const r = (k / COLS) | 0, c = k % COLS;
      if (!this.grid.groundPassable(r, c) || !this.grid.canStand(r, c)) continue;
      if (this.isReservedTile(r, c)) continue;
      const o = localOrder(r - unit.tileR, c - unit.tileC, unit.dir);
      const d = Math.max(Math.abs(r - unit.tileR), Math.abs(c - unit.tileC)) + 0.01 * Math.abs(o[0]);
      if (!(d > 0)) continue;
      const p = onPath.has(k) ? 0 : 1;
      if (p < bp || (p === bp && (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && localBefore(o, bo))))) { bp = p; bd = d; bo = o; best = [r, c]; }
    }
    return best;
  }

  /**
   * Ground tiles the enemies of this field walk on: the flow-field routes (grid.findPath, live obstacles) of the
   * non-FLY routes this battle's wave spawns on (every non-FLY route when no queued spawn names one — e.g. content-only
   * battles), leg by leg (start → MOVE/APPEAR checkpoints → end, clamped to the rect). R1–R3 spawn at the lower gate
   * only (research 08 §4.1), so the unused upper lane does not attract tactical points. Set of tile keys, cached per
   * grid version.
   */
  groundPathTiles() {
    const ver = this.grid.version ?? 0;
    const used = (this._pathRoutesUsed ??= new Set());
    const before = used.size;
    for (const p of this._pending || []) if (!p.route && Number.isInteger(p.routeIndex)) used.add(p.routeIndex);
    if (this._pathTiles && this._pathTilesVer === ver && used.size === before) return this._pathTiles;
    const set = new Set();
    const R = this.rect;
    const clampPt = (p) => [Math.max(R.r0, Math.min(R.r1, Math.round(p[0]))), Math.max(R.c0, Math.min(R.c1, Math.round(p[1])))];
    const ok = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    const walk = (route) => route && route.motion !== 'FLY' && ok(route.start);
    const routes = this.routes || [];
    const any = [...used].some((i) => walk(routes[i]));
    routes.forEach((route, i) => {
      if (!walk(route) || (any && !used.has(i))) return;
      const pts = [clampPt(route.start)];
      for (const cp of route.checkpoints || []) if ((cp.type === 'MOVE' || cp.type === 'APPEAR') && ok(cp.pos)) pts.push(clampPt(cp.pos));
      if (ok(route.end)) pts.push(clampPt(route.end));
      for (let j = 1; j < pts.length; j++) {
        const [a, b] = [pts[j - 1], pts[j]];
        const p = this.grid.findPath(a[0], a[1], b[0], b[1]) || this.grid.findPath(a[0], a[1], b[0], b[1], { ignoreObstacles: true });
        for (const [r, c] of p || []) set.add(r * COLS + c);
      }
    });
    this._pathTiles = set;
    this._pathTilesVer = ver;
    return set;
  }

  addDp(playerId, n) {
    const ps = this.getPlayer(playerId);
    if (!ps || !Number.isFinite(n)) return 0;
    ps.dp = Math.max(0, Math.min(this.flags.dpMax, ps.dp + n));
    return ps.dp;
  }

  /** Record an IN_BATTLE layer gain (no-op when gains are disabled). Returns the layers added. */
  addLayers(playerId, bondId, n, reason = '', opts = {}) {
    if (!this.flags.layerGainsEnabled || !(n > 0) || !Number.isFinite(n) || playerId == null) return 0;
    const pp = this._pp(playerId);
    if (!pp) return 0;
    const source = opts.source ?? null;
    const ctx = { playerId, bondId, n, reason, source, tile: Array.isArray(opts.tile) ? opts.tile : this._sourceTile(source) };
    if (this._hooks.layerGain) { this.emit('layerGain', ctx); if (!(ctx.n > 0) || !Number.isFinite(ctx.n)) return 0; }
    pp.layerGains[bondId] = (pp.layerGains[bondId] ?? 0) + ctx.n;
    const ps = this.getPlayer(playerId);
    if (ps && ps.bonds[bondId]) ps.bonds[bondId].layers = (ps.bonds[bondId].layers ?? 0) + ctx.n;
    this._ev(['layer', playerId, bondId, ctx.n]);
    return ctx.n;
  }

  /**
   * Tile of a gain's source unit ([r, c]): where it stands, or where it stood when it left the field during this very
   * instant (a "被击倒时" gain fires from its `death`). null otherwise (no source, long gone, not a unit).
   */
  _sourceTile(u) {
    if (!u || typeof u !== 'object' || !Number.isFinite(u.x)) return null;
    const here = u.alive && u.deployed && !u.hidden;
    if (!here && !(u.deathAt === this.time && !u.alive)) return null;
    return u.side === 'ally' ? [u.tileR, u.tileC] : [Math.round(u.y), Math.round(u.x)];
  }

  addCoins(playerId, n) {
    const pp = this._pp(playerId);
    if (!pp || !(n > 0) || !Number.isFinite(n)) return 0;
    pp.coins += n;
    this._ev(['bounty', playerId, n]);
    return n;
  }

  fx(kind, params = {}) {
    const { x = 0, y = 0, ...extra } = params || {};
    this._ev(['fx', kind, Math.round(x * 100) / 100, Math.round(y * 100) / 100, extra]);
  }

  log(msg) {
    const k = 'log:' + msg;
    if (this._errKeys.has(k)) return;
    this._errKeys.add(k);
    if (this.opts.verbose) this.logger.warn?.(`[sim] ${msg}`);
  }

  // =============================================================================================================
  // internals: hidden / boss / clamp / events / errors

  _setHidden(e, on) {
    if (e.hidden === on) return;
    e.hidden = on;
    if (on) this._unblock(e);
    this.fx(on ? 'disappear' : 'appear', { x: e.x, y: e.y, id: e.id });
  }

  _syncBossHp(e) {
    const pool = e.bossPool;
    if (!pool) return;
    if (Number.isFinite(pool.maxHp) && pool.maxHp > 0 && e.base.maxHp !== pool.maxHp) { e.base.maxHp = pool.maxHp; e.markDirty(); }
    // a broken pool (NaN hp) must not leak NaN into the unit: show it full until the pool is sane again
    const ratio = pool.maxHp > 0 ? (Number.isFinite(pool.hp) ? Math.max(0, pool.hp) / pool.maxHp : 1) : 0;
    e.hp = e.s.maxHp * Math.min(1, ratio);
  }

  _bossSync() {
    if (!this.sharedBoss) return;
    for (const e of this.enemies) if (e.alive && e.bossPool) {
      this._syncBossHp(e);
      if (e.bossPool.hp <= 0) this.kill(e, null);
    }
  }

  _clampPos(e) {
    const R = this.rect;
    if (e.x < R.c0 - 0.5) e.x = R.c0 - 0.5;
    if (e.x > R.c1 + 0.5) e.x = R.c1 + 0.5;
    if (e.y < R.r0 - 0.5) e.y = R.r0 - 0.5;
    if (e.y > R.r1 + 0.5) e.y = R.r1 + 0.5;
  }

  _compactEnemies() {
    if (!this._enemiesDirty) return;
    this.enemies = this.enemies.filter((e) => e.alive);
    this._enemiesDirty = false;
  }

  _ev(tuple) {
    if (!this.recordEvents) return;
    this._evq.push(tuple);
    if (this._evq.length > EVENT_BUFFER_CAP) this._evq.splice(0, this._evq.length - EVENT_BUFFER_CAP / 2);
  }

  /** Client-facing events since the last drain (DESIGN §8.2 tuples). */
  drainEvents() {
    const ev = this._evq;
    this._evq = [];
    return ev;
  }

  /**
   * Compact full snapshot of this field (DESIGN §8.2 b.snap), plus (only when non-empty):
   *   down: [[id, respawnAt, respawnTime, state]] — knocked-out operators waiting to redeploy on their own tile
   *         (isDown): the game time their respawn timer ends, its length (s) and constants.js DOWN_STATE;
   *   elem: [[id, element, fill, cooldownEnd, cooldown]] — the element gauge each unit shows (damage.js elementView).
   */
  snapshot() {
    const snap = {
      fieldId: this.fieldId,
      t: Math.round(this.time * 1000) / 1000,
      units: snapshotUnits(this.units, this.time),
      dp: this.players.length ? Math.floor(this.players[0].dp) : 0,
      killed: this.killed,
      total: this.total,
    };
    if (this.players.length > 1) {
      snap.dps = {};
      for (const p of this.players) snap.dps[p.playerId] = Math.floor(p.dp);
    }
    if (this.sharedBoss) snap.boss = { hp: Math.max(0, Math.round(this.sharedBoss.hp)), max: Math.round(this.sharedBoss.maxHp) };
    const r2 = (v) => Math.round(v * 100) / 100;
    let down = null;
    for (const u of this.allyUnits) {
      if (!this.isDown(u)) continue;
      (down || (down = [])).push([u.id, r2(u.respawnAt), r2(Math.max(0, u.respawnAt - u.deathAt)), this._downState(u)]);
    }
    if (down) snap.down = down;
    let elem = null;
    for (const u of this.units) {
      if (!u.alive || !u.deployed || u.hidden) continue;
      const v = elementView(u, this.time);
      if (v) (elem || (elem = [])).push([u.id, v[0], v[1], v[2], v[3]]);
    }
    if (elem) snap.elem = elem;
    return snap;
  }

  /**
   * A knocked-out operator waiting to redeploy on its own tile (DESIGN §5.5: after its respawn time, when the tile is
   * free and DP ≥ cost): killed — not withdrawn, not removed for good — after it was deployed. The client keeps its
   * model on the field knocked down with a redeploy countdown (b.snap `down`, render/units.js); summons, devices and
   * enemies simply leave.
   */
  isDown(u) {
    return !!u && u.side === 'ally' && u.kind === 'op' && !u.alive && !u.removed && u.removeReason === 'killed'
      && u.deploySeq > 0 && Number.isFinite(u.respawnAt);
  }

  /** constants.js DOWN_STATE of a down operator: its timer runs, or it waits for its tile / the DP (_checkRedeploys). */
  _downState(u) {
    if (this.time + 1e-9 < u.respawnAt) return DOWN_STATE.COUNTING;
    const occ = this._occ[u.homeR * COLS + u.homeC];
    if (occ && occ.alive && occ !== u) return DOWN_STATE.WAIT_TILE;
    const ps = this.getPlayer(u.ownerId);
    return !ps || ps.dp + 1e-9 < u.base.cost ? DOWN_STATE.WAIT_DP : DOWN_STATE.COUNTING;
  }

  /**
   * Field meta for m.field: { fieldId, kind, rect, stageId, units: UnitInfo[] } — the units on the field, knocked-out
   * operators waiting to redeploy included (a client joining mid-battle shows them down).
   */
  fieldMeta() {
    return {
      fieldId: this.fieldId, kind: this.kind, rect: { ...this.rect }, stageId: this.stageId,
      units: this.units.filter((u) => (u.alive && u.deployed && !u.hidden) || this.isDown(u)).map(unitInfo),
    };
  }

  /** Run a content callback (skill/buff/projectile/timer/install) isolated from errors; shares the hook depth guard. */
  _safe(fn, label, owner = null) {
    if (this._emitDepth >= MAX_HOOK_DEPTH) {
      this._handlerError(`hookDepth:${label}`, owner, new Error(`callback nesting deeper than ${MAX_HOOK_DEPTH}; skipped — ${this._chain(label)}`));
      return undefined;
    }
    const d = this._emitDepth++;
    this._frameName[d] = label;
    this._frameOwner[d] = owner;
    this._frameCtx[d] = null;
    try { return fn(); } catch (e) { this._handlerError(label, owner, e); return undefined; } finally { this._emitDepth--; }
  }

  _handlerError(label, owner, e, internal = false) {
    this.errorCount++;
    const who = owner && owner.defId ? owner.defId : (owner && owner.name) || '';
    const key = `${label}|${who}|${e && e.message}`;
    if (!this._errKeys.has(key)) {
      this._errKeys.add(key);
      if (this.errors.length < 100) this.errors.push({ label, who, message: String(e && e.message), stack: e && e.stack });
      if (this.opts.quiet !== true) this.logger.error?.(`[sim] ${label}${who ? ' (' + who + ')' : ''} failed: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
    }
    // Content handler errors are isolated (the handler is skipped, the battle continues). Repeated *engine*
    // errors mean the field state is suspect: force-end it as a timeout (DESIGN §11).
    if (internal) {
      this.internalErrorCount = (this.internalErrorCount ?? 0) + 1;
      if (this.internalErrorCount > MAX_INTERNAL_ERRORS && !this.finished && !this._forcing) {
        this._forcing = true;
        try { this.forceEnd('timeout'); } catch { this._hardFinish('timeout'); }
      }
    }
  }

  _internalError(label, e) { this._handlerError('internal:' + label, null, e, true); }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Battle<${this.kind} seed=${this.seed} t=${this.time.toFixed(2)} units=${this.units.length}${this.finished ? ' ' + this.reason : ''}>`;
  }

  // exposed for ai/content convenience
  effectiveProfile(u) { return effectiveProfile(u); }
  /**
   * Perform an immediate attack with a unit's current profile (content: "立即攻击", extra attacks, counters). It is an
   * attack in every respect (hooks, attack SP, a running ammo skill's bullet) — except with `noAmmo: true`: an extra
   * attack that spends no ammo (no `ammoUsed`, the skill never ends on it; 圣约送葬人 "不额外消耗弹药").
   * Returns true when an attack was made.
   */
  forceAttack(u, targets = null, { noAmmo = false } = {}) {
    if (!u || !u.alive || !u.profile) return false;
    const prof = effectiveProfile(u);
    const t = targets ?? acquireTargets(this, u, prof);
    if (!t || !t.length) return false;
    const n0 = u.stats.attacks;
    performAttack(this, u, prof, t, noAmmo ? { noAmmo: true } : null);
    return u.stats.attacks > n0;
  }
}

export default Battle;
