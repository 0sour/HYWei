// The worked examples of docs/SIM.md, executed (keeps the documentation honest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../helpers/battleHarness.js';

const dummy = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e7, speed: 0, ...o });

test('SIM.md §10: 隐现 S2 fires 14 shots then ends', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy() } },
    units: [{ chessId: 'chess_char_1_01_a', row: 10, col: 4 }],
    enemies: [{ key: 'enemy_dummy', pos: [10, 6] }],
    hooks: ['ammoUsed', 'skillEnd'],
  });
  const u = h.unit('chess_char_1_01_a');
  assert.ok(h.runUntil(() => u.skill.activations === 1, 60));
  h.runUntil(() => !u.skill.active, 60);
  assert.equal(h.hooksOf('ammoUsed').length, 14);
  checkInvariants(h.b);
});

test('SIM.md example 1: ammo sniper kit with talent (+2 ammo after 20 s)', () => {
  const kit = (bb, chess, def) => ({
    skill: { kind: 'ammo', ammo: bb['attack@trigger_time'], mods: { atkPct: bb.atk, batPct: bb.base_attack_time, taunt: -1 }, targeting: { priority: 'ranged' } },
    talents: [{ install(battle, unit) {
      const t = def.talents[0].bb;
      battle.on('skillStart', ({ unit: u, skill }) => { if (u === unit && battle.time - unit.deployedAt >= t.duration) skill.ammoLeft += t.self_ammo; }, { owner: unit });
    } }],
  });
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy() } }, kits: { chess_char_1_01_a: kit },
    units: [{ chessId: 'chess_char_1_01_a', row: 10, col: 4 }], hooks: ['ammoUsed'],
  });
  const u = h.unit('chess_char_1_01_a');
  h.run(25);
  h.spawn('enemy_dummy', { pos: [10, 6] });
  h.runUntil(() => u.skill.activations === 1, 10);
  h.runUntil(() => !u.skill.active, 60);
  assert.equal(h.hooksOf('ammoUsed').length, 14 + 2);
  assert.equal(u.s.taunt, 0, 'taunt −1 removed after the skill');
});

test('SIM.md example 2: 幽灵鲨 undying during the skill, self-stun afterwards', () => {
  const kit = (bb) => ({
    skill: {
      kind: 'duration', mods: { atkPct: bb.atk },
      onStart({ battle, unit }) { unit.mem.undying = battle.on('fatal', (c) => { if (c.unit === unit) c.prevented = true; }, { owner: unit }); },
      onEnd({ battle, unit, reason }) { battle.off(unit.mem.undying); if (reason !== 'death') battle.applyStatus(unit, 'stun', { duration: bb.stun, source: unit }); },
    },
  });
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy() } }, kits: { chess_char_2_07_a: kit },
    units: [{ chessId: 'chess_char_2_07_a', row: 9, col: 5 }], enemies: [{ key: 'enemy_dummy', pos: [9, 6] }],
  });
  const u = h.unit('chess_char_2_07_a');
  h.runUntil(() => u.skill.active, 60);
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  assert.equal(u.alive, true);
  assert.ok(u.hp >= 1);
  h.runUntil(() => !u.skill.active, 20);
  h.step();
  assert.ok(u.s.flags.stun);
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  assert.equal(u.alive, false, 'undying ended with the skill');
});

test('SIM.md example 5: 赫默 summons a medical drone that expires after 10 s', () => {
  const kit = () => ({
    skill: {
      kind: 'instant', trigger: 'SP_FULL',
      onStart({ battle, unit }) {
        for (const k of unit.rangeKeys) {
          const r = Math.floor(k / 21), c = k % 21;
          if (!battle.unitAt(r, c) && battle.grid.canStand(r, c, { ranged: true })) { battle.spawnToken(unit, 'token_10000_silent_healrb', r, c, { duration: 10 }); break; }
        }
      },
    },
  });
  const h = makeBattle({ kits: { chess_char_2_02_a: kit }, units: [{ chessId: 'chess_char_2_02_a', row: 10, col: 4 }] });
  const u = h.unit('chess_char_2_02_a');
  h.runUntil(() => u.skill.activations === 1, 60);
  const drone = h.b.allyUnits.find((x) => x.kind === 'token');
  assert.ok(drone && drone.alive);
  assert.equal(drone.profile.dmgType, 'heal');
  h.run(10.1);
  assert.equal(drone.alive, false);
});

test('SIM.md example 6: 古米 TAKE_DAMAGE heal on the next attack', () => {
  const kit = (bb) => ({
    skill: {
      kind: 'instant',
      attack: { onHit({ battle, unit }) {
        const ally = battle.alliesInRadius(unit.x, unit.y, 1.5, unit.ownerId).sort((a, b) => a.hpRatio - b.hpRatio)[0];
        if (ally) battle.heal(unit, ally, unit.s.atk * bb.heal_scale);
      } },
    },
  });
  const h = makeBattle({
    defs: { chess: { t_ally: chessRec({ id: 't_ally', skill: null, stats: { maxHp: 10000, atk: 0 } }) }, enemies: { enemy_dummy: dummy({ atk: 50, bat: 1 }) } },
    kits: { chess_char_1_10_a: kit },
    units: [{ chessId: 'chess_char_1_10_a', row: 9, col: 5 }, { chessId: 't_ally', row: 10, col: 5 }],
    enemies: [{ key: 'enemy_dummy', pos: [9, 5], time: 8 }], autoFinish: false, // spawns on 古米's tile ⇒ blocked
  });
  const g = h.unit('chess_char_1_10_a');
  h.run(7);
  h.unit('t_ally').hp = 2000;
  assert.equal(g.skill.rule, 'TAKE_DAMAGE');
  assert.equal(g.skill.activations, 0, 'ready but not hit yet');
  h.run(4);
  assert.ok(g.skill.activations >= 1);
  assert.ok(h.unit('t_ally').hp > 2000, 'healed by the empowered attack');
});
