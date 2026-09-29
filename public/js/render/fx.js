// render/fx.js — battle visual effects with pooling and hard caps (DESIGN §9).
//
//   projectiles  arrow / bolt / orb / bomb / lob / drone / enemy shots from b.ev 'atk' (travel time from the
//                sim's projectile speeds, homing on the interpolated target, arcs for bombs/lobs); chain
//                lightning (chain / chainHeal) as short-lived jagged beams
//   hits         sparks + flash by damage type, melee slash arcs, AoE ground rings for splash attackers
//   numbers      damage numbers (phys orange-white, arts purple, true white, heal green, elements orange) as
//                pooled BitmapText (per font); rapid same-style hits on a target merge into a running total; big hits
//                (≥ 18 % max HP) pop larger; ≤ 4 per target; laid out in screen space against every live number (lanes
//                beside the head, stacked upwards) so numbers of neighbouring units never cover or touch each other;
//                crowded spots get shorter lives (see number())
//   skill        activation flash + light pillar + hex ring; a rotating aura under the unit while active
//   deploy       drop-in ring + pillar; death dissolve embers; crate splinters; element bursts; leak vignette;
//                bond-layer glyph pops and bounty coins (screen space, near the top of the field)
// Particles live in two ParticleContainers (additive / normal) sharing the FX atlas base texture, so the whole
// particle system costs two draw calls. Every pool has a cap; when full, the oldest entry is recycled.

import { fxAtlas } from './textures.js';
import { DMG_STYLE, dmgStyleKey, HIT_TINT, PROJ, COLORS } from './style.js';

const MAX_PARTICLES = { high: 1400, medium: 800, low: 360 };
const MAX_NUMBERS = 90;
/** Particle cap multiplier per adaptive load level (render/app.js loadLevel). */
const LOAD_PARTICLES = Object.freeze([1, 0.75, 0.55, 0.4]);
const NUM_RISE = 0.45;        // tiles a damage number rises over NUM_RISE_T (easeOut), then it stays
const NUM_RISE_T = 0.9;       // seconds of the rise
const NUM_LIFE = 0.9;         // seconds a number lives (a merged running total lives longer, ≤ NUM_MAX_LIFE)
const NUM_MAX_LIFE = 1.8;
const NUM_FADE_T = 0.27;      // fade-out at the end of its life
const NUM_LINE_EM = 0.95;     // vertical room of one line of digits, in em of the 24 px bitmap font
const NUM_MAX_LINES = 5;      // a number starts at most this many lines above the head
const NUM_DIGIT_EM = 0.66;    // advance of one digit of the damage font, in em (Bender 700: 0.56–0.66, the widest kept)
const NUM_POP = 1.35;         // birth / merge pop scale (the layout reserves the popped size)
const NUM_GAP_PX = 7;         // horizontal gap between two numbers side by side (never read as one number)
const NUM_MERGE_GAP = 0.3;    // s: same-style hits on one unit closer than this join its running total
const NUM_PER_TARGET = 4;     // live numbers per unit (then hits join / the oldest fades)
const NUM_CROWD = 6;          // more live numbers than this around a spot → shorter lives there
const NUM_LANES = Object.freeze([0, -1, 1, -2, 2]);   // lane order (lane widths from the unit's head)
/** Screen scale of a number's text (24 px font) at `s` px per tile. */
const numScale = (s, big, style) => clamp(s / 115, 0.42, 1.05) * (big ? 1.35 : 1) * (style === 'heal' ? 0.9 : 1);
const MAX_PROJ = 260;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Cheap fingerprint of a camera's framing (the damage-number layout cache is reused only while it is unchanged). */
const camKey = (c) => (c ? c.tx + c.ty * 1e3 + c.tz * 1e6 + c.tilt * 7.13 + c.dist * 1e4 + c.scale * 3.7e-2 + c.cx * 1.1e-5 + c.cy * 1.3e-8 : 0);
/** Characters of a damage number as drawn (heals get a '+'). */
const numChars = (v, style) => String(Math.round(v)).length + (style === 'heal' ? 1 : 0);

const SPLASH_SUBS = new Set(['aoesniper', 'splashcaster', 'blastcaster', 'bombarder', 'phalanx', 'fortress', 'hammer']);

let fontsReady = false;
/** Generate the damage-number bitmap fonts (after web fonts loaded, if possible). */
export function ensureDamageFonts() {
  if (fontsReady) return;
  const P = globalThis.PIXI;
  for (const st of Object.values(DMG_STYLE)) {
    try {
      P.BitmapFont.from(st.font, {
        fontFamily: ['Bender', 'Oxanium', 'Rajdhani', 'Arial Black', 'sans-serif'], fontSize: 44, fontWeight: '700',
        fill: st.fill, fillGradientStops: [0.25, 1], stroke: st.stroke, strokeThickness: 7,
        dropShadow: true, dropShadowColor: '#000000', dropShadowAlpha: 0.45, dropShadowDistance: 2, dropShadowBlur: 2,
      }, { chars: [['0', '9'], '+-×!'], resolution: 2, padding: 6 });
    } catch (err) { console.warn('[fx] bitmap font', st.font, err?.message || err); }
  }
  fontsReady = true;
}

const num = (v, d) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : d; };

/**
 * Sim fx kind → visual archetype (`a`), colour (`c`) and defaults (`r` radius, `dur` game s, `tex`, `smoke`).
 * Covers every kind emitted by server/sim (Battle, kits, tokens, enemies, bosses, devices, bonds, items); unknown
 * kinds fall back to a keyword guess, then to a generic sparkle (fxSpec).
 */
