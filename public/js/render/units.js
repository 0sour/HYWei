// render/units.js — per-unit views for battle units and prep pieces (DESIGN §9).
//
// UnitView = shadow sprite (shadow layer) + body container (depth-sorted unit layer: elite aura, Spine actor or
// the avatar-in-rarity-diamond fallback) + HUD container (bar layer: HP bar with delayed "ghost" damage, SP bar
// with ready glow / draining skill bar, tier chip, status icons, blocked marker). The fallback shows at once and
// cross-fades to the Spine model when it has loaded; missing or failed models keep the fallback forever (the
// game never blocks on Spine). Every bar is a tinted Texture.WHITE sprite, so HUDs batch into few draw calls.
//
// Placement: feet anchored at world (x, y, z); scale = camera px-per-tile at the feet × UNIT.modelScale, so
// chibis shrink with distance like the original. Operators and summons face their deploy direction `dir`
// (research 09 §1.2, DESIGN §3: UP|RIGHT|DOWN|LEFT, chosen with the direction wheel; UnitInfo / piece `dir`, else
// the legacy `facing` ±1): the Back model for UP (when one exists, research 07 §5.5), the Front model for RIGHT and
// DOWN, mirrored for LEFT; the orange ground wedge "›" of prep board pieces points along `dir` (rotated on the ground
// plane). `setDir(dir)` re-orients a live view (swapping Front ⇄ Back without a fallback flash). Enemies flip by the
// sign of their horizontal velocity (with hysteresis).
//
// ItemView renders hand items as a floating icon plate; DeviceView renders battle devices (crates) as 3D boxes
// with an HP bar once damaged.
//
// Cost control (low-end devices): a unit whose body is outside the viewport (`ctx.viewport()`, with a margin) is not
// animated or drawn at all (its clock catches up, ≤ 0.5 s, when it comes back); `opts.lod: 'idle'` (the enemy preview
// pen: idle loops only) animates through the impostor atlas every 3rd frame; under the view's adaptive load level
// (`ctx.loadLevel()` 1–3, app.js) small / far units (< ~56 px per tile) animate every 2nd frame, and from level 2 on
// every unit does.

import { UF, ANIM } from '../../../shared/constants.js';
import { SpineActor } from './spine.js';
import { diamondTexture, shadowTexture, fxAtlas, tierChip, statusTexture, itemTexture } from './textures.js';
import { COLORS, TIER_COLORS, ENEMY_FRAME, UNIT, statusIconKey } from './style.js';
import { drawCrate, rowDepthKey, ROW_KEY, deviceBoxOf, DEVICE_BOX } from './tiles.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DIRS = ['UP', 'RIGHT', 'DOWN', 'LEFT'];
/** Deploy direction of an ally from a UnitInfo / piece: `dir` (any case), else the legacy `facing` sign. */
export function unitDir(info) {
  const d = typeof info?.dir === 'string' ? info.dir.toUpperCase() : null;
  if (d && DIRS.includes(d)) return d;
  return info?.facing === -1 ? 'LEFT' : 'RIGHT';
}
/** World step (x = col, y = row) of a direction. */
export const DIR_STEP = Object.freeze({ UP: [0, 1], RIGHT: [1, 0], DOWN: [0, -1], LEFT: [-1, 0] });
const nowMs = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
/** How long a view waits for its avatar before showing the image-less placeholder diamond. */
const PIC_WAIT_MS = 400;

/** Heights above this count as standing on a raised top (bench pads are the lowest raised tiles, 0.16). */
const RAISED_Z = 0.12;
/** Flying units hover this many tiles above the ground they cross. */
export const FLY_HOVER = 0.32;

/**
 * Keep `obj` in the right layer: the surface container of block row round(y) when it lies on a raised top at
 * height `z` (drawn after that row's blocks), else `fallback`. Reparents only on change.
 */
export function placeOnGround(ctx, obj, fallback, y, z) {
  let layer = fallback;
  if (z > RAISED_Z && ctx.surfaceLayer) layer = ctx.surfaceLayer(Math.round(y)) || fallback;
  if (obj.parent !== layer) layer.addChild(obj);
}

/** Standing height of a world point (tile top incl. raised devices); 0 off-grid / without a stage. */
export function groundZ(ctx, x, y) {
  if (!ctx.heightAt) return 0;
  const h = ctx.heightAt(Math.round(y), Math.round(x));
  return Number.isFinite(h) && h > 0 ? h : 0;
}

/** Enemy Spine models face right by default like operators (verified by eye on Ark-Models skeletons). */
export const ENEMY_MODEL_FACES_LEFT = false;

let _whiteTex = null;
const white = () => (_whiteTex || (_whiteTex = globalThis.PIXI.Texture.WHITE));

function bar(P, parent, color, alpha = 1) {
  const s = new P.Sprite(white());
  s.tint = color;
  s.alpha = alpha;
  s.anchor.set(0, 0.5);
  parent.addChild(s);
  return s;
}

/**
 * Shared context handed to every view by app.js.
 * @typedef {{ P: any, layers: { shadow: any, units: any, bars: any, groundFx: any },
 *   assets: any, cam: () => any, heightAt: (r:number,c:number)=>number, fx: any, time: () => number,
 *   settings: { damageNumbers: boolean, quality: string } }} ViewCtx
 */

