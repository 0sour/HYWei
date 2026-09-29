// render/style.js — palette and visual tunables of the battlefield renderer (pure data).
// Colours follow research 07 §7 (tile palette, tuned by eye) and the UI design system (theme.css).

export const TILE_H = Object.freeze({
  wall: 0.42,      // 'h' high ground
  forbid: 0.3,     // '#' forbidden block (data: HIGH)
  sep: 0.55,       // 'X' hard separator wall (rows 6 / 13)
  bench: 0.16,     // 'a' / 'A' hand & temp slots (data: HIGH)
  platform: 0.26,  // active 射击台 / mound devices
});

/** Stage glyph → material + height class (data/stages.json legend, DATA.md §12). */
export const GLYPH = Object.freeze({
  '#': { mat: 'forbid', h: 'forbid' },
  X: { mat: 'sep', h: 'sep' },
  r: { mat: 'road', h: null },
  R: { mat: 'roadN', h: null },
  f: { mat: 'floor', h: null },
  p: { mat: 'preview', h: null },
  h: { mat: 'wall', h: 'wall' },
  b: { mat: 'fence', h: null },
  a: { mat: 'hand', h: 'bench' },
  A: { mat: 'temp', h: 'bench' },
  S: { mat: 'start', h: null },
  E: { mat: 'end', h: null },
  I: { mat: 'telin', h: null },
  O: { mat: 'telout', h: null },
  m: { mat: 'mire', h: null },
  g: { mat: 'smog', h: null },
  d: { mat: 'deepsea', h: null },
  i: { mat: 'infection', h: null },
});

/** tileKey (when a stage uses glyphs outside the legend) → glyph. */
export const TILEKEY_GLYPH = Object.freeze({
  tile_forbidden: '#', tile_road: 'r', tile_floor: 'f', tile_wall: 'h', tile_fence_bound: 'b', tile_fence: 'b',
  tile_achand: 'a', tile_start: 'S', tile_end: 'E', tile_telin: 'I', tile_telout: 'O', tile_mire: 'm',
  tile_smog: 'g', tile_deepsea: 'd', tile_infection: 'i', tile_grass: 'r', tile_hole: '#',
});

export const COLORS = Object.freeze({
  bgTop: '#0b0f0e',
  bgMid: '#131a18',
  bgBottom: '#07090a',
  fog: [0.62, 0.68, 0.72],
  mint: 0x4ed8af,
  mintHi: 0x59f4ca,
  gold: 0xffc600,
  gateRed: 0xff3b30,
  gateRedDeep: 0xd0453b,
  objBlue: 0x39a7ff,
  objBlueDeep: 0x2d7fd6,
  legal: 0x3ce08c,
  illegal: 0xff4040,
  range: 0xff9c33,
  rangeStand: 0x4ed8af,
  hpAlly: 0x5fe07a,
  hpAllyLow: 0xe8c547,
  hpEnemy: 0xff4b3e,
  hpBoss: 0xff2d55,
  hpGhost: 0xfff0c8,
  hpBack: 0x0c0f0e,
  sp: 0x6fd3ff,
  spReady: 0xffe066,
  spActive: 0xffb347,
  shield: 0xdfe8ff,
});

/** Chess tier accents (theme.css --tier-1…6) and rarity-ish frames for enemies. */
export const TIER_COLORS = Object.freeze([0x9aa5a0, 0x9aa5a0, 0x7fd37a, 0x52b6ff, 0xb98cff, 0xffc600, 0xff6b3d]);
export const ENEMY_FRAME = Object.freeze({ normal: 0xc84a3c, elite: 0xff7a33, boss: 0xff2d55 });

export const DMG_STYLE = Object.freeze({
  phys: { font: 'sp-dmg-phys', fill: ['#fffbe8', '#ffb35c'], stroke: '#3b1400' },
  arts: { font: 'sp-dmg-arts', fill: ['#fbe8ff', '#c77dff'], stroke: '#2a0b45' },
  true: { font: 'sp-dmg-true', fill: ['#ffffff', '#e8e8e8'], stroke: '#2a2a2a' },
  heal: { font: 'sp-dmg-heal', fill: ['#eafff0', '#62f08a'], stroke: '#07361a' },
  elem: { font: 'sp-dmg-elem', fill: ['#fff4e0', '#ff7b3a'], stroke: '#3a1000' },
});

