// Observing rules and labels of client-side combat (research 09 §3.1 / §6.3, DESIGN §14 "Spectating") — pure helpers
// for the game screen, the team panel and the combat HUD (mirror of server/match/Match.js _watchClient):
//   * prep (休整期): tap a teammate → 前往查看 → their board (read-only);
//   * own normal battle running: no observing ("当前无法查看");
//   * own battle over: "⌛ 作战结束，等待队友完成作战" + the teammates' progress; tap a teammate → 前往查看 → a local
//     replica of their battle; 返回战场 goes back;
//   * 联防 / 最终攻势: the ‹ › pill switches the camera LEFT half / 全景 / RIGHT half of the own field; the other pair's
//     boss field is never shown to a fighting player;
//   * eliminated: anything.

import { PHASE } from '../../../shared/constants.js';

const isObj = (v) => !!v && typeof v === 'object';
const COMBAT = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);

/** The server runs client-side combat (m.public.combatMode). */
export const isClientCombat = (pub) => !!pub && pub.combatMode === 'client';

const players = (pub) => (Array.isArray(pub?.players) ? pub.players.filter(isObj) : []);
const fields = (pub) => (Array.isArray(pub?.fields) ? pub.fields.filter(isObj) : []);

/** The field listing a player, or null. */
export function fieldOf(pub, playerId) {
  return fields(pub).find((f) => Array.isArray(f.players) && f.players.includes(playerId)) || null;
}

/** Display name of a player id ('队友' when unknown). */
export function nameOf(pub, playerId) {
  return players(pub).find((p) => p.playerId === playerId)?.name || '队友';
}

/**
 * What tapping a team row does: `{ back: true }` (own row while observing), `{ fieldId }` to observe, or `{ reason }`.
 * @param {any} p m.public player row
 * @param {any} pub
 * @param {string} myId
 * @param {{ observing?: boolean, ownDone?: boolean }} [o] ownDone: the local simulation of the own battle already ended
 *   (its result is on the way to the server)
 */
export function observeTarget(p, pub, myId, { observing = false, ownDone = false } = {}) {
  if (!isObj(p)) return { reason: '无效的目标' };
  if (p.playerId === myId) return observing ? { back: true } : { reason: null };
  if (p.alive === false || p.status === 'left') return { reason: '该队友已被淘汰，无法查看' };
  const phase = pub?.phase;
  const me = players(pub).find((x) => x.playerId === myId) || null;
  const meAlive = me ? me.alive !== false : true;
  if (!COMBAT.has(phase)) return { fieldId: `n:${p.playerId}` };
  const target = fieldOf(pub, p.playerId);
  if (!target) return { reason: '该队友当前没有战场' };
  const own = fieldOf(pub, myId);
  if (!meAlive || !own) return { fieldId: target.fieldId };
  if (own.fieldId === target.fieldId) return { reason: '队友与你在同一战场，使用 ‹ › 切换视角' };
  if (target.kind === 'boss' || target.kind === 'hidden') return { reason: '无法查看另一组队友的战场' };
  if (own.kind === 'normal' && own.live !== false && !ownDone) return { reason: '作战中无法查看队友，作战结束后可前往查看' };
  return { fieldId: target.fieldId };
}

/** Teammates' progress for the waiting pill: [{ playerId, name, killed, total, done, isBot }]. */
export function teammateProgress(pub, myId) {
  const out = [];
  for (const f of fields(pub)) {
    if (f.kind !== 'normal' || !Array.isArray(f.players)) continue;
    const pid = f.players[0];
    if (pid === myId) continue;
    const p = players(pub).find((x) => x.playerId === pid);
    const pr = isObj(f.progress) ? f.progress : null;
    out.push({
      playerId: pid, name: p?.name || '队友', isBot: !!p?.isBot,
      killed: Number.isFinite(pr?.killed) ? pr.killed : null, total: Number.isFinite(pr?.total) ? pr.total : null,
      done: f.live === false || !!pr?.done,
    });
  }
  return out;
}

/** Side of each player of a local field meta (`sides` from the runner, else seat order). */
export function sidesOf(field) {
  if (isObj(field?.sides)) return field.sides;
  const ps = Array.isArray(field?.players) ? field.players : [];
  return Object.fromEntries(ps.map((pid, i) => [pid, i === 1 ? 'R' : 'L']));
}

/**
 * The ‹ › camera layers of a 联防 / boss field: LEFT half, 全景, RIGHT half with captions "你自己" / "👁 name" /
 * "全景" / "无人在家". Empty for normal fields and single-player boss fields.
 */
export function cameraLayers(field, pub, myId) {
  if (!isObj(field) || (field.kind !== 'unite' && field.kind !== 'boss' && field.kind !== 'hidden')) return [];
  const sides = sidesOf(field);
  const at = (side) => Object.keys(sides).find((pid) => sides[pid] === side) || null;
  const label = (pid) => (!pid ? '无人在家' : pid === myId ? '你自己' : nameOf(pub, pid));
  const left = at('L');
  const right = at('R');
  if ((field.kind === 'boss' || field.kind === 'hidden') && (!left || !right)) return [];
  return [
    { key: 'L', label: label(left), self: left === myId, watch: !!left && left !== myId },
    { key: 'ALL', label: '全景', self: false, watch: false },
    { key: 'R', label: label(right), self: right === myId, watch: !!right && right !== myId },
  ];
}

/** Camera options of a layer for view.setCamera(kind, …). */
export function layerCamera(field, layer, mySide = 'L') {
  const rect = field?.rect;
  if (layer === 'L' || layer === 'R') return { rect, side: layer, half: true };
  return { rect, side: mySide };
}