export class UnitView {
  /**
   * @param {ViewCtx} ctx
   * @param {object} info UnitInfo-like: { id, uid?, kind, side, defId, spine, avatar, tier, golden, facing, maxHp, boss?, motion?, name? }
   * @param {{ prep?: boolean }} [opts]
   */
  constructor(ctx, info, opts = {}) {
    const P = ctx.P;
    this.ctx = ctx;
    this.P = P;
    this.info = { ...info };
    this.id = info.id;
    this.uid = info.uid ?? null;
    this.prep = !!opts.prep;
    this.lodIdle = opts.lod === 'idle';
    this.culled = false;          // outside the viewport this frame (not animated, not drawn)
    this._offDt = 0;              // animation time skipped while culled
    this._far = false;            // small on screen (adaptive LOD, with hysteresis)
    this.isEnemy = info.side === 'enemy';
    this.isBoss = !!info.boss;
    this.isToken = info.kind === 'token';
    this.golden = !!info.golden;
    this.tier = clamp(Number(info.tier) || 1, 1, 6);
    this.x = Number(info.x) || 0; this.y = Number(info.y) || 0; this.z = 0;
    this.zTarget = null;          // battle: standing height the feet ease towards (tile top under the unit)
    this.flying = info.motion === 'FLY';
    this.hover = 0;               // flying: body height above the ground under it
    this.dir = this.isEnemy ? null : unitDir(info);
    // whether the direction is known (UnitInfo / piece `dir`), not just the legacy ±1: battle and scouting views show
    // the ground wedge only then (a derived RIGHT would mislabel an UP / DOWN operator)
    this.hasDir = !this.isEnemy && typeof info.dir === 'string' && DIRS.includes(info.dir.toUpperCase());
    this.facing = this.dir === 'LEFT' ? -1 : 1;
    this.visFacing = this.isEnemy ? -1 : this.facing;
    this.hp = Number(info.maxHp) || 1; this.maxHp = Number(info.maxHp) || 1; this.ghostHp = this.hp;
    this.sp = 0; this.spMax = 0;
    this.flags = 0; this.anim = ANIM.IDLE;
    this.statuses = new Set();
    this.alive = true;
    this.dying = 0;               // seconds left of the death fade (0 = not dying)
    this.dieT = 0;
    this.remove = false;          // set when the death fade ended (owner removes the view)
    this.alpha = 1; this.fadeIn = this.prep ? 1 : 0;
    this.lunge = 0; this.lungeDir = { x: 1, y: 0 };
    this.flash = 0;
    this.bob = Math.random() * Math.PI * 2;
    this.hovered = false; this.dimmed = false; this.lift = 0;
    this.lastAtk = -1; this.atkInterval = defaultInterval(ctx, info);
    this.shake = 0;
    this.screen = { x: 0, y: 0, s: 1, top: 0 };
    this.destroyed = false;

    // --- display objects
    this.shadow = new P.Sprite(ctx.shadowTex || shadowTexture());
    this.shadow.anchor.set(0.5);
    this.shadow.alpha = 0.55;
    ctx.layers.shadow.addChild(this.shadow);

    this.root = new P.Container();
    this.root.sortableChildren = false;
    ctx.layers.units.addChild(this.root);

    const fx = fxAtlas();
    this.aura = null;
    if (this.golden) {
      this.aura = new P.Sprite(fx.tex.glow);
      this.aura.anchor.set(0.5, 0.62);
      this.aura.tint = 0xffc94a;
      this.aura.blendMode = P.BLEND_MODES.ADD;
      this.root.addChild(this.aura);
    }
    this.body = new P.Container();
    this.root.addChild(this.body);
    this.fallback = new P.Sprite(P.Texture.EMPTY);
    this.fallback.anchor.set(0.5, 1);
    this.body.addChild(this.fallback);
    this.actor = null;
    this.spineReady = false;

    this.hud = new P.Container();
    ctx.layers.bars.addChild(this.hud);
    this._buildHud();

    this.facingArrow = null;
    this._loadPicture();
    this._loadSpine();
  }

  // ---- loading ---------------------------------------------------------------------------------------------

  _frameColor() {
    if (this.isEnemy) return this.isBoss ? ENEMY_FRAME.boss : this.tier >= 2 ? ENEMY_FRAME.elite : ENEMY_FRAME.normal;
    if (this.golden) return 0xffc600;
    return TIER_COLORS[this.tier] || TIER_COLORS[1];
  }

  // The fallback portrait (avatar in a rarity diamond, a 160×160 canvas cached by textures.js) is built lazily, on
  // the first frame it is actually visible: never for a unit whose Spine model is ready before that, and never as
  // an image-less placeholder that the avatar replaces a moment later (the placeholder only shows when the avatar
  // is missing or still loading after PIC_WAIT_MS).
  _loadPicture() {
    const a = this.ctx.assets;
    const url = a && (a.picture ? a.picture(this.info.avatar) || a.picture(this.info.defId) || a.picture(this.info.spine) : null);
    this._pic = { key: String(this.info.avatar || this.info.defId || 'unknown'), color: this._frameColor(), img: null, state: 'none', shown: null, t0: nowMs() };
    if (!url || !a.image) return;
    const cached = typeof a.imageNow === 'function' ? a.imageNow(url) : null;
    if (cached) { this._pic.img = cached; this._pic.state = 'img'; return; }
    this._pic.state = 'wait';
    const pic = this._pic;
    Promise.resolve().then(() => a.image(url)).then((img) => {
      if (img) { pic.img = img; pic.state = 'img'; } else pic.state = 'none';
    }, () => { pic.state = 'none'; });
  }

  /** Put the right diamond on the fallback sprite (called while the fallback is visible). */
  _ensurePicture() {
    const pic = this._pic;
    if (!pic || this.destroyed) return;
    let want = pic.state === 'img' ? 'img' : 'placeholder';
    if (pic.state === 'wait' && nowMs() - pic.t0 < PIC_WAIT_MS) want = null;
    if (!want || pic.shown === want) return;
    this.fallback.texture = diamondTexture(pic.key, want === 'img' ? pic.img : null, pic.color, { enemy: this.isEnemy, golden: this.golden });
    pic.shown = want;
  }

  _loadSpine() {
    const a = this.ctx.assets;
    if (!a || !a.spineEntry || !a.spine) return;
    const id = this.info.spine || this.info.defId;
    // Front/Back rule (research 07 §5.5 / 09 §1.2): Front facing right/down (mirrored for left), Back facing up.
    const back = this._wantsBack();
    const entry = id ? a.spineEntry(id, { back }) : null;
    if (!entry || this.ctx.settings?.quality === 'low' && this.isEnemy && !this.isBoss && this.ctx.crowded?.()) return;
    // every acquire is paired with exactly one release: a superseded / failed / post-destroy load releases its own
    // entry; the displayed model's entry (`_actorEntry`) is released when that model is replaced or destroyed
    this.entry = entry;
    this.entryBack = back;
    const req = this._spineReq = (this._spineReq || 0) + 1;
    a.spine.acquire(entry).then((data) => {
      if (this.destroyed || req !== this._spineReq) { this._releaseEntry(entry); return; }
      let actor = null;
      try {
        actor = new SpineActor(data, entry);
        actor.setSkillIndex(this.info.skillIndex);
      } catch (err) {
        console.warn('[render] spine build failed', id, err?.message || err);
        this._releaseEntry(entry);
        return;
      }
      // a Front ⇄ Back swap (setDir) replaces the previous model in place: no fallback diamond in between
      const swap = !!this.actor;
      if (swap) this._dropActor();
      this.actor = actor;
      this._actorEntry = entry;
      this.body.addChild(this.actor.spine);
      this.spineReady = true;
      this.swapT = swap ? 1 : 0;
      this.actor.spine.alpha = swap ? 1 : 0;
      // replay current state
      if (!this.alive) this.actor.die();
      else {
        if (this.flags & UF.SKILL) this.actor.setSkill(true);
        this.actor.setBase(this._baseFromAnim());
      }
    }, () => { this._releaseEntry(entry); /* keep the fallback */ });
  }

  // ---- HUD -------------------------------------------------------------------------------------------------

