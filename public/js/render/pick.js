// render/pick.js — which unit the pointer is on (user playtest #4 item 1: "地上都画好了一个一个方格，点击对应方格就选中那个
// 方格的人物就行" — the ground is drawn as tiles: a press on a tile selects the unit on that tile). Pure logic (no PIXI, no
// DOM): render/app.js hands in the units and the ground under the pointer (render/projection.js pickTile, raised tops
// first, in the tiles the views are drawn on). The one rule behind every picking path — prep press / click / right-click
// and long-press detail / drag start / hover (app.js pieceAt), battle clicks and hover (battleUnitAt), the enemy preview
// pen (penUnitAt); a dragged piece (an item too) drops on the tile under the pointer (render/drag.js):
//   * prep pieces (board tiles, bench row 7, temp row 8), battle allies and the figures of the enemy pen stand on
//     tiles: the unit on the tile under the pointer. An empty tile selects nothing — a press on a unit's head where it is
//     drawn over the tile behind it is a press on that tile. Several on one tile (the pen's clusters of up to 3, a piece
//     held for a moment on an occupied tile) → the one nearest to the pointer's point on the tile, ties → the front-most.
//   * battle enemies walk between tiles: the one within ENEMY_REACH tile of the pointer — its ground position from the
//     pointer's point on the ground, or its drawn body (on screen: the upright line from its feet to its head, in its px
//     per tile), whichever is nearer, so a press on a tall enemy's / a boss's body picks it too; a flying enemy (drawn in
//     the air, over whatever tile it crosses) by its drawn body alone.
//   * an ally's tile and an enemy both qualify → the nearer one (distance in tiles to the pointer's point), ties → the
//     ally, then the front-most.
// (Replaces the drawn-body shapes and the 1-px render probe of v2.2, DESIGN §17.2: the player aims at the grid.)

/** Battle enemies are picked within this many tiles of the pointer's ground point or of their drawn body on screen. */
export const ENEMY_REACH = 0.6;

const EPS = 1e-9;
const isTile = (t) => !!t && Number.isInteger(t.row) && Number.isInteger(t.col);
const onTile = (u, t) => isTile(u.tile) && isTile(t) && u.tile.row === t.row && u.tile.col === t.col;
const depthOf = (u) => (u && Number.isFinite(u.depth) ? u.depth : 0);
/** Tiles between a unit's ground position and the pointer's point on the ground (0 when either is unknown). */
function groundDist(u, g) {
  if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(u.x) || !Number.isFinite(u.y)) return 0;
  return Math.hypot(u.x - g.x, u.y - g.y);
}
/** Tiles (its px per tile) between screen point (px, py) and an enemy's drawn body — the line from its feet up to its head. */
function bodyDist(b, px, py) {
  if (!b || !(b.s > 0) || ![b.x, b.top, b.feet, px, py].every(Number.isFinite)) return Infinity;
  const y = Math.max(Math.min(b.top, b.feet), Math.min(Math.max(b.top, b.feet), py));
  return Math.hypot(px - b.x, py - y) / b.s;
}

/**
 * @typedef {{ row: number, col: number, x?: number, y?: number }} PickGround the tile under the pointer and the pointer's
 *   point on its top (world tiles: x = col, y = row), or null off the grid
 * @typedef {{ tile?: { row: number, col: number } | null, x?: number, y?: number, depth?: number, fly?: boolean,
 *   body?: { x: number, top: number, feet: number, s: number } | null }} PickUnit
 *   `tile`: the tile it stands on (null: it walks — a battle enemy); `x`, `y`: its ground position (world tiles);
 *   `body`: an enemy's drawn body on screen (px: x, head `top`, `feet`; `s` px per tile there); `fly`: in the air — its
 *   ground position does not count; `depth`: draw order (larger = in front)
 */

/**
 * The unit standing on the tile under the pointer (several → the nearest to the pointer's point, ties → the front-most).
 * @param {Array<PickUnit|null>} units
 * @param {PickGround|null} ground
 * @returns {PickUnit|null} one of `units`
 */
export function pickOnTile(units, ground) {
  if (!Array.isArray(units) || !isTile(ground)) return null;
  let best = null, bd = Infinity;
  for (const u of units) {
    if (!u || !onTile(u, ground)) continue;
    const d = groundDist(u, ground);
    if (d < bd - EPS || (Math.abs(d - bd) <= EPS && depthOf(u) > depthOf(best))) { best = u; bd = d; }
  }
  return best;
}

/**
 * Battle pick (see the header): allies on the tile under the pointer, enemies within ENEMY_REACH of it; the nearer wins.
 * @param {Array<PickUnit|null>} units allies with `tile`, enemies with `tile: null` and their drawn `body`
 * @param {PickGround|null} ground
 * @param {number} px pointer on screen (enemies' drawn bodies)
 * @param {number} py
 * @returns {PickUnit|null} one of `units`
 */
export function pickBattle(units, ground, px, py) {
  if (!Array.isArray(units)) return null;
  const onGround = !!ground && Number.isFinite(ground.x) && Number.isFinite(ground.y);
  let best = null, bd = Infinity;
  const better = (u, d) => {
    if (d < bd - EPS) return true;
    if (Math.abs(d - bd) > EPS) return false;
    if (!!u.tile !== !!best.tile) return !!u.tile; // a tie: the ally standing there
    return depthOf(u) > depthOf(best);
  };
  for (const u of units) {
    if (!u) continue;
    let d = Infinity;
    if (u.tile) { if (onTile(u, ground)) d = groundDist(u, ground); }
    else {
      d = bodyDist(u.body, px, py);
      if (!u.fly && onGround && Number.isFinite(u.x) && Number.isFinite(u.y)) d = Math.min(d, Math.hypot(u.x - ground.x, u.y - ground.y));
      if (!(d <= ENEMY_REACH)) continue;
    }
    if (d < Infinity && better(u, d)) { best = u; bd = d; }
  }
  return best;
}
