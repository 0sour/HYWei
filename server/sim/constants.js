// server/sim/constants.js — simulation timing, conversions and tuning knobs (DESIGN §3, §4, §5).
// Pure data; every value here is safe to tweak for balancing. Nothing in the sim reads wall-clock time.

import { GEO } from '../../shared/constants.js';

/** Fixed simulation step in game seconds (DESIGN §4). */
export const TICK = 1 / 30;
/** Snapshots are produced every N ticks by the match (20 Hz at 2× real time). */
export const SNAPSHOT_EVERY = 3;

export const ROWS = GEO.ROWS;
export const COLS = GEO.COLS;

/** tilesPerSecond = moveSpeed × MOVE_SCALE (DESIGN §3). */
export const MOVE_SCALE = 0.5;
/** Ranged enemies stop moving this long after each attack (DESIGN §5.5). */
export const ATTACK_PAUSE = 0.35;
/** Default projectile speed in tiles/s for ranged operators/enemies. */
export const PROJECTILE_SPEED = 12;
/** Projectile speeds per visual kind (tiles/s). `none`/`beam` are instant. */
export const PROJECTILE_SPEEDS = Object.freeze({ arrow: 14, bolt: 11, bomb: 8, lob: 8, orb: 10, drone: 16, enemy: 10 });

/** Minimum damage ratio after mitigation (5 % of the pre-mitigation amount). */
export const MIN_DAMAGE_RATIO = 0.05;

/** Element gauge capacity of operators and normal/elite enemies; leaders (rank BOSS) hold 2000 (ba.dt.*2). */
export const ELEMENT_GAUGE_MAX = 1000;
export const ELEMENT_GAUGE_MAX_LEADER = 2000;
/** Element names with a gauge on every unit. `necrosis` is a legacy spare gauge (凋亡 is `apoptosis`). */
export const ELEMENTS = Object.freeze(['burn', 'neural', 'necrosis', 'apoptosis', 'erosion']);
/**
 * Element bursts — official term table (gamedata_const termDescriptionDict):
 *   `ally` = an operator/summon hit by enemy damage (ba.dt.burning / neural / apoptosis / erosion),
 *   `enemy` = an enemy hit by operators (the "·我方" terms ba.dt.burning2 / neural2 / apoptosis2 / erosion2;
 *   `elemDamage` is 元素伤害: HP damage ignoring DEF/RES, × elemTakenMul).
 * `necrosis` keeps the engine's earlier invented burst (no official counterpart) for legacy content.
 */
export const ELEMENT = Object.freeze({
  burn: Object.freeze({
    burstDamage: 1200, burstType: 'arts', resDown: 20, duration: 10,
    ally: Object.freeze({ damage: 1200, type: 'arts', resDown: 20, duration: 10 }),
    enemy: Object.freeze({ elemDamage: 7000, resDown: 20, duration: 10 }),
  }),
  neural: Object.freeze({
    burstDamage: 1000, burstType: 'true', stun: 10, duration: 10,
    ally: Object.freeze({ damage: 1000, type: 'true', stun: 10, duration: 10 }),
    enemy: Object.freeze({ elemDamage: 6000, palsy: 3, duration: 10 }),
  }),
  apoptosis: Object.freeze({
    dps: 100, duration: 15,
    ally: Object.freeze({ dps: 100, dpsType: 'arts', spLossPerSec: 1, duration: 15 }),
    enemy: Object.freeze({ elemDps: 800, weaken: 0.5, duration: 15 }),
  }),
  erosion: Object.freeze({
    ally: Object.freeze({ damage: 800, type: 'phys', defDown: 100, duration: 0 }),
    enemy: Object.freeze({ elemDamage: 5000, defDown: 120, duration: 8 }),
  }),
  necrosis: Object.freeze({ dps: 100, duration: 12, atkDownPct: 0.2 }),
});
/** 麻痹 (ba.palsy): each stack cancels one normal attack of an enemy; at most 3 stacks, lasts until consumed. */
export const PALSY_MAX = 3;

/** Freeze caused by cold on cold (DESIGN §5.3). */
export const COLD_FREEZE_DURATION = 3;
/** 浮空 (ba.levitate): the duration is halved on units heavier than this weight (massLevel). */
export const LEVITATE_HALF_WEIGHT = 3;
/** 抵抗 (ba.buffres): default share of a resisted status's duration that is removed (0.5 = 减半). */
export const RESIST_DEFAULT = 0.5;
/** 抵抗: a resisting unit loses one 麻痹 stack every RESIST_PALSY_DECAY seconds ("麻痹等状态每5秒流失1层"). */
export const RESIST_PALSY_DECAY = 5;
export const COLD_ASPD = -30;
export const FREEZE_RES_DOWN = 15;

/** Default DP rules (DESIGN §5.5), overridable by Battle opts.flags. */
export const DP_DEFAULTS = Object.freeze({ dpInit: 10, dpPerSec: 1, dpMax: 99 });

/** Safety cap for battles with an infinite time limit (boss rounds are force-ended by the match). */
export const MAX_BATTLE_TIME = 3600;
/** A battle that raised this many internal errors is force-ended as a timeout. */
export const MAX_INTERNAL_ERRORS = 200;

/** Time (s) a dead unit stays in snapshots with the DIE animation. */
export const DIE_ANIM_TIME = 0.8;
/** Time (s) the ATTACK / DEPLOY animation code is reported after the action. */
export const ATTACK_ANIM_TIME = 0.35;
export const DEPLOY_ANIM_TIME = 0.5;

/** Stage devices that act as ground obstacles for pathing (阻隔工事). */
export const OBSTACLE_DEVICES = Object.freeze({ trap_1105_accrate: { hp: 100, name: '阻隔工事' } });

/** Default enemy/op aggregation clamps. */
export const ASPD_MIN = 10;
export const ASPD_MAX = 600;

/** Client event buffer cap (events are dropped oldest-first beyond this when nobody drains). */
export const EVENT_BUFFER_CAP = 50000;

/** Nested hook emits deeper than this are skipped (content recursion, e.g. a `damaged` handler dealing damage). */
export const MAX_HOOK_DEPTH = 32;
/** spawnEnemy refuses to exceed this many living enemies on one field (runaway content spawn loops). */
export const MAX_ALIVE_ENEMIES = 600;

/** Heal-over-time / regen events are aggregated and only emitted when they reach this amount. */
export const REGEN_EVENT_MIN = 1;

/** Row offset mapping board rows (9..12) onto boss-field rows (2..5). */
export const BOSS_ROW_OFFSET = -7;