  _buildHud() {
    const P = this.P, h = this.hud;
    this.hpBg = bar(P, h, COLORS.hpBack, 0.85);
    this.hpGhost = bar(P, h, COLORS.hpGhost, 0.9);
    this.hpFill = bar(P, h, this.isEnemy ? (this.isBoss ? COLORS.hpBoss : COLORS.hpEnemy) : COLORS.hpAlly);
    this.shieldBar = bar(P, h, COLORS.shield, 0.95);
    this.spBg = bar(P, h, COLORS.hpBack, 0.85);
    this.spFill = bar(P, h, COLORS.sp);
    this.spGlow = new P.Sprite(fxAtlas().tex.glow);
    this.spGlow.anchor.set(0.5);
    this.spGlow.tint = COLORS.spReady;
    this.spGlow.blendMode = P.BLEND_MODES.ADD;
    h.addChild(this.spGlow);
    // nothing shows until the first HUD update decides (a culled or prep view never draws bars)
    for (const b of [this.hpBg, this.hpGhost, this.hpFill, this.shieldBar, this.spBg, this.spFill, this.spGlow]) b.visible = false;
    this.chip = null;
    // operators only: summon tokens have no tier (hand and field alike)
    if (!this.isEnemy && !this.isToken && this.info.kind !== 'device') {
      this.chip = new P.Sprite(tierChip(this.tier, this.golden));
      this.chip.anchor.set(0.5);
      h.addChild(this.chip);
    }
    this.icons = [];
    for (let i = 0; i < 4; i++) {
      const s = new P.Sprite(P.Texture.EMPTY);
      s.anchor.set(0.5);
      s.visible = false;
      h.addChild(s);
      this.icons.push(s);
    }
    this.blockIcon = new P.Sprite(statusTexture('blocked'));
    this.blockIcon.anchor.set(0.5);
    this.blockIcon.visible = false;
    this.ctx.layers.groundFx.addChild(this.blockIcon);
    this.countText = null;
    this.itemPips = [];
  }

  /** Show a stack count (token stacks in the hand) — BitmapText-free: a tiny canvas-less chip via Text. */
  setCount(n) {
    const P = this.P;
    if (!(n > 1)) { if (this.countText) this.countText.visible = false; return; }
    if (!this.countText) {
      this.countText = new P.Text('', { fontFamily: 'Bender, Oxanium, sans-serif', fontSize: 22, fontWeight: '700', fill: '#ffffff', stroke: '#0b0f0e', strokeThickness: 5 });
      this.countText.anchor.set(0.5);
      this.hud.addChild(this.countText);
    }
    this.countText.text = `×${n}`;
    this.countText.visible = true;
  }

  /** Equipped item pips (prep): list of item icon URLs. */
  setItems(urls) {
    const P = this.P;
    const list = Array.isArray(urls) ? urls.slice(0, 2) : [];
    while (this.itemPips.length > list.length) this.itemPips.pop().destroy();
    list.forEach((u, i) => {
      let s = this.itemPips[i];
      if (!s) { s = new P.Sprite(P.Texture.EMPTY); s.anchor.set(0.5); this.hud.addChild(s); this.itemPips[i] = s; }
      if (s._url === u) return;
      s._url = u;
      const a = this.ctx.assets;
      s.texture = itemTexture(u || 'none', null, 0x4ed8af);
      if (u && a?.image) a.image(u).then((img) => { if (!s.destroyed && s._url === u) s.texture = itemTexture(u, img, 0x4ed8af); }, () => {});
    });
  }

  // ---- state input ---------------------------------------------------------------------------------------

  _baseFromAnim() {
    if (this.anim === ANIM.STUN || (this.flags & (UF.STUNNED | UF.FROZEN | UF.SLEEP))) return 'stun';
    if (this.anim === ANIM.MOVE) return 'move';
    return 'idle';
  }

  /** Apply an interpolated sample (render/interp.js). */
  sync(s) {
    if (!s) return;
    this.x = s.x; this.y = s.y;
    this.flying = !!(s.flags & UF.FLYING) || this.info.motion === 'FLY';
    // ground enemies only ever walk low tiles (a rounding step onto a block edge must not pop them up)
    const gz = this.isEnemy && !this.flying ? 0 : groundZ(this.ctx, s.x, s.y);
    if (this.zTarget == null) this.z = gz;
    this.zTarget = gz;
    if (s.maxHp > 0) this.maxHp = s.maxHp;
    const hp = clamp(s.hp, 0, this.maxHp);
    if (hp < this.hp - 0.5 && this.isBoss) this.shake = 0.25;
    this.hp = hp;
    this.sp = s.sp; this.spMax = s.spMax;
    const prevFlags = this.flags;
    this.flags = s.flags | 0;
    this.anim = s.anim | 0;
    if (this.isEnemy && Math.abs(s.vx) > 0.08) this.visFacing = s.vx < 0 ? -1 : 1;
    if ((prevFlags ^ this.flags) & UF.SKILL) this.setSkill(!!(this.flags & UF.SKILL));
    if (this.anim === ANIM.DIE && this.alive) this.die();
    if (this.actor && this.alive) this.actor.setBase(this._baseFromAnim());
  }

  setWorld(x, y, z = 0) { this.x = x; this.y = y; this.z = z; }

  setFacing(f) {
    if (this.isEnemy) { this.facing = f === -1 ? -1 : 1; return; }
    // the legacy ±1 only speaks about left / right: an UP / DOWN operator keeps its direction
    if (f === -1) this.setDir('LEFT');
    else if (this.dir === 'LEFT') this.setDir('RIGHT');
  }

  /** Whether this unit should show its Back model (facing UP and a Back model exists). */
  _wantsBack() {
    const a = this.ctx.assets;
    const id = this.info.spine || this.info.defId;
    return !this.isEnemy && this.dir === 'UP' && !!id && !!a && typeof a.hasBack === 'function' && !!a.hasBack(id);
  }

  /**
   * Re-orient an operator / summon (UP|RIGHT|DOWN|LEFT, any case; the direction wheel's live preview and the stored
   * m.private `dir`). Mirrors for LEFT, swaps to the Back model for UP (and back) when the model differs.
   */
  setDir(dir) {
    if (this.isEnemy || this.destroyed) return;
    const d = unitDir({ dir, facing: this.facing });
    if (typeof dir !== 'string' || d === this.dir) return;
    this.dir = d;
    this.info.dir = d;
    this.hasDir = true;
    this.facing = d === 'LEFT' ? -1 : 1;
    this.visFacing = this.facing;
    if (this.imp) this.imp.dirty = true;
    if (this.entry && this._wantsBack() !== !!this.entryBack) this._loadSpine();
  }

  _releaseEntry(entry) {
    try { this.ctx.assets?.spine?.release(entry); } catch { /* ignore */ }
  }

  /** Destroy the current Spine actor (and its impostor) and release its asset entry (model swap / destroy). */
  _dropActor() {
    if (this.imp) {
      try { if (this.imp.slot) this.ctx.impostors?.free(this.imp.slot); this.imp.sprite.destroy(); if (this.imp.rt) this.imp.rt.destroy(true); } catch { /* ignore */ }
      this.imp = null;
    }
    this._box = null;
    const old = this.actor;
    this.actor = null;
    this.spineReady = false;
    if (old) { try { old.destroy(); } catch { /* ignore */ } }
    if (this._actorEntry) this._releaseEntry(this._actorEntry);
    this._actorEntry = null;
  }

  /** An attack was made (b.ev 'atk'). `target` = view or null. */
  onAttack(target, now) {
    if (!this.alive) return;
    if (this.lastAtk >= 0) {
      const d = now - this.lastAtk;
      if (d > 0.05 && d < 6) this.atkInterval = this.atkInterval * 0.6 + d * 0.4;
    }
    this.lastAtk = now;
    if (target && !this.isEnemy && this.info.kind !== 'device') {
      // operators keep their deploy direction (research 09 §1.2); enemies may turn towards their target
    } else if (target && this.isEnemy) {
      const dx = target.x - this.x;
      if (Math.abs(dx) > 0.1) this.visFacing = dx < 0 ? -1 : 1;
    }
    if (target) {
      const dx = target.x - this.x, dy = target.y - this.y, len = Math.hypot(dx, dy) || 1;
      this.lungeDir.x = dx / len; this.lungeDir.y = dy / len;
    }
    this.lunge = 1;
    if (this.actor) this.actor.attack(this.atkInterval); // game seconds: the actor's clock runs in game time
    if (this.imp) this.imp.dirty = true;
  }