export const FX_KINDS = Object.freeze({
  // blasts
  aoe: { a: 'blast', c: 0xffb35c }, explode: { a: 'blast', c: 0xff7a33 }, explosion: { a: 'blast', c: 0xff7a33 },
  bombard: { a: 'blast', c: 0xffa04a, r: 1.5 }, airstrike: { a: 'blast', c: 0xff8a3d, r: 1.5 }, splash: { a: 'blast', c: 0xffc27a },
  scorchBurst: { a: 'blast', c: 0xff6a2a }, champagneBomb: { a: 'blast', c: 0xffd27a }, shockBlast: { a: 'blast', c: 0x9fd4ff, smoke: 0x1c2630 },
  frostNova: { a: 'blast', c: 0x9fe6ff, smoke: 0x1c2630 }, sunBurst: { a: 'blast', c: 0xffe28a }, meltdown: { a: 'blast', c: 0xff5a2a, r: 1.5 },
  iceSpike: { a: 'blast', c: 0xbfeeff, smoke: 0x1c2630 }, rockfall: { a: 'blast', c: 0xc8a878, smoke: 0x4a3f33 }, rockslide: { a: 'blast', c: 0xc8a878, smoke: 0x4a3f33 },
  finale: { a: 'blast', c: 0xffd45a, r: 1.5 }, swordStorm: { a: 'blast', c: 0xdfe8ff }, swordRain: { a: 'blast', c: 0xdfe8ff }, liberate: { a: 'blast', c: 0xffffff },
  knockout: { a: 'crit', c: 0xffc27a }, quadShot: { a: 'volley', c: 0xfff2d0 }, featherArrow: { a: 'counter', c: 0xfff2d0 },
  burst: { a: 'element', c: 0xd0a0ff },
  // areas
  zone: { a: 'zone', c: 0xffb35c, dur: 3 }, healField: { a: 'zone', c: 0x62f08a, dur: 4 }, firewall: { a: 'wall', c: 0xff6a2a, dur: 4 },
  firewallBlock: { a: 'counter', c: 0xff6a2a }, tide: { a: 'zone', c: 0x5fe0ff, dur: 3, r: 2 }, storm: { a: 'zone', c: 0xd8c8a0, dur: 3 },
  tornado: { a: 'zone', c: 0xd8e8ff, dur: 3 }, snow: { a: 'zone', c: 0xe8f6ff, dur: 3 }, telegraph: { a: 'telegraph', c: 0xff3b30, dur: 1.2 },
  coldWind: { a: 'chill', c: 0x9fd4ff },
  // support
  heal: { a: 'heal', c: 0x62f08a }, healAoe: { a: 'healAoe', c: 0x62f08a, r: 1.5 }, bandage: { a: 'heal', c: 0x62f08a }, blessing: { a: 'healAoe', c: 0xfff0a8 },
  cleanse: { a: 'healAoe', c: 0xdfffff, r: 0.9 }, revive: { a: 'summon', c: 0xfff0a8 }, reborn: { a: 'summon', c: 0xffd45a }, hpShare: { a: 'heal', c: 0xff9aa6 },
  spGift: { a: 'sp', c: 0x6fd3ff }, spGain: { a: 'sp', c: 0x6fd3ff }, reload: { a: 'sp', c: 0xffe066 },
  shield: { a: 'shield', c: 0xdfe8ff }, catShield: { a: 'shield', c: 0xffe0a8 }, saltWard: { a: 'shield', c: 0xbfeeff }, shell: { a: 'shield', c: 0xc8b890 },
  vest: { a: 'shield', c: 0xdfe8ff }, sleepGuard: { a: 'shield', c: 0xa8b6ff }, truesilver: { a: 'shield', c: 0xfff3b8 }, shieldBreak: { a: 'shatter', c: 0xdfe8ff },
  // arrivals / departures
  summon: { a: 'summon', c: 0x9ff0dc }, drones: { a: 'summon', c: 0x8fe6ff }, drone: { a: 'summon', c: 0x8fe6ff }, sentry: { a: 'summon', c: 0x9ff0dc },
  turretOnline: { a: 'summon', c: 0xff8a6a }, yanyouSummon: { a: 'summon', c: 0xffb347 }, device: { a: 'summon', c: 0xc0c8cc },
  appear: { a: 'summon', c: 0xb36bff }, copy: { a: 'summon', c: 0xd8b0ff }, manifoldCopy: { a: 'summon', c: 0xd8b0ff }, split: { a: 'summon', c: 0xff9a6a },
  disappear: { a: 'vanish', c: 0xb36bff }, stealth: { a: 'vanish', c: 0x8fa0b0 }, camouflage: { a: 'vanish', c: 0x8fb08f }, phase: { a: 'vanish', c: 0xb36bff },
  substitute: { a: 'vanish', c: 0xd8b0ff }, swap: { a: 'blink', c: 0xd8b0ff }, blink: { a: 'blink', c: 0xb36bff }, teleport: { a: 'blink', c: 0xb36bff },
  ulpiaReturn: { a: 'blink', c: 0x9ff0dc }, manifoldSplit: { a: 'blink', c: 0xd8b0ff },
  // displacement
  pull: { a: 'move', c: 0x9fd4ff }, push: { a: 'move', c: 0xffd9a0 }, displace: { a: 'move', c: 0xd0c0a0 }, lure: { a: 'move', c: 0xffb3ec },
  charge: { a: 'move', c: 0xff9c33 }, dash: { a: 'move', c: 0xffd9a0 }, slippery: { a: 'move', c: 0x9fe6ff },
  // pulses
  sonic: { a: 'wave', c: 0xc9a2ff, r: 1.5 }, pulse: { a: 'wave', c: 0x9ff0dc }, sermon: { a: 'wave', c: 0xffe28a, r: 1.5 }, ripple: { a: 'wave', c: 0x5fe0ff },
  tornadoPulse: { a: 'wave', c: 0xd8e8ff }, wake: { a: 'wave', c: 0x5fe0ff }, wolfShadow: { a: 'wave', c: 0x8fa0b0 }, wolfShadowLost: { a: 'vanish', c: 0x8fa0b0 },
  redistribute: { a: 'wave', c: 0x62f08a }, dilemma: { a: 'wave', c: 0xc9a2ff },
  // marks
  taunt: { a: 'mark', c: 0xff9c33 }, palsy: { a: 'mark', c: 0xc77dff }, emergency: { a: 'mark', c: 0xff5a4a },
  lock: { a: 'reticle', c: 0xff5a4a }, droneLock: { a: 'reticle', c: 0x8fe6ff }, wanted: { a: 'reticle', c: 0xffc600 }, expose: { a: 'reticle', c: 0xff7b8a },
  reveal: { a: 'reticle', c: 0x9fd4ff }, anchor: { a: 'reticle', c: 0x9fd4ff },
  // buffs
  buff: { a: 'buff', c: 0xffd45a }, overload: { a: 'buff', c: 0xff7a33 }, overclock: { a: 'buff', c: 0xff9c33 }, talent: { a: 'buff', c: 0xffd45a },
  knack: { a: 'buff', c: 0xffd45a }, bloodBattle: { a: 'buff', c: 0xff4b3e }, sword: { a: 'buff', c: 0xdfe8ff }, equip: { a: 'buff', c: 0x4ed8af },
  garrisonGrant: { a: 'buff', c: 0x4ed8af }, extraAttack: { a: 'buff', c: 0xffe066 }, soul: { a: 'buff', c: 0xb36bff }, jungleSoul: { a: 'buff', c: 0x7fd37a },
  candle: { a: 'buff', c: 0xffb347 }, mote: { a: 'buff', c: 0xfff0a8 }, ember: { a: 'buff', c: 0xff7a33 }, ignite: { a: 'buff', c: 0xff6a2a },
  flame: { a: 'buff', c: 0xff6a2a }, yanyouFlame: { a: 'buff', c: 0xff8a3d }, grow: { a: 'buff', c: 0x7fd37a }, weightlessBuff: { a: 'buff', c: 0xcfe0ff },
  // states
  takeoff: { a: 'lift', c: 0xcfe0ff }, levitate: { a: 'lift', c: 0xcfe0ff }, weightless: { a: 'lift', c: 0xcfe0ff },
  sleep: { a: 'sleep', c: 0xa8b6ff }, crit: { a: 'crit', c: 0xffe066 },
  dodge: { a: 'dodge', c: 0xffffff }, riposte: { a: 'counter', c: 0xffd9a0 }, counter: { a: 'counter', c: 0xffd9a0 }, block: { a: 'counter', c: 0xdfe8ff },
  thorns: { a: 'counter', c: 0xff9aa6 }, downed: { a: 'down', c: 0xbfeee2 }, stone: { a: 'down', c: 0xc0b8a8, smoke: 0x5a5448 },
  dp: { a: 'dp', c: 0x9fd4ff }, coin: { a: 'coin', c: 0xffc600 }, steal: { a: 'coin', c: 0xffc600 }, crateBreak: { a: 'crate', c: 0xc89a5a },
  lpLoss: { a: 'lp', c: 0xff3b30 },
  // beams
  beam: { a: 'beam', c: 0xff7a5a }, link: { a: 'beam', c: 0x9ff0dc }, lightning: { a: 'bolt', c: 0xc9a2ff }, tentacle: { a: 'beam', c: 0x5fe0ff },
  sandChains: { a: 'beam', c: 0xd8c8a0 }, sandChainsCharged: { a: 'beam', c: 0xffd45a },
  strike: { a: 'strike', c: 0xffe6a8 }, volley: { a: 'volley', c: 0xfff2d0 }, column: { a: 'pillar', c: 0x9ff0dc }, obelisk: { a: 'pillar', c: 0xc9a2ff },
  duskDragon: { a: 'blast', c: 0x9dff6a, r: 1.5 }, shadowWeave: { a: 'vanish', c: 0x8f7bff }, reweave: { a: 'summon', c: 0x8f7bff },
  slash: { a: 'counter', c: 0xfff0d0 }, devour: { a: 'vanish', c: 0xff4b3e }, undying: { a: 'shield', c: 0xffd45a },
  // summon arrival bursts (content/tokens.js burst(): 沙之碑 default, 迷迭香 gear stun, 耀阳 sword, 纸偶)
  summonBurst: { a: 'blast', c: 0xe8c878, smoke: 0x4a3f33 }, summonStun: { a: 'blast', c: 0xcfe0ff, smoke: 0x2a2e36 },
  radiantSword: { a: 'pillar', c: 0xffe8a0 }, paperDoll: { a: 'blast', c: 0xc9a2ff, smoke: 0x2c2436 },
  // bonds / garrisons (support/index.js fxOn)
  bondMilestone: { a: 'buff', c: 0xffc600 }, bondProc: { a: 'buff', c: 0x4ed8af }, bondShare: { a: 'wave', c: 0x4ed8af },
  garrison: { a: 'buff', c: 0x4ed8af }, layer: { a: 'buff', c: 0xffe066 }, sp: { a: 'sp', c: 0x6fd3ff },
});

/** Keyword guesses for kinds added later (checked in order), before the generic sparkle. */
const FX_GUESS = [
  [/heal|cure|mend|regen/i, 'heal'], [/shield|ward|barrier|guard/i, 'shield'], [/summon|spawn|call|deploy/i, 'summon'],
  [/blast|bomb|explo|burst|boom|nova|strike/i, 'blast'], [/zone|field|area|wall|mist|fog|pool/i, 'zone'],
  [/buff|boost|power|rage|charge|up$/i, 'buff'], [/mark|lock|target|wanted|expose/i, 'reticle'], [/teleport|blink|warp|swap/i, 'blink'],
  [/stealth|hide|vanish|cloak/i, 'vanish'], [/pull|push|knock|dash|leap/i, 'move'], [/pulse|wave|ring|sonic/i, 'wave'],
];

/** Visual spec of an fx kind (see FX_KINDS); `extra.kind` / `extra.element` may pick a better colour. */
export function fxSpec(kind, extra = {}) {
  const k = typeof kind === 'string' ? kind : '';
  let spec = FX_KINDS[k];
  if (!spec) {
    const g = FX_GUESS.find(([re]) => re.test(k));
    spec = g ? { ...FX_KINDS[{ heal: 'heal', shield: 'shield', summon: 'summon', blast: 'aoe', zone: 'zone', buff: 'buff', reticle: 'lock', blink: 'blink', vanish: 'disappear', move: 'displace', wave: 'pulse' }[g[1]]] } : { a: 'generic', c: 0xfff2d0 };
  }
  const el = extra && extra.element;
  if (el && (spec.a === 'blast' || spec.a === 'zone' || spec.a === 'element')) {
    const c = el === 'burn' ? 0xff7a33 : el === 'neural' ? 0xff5ad0 : el === 'necrosis' || el === 'apoptosis' ? 0x9dff6a : el === 'erosion' ? 0x6fe0ff : null;
    if (c) spec = { ...spec, c };
  }
  if (extra && (extra.dmgType === 'arts' || /arts|magic/i.test(String(extra.kind || ''))) && spec.a === 'blast') spec = { ...spec, c: 0xc77dff };
  return spec;
}

/** Tiles covered by a blast / telegraph: `tiles` = [[r,c]…] or 'box' (Chebyshev ⌊r⌋ around the centre) or 'disc'. */
export function tilesAround(x, y, r, tiles) {
  if (Array.isArray(tiles)) return tiles.filter((t) => Array.isArray(t) && Number.isInteger(t[0]) && Number.isInteger(t[1])).slice(0, 80);
  const cr = Math.round(y), cc = Math.round(x), R = Math.max(0, Math.min(6, Math.floor(r)));
  const out = [];
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    if (tiles === 'box' || dr * dr + dc * dc <= r * r + 0.25) out.push([cr + dr, cc + dc]);
  }
  return out;
}

/**
 * Tiles of a straight wall through tile (round(y), round(x)): `axis` 'col' = that column, 'row' = that row (余 S3
 * fire wall: perpendicular to his facing, sim/content/kits/tier6.js). Clipped to the field `rect` (inclusive
 * { r0, r1, c0, c1 }); without one ±4 tiles.
 */
export function wallTiles(x, y, axis, rect) {
  const R = Math.round(Number(y)), C = Math.round(Number(x));
  if (!Number.isFinite(R) || !Number.isFinite(C)) return [];
  const ok = rect && [rect.r0, rect.r1, rect.c0, rect.c1].every(Number.isFinite);
  const out = [];
  if (axis === 'row') {
    const [a, b] = ok ? [rect.c0, rect.c1] : [C - 4, C + 4];
    for (let c = a; c <= b; c++) out.push([R, c]);
  } else {
    const [a, b] = ok ? [rect.r0, rect.r1] : [R - 4, R + 4];
    for (let r = a; r <= b; r++) out.push([r, C]);
  }
  return out.filter(([r, c]) => r >= 0 && r <= 18 && c >= 0 && c <= 20);
}