/** Map b.ev dmg types to a style key. */
export function dmgStyleKey(type) {
  if (type === 'phys' || type === 'arts' || type === 'true' || type === 'heal') return type;
  if (type === 'burn' || type === 'neural' || type === 'necrosis' || type === 'apoptosis' || type === 'erosion' || type === 'element') return 'elem';
  return 'phys';
}

/** Hit spark colour per damage type. */
export const HIT_TINT = Object.freeze({ phys: 0xffd9a0, arts: 0xc77dff, true: 0xffffff, heal: 0x62f08a, elem: 0xff7b3a });

/** Projectile visuals per atk projKind (sim: none|arrow|bolt|bomb|lob|orb|drone|enemy|chain|chainHeal). */
export const PROJ = Object.freeze({
  arrow: { speed: 14, tex: 'streak', tint: 0xfff2d0, len: 0.55, width: 0.09, trail: 0 },
  bolt: { speed: 11, tex: 'orb', tint: 0xd49bff, len: 0.28, width: 0.28, trail: 0xa35cff },
  orb: { speed: 11, tex: 'orb', tint: 0x9dffb8, len: 0.26, width: 0.26, trail: 0x4ee07a },
  bomb: { speed: 8, tex: 'orb', tint: 0xffb066, len: 0.24, width: 0.24, trail: 0xff7a33, arc: 0.9 },
  lob: { speed: 8, tex: 'orb', tint: 0xffc78a, len: 0.22, width: 0.22, trail: 0xffa04a, arc: 1.2 },
  drone: { speed: 16, tex: 'orb', tint: 0x8fe6ff, len: 0.16, width: 0.16, trail: 0x57c9ff },
  enemy: { speed: 12, tex: 'orb', tint: 0xff6a5a, len: 0.22, width: 0.22, trail: 0xff3b30 },
});

/** Status keys (b.ev 'status' + UF flags) → icon atlas key (render/textures.js) and colour. */
export const STATUS_ICON = Object.freeze({
  stun: 'stun', freeze: 'freeze', cold: 'cold', stealth: 'stealth', shield: 'shield', fragile: 'fragile',
  artsFragile: 'fragile', physFragile: 'fragile', elemFragile: 'fragile', sleep: 'sleep', invulnerable: 'invuln',
  silence: 'silence', slow: 'slow', sluggish: 'slow', bind: 'bind', fear: 'fear', tremble: 'fear', weaken: 'weaken',
  levitate: 'levitate', taunt: 'taunt', defDown: 'weaken', resDown: 'weaken', aspdDown: 'slow', disarm: 'silence',
  burn: 'burn', burnBurst: 'burn', neural: 'neural', neuralBurst: 'neural', necrosis: 'necrosis', apoptosis: 'necrosis',
});

/** Keyword fallbacks for namespaced / content status keys ('ab:frost', 'reed2:scorch', 'skill:shotst_shred' …). */
const STATUS_GUESS = [
  [/frost|chill|cold/i, 'cold'], [/freez/i, 'freeze'], [/scorch|burn|ignit|flame/i, 'burn'], [/stun|daze/i, 'stun'],
  [/sleep|slumber/i, 'sleep'], [/silenc/i, 'silence'], [/slow|slugg|bind|root|snare/i, 'slow'], [/fear|trembl/i, 'fear'],
  [/fragil|shred|expos|wanted|vulner|mark/i, 'fragile'], [/weak|down$/i, 'weaken'], [/shield|resist|guard|ward|barrier/i, 'shield'],
  [/invul|immun/i, 'invuln'], [/stealth|camou|invis/i, 'stealth'], [/levit|float/i, 'levitate'], [/taunt/i, 'taunt'],
  [/neural/i, 'neural'], [/necro|apopt|erosion/i, 'necrosis'],
];

/** Icon key (textures STATUS_KEYS) for a b.ev status key or flag name; null when it has no icon. */
export function statusIconKey(key) {
  if (typeof key !== 'string' || !key) return null;
  if (STATUS_ICON[key]) return STATUS_ICON[key];
  const tail = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
  if (STATUS_ICON[tail]) return STATUS_ICON[tail];
  for (const [re, icon] of STATUS_GUESS) if (re.test(tail)) return icon;
  return null;
}

export const UNIT = Object.freeze({
  /** Spine skeleton units → world tiles (skeletons are ~360–450 units tall ⇒ ~1.2 tiles). */
  modelScale: 1 / 320,
  /** Fallback diamond size in tiles. */
  diamond: 0.78,
  headroom: 1.18, // tiles above the feet where bars sit (operators; enemies use their bounds)
  barWidth: 0.64,
  bossBarWidth: 2.2,
});