  /**
   * An attack by this unit is `lead` game seconds ahead in the snapshot buffer: start the Spine attack wind-up now
   * so the strike frame lines up with the attack. True once started (then stop calling for that attack).
   */
  windUp(lead) {
    if (!this.alive || !this.actor || !this.spineReady) return false;
    const ok = this.actor.windUp(this.atkInterval, lead);
    if (ok && this.imp) this.imp.dirty = true;
    return ok;
  }

  onHit() { this.flash = 1; }

  setSkill(on) {
    if (on) this.statuses.add('skill'); else this.statuses.delete('skill');
    if (this.actor) this.actor.setSkill(on);
  }

  onDeploy() {
    this.fadeIn = 0;
    if (!this.alive) this.revive();
    if (this.actor) this.actor.deploy();
  }

  onStatus(key, on) {
    if (typeof key !== 'string') return;
    if (on) this.statuses.add(key); else this.statuses.delete(key);
  }

  die() {
    if (!this.alive) return;
    this.alive = false;
    const d = this.actor ? this.actor.die() : 0;
    const rate = this.ctx.animRate?.() || 1;
    this.dieT = 0;
    this.dying = clamp(d / rate, 0.35, 1.6) + 0.55;
    this.dieDur = this.dying;
  }

  revive() {
    this.alive = true;
    this.dying = 0; this.remove = false; this.alpha = 1;
    this.hp = this.maxHp; this.ghostHp = this.hp;
    if (this.actor) this.actor.revive();
  }

  // ---- per frame -------------------------------------------------------------------------------------------

  /** @param {number} dt real seconds @param {any} cam camera @param {number} t real clock */
  update(dt, cam, t) {
    if (this.destroyed) return;
    const P = this.P;
    if (this.zTarget != null && this.z !== this.zTarget) {
      const d = this.zTarget - this.z;
      this.z = Math.abs(d) < 1e-3 ? this.zTarget : this.z + d * Math.min(1, dt * 12);
    }
    const hoverTo = this.flying && this.alive ? FLY_HOVER : 0;
    if (this.hover !== hoverTo) this.hover = Math.abs(hoverTo - this.hover) < 1e-3 ? hoverTo : this.hover + (hoverTo - this.hover) * Math.min(1, dt * 6);
    const p = cam.project(this.x, this.y, this.z + this.hover + this.lift, this.screen);
    const s = p.s;
    // fades
    if (this.fadeIn < 1) this.fadeIn = Math.min(1, this.fadeIn + dt * 4);
    let alpha = this.fadeIn;
    if (this.dying > 0) {
      this.dieT += dt;
      this.dying -= dt;
      const tail = 0.55;
      if (this.dying < tail) alpha *= Math.max(0, this.dying / tail);
      if (this.dying <= 0) { this.dying = 0; this.remove = true; alpha = 0; }
    }
    if (this.flags & UF.STEALTH) alpha *= 0.45;
    if (this.dimmed) alpha *= 0.35;
    this.alpha = alpha;

    // body placement
    const lungeK = this.lunge > 0 ? Math.sin(this.lunge * Math.PI) * 0.12 : 0;
    this.lunge = Math.max(0, this.lunge - dt * 5);
    const lx = this.lungeDir.x * lungeK, ly = this.lungeDir.y * lungeK;
    let bx = p.x, by = p.y;
    if (lungeK) { const q = cam.project(this.x + lx, this.y + ly, this.z + this.hover + this.lift, LG_P); bx = q.x; by = q.y; }
    this.root.position.set(bx, by);
    this.root.alpha = alpha;
    this.root.zIndex = unitDepthKey(cam, this.x, this.y, this.lift);
    // off-screen: nothing to animate or draw (bounds / hit-testing still follow `screen`)
    if (this._cull(bx, by, s, dt)) return;
    const flip = this.isEnemy ? (ENEMY_MODEL_FACES_LEFT ? -this.visFacing : this.visFacing) : this.visFacing;

    // shadow (on a raised top it is drawn with that block row, else in the shadow layer under everything)
    placeOnGround(this.ctx, this.shadow, this.ctx.layers.shadow, this.y, this.z);
    const sh = cam.project(this.x, this.y, this.z, SH_P);
    this.shadow.position.set(sh.x, sh.y);
    const shw = s * (this.isBoss ? 1.6 : 0.95) / this.shadow.texture.width;
    this.shadow.scale.set(shw, shw * (this.shadow.texture === shadowTexture() ? 1 : 1.05));
    this.shadow.alpha = 0.5 * alpha * (this.lift > 0 ? 0.6 : 1);

    // model / fallback
    const spineShown = this.actor && this.spineReady;
    if (spineShown) {
      if (this.swapT < 1) this.swapT = Math.min(1, this.swapT + dt * 5);
      this.fallback.alpha = 1 - this.swapT;
      this.fallback.visible = this.swapT < 1;
      const sc = s * UNIT.modelScale;
      const flashK = this.flash > 0 ? this.flash : 0;
      let tint = 0xffffff;
      if (this.flags & UF.FROZEN) tint = 0x9fd4ff;
      else if (this.flags & UF.COLD) tint = 0xcfe6ff;
      if (flashK > 0) tint = mixTint(tint, 0xff8a80, flashK * 0.8);
      let animDt = dt * (this.ctx.animRate?.() || 1);
      if (this._offDt > 0) { animDt += Math.min(0.5, this._offDt); this._offDt = 0; }
      let interval = this.ctx.impostorInterval ? this.ctx.impostorInterval() : 0;
      if (this.lodIdle) interval = Math.max(interval, 3);
      const lvl = this.ctx.loadLevel ? this.ctx.loadLevel() : 0;
      if (lvl > 0) {
        this._far = this._far ? s < 60 : s < 52;
        if (lvl >= 2 || this._far) interval = Math.max(interval, 2);
      }
      if (this.actor.clipped) {
        const clip = this.ctx.clipAllowed ? this.ctx.clipAllowed() : true;
        this.actor.setClipping(clip);
        if (clip && this.ctx.impostors) interval = Math.max(1, interval);
      }
      if (interval > 0 && this.ctx.renderer) {
        this._updateImpostor(sc, flip, tint, animDt, interval);
      } else {
        if (this.imp) this._leaveImpostor();
        this.actor.spine.alpha = this.swapT;
        this.actor.spine.scale.set(sc * flip, sc);
        this.actor.update(animDt);
        if (this._tint !== tint) { this._tint = tint; this.actor.spine.tint = tint; }
      }
    }
    // the diamond is only needed while no model shows (a cross-fade keeps whatever diamond was already up)
    if (!spineShown) this._ensurePicture();
    if (!spineShown || this.swapT < 1) {
      const size = s * UNIT.diamond * (this.isBoss ? 1.5 : 1);
      const bob = this.alive ? Math.sin(t * 2.4 + this.bob) * s * 0.03 : 0;
      this.fallback.scale.set(size / 160);
      this.fallback.position.set(0, -s * 0.08 + bob);
      this.fallback.tint = this.flash > 0 ? mixTint(0xffffff, 0xff8a80, this.flash) : (this.flags & UF.FROZEN ? 0x9fd4ff : 0xffffff);
      if (!this.alive) this.fallback.alpha = Math.max(0, this.fallback.alpha);
    }
    this.flash = Math.max(0, this.flash - dt * 6);

    // facing chevron on the ground, like the original's orange › (research 09 §1.2: prep and combat): own prep pieces
    // on the board (app.js sets _showFacing; bench pieces have none); battle / scouting allies whose dir is known
    const wedge = this._showFacing !== undefined ? this._showFacing && this.prep : this.hasDir && this.info.kind !== 'device';
    if (wedge && this.alive) {
      if (!this.facingArrow) {
        this.facingArrow = new P.Sprite(fxAtlas().tex.chevron);
        this.facingArrow.anchor.set(0.5);
        this.facingArrow.tint = 0xff9c33;
        this.ctx.layers.groundFx.addChild(this.facingArrow);
      }
      placeOnGround(this.ctx, this.facingArrow, this.ctx.layers.groundFx, this.y, this.z);
      // on the ground ring, 0.36 tile out along the deploy direction; rotated to the projected direction and
      // foreshortened along it (the chevron texture points right: local x = the pointing axis)
      const [sx, sy] = DIR_STEP[this.dir] || DIR_STEP.RIGHT;
      const c0 = cam.project(this.x, this.y, this.z + 0.01, FA_C);
      const fa = cam.project(this.x + 0.36 * sx, this.y + 0.36 * sy, this.z + 0.01, FA_P);
      const vx = fa.x - c0.x, vy = fa.y - c0.y;
      const len = Math.hypot(vx, vy) || 1;
      this.facingArrow.visible = this.lift <= 0;
      this.facingArrow.position.set(fa.x, fa.y);
      this.facingArrow.rotation = Math.atan2(vy, vx);
      const fs = (s * 0.22) / 64;
      const along = clamp(len / (s * 0.36 || 1), 0.35, 1.2);
      this.facingArrow.scale.set(fs * along, fs * (sy ? 1 : 0.8));
      this.facingArrow.alpha = 0.9 * alpha;
    } else if (this.facingArrow) this.facingArrow.visible = false;

    // elite aura
    if (this.aura) {
      const k = 0.35 + 0.12 * Math.sin(t * 2.2 + this.bob);
      this.aura.alpha = k;
      this.aura.scale.set((s * 1.3) / 128, (s * 1.9) / 128);
    }

    // head height: operators/tokens are uniform chibis; enemies vary (setup-pose bounds, when known)
    let headTiles = UNIT.headroom;
    if (this.isEnemy && spineShown && this.actor.entry.bounds) headTiles = clamp(this.actor.height * UNIT.modelScale * 0.92, 0.55, this.isBoss ? 3.2 : 2.2);
    else if (this.isEnemy && this.isBoss) headTiles = 2.2;
    this._headTiles = headTiles;
    this.screen.top = by - headTiles * s;
    this._updateHud(dt, s, bx, by - headTiles * s, alpha, t);
  }