export class FxSystem {
  /**
   * @param {{ P, layers: { groundFx, fxAdd, fxNormal, text, screen }, cam: () => any, view: (id) => any,
   *           heightAt: (r,c)=>number, settings: object, assets: any, timeScale: () => number,
   *           subProfOf: (defId) => string|null, screenSize: () => {width,height}, fieldTop: () => number }} ctx
   */
  constructor(ctx) {
    const P = ctx.P;
    this.ctx = ctx;
    this.P = P;
    this.atlas = fxAtlas();
    this.tex = this.atlas.tex;
    ensureDamageFonts();
    const props = { vertices: true, position: true, rotation: true, uvs: true, tint: true };
    this.addPc = new P.ParticleContainer(MAX_PARTICLES.high, props, 512, true);
    this.addPc.blendMode = P.BLEND_MODES.ADD;
    this.normPc = new P.ParticleContainer(MAX_PARTICLES.high, props, 512, true);
    ctx.layers.fxNormal.addChild(this.normPc);
    ctx.layers.fxAdd.addChild(this.addPc);
    this.parts = [];          // active particles
    this.freeAdd = []; this.freeNorm = [];
    this.projs = [];
    this.projFree = [];
    this.projLayer = new P.Container();
    ctx.layers.fxAdd.addChild(this.projLayer);
    this.beams = new P.Graphics();
    this.beams.blendMode = P.BLEND_MODES.ADD;
    ctx.layers.fxAdd.addChild(this.beams);
    this.beamList = [];
    this.nums = [];
    this._numPools = new Map();   // bitmap font → free number records
    this.auras = new Map();   // unit id → { sprite, ring, t }
    this.rings = [];          // ground rings { sprite, x, y, z, t, dur, r0, r1, tint }
    this.ringFree = [];
    this.pops = [];           // screen-space pops (bond glyphs, coins)
    this.zones = [];          // persistent ground areas (zone / telegraph fx)
    this.labels = [];         // floating '!' / '+n' labels
    this.tileFlashes = [];    // flashing tile sets (telegraphed boxes)
    this.tileGfx = new P.Graphics();
    this.tileGfx.blendMode = P.BLEND_MODES.ADD;
    ctx.layers.groundFx.addChild(this.tileGfx);
    this.tintSprite = new P.Sprite(P.Texture.WHITE);
    this.tintSprite.alpha = 0;
    this.tintSprite.blendMode = P.BLEND_MODES.ADD;
    ctx.layers.screen.addChild(this.tintSprite);
    this.tintT = 0; this.tintDur = 1; this.tintA = 0;
    this.vignette = new P.Sprite(ctx.redVignette || P.Texture.EMPTY);
    this.vignette.alpha = 0;
    ctx.layers.screen.addChild(this.vignette);
    this.vigT = 0;
    this.time = 0;
    this._p = { x: 0, y: 0, s: 0, depth: 0 };
    this._q = { x: 0, y: 0, s: 0, depth: 0 };
  }

  get quality() { return this.ctx.settings?.quality || 'high'; }
  /** The view's adaptive load level (0–3, render/app.js): a struggling device gets fewer particles / numbers. */
  get load() { return this.ctx.loadLevel ? this.ctx.loadLevel() | 0 : 0; }
  get maxParticles() { return Math.round((MAX_PARTICLES[this.quality] || MAX_PARTICLES.high) * LOAD_PARTICLES[Math.min(3, this.load)]); }

  // ---- particles ------------------------------------------------------------------------------------------

  /** Spawn a screen-space particle. Returns the particle (or null when capped at low quality). */
  particle(tex, x, y, o = {}) {
    const P = this.P;
    const add = o.add !== false;
    if (this.parts.length >= this.maxParticles) {
      // recycle the oldest
      const old = this.parts.shift();
      this._freeParticle(old);
    }
    const free = add ? this.freeAdd : this.freeNorm;
    let sp = free.pop();
    if (!sp) {
      sp = new P.Sprite(this.tex[tex]);
      sp.anchor.set(0.5);
      (add ? this.addPc : this.normPc).addChild(sp);
    }
    sp.texture = this.tex[tex] || this.tex.dot;
    sp.anchor.set(o.anchorX ?? 0.5, o.ay ?? 0.5);
    sp.visible = true;
    sp.position.set(x, y);
    sp.tint = o.tint ?? 0xffffff;
    sp.rotation = o.rot ?? 0;
    const p = {
      sp, add, x, y, vx: o.vx || 0, vy: o.vy || 0, g: o.g || 0, drag: o.drag ?? 0, life: 0, max: o.life || 0.5,
      s0: o.s0 ?? 1, s1: o.s1 ?? o.s0 ?? 1, sx: o.sx ?? 1, a0: o.a0 ?? 1, a1: o.a1 ?? 0, spin: o.spin || 0, fadeIn: o.fadeIn || 0,
    };
    sp.scale.set(p.s0 * p.sx, p.s0);
    sp.alpha = p.fadeIn > 0 ? 0 : p.a0;
    this.parts.push(p);
    return p;
  }

  _freeParticle(p) {
    p.sp.visible = false;
    (p.add ? this.freeAdd : this.freeNorm).push(p.sp);
  }

