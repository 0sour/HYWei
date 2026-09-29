// render/pick.js — which unit the pointer is on (user playtest #3 item 7: "clicking a unit on the map often selects
// the one a row below it; dropping equipment too"). Pure screen-space geometry (no PIXI, no DOM), the ONE rule behind
// every picking path: prep press / drag start / right-click detail and equipment dropped on an operator
// (render/app.js pieceAt / pieceUnder, and ui/gameLogic.js pickPieceAt over view.pieceScreenRect shapes), battle
// clicks and hover (battleUnitAt) and the enemy preview pen (penUnitAt).
//
// Why "the front-most rectangle under the pointer" failed: a chibi is an upright billboard ~1.27 tiles tall (median
// of the 138 official operators' Front / Back skeletons in their idle pose, p10–p90 1.17–1.41) standing on its tile,
// while the rows of the official 30° cameras are only ~0.84 (prep) – 0.91 (battle) of a tile apart on screen. The unit
// in front covers the legs / feet of the unit behind it and its head sits over that unit's tile; its 0.7-tile-wide
// rectangle also covered the ground and the legs showing beside its head (a head is only ~0.5 tile wide), and a
// pressed tile was only looked at when no rectangle at all was hit — so a press on the lower part of a unit, on its
// feet or on its tile went to the unit in front of it: the one a row lower on screen.
//
// Body of a unit (all px on one screen; `x`, `y` = its feet, `s` = px per tile at the feet, `h` = model height in
// tiles, `w` = width factor (1 for operators; enemies scale with their size), `flip` = +1 facing right / −1 left). The
// measured opaque profile of the idle chibis is ~±0.3 tile wide through the body (the back side a little wider: hair,
// capes) and ~±0.2 at the crown; a taller model is taller hair / ears / hats — its face stays ~0.86 tile up:
//   outline  head ellipse (centre h − 0.33·w above the feet, radii 0.27·w × 0.33·w) ∪ body box (0.08 below the feet …
//            the shoulders at min(0.62·h, 0.78·w); −0.34·w … +0.28·w facing right) ∪ the unit's HUD (tier chip /
//            bars) — what is drawn
//   core     face (ellipse 0.21·w × 0.15·w centred min(0.86·w, h − 0.36·w) above the feet) ∪ torso / legs (±0.2·w, from
//            0.1 above the feet to the shoulders) — what a player aims at
//   'diamond' (the avatar diamond shown until the Spine model is there): the rhombus of side `d` tiles above the feet
//   'plate'   (hand items): a square of half-size `r` tiles centred on (x, y)
// Rule (pickBody):
//   1. the pointer is on units' cores → the front-most of them (drawn on top: the face of the unit in front is its own;
//      the torso of the unit behind is its own above that face)
//   2. else a unit stands on the tile under the pointer → that unit (its feet, its tile — also where the hair or a
//      weapon of the unit in front hangs over it)
//   3. else the pointer is on outlines only (hair, hands, feet, weapon edges) → the unit whose core is nearest (px / its
//      own scale); ties → the front-most
// The feet of a unit hidden behind the face of the unit in front are not pickable (nothing of them shows there); its
// tile beside that face and everything of it above that face are.
//
// Pixel probe (optional `probe(body)` → true / false / null, render/app.js drawnAt): the shapes above are a model of
// the drawn chibi, and where the bodies of two units overlap the model cannot tell whose arm, hair or weapon is drawn
// on top. Measured on the mock match against the rendered pixels (1920×1080, every opaque unit pixel sampled, the
// front-most drawn unit = the truth): the rule alone put 7 % of the prep presses (18 % in battle) on the wrong unit —
// mostly the unit BEHIND: the hair crown and the sides (arms, clothes, weapons) of the unit in front lie over the legs /
// tile of the one behind — against 2 % / 11 % for the old front-most rectangle; with the probe 0.7 % / 1.7 % (the rest:
// anti-aliased edges). So wherever the probe can change the answer (two or more bodies within their outline +
// PROBE_MARGIN of the pointer, or one the rule did not pick), the front-most body whose model really draws the pixel
// under the pointer wins — what the player sees. Only when none of them draws there (a gap, the bare tile) or the probe
// cannot tell (null) does the rule above decide.