  /**
   * Viewport culling: true (and everything hidden) while the unit's body lies outside the viewport with a margin.
   * Dying units are never culled (their fade must finish and remove the view).
   */
  _cull(bx, by, s, dt) {
    const vp = this.ctx.viewport ? this.ctx.viewport() : null;
    let off = false;
    if (vp && !(this.dying > 0) && !this.lift) {
      const m = s * 1.3;
      off = bx < -m || bx > vp.width + m || by < -m * 0.5 || by - s * 3.6 > vp.height;
    }
    if (off !== this.culled) {
      this.culled = off;
      this.root.visible = !off;
      this.hud.visible = !off;
      this.shadow.visible = !off;
      if (off) { if (this.facingArrow) this.facingArrow.visible = false; this.blockIcon.visible = false; }
    }
    if (off) this._offDt += dt * (this.ctx.animRate?.() || 1);
    return off;
  }

  _updateHud(dt, s, x, y, alpha, t) {
    const prep = this.prep;
    const showBars = !prep && this.alive && this.info.kind !== 'item';
    const damaged = this.hp < this.maxHp - 0.5;
    const showHp = showBars && (!this.isEnemy || damaged || this.isBoss);
    const bw = clamp(s * (this.isBoss ? UNIT.bossBarWidth : UNIT.barWidth), 24, this.isBoss ? 260 : 96);
    const bh = clamp(s * (this.isBoss ? 0.12 : 0.075), 3, this.isBoss ? 12 : 7);
    this.hud.alpha = this.dying > 0 ? 0 : alpha;
    let sx = this.shake > 0 ? Math.sin(t * 90) * this.shake * 10 : 0;
    this.shake = Math.max(0, this.shake - dt);
    const x0 = x - bw / 2 + sx;
    let cy = y - 4;
    // HP
    this.hpBg.visible = this.hpFill.visible = this.hpGhost.visible = showHp;
    if (showHp) {
      const k = this.maxHp > 0 ? clamp(this.hp / this.maxHp, 0, 1) : 0;
      if (this.ghostHp < this.hp) this.ghostHp = this.hp;
      else this.ghostHp = Math.max(this.hp, this.ghostHp - this.maxHp * dt * 0.9);
      const g = this.maxHp > 0 ? clamp(this.ghostHp / this.maxHp, 0, 1) : 0;
      this.hpBg.position.set(x0 - 1, cy); this.hpBg.width = bw + 2; this.hpBg.height = bh + 2;
      this.hpGhost.position.set(x0, cy); this.hpGhost.width = bw * g; this.hpGhost.height = bh;
      this.hpFill.position.set(x0, cy); this.hpFill.width = bw * k; this.hpFill.height = bh;
      if (!this.isEnemy) this.hpFill.tint = k < 0.3 ? COLORS.hpAllyLow : COLORS.hpAlly;
    }
    const shielded = showHp && (this.flags & UF.SHIELD);
    this.shieldBar.visible = !!shielded;
    if (shielded) { this.shieldBar.position.set(x0, cy - bh / 2 - 1); this.shieldBar.width = bw; this.shieldBar.height = Math.max(1.5, bh * 0.35); }
    // SP
    const showSp = showBars && !this.isEnemy && this.spMax > 0;
    this.spBg.visible = this.spFill.visible = showSp;
    const spH = Math.max(2, bh * 0.6);
    let ready = false;
    if (showSp) {
      const active = !!(this.flags & UF.SKILL);
      const k = clamp(this.sp / this.spMax, 0, 1);
      ready = !active && k >= 0.999;
      const sy = cy + bh / 2 + spH / 2 + 1.5;
      this.spBg.position.set(x0 - 1, sy); this.spBg.width = bw + 2; this.spBg.height = spH + 2;
      this.spFill.position.set(x0, sy); this.spFill.width = bw * k; this.spFill.height = spH;
      this.spFill.tint = active ? COLORS.spActive : ready ? COLORS.spReady : COLORS.sp;
      this._spY = sy;
    }
    this.spGlow.visible = ready;
    if (ready) {
      const pulse = 0.55 + 0.35 * Math.sin(t * 6);
      this.spGlow.position.set(x0 + bw, this._spY);
      this.spGlow.scale.set((spH * 5) / 128);
      this.spGlow.alpha = pulse;
    }
    // tier chip (left of the bars in battle; above the head in prep)
    if (this.chip) {
      const cs = clamp(s * (prep ? 0.24 : 0.19), 11, 28) / 44;
      this.chip.scale.set(cs);
      this.chip.visible = this.alive;
      if (prep) this.chip.position.set(x, y - this.chip.height / 2 + 2);
      else this.chip.position.set(x0 - this.chip.width / 2 - 1, cy + (showSp ? spH / 2 : 0));
    }
    // status icons row above the bars
    const icons = this._iconKeys();
    const isz = clamp(s * 0.26, 12, 26);
    const iy = cy - bh / 2 - isz / 2 - 3;
    for (let i = 0; i < this.icons.length; i++) {
      const ic = this.icons[i];
      const key = icons[i];
      if (!key || !this.alive || prep) { ic.visible = false; continue; }
      const tex = statusTexture(key);
      if (!tex) { ic.visible = false; continue; }
      ic.texture = tex;
      ic.visible = true;
      ic.width = ic.height = isz;
      ic.position.set(x - ((icons.length - 1) * (isz + 2)) / 2 + i * (isz + 2), iy);
    }
    // blocked marker at the feet (enemies held by a blocker)
    const blocked = !prep && this.alive && this.isEnemy && (this.flags & UF.BLOCKED);
    this.blockIcon.visible = !!blocked;
    if (blocked) {
      const f = this.screen;
      this.blockIcon.position.set(f.x + (this.visFacing < 0 ? -1 : 1) * s * 0.34, SH_P.y - s * 0.04);
      this.blockIcon.scale.set(clamp(s * 0.22, 9, 22) / 32 * (this.visFacing < 0 ? -1 : 1), clamp(s * 0.22, 9, 22) / 32);
      this.blockIcon.alpha = 0.85 * alpha;
    }
    // count badge & item pips (prep)
    if (this.countText && this.countText.visible) {
      this.countText.scale.set(clamp(s / 90, 0.5, 1.2));
      this.countText.position.set(x + s * 0.32, this.screen.y - s * 0.12);
    }
    for (let i = 0; i < this.itemPips.length; i++) {
      const pip = this.itemPips[i];
      const ps = clamp(s * 0.26, 12, 30);
      pip.width = pip.height = ps;
      pip.position.set(this.screen.x - s * 0.36 + i * (ps + 1), this.screen.y - s * 0.05);
      pip.visible = this.alive;
    }
  }