  _updateParticles(dt) {
    const list = this.parts;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life += dt;
      if (p.life >= p.max) { this._freeParticle(p); continue; }
      const k = p.life / p.max;
      if (p.drag) { const d = Math.max(0, 1 - p.drag * dt); p.vx *= d; p.vy *= d; }
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const sp = p.sp;
      sp.position.set(p.x, p.y);
      const s = p.s0 + (p.s1 - p.s0) * k;
      sp.scale.set(s * p.sx, s);
      if (p.spin) sp.rotation += p.spin * dt;
      let a = p.a0 + (p.a1 - p.a0) * k;
      if (p.fadeIn > 0 && p.life < p.fadeIn) a *= p.life / p.fadeIn;
      sp.alpha = clamp(a, 0, 1);
      list[w++] = p;
    }
    list.length = w;
  }

  // ---- helpers ------------------------------------------------------------------------------------------

  _proj(x, y, z, out = this._p) { return this.ctx.cam().project(x, y, z, out); }

  /** Ground decals: on a raised top they are drawn with that block row (tiles.surfaceLayer), else in groundFx. */
  _onGround(sp, y, z) {
    let layer = this.ctx.layers.groundFx;
    if (z > 0.12 && this.ctx.surfaceLayer) layer = this.ctx.surfaceLayer(Math.round(y)) || layer;
    if (sp.parent !== layer) layer.addChild(sp);
  }

  _chest(view, out = this._p) {
    const z = (view.z || 0) + (view.hover || 0) + (view._headTiles ? view._headTiles * 0.45 : 0.5);
    return this._proj(view.x, view.y, z, out);
  }

  burst(x, y, s, n, tint, o = {}) {
    const q = this.quality === 'low' ? Math.ceil(n / 2) : n;
    for (let i = 0; i < q; i++) {
      const a = Math.random() * Math.PI * 2, v = s * (o.speed ?? 2.2) * (0.4 + Math.random() * 0.8);
      this.particle(o.tex || 'spark', x, y, {
        tint, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7 - (o.up ?? 0) * s, drag: 3, g: (o.g ?? 0) * s,
        life: (o.life ?? 0.35) * (0.7 + Math.random() * 0.6), s0: (s / 64) * (o.size ?? 0.45), s1: (s / 64) * 0.05, a0: 1, a1: 0, spin: (Math.random() - 0.5) * 8,
      });
    }
  }

  // ---- projectiles -----------------------------------------------------------------------------------------

  /** b.ev 'atk' visual. src/tgt are views (tgt may be null). */
  attack(src, tgt, kind) {
    if (!src) return;
    // chain: the source is the previous target of the bounce (sim ai.js), so the arc hops unit to unit
    if (kind === 'chain' || kind === 'chainHeal') { if (tgt && tgt !== src) this._beam(src, tgt, kind === 'chainHeal' ? 0x7dffa8 : 0xc9a2ff); return; }
    if (kind === 'beam') { if (tgt && tgt !== src) this._beam(src, tgt, src.isEnemy ? 0xff7a5a : 0xffe6a8, 0.18, 0.15); return; }
    const spec = PROJ[kind];
    if (!spec || !tgt) {
      if (kind === 'none' || !kind) this._slashAt = src.id;
      return;
    }
    if (this.projs.length >= MAX_PROJ) this._releaseProj(this.projs.shift());
    const P = this.P;
    let pr = this.projFree.pop();
    if (!pr) {
      const head = new P.Sprite(this.tex.orb);
      head.anchor.set(0.5);
      head.blendMode = P.BLEND_MODES.ADD;
      const trail = new P.Sprite(this.tex.streak);
      trail.anchor.set(1, 0.5);
      trail.blendMode = P.BLEND_MODES.ADD;
      this.projLayer.addChild(trail, head);
      pr = { head, trail };
    }
    const sz = (src._headTiles || 1.2) * 0.45;
    const dx = tgt.x - src.x, dy = tgt.y - src.y;
    const dist = Math.hypot(dx, dy);
    const ts = this.ctx.timeScale ? this.ctx.timeScale() : 2;
    Object.assign(pr, {
      kind, spec, src, tgt, x0: src.x + Math.sign(dx || 1) * 0.15, y0: src.y, z0: (src.z || 0) + (src.hover || 0) + sz,
      tx: tgt.x, ty: tgt.y, t: 0, dur: clamp(dist / spec.speed / ts, 0.04, 1.2), done: false,
    });
    pr.head.texture = this.tex[spec.tex === 'streak' ? 'dot' : 'orb'];
    pr.head.tint = spec.tint;
    pr.trail.texture = this.tex.streak;
    pr.trail.tint = spec.trail || spec.tint;
    pr.head.visible = pr.trail.visible = true;
    this.projs.push(pr);
  }

  _releaseProj(pr) {
    pr.head.visible = pr.trail.visible = false;
    pr.src = pr.tgt = null;
    this.projFree.push(pr);
  }

  _updateProjs(dt) {
    const cam = this.ctx.cam();
    const p = this._p, q = this._q;
    let w = 0;
    for (let i = 0; i < this.projs.length; i++) {
      const pr = this.projs[i];
      pr.t += dt;
      if (pr.tgt && !pr.tgt.destroyed && pr.tgt.alive !== false) { pr.tx = pr.tgt.x; pr.ty = pr.tgt.y; }
      const k = clamp(pr.t / pr.dur, 0, 1);
      const tz = pr.tgt ? (pr.tgt.z || 0) + (pr.tgt.hover || 0) + (pr.tgt._headTiles || 1.2) * 0.45 : 0.5;
      const x = pr.x0 + (pr.tx - pr.x0) * k, y = pr.y0 + (pr.ty - pr.y0) * k;
      const arc = pr.spec.arc ? Math.sin(k * Math.PI) * pr.spec.arc : 0;
      const z = pr.z0 + (tz - pr.z0) * k + arc;
      cam.project(x, y, z, p);
      // direction from a point slightly behind
      const kb = Math.max(0, k - 0.06);
      const xb = pr.x0 + (pr.tx - pr.x0) * kb, yb = pr.y0 + (pr.ty - pr.y0) * kb;
      const zb = pr.z0 + (tz - pr.z0) * kb + (pr.spec.arc ? Math.sin(kb * Math.PI) * pr.spec.arc : 0);
      cam.project(xb, yb, zb, q);
      const ang = Math.atan2(p.y - q.y, p.x - q.x);
      const s = p.s;
      pr.head.position.set(p.x, p.y);
      const hs = (s * pr.spec.width) / (pr.spec.tex === 'streak' ? 32 : 64) * (pr.spec.tex === 'streak' ? 1.2 : 1);
      pr.head.scale.set(hs);
      pr.trail.position.set(p.x, p.y);
      pr.trail.rotation = ang;
      const tl = s * pr.spec.len * (pr.spec.tex === 'streak' ? 1.4 : 1.8);
      pr.trail.scale.set(tl / 128, (s * pr.spec.width * (pr.spec.tex === 'streak' ? 0.9 : 1.1)) / 32);
      pr.trail.alpha = pr.spec.tex === 'streak' ? 1 : 0.8;
      if (pr.spec.trail && Math.random() < 0.6 && this.quality !== 'low') {
        this.particle('dot', p.x, p.y, { tint: pr.spec.trail, life: 0.22, s0: s / 32 * pr.spec.width * 0.6, s1: 0, a0: 0.7, a1: 0 });
      }
      if (k >= 1) {
        if (pr.spec.arc) this.ring(pr.tx, pr.ty, 0.02, 0.1, 0.9, pr.spec.trail || pr.spec.tint, 0.35);
        this._releaseProj(pr);
        continue;
      }
      this.projs[w++] = pr;
    }
    this.projs.length = w;
  }

  _beam(a, b, color, dur = 0.22, jitter = 1) {
    this.beamList.push({ a, b, color, t: 0, dur, jitter, seed: Math.random() * 1000 });
    if (this.beamList.length > 40) this.beamList.shift();
  }

  _updateBeams(dt) {
    const g = this.beams;
    g.clear();
    let w = 0;
    const p = this._p, q = this._q;
    for (const bm of this.beamList) {
      bm.t += dt;
      if (bm.t >= bm.dur || !bm.a || !bm.b) continue;
      this._chest(bm.a, p); const px = p.x, py = p.y, s = p.s;
      this._chest(bm.b, q);
      const k = 1 - bm.t / bm.dur;
      const segs = 7;
      for (const [wd, al] of [[s * 0.09, 0.25 * k], [s * 0.035, 0.95 * k]]) {
        g.lineStyle(Math.max(1, wd), bm.color, al);
        g.moveTo(px, py);
        for (let i = 1; i < segs; i++) {
          const f = i / segs;
          const j = Math.sin(bm.seed + i * 12.9 + bm.t * 40) * s * 0.12 * (bm.jitter ?? 1);
          g.lineTo(px + (q.x - px) * f + j, py + (q.y - py) * f - j * 0.5);
        }
        g.lineTo(q.x, q.y);
      }
      this.beamList[w++] = bm;
    }
    this.beamList.length = w;
  }

  // ---- hits / numbers -----------------------------------------------------------------------------------------

  /** b.ev 'dmg' visual. */
  damage(view, amount, type, srcView) {
    if (!view) return;
    const style = dmgStyleKey(type);
    const p = this._chest(view);
    const s = p.s;
    const tint = HIT_TINT[style] || 0xffffff;
    const big = view.maxHp > 0 && amount >= view.maxHp * 0.18;
    this.particle('glow', p.x, p.y, { tint, life: 0.18, s0: (s / 128) * (big ? 1.0 : 0.6), s1: (s / 128) * (big ? 1.5 : 0.9), a0: 0.9, a1: 0 });
    this.burst(p.x, p.y, s, big ? 7 : 4, tint, { speed: 2.4, size: big ? 0.55 : 0.4 });
    if (srcView && this._slashAt === srcView.id) {
      this._slashAt = null;
      const sp = this.particle('slash', p.x, p.y, { tint: style === 'arts' ? 0xe0b0ff : 0xfff0d0, life: 0.2, s0: s / 128 * 0.9, s1: s / 128 * 1.2, a0: 0.95, a1: 0, rot: (Math.random() - 0.5) * 1.2 });
      if (sp) sp.sx = srcView.x > view.x ? -1 : 1;
    }
    if (srcView && this.ctx.subProfOf && SPLASH_SUBS.has(this.ctx.subProfOf(srcView.info?.defId))) {
      if (!this._lastRing || this.time - this._lastRing > 0.08) {
        this._lastRing = this.time;
        this.ring(view.x, view.y, view.z || 0, 0.1, 1.1, tint, 0.3);
      }
    }
    view.onHit?.();
    if (this.ctx.settings?.damageNumbers !== false) this.number(view, amount, style, big);
  }

  heal(view, amount) {
    if (!view) return;
    const p = this._chest(view);
    const s = p.s;
    for (let i = 0; i < (this.quality === 'low' ? 1 : 3); i++) {
      this.particle('plus', p.x + (Math.random() - 0.5) * s * 0.5, p.y + (Math.random() - 0.2) * s * 0.3, {
        tint: 0x7dffa8, vy: -s * 0.9, life: 0.7, s0: s / 64 * 0.32, s1: s / 64 * 0.2, a0: 0.95, a1: 0, fadeIn: 0.08,
      });
    }
    if (this.ctx.settings?.damageNumbers !== false) this.number(view, amount, 'heal', false);
  }

  /**
   * A damage / heal number over `view` (see the header). Layout in screen space, against EVERY live number (the
   * '41509' / '201625' overlaps were numbers of neighbouring units standing side by side):
   *   * merge: a same-style hit on the same unit within NUM_MERGE_GAP of that number's last hit (and while it is still
   *     young) adds to it — a running total that re-pops and lives a little longer;
   *   * cap: a unit shows at most NUM_PER_TARGET numbers; past it the hit joins the unit's youngest same-style number,
   *     else the unit's oldest number fades out at once;
   *   * lanes: the new number takes the lowest free slot of its unit's lanes (centre, then beside the head, 0 / ±1 / ±2
   *     lane widths), stacking upwards at most NUM_MAX_LINES lines; a slot is free when no live number of any unit
   *     overlaps it now or later (a younger number rises faster: below an older one it must keep that one's rise so
   *     far as a margin) with a gap wide enough that two numbers never read as one;
   *   * crowded (> NUM_CROWD numbers near it): it lives shorter; a pair that still ends up overlapping (units walking
   *     into each other) resolves by fading the older one quickly (_updateNums).
   */
  number(view, amount, style, big) {
    const n = Math.round(amount);
    if (!(n > 0) || !view) return;
    const now = this.time;
    const cam = this.ctx.cam();
    const base = (view.z || 0) + (view.hover || 0) + (view._headTiles || 1.2) * 0.8;
    const a = cam.project(view.x, view.y, base, this._p);
    const ax = a.x, ay = a.y, s = a.s > 0 ? a.s : 100;
    const pxPerZ = ay - cam.project(view.x, view.y, base + 1, this._q).y;
    const risePx = NUM_RISE * (pxPerZ > 1e-3 ? pxPerZ : s * 0.5);
    // the live boxes only change between frames: laid out once per frame / camera, not once per hit (a heavy AoE
    // lands dozens of hits in one frame — re-projecting every live number for each was O(hits × numbers))
    this._layoutNumsOnce(cam);
    // 1. merge into this unit's running total of the same style
    let mine = 0, youngest = null, oldest = null;
    for (const t of this.nums) {
      if (t.unit !== view || t.fading) continue;
      mine++;
      if (!oldest || t.born < oldest.born) oldest = t;
      if (t.style === style && (!youngest || t.born > youngest.born)) youngest = t;
    }
    const merge = youngest && now - youngest.lastHit < NUM_MERGE_GAP && youngest.life < NUM_RISE_T * 0.55 ? youngest
      : (mine >= NUM_PER_TARGET && youngest ? youngest : null);
    if (merge && this._growFits(merge, n, big)) {
      merge.value += n;
      merge.text.text = (style === 'heal' ? '+' : '') + merge.value;
      merge.pop = 1;
      merge.big = merge.big || big;
      merge.lastHit = now;
      merge.end = Math.min(merge.life + NUM_LIFE * 0.75, Math.max(merge.end, merge.life + NUM_LIFE * 0.6), NUM_MAX_LIFE);
      this._sizeNum(merge);
      return;
    }
    if (mine >= NUM_PER_TARGET && oldest) this._fadeNum(oldest, 0.1);
    // 2. a free slot among the unit's lanes
    const sc = numScale(s, big, style);
    const w = numChars(n, style) * NUM_DIGIT_EM * 24 * sc * NUM_POP + NUM_GAP_PX;
    const h = 24 * NUM_LINE_EM * sc * NUM_POP;
    const lane = Math.max(w, 24 * NUM_DIGIT_EM * sc * 3.2) * 0.62;
    let best = null;
    for (const k of NUM_LANES) {
      const cx = ax + k * lane;
      const cy = this._numSlotPx(cx, ay, w, h, risePx);
      const lift = ay - cy;
      if (!best || lift < best.lift - 0.5) best = { cx, cy, lift, k };
      if (lift <= h * 1.2) break;              // low enough: keep the nearest lane
    }
    const cap = h * NUM_MAX_LINES;
    let { cx, cy } = best;
    if (ay - cy > cap) {
      // over capacity (a knot of units under fire): join this unit's latest same-style total when it fits, else take
      // the capped spot and drop whatever is there (crowded numbers give way at once)
      let same = null;
      for (const t of this.nums) if (t.unit === view && t.style === style && !t.fading && (!same || t.born > same.born)) same = t;
      if (same && this._growFits(same, n, big)) {
        same.value += n;
        same.text.text = (style === 'heal' ? '+' : '') + same.value;
        same.pop = 1;
        same.big = same.big || big;
        same.lastHit = now;
        this._sizeNum(same);
        return;
      }
      // (released at once, not merely ended: they would vanish before the next render anyway, and as obstacles they
      // made every further hit of the same frame search a crowd that is no longer there — a knot under AoE)
      cx = ax; cy = ay - cap;
      let keep = 0;
      for (const t of this.nums) {
        if (Math.abs(t._x - cx) < (t._w + w) / 2 && t._y > cy - h && t._y - t._h < cy) { this._releaseNum(t); continue; }
        this.nums[keep++] = t;
      }
      this.nums.length = keep;
    }
    // 3. crowding: numbers around this spot → a shorter life for everyone new here
    let near = 0;
    for (const t of this.nums) if (!t.fading && Math.abs(t._x - cx) < 150 && Math.abs(t._y - cy) < 110) near++;
    const life = near >= NUM_CROWD ? NUM_LIFE * 0.62 : NUM_LIFE;
    const maxNums = this.load >= 2 ? MAX_NUMBERS >> 1 : MAX_NUMBERS;
    while (this.nums.length >= maxNums) this._releaseNum(this.nums.shift());
    const t = this._takeNum(style);
    t.text.visible = true;
    t.text.alpha = 1;
    t.text.text = (style === 'heal' ? '+' : '') + n;
    Object.assign(t, {
      unit: view, style, value: n, life: 0, end: life, born: now, lastHit: now, pop: 1, big: !!big, fading: false,
      ox: cx - ax, oy: cy - ay, x0: view.x, y0: view.y, z0: base, risePx, _x: cx, _y: cy, _w: w, _h: h,
    });
    this.nums.push(t);
  }

  /** Whether a merged number's grown text still fits among its neighbours (else a new number is made). */
  _growFits(t, add, big) {
    const sc = numScale(t._s || 100, t.big || big, t.style);
    const w = numChars(t.value + add, t.style) * NUM_DIGIT_EM * 24 * sc * NUM_POP + NUM_GAP_PX;
    for (const o of this.nums) {
      if (o === t || o.fading) continue;
      if (Math.abs(o._x - t._x) < (o._w + w) / 2 && Math.abs(o._y - t._y) < (o._h + t._h) / 2) return false;
    }
    return true;
  }

  /**
   * Lowest (largest screen y) bottom for a number of size w×h centred at x, starting at y0, clear of every live number
   * now and later: above one it must sit on its top; below one it must leave that one's rise so far as a margin
   * (the new number rises faster and would catch up).
   */
  _numSlotPx(x, y0, w, h, risePx) {
    let y = y0;
    for (let pass = 0; pass <= this.nums.length; pass++) {
      let moved = false;
      for (const t of this.nums) {
        if (t.fading && t.text.alpha < 0.3) continue;   // almost gone
        if (Math.abs(t._x - x) >= (t._w + w) / 2) continue;
        const top = t._y - t._h, bottom = t._y;
        const risen = t.risePx * easeOut(Math.min(1, t.life / NUM_RISE_T));
        if (y <= top) continue;                                   // entirely above it (bottom at or over its top)
        if (y - h >= bottom + risen) continue;                    // below it, for good
        y = top;
        moved = true;
      }
      if (!moved) break;
    }
    return y;
  }

  /** Screen boxes of the live numbers (their current anchor, rise and size) → t._x, t._y (bottom), t._w, t._h. */
  _layoutNums(cam) {
    const p = this._p;
    for (const t of this.nums) {
      const u = t.unit;
      if (u && !u.destroyed) { t.x0 = u.x; t.y0 = u.y; }
      cam.project(t.x0, t.y0, t.z0, p);
      t._s = p.s;
      const k = Math.min(1, t.life / NUM_RISE_T);
      t._x = p.x + t.ox;
      t._y = p.y + t.oy - t.risePx * easeOut(k);
      this._sizeNum(t);
    }
    this._laidAt = this.time;
    this._laidCam = cam;
    this._laidKey = camKey(cam);
  }

  /** `_layoutNums` unless the boxes are already current: same frame (fx time) and the same camera framing. */
  _layoutNumsOnce(cam) {
    if (this._laidAt === this.time && this._laidCam === cam && this._laidKey === camKey(cam)) return;
    this._layoutNums(cam);
  }

  /** A number's box size from its value, style, pop and the scale of its last layout (t._s px per tile). */
  _sizeNum(t) {
    const sc = numScale(t._s || 100, t.big, t.style);
    const pop = 1 + t.pop * (NUM_POP - 1);
    t._w = numChars(t.value, t.style) * NUM_DIGIT_EM * 24 * sc * pop + NUM_GAP_PX;
    t._h = 24 * NUM_LINE_EM * sc * pop;
    t._sc = sc;
  }

  _fadeNum(t, within) {
    if (t.fading) return;
    t.fading = true;
    t.fadeFrom = t.text.alpha;
    t.end = Math.min(t.end, t.life + within);
    t.fadeT0 = t.life;
  }

  _takeNum(style) {
    const P = this.P;
    const font = DMG_STYLE[style]?.font || DMG_STYLE.phys.font;
    const pool = this._numPools || (this._numPools = new Map());
    const list = pool.get(font);
    let t = list && list.length ? list.pop() : null;
    if (!t) {
      const text = new P.BitmapText('0', { fontName: font, fontSize: 24, align: 'center' });
      text.anchor.set(0.5, 1);
      this.ctx.layers.text.addChild(text);
      t = { text, font };
    }
    return t;
  }

  _releaseNum(t) {
    t.text.visible = false;
    t.unit = null;
    const pool = this._numPools || (this._numPools = new Map());
    let list = pool.get(t.font);
    if (!list) pool.set(t.font, list = []);
    if (list.length < 30) list.push(t); else t.text.destroy();
  }

  _updateNums(dt) {
    const cam = this.ctx.cam();
    let w = 0;
    for (const t of this.nums) {
      t.life += dt;
      if (t.life >= t.end) { this._releaseNum(t); continue; }
      t.pop = Math.max(0, t.pop - dt * 6);
      this.nums[w++] = t;
    }
    this.nums.length = w;
    this._layoutNums(cam);
    // a pair still overlapping (their units walked into each other): the older one gives way
    const L = this.nums;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (a.fading) continue;
      for (let j = i + 1; j < L.length; j++) {
        const b = L[j];
        if (b.fading) continue;
        if (Math.abs(a._x - b._x) < (a._w + b._w) / 2 - NUM_GAP_PX * 0.5 && Math.abs((a._y - a._h / 2) - (b._y - b._h / 2)) < (a._h + b._h) / 2 * 0.9) {
          this._fadeNum(a.born <= b.born ? a : b, 0.06);
          if (a.fading) break;
        }
      }
    }
    for (const t of L) {
      const tx = t.text;
      tx.scale.set(t._sc * (1 + t.pop * (NUM_POP - 1)));
      tx.position.set(t._x, t._y);
      let alpha = 1;
      const left = t.end - t.life;
      if (t.fading) alpha = (t.fadeFrom ?? 1) * clamp(left / Math.max(0.01, t.end - t.fadeT0), 0, 1);
      else if (left < NUM_FADE_T) alpha = left / NUM_FADE_T;
      tx.alpha = alpha;
    }
  }

  // ---- rings / auras -----------------------------------------------------------------------------------------

  /** Ground ring expanding from r0 to r1 tiles. */
  ring(x, y, z, r0, r1, tint, dur = 0.4, tex = 'ring') {
    const P = this.P;
    let r = this.ringFree.pop();
    if (!r) {
      const sp = new P.Sprite(this.tex[tex]);
      sp.anchor.set(0.5);
      sp.blendMode = P.BLEND_MODES.ADD;
      this.ctx.layers.groundFx.addChild(sp);
      r = { sp };
    }
    r.sp.texture = this.tex[tex];
    r.sp.visible = true;
    r.sp.tint = tint;
    this._onGround(r.sp, y, z);
    Object.assign(r, { x, y, z, r0, r1, t: 0, dur });
    this.rings.push(r);
    if (this.rings.length > 80) { const o = this.rings.shift(); o.sp.visible = false; this.ringFree.push(o); }
  }

  _updateRings(dt) {
    const cam = this.ctx.cam();
    const p = this._p, q = this._q;
    let w = 0;
    for (const r of this.rings) {
      r.t += dt;
      if (r.t >= r.dur) { r.sp.visible = false; this.ringFree.push(r); continue; }
      const k = easeOut(r.t / r.dur);
      const rad = r.r0 + (r.r1 - r.r0) * k;
      cam.project(r.x, r.y, r.z + 0.01, p);
      cam.project(r.x, r.y + rad, r.z + 0.01, q);
      const rx = p.s * rad, ry = Math.max(1, p.y - q.y);
      r.sp.position.set(p.x, p.y);
      r.sp.scale.set((rx * 2) / 128, (ry * 2) / 128);
      r.sp.alpha = 1 - r.t / r.dur;
      this.rings[w++] = r;
    }
    this.rings.length = w;
  }

  /** Skill activation (on) / end (off). */
  skill(view, on) {
    if (!view) return;
    if (on) {
      const p = this._proj(view.x, view.y, view.z || 0);
      const s = p.s;
      this.particle('pillar', p.x, p.y, { tint: 0xffd45a, life: 0.55, s0: s / 64 * 0.9, s1: s / 64 * 1.2, a0: 0.9, a1: 0, sx: 0.6, ay: 1 });
      this.particle('glow', p.x, p.y - s * 0.6, { tint: 0xffe28a, life: 0.3, s0: s / 128 * 1.2, s1: s / 128 * 2.2, a0: 0.9, a1: 0 });
      this.ring(view.x, view.y, view.z || 0, 0.2, 1.3, 0xffd45a, 0.5, 'hex');
      this.burst(p.x, p.y - s * 0.5, s, 8, 0xffe28a, { speed: 1.8, up: 1.2, life: 0.6 });
      this._aura(view, true);
    } else this._aura(view, false);
  }

  _aura(view, on) {
    const P = this.P;
    let a = this.auras.get(view.id);
    if (on) {
      if (!a) {
        const sp = new P.Sprite(this.tex.hex);
        sp.anchor.set(0.5);
        sp.blendMode = P.BLEND_MODES.ADD;
        sp.tint = 0xffc94a;
        this.ctx.layers.groundFx.addChild(sp);
        a = { sp, view, t: 0 };
        this.auras.set(view.id, a);
      }
      a.view = view;
      a.off = false;
    } else if (a) a.off = true;
  }

  _updateAuras(dt) {
    const cam = this.ctx.cam();
    const p = this._p, q = this._q;
    for (const [id, a] of this.auras) {
      a.t += dt;
      const v = a.view;
      if (a.off || !v || v.destroyed || v.alive === false) {
        a.sp.alpha -= dt * 3;
        if (a.sp.alpha <= 0) { a.sp.destroy(); this.auras.delete(id); continue; }
      } else a.sp.alpha = 0.38 + 0.14 * Math.sin(a.t * 4);
      if (!v || v.destroyed) continue;
      this._onGround(a.sp, v.y, v.z || 0);
      cam.project(v.x, v.y, (v.z || 0) + 0.01, p);
      cam.project(v.x, v.y + 0.55, (v.z || 0) + 0.01, q);
      a.sp.position.set(p.x, p.y);
      a.sp.scale.set((p.s * 0.95) / 128, (Math.max(1, p.y - q.y) * 1.72) / 128);
    }
  }

  deploy(view) {
    if (!view) return;
    const p = this._proj(view.x, view.y, view.z || 0);
    const s = p.s;
    const col = view.isEnemy ? 0xff6a5a : 0x9ff0dc;
    this.particle('pillar', p.x, p.y, { tint: col, life: 0.45, s0: s / 64 * 0.7, s1: s / 64 * 0.2, a0: 0.9, a1: 0, sx: 1, ay: 1 });
    this.ring(view.x, view.y, view.z || 0, 0.1, 0.8, col, 0.45);
    this.burst(p.x, p.y, s, 6, col, { speed: 1.6, up: 0.4, life: 0.4, tex: 'dot' });
  }

  death(view) {
    if (!view) return;
    const p = this._chest(view);
    const s = p.s;
    const col = view.isEnemy ? 0xff7a52 : 0xbfeee2;
    const n = this.quality === 'low' ? 5 : 12;
    for (let i = 0; i < n; i++) {
      this.particle(i % 3 ? 'dot' : 'shard', p.x + (Math.random() - 0.5) * s * 0.5, p.y + (Math.random() - 0.3) * s * 0.6, {
        tint: col, vx: (Math.random() - 0.5) * s * 0.6, vy: -s * (0.4 + Math.random() * 0.8), drag: 1.5,
        life: 0.7 + Math.random() * 0.5, s0: s / 32 * 0.12, s1: 0, a0: 0.9, a1: 0, spin: (Math.random() - 0.5) * 6,
      });
    }
    this.particle('smoke', p.x, p.y, { add: false, tint: 0x1a1a1a, life: 0.8, s0: s / 128 * 0.6, s1: s / 128 * 1.4, a0: 0.5, a1: 0 });
  }

  crateBreak(x, y, z, tint = null) {
    const p = this._proj(x, y, (z || 0) + 0.35);
    const s = p.s;
    for (let i = 0; i < (this.quality === 'low' ? 4 : 10); i++) {
      this.particle('shard', p.x, p.y, {
        add: false, tint: tint ?? (i % 2 ? 0xc89a5a : 0x9a6d38), vx: (Math.random() - 0.5) * s * 2.2, vy: -s * (0.6 + Math.random()), g: s * 4,
        life: 0.6, s0: s / 32 * 0.25, s1: s / 32 * 0.15, a0: 1, a1: 0.2, spin: (Math.random() - 0.5) * 14,
      });
    }
    this.particle('smoke', p.x, p.y, { add: false, tint: 0x8a7a60, life: 0.7, s0: s / 128 * 0.6, s1: s / 128 * 1.5, a0: 0.45, a1: 0 });
  }

  // ---- sim fx (b.ev ['fx', kind, x, y, extra]) -------------------------------------------------------------

  /** Unit view of an fx's `id` / `src` / … (null when unknown or gone). */
  _viewOf(id) {
    if (id == null || !this.ctx.view) return null;
    const v = this.ctx.view(id);
    return v && !v.destroyed ? v : null;
  }

  /** Where an fx happens: the anchored unit (rendered position) or the sim position on the ground. */
  _where(x, y, ex) {
    const v = this._viewOf(ex.id);
    if (v && Number.isFinite(v.x)) return { x: v.x, y: v.y, z: (v.z || 0) + (v.hover || 0), v };
    const z = this.ctx.heightAt ? (this.ctx.heightAt(Math.round(y), Math.round(x)) || 0) : 0;
    return { x, y, z, v: null };
  }

  /**
   * b.ev 'fx': every kind the sim / content emits has a visual (FX_KINDS archetypes: blast, zone, telegraph, heal,
   * sp, shield, shatter, summon, vanish, blink, move, wave, mark, reticle, buff, lift, sleep, crit, dodge, counter,
   * dp, coin, crate, down, beam, bolt, strike, volley, pillar, lp, chill, element); unknown kinds get a generic
   * sparkle. `extra` keys used: id (anchor unit), r | radius, dur | duration, src / from / to / targets (unit ids),
   * fx, fy / fromX, fromY / tx, ty (positions), element, n, scale, kind, tiles.
   */
  simFx(kind, x, y, extra) {
    const ex = extra && typeof extra === 'object' ? extra : {};
    const spec = fxSpec(kind, ex);
    const at = this._where(Number(x), Number(y), ex);
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    const col = spec.c;
    const r = clamp(num(ex.r ?? ex.radius, spec.r ?? 1), 0.3, 30);
    const ts = this.ctx.timeScale ? Math.max(0.25, this.ctx.timeScale()) : 2;
    const dur = num(ex.dur ?? ex.duration, spec.dur ?? 0) / ts;
    const cam = this.ctx.cam();
    const chest = (v, out = this._p) => (v ? this._chest(v, out) : cam.project(at.x, at.y, at.z + 0.5, out));
    const p = chest(at.v);
    const s = p.s;
    switch (spec.a) {
      case 'blast': {
        if (r >= 12) { this.flashScreen(col, 0.5); break; }
        const g = cam.project(at.x, at.y, at.z + 0.3);
        this.particle('glow', g.x, g.y, { tint: col, life: 0.35, s0: s / 128 * (0.8 + r * 0.5), s1: s / 128 * (1.4 + r), a0: 0.95, a1: 0 });
        this.particle('glow', g.x, g.y, { tint: 0xffffff, life: 0.16, s0: s / 128 * (0.4 + r * 0.3), s1: s / 128 * (0.9 + r * 0.4), a0: 0.9, a1: 0 });
        this.ring(at.x, at.y, at.z, 0.15, r, col, 0.45);
        this.ring(at.x, at.y, at.z, 0.1, r * 0.72, 0xffffff, 0.3);
        this.burst(g.x, g.y, s, Math.round(6 + r * 4), col, { speed: 2 + r, life: 0.5, up: 0.4 });
        if (ex.tiles) this.tileFlash(tilesAround(at.x, at.y, r, ex.tiles), col, 0.45);
        this.smoke(g.x, g.y, s * (0.4 + r * 0.3), spec.smoke ?? 0x2a2522, 0.35);
        break;
      }
      case 'zone': this.zone(at.x, at.y, at.z, r, col, Math.max(0.6, dur || 1.5), spec.tex); break;
      case 'wall': {
        // a line of burning tiles through the anchor tile along `axis` ('col' | 'row', from the sim event)
        const rect = this.ctx.fieldRect ? this.ctx.fieldRect() : null;
        this.tileFlash(wallTiles(Number(x), Number(y), ex.axis === 'row' ? 'row' : 'col', rect), col, Math.max(0.6, dur || 1.5));
        this.zone(at.x, at.y, at.z, 0.6, col, Math.max(0.6, dur || 1.5), spec.tex);
        break;
      }
      case 'telegraph': {
        const d = Math.max(0.4, dur || 1);
        if (r >= 12) { this.flashScreen(col, 0.45, d); break; }
        if (ex.tiles) this.tileFlash(tilesAround(at.x, at.y, r, ex.tiles), col, d, true);
        else this.zone(at.x, at.y, at.z, r, col, d, 'ring', true);
        break;
      }
      case 'chill': this.flashScreen(col, 0.35, 0.8); this.snowfall(col); break;
      case 'heal': this.heal(at.v || { x: at.x, y: at.y, z: at.z }, 0); break;
      case 'healAoe': {
        this.ring(at.x, at.y, at.z, 0.2, r, col, 0.6);
        const n = this.quality === 'low' ? 4 : 9;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.85;
          const q = cam.project(at.x + Math.cos(a) * d, at.y + Math.sin(a) * d, at.z + 0.2);
          this.particle('plus', q.x, q.y, { tint: col, vy: -q.s * 0.9, life: 0.8, s0: q.s / 64 * 0.3, s1: q.s / 64 * 0.18, a0: 0.9, a1: 0, fadeIn: 0.1 });
        }
        break;
      }
      case 'sp': {
        for (let i = 0; i < (this.quality === 'low' ? 3 : 7); i++) {
          this.particle('dot', p.x + (Math.random() - 0.5) * s * 0.6, p.y + (Math.random() - 0.2) * s * 0.4, { tint: col, vy: -s * (0.6 + Math.random() * 0.6), life: 0.7, s0: s / 32 * 0.2, s1: 0, a0: 1, a1: 0, fadeIn: 0.05 });
        }
        this.particle('glow', p.x, p.y, { tint: col, life: 0.3, s0: s / 128 * 0.6, s1: s / 128 * 1.1, a0: 0.7, a1: 0 });
        break;
      }
      case 'shield': {
        this.particle('hex', p.x, p.y, { tint: col, life: 0.55, s0: s / 128 * 0.9, s1: s / 128 * 1.25, a0: 0.85, a1: 0, sx: 0.85 });
        this.particle('glow', p.x, p.y, { tint: col, life: 0.4, s0: s / 128 * 0.9, s1: s / 128 * 1.3, a0: 0.5, a1: 0 });
        break;
      }
      case 'shatter': {
        this.particle('hex', p.x, p.y, { tint: col, life: 0.25, s0: s / 128 * 1.1, s1: s / 128 * 1.5, a0: 0.9, a1: 0 });
        for (let i = 0; i < (this.quality === 'low' ? 5 : 12); i++) {
          const a = Math.random() * Math.PI * 2;
          this.particle('shard', p.x + Math.cos(a) * s * 0.3, p.y + Math.sin(a) * s * 0.3, { tint: col, vx: Math.cos(a) * s * 1.6, vy: Math.sin(a) * s * 1.2 - s * 0.3, g: s * 3, life: 0.55, s0: s / 32 * 0.16, s1: s / 32 * 0.05, a0: 1, a1: 0, spin: (Math.random() - 0.5) * 12 });
        }
        break;
      }
      case 'summon': {
        const g = cam.project(at.x, at.y, at.z);
        this.particle('pillar', g.x, g.y, { tint: col, life: 0.55, s0: g.s / 64 * 0.8, s1: g.s / 64 * 0.3, a0: 0.9, a1: 0, sx: 1, ay: 1 });
        this.ring(at.x, at.y, at.z, 0.1, 0.9, col, 0.5, 'hex');
        this.burst(g.x, g.y - g.s * 0.3, g.s, 8, col, { speed: 1.4, up: 0.8, life: 0.5, tex: 'dot' });
        break;
      }
      case 'vanish': {
        this.particle('glow', p.x, p.y, { tint: col, life: 0.4, s0: s / 128 * 0.7, s1: s / 128 * 1.5, a0: 0.8, a1: 0 });
        this.smoke(p.x, p.y, s * 0.7, 0x2c2436, 0.5);
        this.burst(p.x, p.y, s, 7, col, { speed: 1.5, tex: 'dot', life: 0.45 });
        break;
      }
      case 'blink': {
        const fx0 = num(ex.fx ?? ex.fromX, NaN), fy0 = num(ex.fy ?? ex.fromY, NaN);
        if (Number.isFinite(fx0) && Number.isFinite(fy0)) {
          const q = cam.project(fx0, fy0, at.z + 0.5, this._q);
          this.smoke(q.x, q.y, q.s * 0.6, 0x2c2436, 0.45);
          this.particle('glow', q.x, q.y, { tint: col, life: 0.3, s0: q.s / 128 * 0.8, s1: q.s / 128 * 0.2, a0: 0.8, a1: 0 });
          this.streak(fx0, fy0, at.x, at.y, at.z + 0.5, col, 0.3);
        }
        this.particle('glow', p.x, p.y, { tint: col, life: 0.35, s0: s / 128 * 0.3, s1: s / 128 * 1.2, a0: 0.9, a1: 0 });
        this.burst(p.x, p.y, s, 6, col, { speed: 1.4, tex: 'dot', life: 0.4 });
        break;
      }
      case 'move': {
        const fx0 = num(ex.fromX ?? ex.fx ?? ex.x0, NaN), fy0 = num(ex.fromY ?? ex.fy ?? ex.y0, NaN);
        const tx = num(ex.tx, NaN), ty = num(ex.ty, NaN);
        if (Number.isFinite(fx0) && Number.isFinite(fy0)) this.streak(fx0, fy0, at.x, at.y, at.z + 0.35, col, 0.35);
        else if (Number.isFinite(tx) && Number.isFinite(ty)) this.streak(at.x, at.y, tx, ty, at.z + 0.35, col, 0.35);
        const g = cam.project(at.x, at.y, at.z + 0.05);
        for (let i = 0; i < (this.quality === 'low' ? 2 : 5); i++) {
          this.particle('smoke', g.x + (Math.random() - 0.5) * g.s * 0.5, g.y, { add: false, tint: 0x6b6358, vx: (Math.random() - 0.5) * g.s * 0.6, vy: -g.s * 0.2, drag: 2, life: 0.5, s0: g.s / 128 * 0.25, s1: g.s / 128 * 0.55, a0: 0.45, a1: 0 });
        }
        break;
      }
      case 'wave': {
        const k = clamp(num(ex.scale, 1), 0.5, 4);
        const rr = Math.max(0.8, r * (ex.scale ? Math.min(2, k / 2) : 1));
        for (let i = 0; i < 3; i++) this.ring(at.x, at.y, at.z, 0.15 + i * 0.15, rr * (0.7 + i * 0.25), col, 0.45 + i * 0.12);
        this.particle('glow', p.x, p.y, { tint: col, life: 0.3, s0: s / 128 * 0.5, s1: s / 128 * 1.2, a0: 0.7, a1: 0 });
        break;
      }
      case 'mark': case 'reticle': {
        const v = at.v;
        const hz = v ? (v.z || 0) + (v.hover || 0) + (v._headTiles || 1.2) + 0.25 : at.z + 1.4;
        const q = cam.project(at.x, at.y, hz, this._q);
        if (spec.a === 'mark') {
          this.particle('glow', q.x, q.y, { tint: col, life: 0.6, s0: q.s / 128 * 0.5, s1: q.s / 128 * 0.7, a0: 0.8, a1: 0 });
          this.numberAt(q.x, q.y, '!', col, 0.8);
        } else {
          this.particle('ring', p.x, p.y, { tint: col, life: 0.6, s0: s / 128 * 1.3, s1: s / 128 * 0.7, a0: 0.95, a1: 0, spin: 3 });
          this.particle('hex', p.x, p.y, { tint: col, life: 0.6, s0: s / 128 * 0.5, s1: s / 128 * 0.9, a0: 0.8, a1: 0, spin: -2 });
        }
        break;
      }
      case 'buff': {
        const g = cam.project(at.x, at.y, at.z + 0.05);
        const n = this.quality === 'low' ? 3 : 6;
        for (let i = 0; i < n; i++) {
          const ox = (Math.random() - 0.5) * g.s * 0.7;
          this.particle('chevron', g.x + ox, g.y - g.s * (0.1 + Math.random() * 0.5), { tint: col, vy: -g.s * (1 + Math.random() * 0.5), life: 0.65, s0: g.s / 64 * 0.22, s1: g.s / 64 * 0.12, a0: 0.95, a1: 0, rot: -Math.PI / 2, fadeIn: 0.06 });
        }
        this.ring(at.x, at.y, at.z, 0.2, 0.75, col, 0.4);
        this.particle('glow', p.x, p.y, { tint: col, life: 0.35, s0: s / 128 * 0.6, s1: s / 128 * 1.1, a0: 0.6, a1: 0 });
        break;
      }
      case 'lift': {
        const g = cam.project(at.x, at.y, at.z);
        this.ring(at.x, at.y, at.z, 0.2, 0.8, col, 0.5);
        for (let i = 0; i < (this.quality === 'low' ? 3 : 7); i++) {
          this.particle('streak', g.x + (Math.random() - 0.5) * g.s * 0.6, g.y - g.s * Math.random() * 0.4, { tint: col, vy: -g.s * 1.8, life: 0.4, s0: g.s / 128 * 0.4, s1: g.s / 128 * 0.2, a0: 0.8, a1: 0, rot: -Math.PI / 2, sx: 1 });
        }
        break;
      }
      case 'sleep': {
        const v = at.v;
        const hz = v ? (v.z || 0) + (v._headTiles || 1.2) : at.z + 1.2;
        const q = cam.project(at.x + 0.2, at.y, hz, this._q);
        for (let i = 0; i < 3; i++) this.particle('st_sleep', q.x + i * q.s * 0.12, q.y - i * q.s * 0.12, { add: false, vy: -q.s * 0.5, vx: q.s * 0.15, life: 0.9 + i * 0.2, s0: q.s / 32 * 0.22, s1: q.s / 32 * 0.32, a0: 1, a1: 0, fadeIn: 0.1 * i });
        break;
      }
      case 'crit': {
        this.particle('spark', p.x, p.y, { tint: col, life: 0.28, s0: s / 64 * 1.3, s1: s / 64 * 0.2, a0: 1, a1: 0, rot: Math.random() * Math.PI });
        this.particle('glow', p.x, p.y, { tint: 0xffffff, life: 0.18, s0: s / 128 * 0.9, s1: s / 128 * 1.4, a0: 0.9, a1: 0 });
        this.burst(p.x, p.y, s, 8, col, { speed: 3.2, life: 0.3, size: 0.5 });
        break;
      }
      case 'dodge': {
        this.particle('soft', p.x, p.y, { tint: 0xffffff, life: 0.3, s0: s / 128 * 0.5, s1: s / 128 * 0.9, a0: 0.5, a1: 0 });
        this.particle('slash', p.x, p.y, { tint: col, life: 0.22, s0: s / 128 * 0.8, s1: s / 128 * 1.1, a0: 0.7, a1: 0, rot: -0.5 });
        break;
      }
      case 'counter': {
        this.particle('spark', p.x, p.y, { tint: col, life: 0.22, s0: s / 64 * 0.9, s1: 0, a0: 1, a1: 0 });
        this.particle('slash', p.x, p.y, { tint: col, life: 0.22, s0: s / 128 * 0.9, s1: s / 128 * 1.2, a0: 0.9, a1: 0, rot: 0.6 });
        this.burst(p.x, p.y, s, 4, col, { speed: 2.4, life: 0.25 });
        break;
      }
      case 'dp': {
        const n = Math.round(num(ex.n, 0));
        this.particle('shard', p.x, p.y, { tint: col, vy: -s * 0.6, life: 0.9, s0: s / 32 * 0.28, s1: s / 32 * 0.22, a0: 1, a1: 0 });
        if (n > 0) this.numberAt(p.x + s * 0.2, p.y, `+${n}`, col, 0.7);
        break;
      }
      case 'coin': {
        for (let i = 0; i < 4; i++) this.particle('coin', p.x + (Math.random() - 0.5) * s * 0.4, p.y, { add: false, vx: (Math.random() - 0.5) * s, vy: -s * (1.2 + Math.random() * 0.6), g: s * 4, life: 0.7, s0: s / 48 * 0.2, s1: s / 48 * 0.16, a0: 1, a1: 0.2 });
        break;
      }
      case 'crate': this.crateBreak(at.x, at.y, at.z); break;
      case 'down': {
        this.smoke(p.x, p.y, s * 0.6, spec.smoke ?? 0x1a1a1a, 0.5);
        this.burst(p.x, p.y, s, 5, col, { speed: 1.2, tex: 'dot', life: 0.5, g: 2 });
        break;
      }
      case 'beam': case 'bolt': {
        const a = this._viewOf(ex.from ?? ex.src) || (spec.a === 'bolt' ? null : at.v);
        const b = this._viewOf(ex.to ?? ex.target) || (a === at.v ? null : at.v);
        if (a && b && a !== b) this._beam(a, b, col, spec.a === 'bolt' ? 0.28 : 0.4, spec.a === 'bolt' ? 1 : 0.4);
        else this.strike(at.x, at.y, at.z, col);
        break;
      }
      case 'strike': case 'pillar': this.strike(at.x, at.y, at.z, col, spec.a === 'pillar'); break;
      case 'volley': {
        const list = Array.isArray(ex.targets) ? ex.targets.slice(0, 12) : [];
        const src = this._viewOf(ex.src ?? ex.id);
        for (const id of list) {
          const t = this._viewOf(id);
          if (!t) continue;
          if (src && src !== t) this.attack(src, t, 'arrow');
          else { const q = this._chest(t, this._q); this.burst(q.x, q.y, q.s, 4, col, { speed: 2, life: 0.3 }); }
        }
        if (!list.length) this.burst(p.x, p.y, s, 6, col, { speed: 2.4, life: 0.35 });
        break;
      }
      case 'lp': this.leak(); break;
      case 'element': {
        const el = ex.element;
        const c2 = el === 'burn' ? 0xff7a33 : el === 'neural' ? 0xff5ad0 : el === 'necrosis' || el === 'apoptosis' ? 0x9dff6a : el === 'erosion' ? 0x6fe0ff : col;
        this.particle('glow', p.x, p.y, { tint: c2, life: 0.45, s0: s / 128 * 1.2, s1: s / 128 * 2.6, a0: 1, a1: 0 });
        this.ring(at.x, at.y, at.z, 0.2, 1.5, c2, 0.55);
        this.burst(p.x, p.y, s, 12, c2, { speed: 3, life: 0.5 });
        break;
      }
      default: {
        this.particle('spark', p.x, p.y, { tint: col, life: 0.35, s0: s / 64 * 0.6, s1: 0, a0: 0.9, a1: 0, rot: Math.random() });
        this.particle('glow', p.x, p.y, { tint: col, life: 0.3, s0: s / 128 * 0.4, s1: s / 128 * 0.9, a0: 0.6, a1: 0 });
        this.burst(p.x, p.y, s, 4, col, { speed: 1.6, tex: 'dot', life: 0.35 });
      }
    }
  }

  /** Dark (normal-blend) smoke puff. */
  smoke(x, y, size, tint, alpha = 0.45) {
    this.particle('smoke', x, y, { add: false, tint, life: 0.8, s0: size / 128 * 0.9, s1: size / 128 * 2, a0: alpha, a1: 0 });
  }

  /** Motion streak between two world points at height z (dash / pull / blink trails). */
  streak(x0, y0, x1, y1, z, tint, life = 0.3) {
    const cam = this.ctx.cam();
    const a = cam.project(x0, y0, z, this._p), ax = a.x, ay = a.y;
    const b = cam.project(x1, y1, z, this._q);
    const len = Math.hypot(b.x - ax, b.y - ay);
    if (len < 2) return;
    const th = Math.max(0.05, (b.s * 0.3) / 32);
    this.particle('streak', b.x, b.y, { tint, life, s0: th, s1: th * 0.5, sx: len / 128 / th, a0: 0.8, a1: 0, rot: Math.atan2(b.y - ay, b.x - ax), anchorX: 1 });
  }

  /** Light strike from the sky onto a point (lightning / skill strikes / columns). */
  strike(x, y, z, tint, wide = false) {
    const cam = this.ctx.cam();
    const g = cam.project(x, y, z);
    this.particle('pillar', g.x, g.y, { tint, life: 0.4, s0: g.s / 64 * (wide ? 1.2 : 0.7), s1: g.s / 64 * (wide ? 0.9 : 0.2), a0: 1, a1: 0, sx: wide ? 1 : 0.5, ay: 1 });
    this.particle('glow', g.x, g.y - g.s * 0.2, { tint, life: 0.3, s0: g.s / 128 * 0.8, s1: g.s / 128 * 1.6, a0: 0.9, a1: 0 });
    this.ring(x, y, z, 0.1, wide ? 1.2 : 0.7, tint, 0.35);
    this.burst(g.x, g.y - g.s * 0.2, g.s, 6, tint, { speed: 2.4, life: 0.35 });
  }

  /** Floating label ('!', '+10') at a screen point, using the damage-number pool. */
  numberAt(x, y, label, tint, life = 0.8) {
    const P = this.P;
    if (this.labels.length >= 24) { const o = this.labels.shift(); o.t.destroy(); }
    const t = new P.BitmapText(String(label), { fontName: DMG_STYLE.true.font, fontSize: 26, align: 'center' });
    t.anchor.set(0.5, 1);
    t.tint = tint;
    t.position.set(x, y);
    this.ctx.layers.text.addChild(t);
    this.labels.push({ t, y0: y, life: 0, max: life });
  }

  _updateLabels(dt) {
    let w = 0;
    for (const l of this.labels) {
      l.life += dt;
      if (l.life >= l.max) { l.t.destroy(); continue; }
      const k = l.life / l.max;
      l.t.position.y = l.y0 - 22 * easeOut(k);
      l.t.alpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
      l.t.scale.set(k < 0.12 ? 0.6 + (k / 0.12) * 0.5 : 1.1 - Math.min(0.1, k - 0.12));
      this.labels[w++] = l;
    }
    this.labels.length = w;
  }

  /** Persistent ground area: soft disc + pulsing edge ring for `dur` real seconds (telegraphs pulse faster). */
  zone(x, y, z, r, tint, dur, tex = 'soft', warn = false) {
    const P = this.P;
    const disc = new P.Sprite(this.tex[tex === 'ring' ? 'soft' : tex] || this.tex.soft);
    disc.anchor.set(0.5); disc.blendMode = P.BLEND_MODES.ADD; disc.tint = tint;
    const edge = new P.Sprite(this.tex.ring);
    edge.anchor.set(0.5); edge.blendMode = P.BLEND_MODES.ADD; edge.tint = tint;
    this._onGround(disc, y, z); this._onGround(edge, y, z);
    this.zones.push({ disc, edge, x, y, z, r, t: 0, dur, warn });
    if (this.zones.length > 24) this._freeZone(this.zones.shift());
  }

  _freeZone(zn) { zn.disc.destroy(); zn.edge.destroy(); }

  _updateZones(dt) {
    const cam = this.ctx.cam();
    const p = this._p, q = this._q;
    let w = 0;
    for (const zn of this.zones) {
      zn.t += dt;
      if (zn.t >= zn.dur) { this._freeZone(zn); continue; }
      const k = zn.t / zn.dur;
      const grow = Math.min(1, zn.t / 0.25);
      const rad = zn.r * (0.35 + 0.65 * easeOut(grow));
      cam.project(zn.x, zn.y, zn.z + 0.02, p);
      cam.project(zn.x, zn.y + rad, zn.z + 0.02, q);
      const rx = p.s * rad, ry = Math.max(1, p.y - q.y);
      const fade = k > 0.8 ? (1 - k) / 0.2 : 1;
      const pulse = zn.warn ? 0.55 + 0.45 * Math.abs(Math.sin(zn.t * 7)) : 0.8 + 0.2 * Math.sin(zn.t * 3);
      zn.disc.position.set(p.x, p.y); zn.disc.scale.set((rx * 2) / 128, (ry * 2) / 128); zn.disc.alpha = (zn.warn ? 0.35 : 0.28) * fade * pulse;
      zn.edge.position.set(p.x, p.y); zn.edge.scale.set((rx * 2.1) / 128, (ry * 2.1) / 128); zn.edge.alpha = 0.75 * fade * pulse;
      this.zones[w++] = zn;
    }
    this.zones.length = w;
  }

  /** Flash a set of tiles ([[r,c]]) on the ground (telegraphed boxes, blast tiles). */
  tileFlash(tiles, tint, dur, warn = false) {
    if (!Array.isArray(tiles) || !tiles.length) return;
    this.tileFlashes.push({ tiles: tiles.slice(0, 60), tint, dur: Math.max(0.2, dur), t: 0, warn });
    if (this.tileFlashes.length > 12) this.tileFlashes.shift();
  }

  _updateTileFlashes(dt) {
    const g = this.tileGfx;
    g.clear();
    if (!this.tileFlashes.length) return;
    const cam = this.ctx.cam();
    const p = this._p;
    let w = 0;
    for (const f of this.tileFlashes) {
      f.t += dt;
      if (f.t >= f.dur) continue;
      const k = f.t / f.dur;
      const a = (f.warn ? 0.35 + 0.35 * Math.abs(Math.sin(f.t * 7)) : 0.55 * (1 - k)) * (k > 0.85 ? (1 - k) / 0.15 : 1);
      for (const [r, c] of f.tiles) {
        const z = (this.ctx.heightAt ? this.ctx.heightAt(r, c) : 0) + 0.015;
        const pts = [];
        for (const [dx, dy] of [[-0.46, 0.46], [0.46, 0.46], [0.46, -0.46], [-0.46, -0.46]]) { cam.project(c + dx, r + dy, z, p); pts.push(p.x, p.y); }
        g.lineStyle(Math.max(1, p.s * 0.03), f.tint, Math.min(1, a * 1.6));
        g.beginFill(f.tint, a * 0.6);
        g.drawPolygon(pts);
        g.endFill();
      }
      this.tileFlashes[w++] = f;
    }
    this.tileFlashes.length = w;
  }

  /** Full-screen colour pulse (field-wide telegraphs, cold wind). */
  flashScreen(tint, alpha = 0.4, dur = 0.6) {
    this.tintT = dur; this.tintDur = dur; this.tintA = alpha;
    this.tintSprite.tint = tint;
  }

  /** A short flurry of snow over the field (cold wind). */
  snowfall(tint) {
    const size = this.ctx.screenSize();
    for (let i = 0; i < (this.quality === 'low' ? 10 : 26); i++) {
      this.particle('dot', Math.random() * size.width, Math.random() * size.height * 0.7, { tint, vx: 30 + Math.random() * 40, vy: 60 + Math.random() * 60, life: 1 + Math.random() * 0.6, s0: 0.25 + Math.random() * 0.3, s1: 0.1, a0: 0.8, a1: 0, fadeIn: 0.2 });
    }
  }

  /** Leak: objective flash + red screen vignette pulse. */
  leak() {
    this.vigT = 0.9;
  }

  /** Screen-space pop (bond layer gain / bounty coins). `icon` = texture or null. */
  pop(icon, label, tint, i = 0) {
    const P = this.P;
    const size = this.ctx.screenSize();
    const top = this.ctx.fieldTop ? this.ctx.fieldTop() : size.height * 0.2;
    const c = new P.Container();
    const x = size.width / 2 + (i % 5 - 2) * 70;
    c.position.set(x, top);
    if (icon) {
      const glow = new P.Sprite(this.tex.glow);
      glow.anchor.set(0.5); glow.tint = tint; glow.blendMode = P.BLEND_MODES.ADD; glow.scale.set(0.9);
      const sp = new P.Sprite(icon);
      sp.anchor.set(0.5);
      const k = 46 / Math.max(1, Math.max(icon.width, icon.height));
      sp.scale.set(k);
      sp.tint = tint;
      c.addChild(glow, sp);
    }
    if (label) {
      const t = new P.BitmapText(label, { fontName: DMG_STYLE.heal.font, fontSize: 26 });
      t.anchor.set(0, 0.5);
      t.position.set(26, 0);
      if (tint === COLORS.gold) t.tint = 0xffe066;
      c.addChild(t);
    }
    this.ctx.layers.screen.addChild(c);
    this.pops.push({ c, t: 0, dur: 1.4, y0: top });
    if (this.pops.length > 12) { const o = this.pops.shift(); o.c.destroy({ children: true }); }
  }

  _updatePops(dt) {
    let w = 0;
    for (const p of this.pops) {
      p.t += dt;
      if (p.t >= p.dur) { p.c.destroy({ children: true }); continue; }
      const k = p.t / p.dur;
      p.c.position.y = p.y0 - 40 * easeOut(k);
      p.c.alpha = k < 0.15 ? k / 0.15 : k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      const s = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, (k - 0.15));
      p.c.scale.set(s);
      this.pops[w++] = p;
    }
    this.pops.length = w;
  }

  /** Remove everything (battle reset). */
  clear() {
    for (const p of this.parts) this._freeParticle(p);
    this.parts.length = 0;
    for (const pr of this.projs) this._releaseProj(pr);
    this.projs.length = 0;
    for (const t of this.nums) this._releaseNum(t);
    this.nums.length = 0;
    for (const r of this.rings) { r.sp.visible = false; this.ringFree.push(r); }
    this.rings.length = 0;
    for (const a of this.auras.values()) a.sp.destroy();
    this.auras.clear();
    for (const p of this.pops) p.c.destroy({ children: true });
    this.pops.length = 0;
    this.beamList.length = 0;
    this.beams.clear();
    this.vigT = 0;
    this.vignette.alpha = 0;
    for (const zn of this.zones) this._freeZone(zn);
    this.zones.length = 0;
    for (const l of this.labels) l.t.destroy();
    this.labels.length = 0;
    this.tileFlashes.length = 0;
    this.tileGfx.clear();
    this.tintT = 0; this.tintSprite.alpha = 0;
  }

  update(dt) {
    this.time += dt;
    this._updateParticles(dt);
    this._updateProjs(dt);
    this._updateBeams(dt);
    this._updateNums(dt);
    this._updateRings(dt);
    this._updateAuras(dt);
    this._updatePops(dt);
    this._updateZones(dt);
    this._updateLabels(dt);
    this._updateTileFlashes(dt);
    if (this.tintT > 0) {
      this.tintT = Math.max(0, this.tintT - dt);
      const size = this.ctx.screenSize();
      this.tintSprite.width = size.width; this.tintSprite.height = size.height;
      this.tintSprite.alpha = Math.sin((this.tintT / this.tintDur) * Math.PI) * this.tintA * 0.35;
    } else if (this.tintSprite.alpha) this.tintSprite.alpha = 0;
    if (this.vigT > 0) {
      this.vigT = Math.max(0, this.vigT - dt);
      const size = this.ctx.screenSize();
      this.vignette.width = size.width; this.vignette.height = size.height;
      this.vignette.alpha = Math.sin((this.vigT / 0.9) * Math.PI) * 0.55;
    } else if (this.vignette.alpha) this.vignette.alpha = 0;
  }

  get counts() {
    return { particles: this.parts.length, projectiles: this.projs.length, numbers: this.nums.length, rings: this.rings.length, auras: this.auras.size };
  }

  destroy() {
    this.clear();
    this.addPc.destroy({ children: true });
    this.normPc.destroy({ children: true });
    this.projLayer.destroy({ children: true });
    this.beams.destroy();
    this.vignette.destroy();
    this.tileGfx.destroy();
    this.tintSprite.destroy();
    for (const list of this._numPools.values()) for (const t of list) t.text.destroy();
    this._numPools.clear();
  }
}

const easeOut = (t) => 1 - (1 - t) * (1 - t);