/** Median model height of the official chibis (tiles above the feet), when the model's own is not known. */
export const BODY_H = 1.27;
/** Shape constants in tiles (see the header). */
export const BODY = Object.freeze({
  headRx: 0.27, headRy: 0.33, faceRx: 0.21, faceRy: 0.15, face: 0.86, faceTop: 0.36, back: 0.34, front: 0.28,
  below: 0.08, shoulder: 0.62, neck: 0.78, torso: 0.2, torsoFrom: 0.1, lean: 0.03,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const inRect = (r, px, py) => !!r && px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1;
const inEllipse = (e, px, py) => ((px - e.cx) / e.rx) ** 2 + ((py - e.cy) / e.ry) ** 2 <= 1;
const rectDist = (r, px, py) => Math.hypot(Math.max(r.x0 - px, 0, px - r.x1), Math.max(r.y0 - py, 0, py - r.y1));
function ellipseDist(e, px, py) {
  const k = Math.hypot((px - e.cx) / e.rx, (py - e.cy) / e.ry);
  return k > 1 ? (k - 1) * Math.min(e.rx, e.ry) : 0;
}
/** Rhombus |dx|/a + |dy|/a ≤ k around (cx, cy). */
const inRhombus = (d, px, py, k = 1) => Math.abs(px - d.cx) / d.a + Math.abs(py - d.cy) / d.a <= k;

/**
 * @typedef {{ x: number, y: number, s: number, h?: number, w?: number, flip?: number, kind?: 'chibi'|'diamond'|'plate',
 *   d?: number, r?: number, depth?: number, hud?: { x0: number, y0: number, x1: number, y1: number } | null,
 *   tile?: { row: number, col: number } | null }} PickBody
 *   `depth`: draw order (larger = nearer the camera, drawn on top); `tile`: the tile it stands on (null: moving units)
 */

/**
 * Screen geometry of a body: `{ outline: [parts], core: [parts] }`, parts `{ rect }` / `{ ellipse }` / `{ rhombus }`.
 * @param {PickBody} b
 */
export function bodyParts(b) {
  const s = b.s, x = b.x, y = b.y;
  const hud = b.hud && [b.hud.x0, b.hud.y0, b.hud.x1, b.hud.y1].every(Number.isFinite) ? { rect: b.hud } : null;
  if (b.kind === 'plate') {
    const a = (Number(b.r) > 0 ? b.r : 0.31) * s;
    return { outline: [{ rect: { x0: x - a, x1: x + a, y0: y - a, y1: y + a } }], core: [{ rect: { x0: x - a * 0.7, x1: x + a * 0.7, y0: y - a * 0.7, y1: y + a * 0.7 } }] };
  }
  if (b.kind === 'diamond') {
    const half = ((Number(b.d) > 0 ? b.d : 0.78) / 2) * s;
    const rh = { cx: x, cy: y - BODY.below * s - half, a: half };
    return { outline: [{ rhombus: rh, k: 1 }, ...(hud ? [hud] : [])], core: [{ rhombus: rh, k: 0.7 }] };
  }
  const w = Number(b.w) > 0 ? b.w : 1;
  const h = clamp(Number(b.h) > 0 ? b.h : BODY_H, 0.3, 4);
  const flip = b.flip === -1 ? -1 : 1;
  const cx = x - BODY.lean * flip * w * s;
  const head = { cx, cy: y - (h - BODY.headRy * w) * s, rx: BODY.headRx * w * s, ry: BODY.headRy * w * s };
  const face = { cx, cy: y - Math.min(BODY.face * w, h - BODY.faceTop * w) * s, rx: BODY.faceRx * w * s, ry: BODY.faceRy * w * s };
  const top = y - Math.min(BODY.shoulder * h, BODY.neck * w) * s;
  const box = { x0: x - (flip > 0 ? BODY.back : BODY.front) * w * s, x1: x + (flip > 0 ? BODY.front : BODY.back) * w * s, y0: top, y1: y + BODY.below * s };
  const torso = { x0: cx - BODY.torso * w * s, x1: cx + BODY.torso * w * s, y0: top, y1: y - BODY.torsoFrom * Math.min(1, h) * s };
  // the HUD (tier chip / bars) is drawn above every unit, but over the unit behind: an outline, never a core
  return { outline: [{ ellipse: head }, { rect: box }, ...(hud ? [hud] : [])], core: [{ ellipse: face }, { rect: torso }] };
}

const partHit = (p, px, py) => (p.rect ? inRect(p.rect, px, py) : p.ellipse ? inEllipse(p.ellipse, px, py) : inRhombus(p.rhombus, px, py, p.k));
function partDist(p, px, py) {
  if (p.rect) return rectDist(p.rect, px, py);
  if (p.ellipse) return ellipseDist(p.ellipse, px, py);
  const r = p.rhombus, k = (Math.abs(px - r.cx) + Math.abs(py - r.cy)) / r.a;
  return k > p.k ? (k - p.k) * r.a * Math.SQRT1_2 : 0;
}

/** 2 = on the body's core, 1 = on its outline only, 0 = off it. */
export function hitBody(b, px, py) {
  if (!b || !(b.s > 0) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return 0;
  // cheap reject (battle hover tests every unit on every pointer move): far outside the body and its HUD
  if (b.kind !== 'plate' && !(b.hud && inRect(b.hud, px, py))) {
    const w = Number(b.w) > 0 ? b.w : 1, reach = Math.max(BODY.back * w, (Number(b.d) || 0) / 2) * b.s + 1;
    const top = b.y - (b.kind === 'diamond' ? (Number(b.d) || 0.78) + BODY.below : clamp(Number(b.h) > 0 ? b.h : BODY_H, 0.3, 4)) * b.s - 1;
    if (Math.abs(px - b.x) > reach || py < top || py > b.y + BODY.below * b.s + 1) return 0;
  }
  const parts = bodyParts(b);
  if (parts.core.some((p) => partHit(p, px, py))) return 2;
  return parts.outline.some((p) => partHit(p, px, py)) ? 1 : 0;
}

/** Distance (px) from a point to the body's core, divided by the body's scale (0 on the core). */
export function coreDistance(b, px, py) {
  const parts = bodyParts(b);
  let d = Infinity;
  for (const p of parts.core) d = Math.min(d, partDist(p, px, py));
  return d / b.s;
}

/** The screen bounding box of a body's outline (px): `{ x, y, width, height }`. */
export function bodyBounds(b) {
  const parts = bodyParts(b);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of [...parts.outline, ...parts.core]) {
    if (p.rect) { x0 = Math.min(x0, p.rect.x0); x1 = Math.max(x1, p.rect.x1); y0 = Math.min(y0, p.rect.y0); y1 = Math.max(y1, p.rect.y1); }
    else if (p.ellipse) { const e = p.ellipse; x0 = Math.min(x0, e.cx - e.rx); x1 = Math.max(x1, e.cx + e.rx); y0 = Math.min(y0, e.cy - e.ry); y1 = Math.max(y1, e.cy + e.ry); }
    else { const r = p.rhombus, a = r.a * p.k; x0 = Math.min(x0, r.cx - a); x1 = Math.max(x1, r.cx + a); y0 = Math.min(y0, r.cy - a); y1 = Math.max(y1, r.cy + a); }
  }
  if (!Number.isFinite(x0)) return { x: b.x, y: b.y, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const depthOf = (b) => (Number.isFinite(b.depth) ? b.depth : 0);

/** Margin (tiles) around a body's outline in which the pixel probe still looks (weapons, capes, hair, big enemies past
 * the modelled outline; 0.25 left 4 % of the battle presses wrong, 0.5 1.7 %). */
export const PROBE_MARGIN = 0.5;
/** At most this many overlapping bodies are probed (front-most first). */
const PROBE_MAX = 6;

/** Bodies whose outline (+ PROBE_MARGIN) contains the point, front-most first. */
export function probeCandidates(bodies, px, py) {
  const out = [];
  for (const b of bodies) {
    if (!b || !(b.s > 0) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    const r = bodyBounds({ ...b, hud: null }), m = PROBE_MARGIN * b.s;
    if (px >= r.x - m && px <= r.x + r.width + m && py >= r.y - m && py <= r.y + r.height + m) out.push(b);
  }
  return out.sort((a, b) => depthOf(b) - depthOf(a));
}

/**
 * Pixel probe step of pickBody: the front-most body around the point whose model draws the pixel under it. Asked only
 * when it can change the answer: two or more bodies there, or one that the shape rule did not pick (`rule`: e.g. its
 * arm over the tile of a unit standing behind it). null when none of them draws there or the probe cannot tell for one
 * in front of the first that does (then the shape rule decides).
 */
function probeBodies(bodies, px, py, probe, rule) {
  const cand = probeCandidates(bodies, px, py);
  if (!cand.length || (cand.length === 1 && cand[0] === rule)) return null;
  for (const b of cand.slice(0, PROBE_MAX)) {
    let d = null;
    try { d = probe(b); } catch { d = null; }
    if (d === true) return b;
    if (d !== false) return null;
  }
  return null;
}
const onTile = (b, t) => !!t && !!b.tile && b.tile.row === t.row && b.tile.col === t.col;
function nearest(list, px, py) {
  let best = null, bd = Infinity;
  for (const b of list) {
    const d = coreDistance(b, px, py);
    if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best && depthOf(b) > depthOf(best))) { best = b; bd = d; }
  }
  return best;
}

/**
 * The body the pointer is on (see the header for the rule), or null.
 * @param {Array<PickBody|null>} bodies
 * @param {number} px
 * @param {number} py
 * @param {{ row: number, col: number } | null} [ground] the tile under the pointer (same space as the bodies' `tile`)
 * @param {((body: PickBody) => (boolean|null)) | null} [probe] does this body's model draw the pixel under the pointer
 *   (null: cannot tell)? See the header.
 * @returns {PickBody|null} one of `bodies`
 */
export function pickBody(bodies, px, py, ground = null, probe = null) {
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Array.isArray(bodies)) return null;
  const rule = ruleBody(bodies, px, py, ground);
  if (typeof probe === 'function') {
    const drawn = probeBodies(bodies, px, py, probe, rule);
    if (drawn) return drawn;
  }
  return rule;
}

/** The shape rule of pickBody (the header's steps 1–3). */
function ruleBody(bodies, px, py, ground) {
  let core = null;
  const rims = [];
  for (const b of bodies) {
    const hit = hitBody(b, px, py);
    if (hit === 2) { if (!core || depthOf(b) > depthOf(core)) core = b; }
    else if (hit === 1) rims.push(b);
  }
  if (core) return core;
  const standing = ground ? bodies.filter((b) => b && b.s > 0 && onTile(b, ground)) : [];
  if (standing.length) return nearest(standing, px, py);
  return rims.length ? nearest(rims, px, py) : null;
}