  // ---- impostor mode (crowded fields, clipped skeletons): the skeleton is rendered into a slot of the shared
  // impostor atlas (render/impostor.js) every `interval` frames (staggered per unit; every frame for clipped
  // skeletons, whose stencil masks must stay out of the main pass) and shown as one sprite. Without a free atlas
  // slot the unit keeps a private RenderTexture (same visuals, one extra framebuffer switch).

  _impBox() {
    if (this._box) return this._box;
    let b = null;
    try { b = this.actor.spine.getLocalBounds(); } catch { b = null; }
    let x0 = -220, y0 = -420, x1 = 220, y1 = 40;
    if (b && Number.isFinite(b.width) && b.width > 10 && b.height > 10) {
      const padX = Math.max(60, b.width * 0.3), padY = Math.max(50, b.height * 0.22);
      x0 = Math.min(b.x - padX, -140); x1 = Math.max(b.x + b.width + padX, 140);
      y0 = Math.min(b.y - padY, -260); y1 = Math.max(b.y + b.height + padY * 0.4, 30);
    }
    this._box = { x0, y0, w: x1 - x0, h: y1 - y0 };
    return this._box;
  }

  _updateImpostor(sc, flip, tint, animDt, interval) {
    const P = this.P;
    const atlas = this.ctx.impostors || null;
    if (!this.imp) {
      const sprite = new P.Sprite(P.Texture.EMPTY);
      if (this.actor.spine.parent) this.actor.spine.parent.removeChild(this.actor.spine);
      if (atlas) atlas.park(this.actor.spine);
      this.body.addChild(sprite);
      this.imp = { sprite, slot: null, rt: null, sc: 0, acc: 0, phase: (Math.random() * 64) | 0, dirty: true };
    }
    const imp = this.imp;
    imp.acc += animDt;
    const frame = this.ctx.frameNo ? this.ctx.frameNo() : 0;
    const due = imp.dirty || interval <= 1 || (frame + imp.phase) % interval === 0 || Math.abs(sc - imp.sc) > imp.sc * 0.12;
    if (due) {
      this.actor.update(imp.acc);
      imp.acc = 0;
      imp.dirty = false;
      this._renderImpostor(sc, atlas);
    }
    const k = imp.sc > 0 ? sc / imp.sc : 1;
    imp.sprite.scale.set(k * flip, k);
    imp.sprite.alpha = this.swapT;
    imp.sprite.tint = tint;
  }

  _renderImpostor(sc, atlas) {
    const P = this.P, R = this.ctx.renderer, imp = this.imp;
    const box = this._impBox();
    const w = Math.max(8, Math.ceil(box.w * sc)), h = Math.max(8, Math.ceil(box.h * sc));
    const sp = this.actor.spine;
    sp.alpha = 1;
    if (this._tint !== 0xffffff) { this._tint = 0xffffff; sp.tint = 0xffffff; }
    const ox = -box.x0 * sc, oy = -box.y0 * sc;
    if (atlas) {
      let slot = imp.slot;
      const clip = !!(this.actor.clipped && this.actor.clipOn);
      if (!slot || w > slot.w || h > slot.h || w < slot.w * 0.6 || h < slot.h * 0.6 || slot.clip !== clip) {
        if (slot) atlas.free(slot);
        slot = imp.slot = atlas.alloc(w, h, { clip });
        if (slot && imp.rt) { imp.rt.destroy(true); imp.rt = null; }
      }
      if (slot) {
        atlas.draw(slot, sp, { a: sc, d: sc, tx: ox, ty: oy });
        if (imp.sprite.texture !== slot.tex) imp.sprite.texture = slot.tex;
        imp.sprite.anchor.set(ox / slot.w, oy / slot.h);
        imp.sc = sc;
        return;
      }
    }
    // private render target (no atlas / atlas full)
    let rt = imp.rt;
    if (!rt || w > rt.width || h > rt.height || w < rt.width * 0.6 || h < rt.height * 0.6) {
      if (rt) rt.destroy(true);
      rt = imp.rt = P.RenderTexture.create({ width: Math.ceil(w / 8) * 8, height: Math.ceil(h / 8) * 8, resolution: R.resolution });
      imp.sprite.texture = rt;
    }
    const parent = sp.parent;
    sp.position.set(0, 0);
    sp.scale.set(1, 1);
    sp.visible = true;
    const m = this._m || (this._m = new P.Matrix());
    m.set(sc, 0, 0, sc, ox, oy);
    try { R.render(sp, { renderTexture: rt, clear: true, transform: m }); } catch { /* lost context etc. */ }
    if (parent === atlas?.parked) sp.visible = false;
    imp.sprite.anchor.set(ox / rt.width, oy / rt.height);
    imp.sc = sc;
  }

  _leaveImpostor() {
    const imp = this.imp;
    this.imp = null;
    if (!imp) return;
    const atlas = this.ctx.impostors || null;
    if (imp.slot && atlas) atlas.free(imp.slot);
    imp.sprite.destroy();
    if (imp.rt) imp.rt.destroy(true);
    if (this.actor && this.actor.spine) {
      if (atlas) atlas.unpark(this.actor.spine);
      this.actor.spine.visible = true;
      this.actor.spine.position.set(0, 0);
      this.body.addChild(this.actor.spine);
    }
  }

  _iconKeys() {
    const out = ICON_TMP;
    out.length = 0;
    const f = this.flags;
    const push = (k) => { if (k && !out.includes(k) && out.length < 4) out.push(k); };
    if (f & UF.FROZEN) push('freeze');
    else if (f & UF.STUNNED) push('stun');
    if (f & UF.SLEEP) push('sleep');
    if (f & UF.COLD && !(f & UF.FROZEN)) push('cold');
    if (f & UF.INVULN) push('invuln');
    if (f & UF.STEALTH) push('stealth');
    for (const k of this.statuses) {
      if (out.length >= 4) break;
      if (k === 'skill') continue;
      const icon = statusIconKey(k);
      // flag-driven states are authoritative (a stale 'stun' status must not outlive the flag)
      if (!icon || icon === 'stun' || icon === 'freeze' || icon === 'sleep' || icon === 'stealth' || icon === 'invuln') continue;
      if (icon === 'cold' && (f & UF.FROZEN)) continue;
      push(icon);
    }
    return out;
  }

  /** Canvas-space bounds (CSS px) of the body. */
  bounds() {
    const s = this.screen.s || 1;
    const h = (this._headTiles || UNIT.headroom) * s;
    const w = s * 0.7;
    return { x: this.screen.x - w / 2, y: this.screen.y - h, width: w, height: h + s * 0.1 };
  }

  hitTest(x, y) {
    if (!this.alive || this.alpha < 0.05) return false;
    const b = this.bounds();
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  }

  setHover(on) { this.hovered = !!on; }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._dropActor();
    this.shadow.destroy();
    this.blockIcon.destroy();
    if (this.facingArrow) this.facingArrow.destroy();
    this.hud.destroy({ children: true });
    this.root.destroy({ children: true });
  }
}

const SH_P = { x: 0, y: 0, s: 0, depth: 0 };
const FA_P = { x: 0, y: 0, s: 0, depth: 0 };
const FA_C = { x: 0, y: 0, s: 0, depth: 0 };
const LG_P = { x: 0, y: 0, s: 0, depth: 0 };
const ICON_TMP = [];

/**
 * Unit-layer zIndex of a unit / piece whose feet are at (x, y): farther rows first (so raised block rows, keyed by
 * tiles.rowDepthKey, hide units behind them); lifted (dragged) pieces on top; ties broken by column.
 */
export function unitDepthKey(cam, x, y, lift = 0) {
  // +40 (< one row of depth at the official 30° pitch, 100·sin 30° = 50): a lifted piece never ties with the unit one
  // row in front of it (a tie flickers with the column tie-break)
  return -cam.depthOf(x, y, 0) * 100 + (lift > 0 ? 40 : 0) + x * 0.001;
}

function mixTint(a, b, k) {
  const t = clamp(k, 0, 1);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((ar + (br - ar) * t) << 16) | ((ag + (bg - ag) * t) << 8) | ((ab + (bb - ab) * t) | 0);
}

/** Attack interval from data (bat × 100 / aspd), game seconds. */
function defaultInterval(ctx, info) {
  try {
    const rec = ctx.lookupDef ? ctx.lookupDef(info) : null;
    const st = rec?.stats;
    if (st && st.bat > 0) return clamp((st.bat * 100) / (st.aspd > 0 ? st.aspd : 100), 0.2, 6);
  } catch { /* ignore */ }
  return 1.2;
}

// =============================================================================================================

/** Hand item: icon plate floating above its slot. */
export class ItemView {
  constructor(ctx, info) {
    const P = ctx.P;
    this.ctx = ctx; this.P = P;
    this.info = { ...info };
    this.id = info.id; this.uid = info.uid ?? null;
    this.x = info.x || 0; this.y = info.y || 0; this.z = 0;
    this.alive = true; this.remove = false; this.lift = 0; this.dimmed = false;
    this.bob = Math.random() * 6;
    this.screen = { x: 0, y: 0, s: 1, top: 0 };
    this.shadow = new P.Sprite(ctx.shadowTex || shadowTexture());
    this.shadow.anchor.set(0.5);
    ctx.layers.shadow.addChild(this.shadow);
    this.root = new P.Container();
    ctx.layers.units.addChild(this.root);
    this.plate = new P.Sprite(itemTexture(String(info.defId || 'item'), null, info.color || 0x9aa5a0));
    this.plate.anchor.set(0.5, 1);
    this.root.addChild(this.plate);
    const url = info.icon;
    if (url && ctx.assets?.image) ctx.assets.image(url).then((img) => { if (!this.destroyed && img) this.plate.texture = itemTexture(String(info.defId), img, info.color || 0x9aa5a0); }, () => {});
    this.hud = null;
  }
  setWorld(x, y, z = 0) { this.x = x; this.y = y; this.z = z; }
  update(dt, cam, t) {
    const p = cam.project(this.x, this.y, this.z + this.lift + 0.12 + Math.sin(t * 2 + this.bob) * 0.03, this.screen);
    this.root.position.set(p.x, p.y);
    this.root.zIndex = unitDepthKey(cam, this.x, this.y, this.lift);
    const size = p.s * 0.62;
    this.plate.scale.set(size / 128);
    this.root.alpha = this.dimmed ? 0.35 : 1;
    placeOnGround(this.ctx, this.shadow, this.ctx.layers.shadow, this.y, this.z);
    const sh = cam.project(this.x, this.y, this.z, SH_P);
    this.shadow.position.set(sh.x, sh.y);
    this.shadow.scale.set((p.s * 0.55) / this.shadow.texture.width);
    this.shadow.alpha = 0.35;
    this.screen.top = p.y - size;
  }
  bounds() { const s = this.screen.s; const w = s * 0.62; return { x: this.screen.x - w / 2, y: this.screen.y - w, width: w, height: w }; }
  hitTest(x, y) { const b = this.bounds(); return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; }
  setHover() {}
  destroy() { if (this.destroyed) return; this.destroyed = true; this.shadow.destroy(); this.root.destroy({ children: true }); }
}

// =============================================================================================================

/**
 * Battle device unit (kind 'device': crates, “双眼皮” turrets, unknown stage devices): a textured 3D box (the tile
 * atlas, render/tiles.js BoxMesh — the real crate / device plates when the board art is installed), a turret head
 * that turns to its target and flashes on attack, HP bar once damaged, and a break-apart on death.
 */
const GENERIC_DEVICE = Object.freeze({ size: 0.7, height: 0.36, top: 'platformTop', side: 'forbidSide' });
export class DeviceView {
  constructor(ctx, info) {
    const P = ctx.P;
    this.ctx = ctx; this.P = P;
    this.info = { ...info };
    this.id = info.id; this.uid = null;
    this.isEnemy = false;
    this.spec = deviceBoxOf(info.defId) || GENERIC_DEVICE;
    this.turret = this.spec === DEVICE_BOX.turret;
    this.x = Number(info.x) || 0; this.y = Number(info.y) || 0; this.z = 0;
    this.hp = Number(info.maxHp) || 100; this.maxHp = this.hp;
    this.alive = true; this.remove = false; this.dying = 0; this.flags = 0;
    this.facing = info.facing === -1 ? -1 : 1;
    this.aim = this.facing > 0 ? 0 : Math.PI; this.aimTo = this.aim; this.fire = 0;
    this.screen = { x: 0, y: 0, s: 1, top: 0 };
    this._headTiles = this.spec.height + 0.2;
    this.box = ctx.createBox ? ctx.createBox() : null;
    this.gfx = new P.Graphics();       // fallback body (no tile field) and the turret head
    ctx.layers.units.addChild(this.gfx);
    this.hud = new P.Container();
    ctx.layers.bars.addChild(this.hud);
    this.hpBg = bar(P, this.hud, COLORS.hpBack, 0.85);
    this.hpFill = bar(P, this.hud, this.turret ? COLORS.hpAlly : 0xe0b877);
    this.camVersion = -1;
  }
  sync(s) {
    if (!s) return;
    this.x = s.x; this.y = s.y; this.z = groundZ(this.ctx, s.x, s.y);
    if (s.maxHp > 0) this.maxHp = s.maxHp;
    this.hp = clamp(s.hp, 0, this.maxHp); this.flags = s.flags | 0;
  }
  setWorld(x, y, z = 0) { this.x = x; this.y = y; this.z = z; }
  onAttack(target) {
    if (!this.alive) return;
    if (target) this.aimTo = Math.atan2(target.y - this.y, target.x - this.x);
    this.fire = 1;
  }
  windUp() { return false; }
  onHit() { this.shake = 0.2; }
  onDeploy() {}
  onStatus() {}
  setSkill() {}
  setFacing() {}
  die() { if (!this.alive) return; this.alive = false; this.dying = 0.45; this.ctx.fx?.crateBreak?.(this.x, this.y, this.z, this.turret ? 0x6c777d : null); }
  revive() { this.alive = true; this.dying = 0; this.remove = false; }
  update(dt, cam, t) {
    const shake = this.shake > 0 ? Math.sin(t * 80) * this.shake * 0.05 : 0;
    this.shake = Math.max(0, (this.shake || 0) - dt);
    const k = this.dying > 0 ? Math.max(0, this.dying / 0.45) : 1;
    if (this.dying > 0) { this.dying -= dt; if (this.dying <= 0) this.remove = true; }
    const zKey = rowDepthKey(cam, Math.round(this.y)) + ROW_KEY.devices;
    const size = this.spec.size * (0.6 + 0.4 * k), height = this.spec.height * k;
    const g = this.gfx;
    if (this.box) {
      this.box.update(cam, { x: this.x + shake, y: this.y, z: this.z, size, height, top: this.spec.top, side: this.spec.side, alpha: k });
      if (this.box.mesh) {
        if (!this.box.mesh.parent) this.ctx.layers.units.addChild(this.box.mesh);
        this.box.mesh.zIndex = zKey;
      }
    }
    const redraw = !this.box || this.turret || cam.version !== this.camVersion || shake || this.dying > 0 || this._lastShake;
    if (redraw) {
      this.camVersion = cam.version;
      this._lastShake = !!shake;
      g.clear();
      if (!this.box) drawCrate(g, cam, this.x + shake, this.y, this.z, size, height, 1);
      if (this.turret && height > 0.05) this._drawHead(g, cam, dt, height, k);
    }
    g.zIndex = zKey + 0.001;
    g.alpha = k;
    const p = cam.project(this.x, this.y, this.z + this.spec.height + 0.35, this.screen);
    const show = this.alive && this.hp < this.maxHp - 0.5;
    this.hud.visible = show;
    if (show) {
      const bw = clamp(p.s * 0.7, 24, 90), bh = clamp(p.s * 0.06, 3, 6);
      this.hpBg.position.set(p.x - bw / 2 - 1, p.y); this.hpBg.width = bw + 2; this.hpBg.height = bh + 2;
      this.hpFill.position.set(p.x - bw / 2, p.y); this.hpFill.width = bw * clamp(this.hp / this.maxHp, 0, 1); this.hpFill.height = bh;
    }
    this.screen.top = p.y;
  }
  /** Turret head: a squat dome with a barrel aimed at the last target; muzzle flash on attack. */
  _drawHead(g, cam, dt, height, k) {
    let d = this.aimTo - this.aim;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.aim += d * Math.min(1, dt * 10);
    this.fire = Math.max(0, this.fire - dt * 5);
    const z = this.z + height;
    const c = cam.project(this.x, this.y, z + 0.08);
    const s = c.s;
    const ex = Math.cos(this.aim), ey = Math.sin(this.aim);
    const recoil = this.fire * 0.06;
    const tip = cam.project(this.x + ex * (0.42 - recoil), this.y + ey * (0.42 - recoil), z + 0.12);
    g.lineStyle(0);
    g.beginFill(0x1c2124, 0.95 * k); g.drawEllipse(c.x, c.y, s * 0.2, s * 0.13); g.endFill();
    g.lineStyle(Math.max(2, s * 0.07), 0x39444a, k);
    g.moveTo(c.x, c.y - s * 0.05); g.lineTo(tip.x, tip.y - s * 0.03);
    g.lineStyle(Math.max(1, s * 0.03), 0x9aa7ad, k);
    g.moveTo(c.x, c.y - s * 0.06); g.lineTo(tip.x, tip.y - s * 0.04);
    g.lineStyle(0);
    g.beginFill(0x4b565c, k); g.drawEllipse(c.x, c.y - s * 0.07, s * 0.14, s * 0.09); g.endFill();
    g.beginFill(this.fire > 0 ? 0xffd27a : 0xff5a4a, (0.6 + 0.4 * this.fire) * k); g.drawCircle(c.x, c.y - s * 0.09, s * 0.035); g.endFill();
    if (this.fire > 0.2) { g.beginFill(0xfff0c0, this.fire * 0.8 * k); g.drawCircle(tip.x, tip.y - s * 0.03, s * 0.08 * this.fire); g.endFill(); }
  }
  bounds() { const s = this.screen.s; return { x: this.screen.x - s * 0.45, y: this.screen.y, width: s * 0.9, height: s }; }
  hitTest(x, y) { const b = this.bounds(); return this.alive && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; }
  setHover() {}
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.box) this.box.destroy();
    this.gfx.destroy();
    this.hud.destroy({ children: true });
  }
}
