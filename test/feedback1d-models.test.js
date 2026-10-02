// test/feedback1d-models.test.js — community report D3 after 0.1.0 ("所有特殊源石虫的模型全表现为普通源石虫"): 灼热源石虫 /
// 炽焰源石虫 (enemy_1305_mhslim / _2, the ELEMENT faction's slugs — up to 10 a round) were drawn with the plain 源石虫
// skeleton because no community dump carries their models (Ark-Models lists them with an empty assetList) and the
// asset plan aliased them to enemy_1007_slime. Their official skeletons come from the local client now
// (tools/local-extract/extract.py ENEMY_SPINES → public/assets/local/spine/enemy/<id>/) and tools/fetch-assets.mjs
// plans such a model in place of the alias (tools/assets/spine.mjs findLocalEnemyModels, plan.mjs localEnemyModels).
// 高能 / 冰爆 / 简饲源石虫 and “庞贝” always had their own models (checked in headless Chrome).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../tools/assets/plan.mjs';
import { findLocalEnemyModels } from '../tools/assets/spine.mjs';
import { indexAudio } from '../tools/assets/audio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const SLUGS = ['enemy_1305_mhslim', 'enemy_1305_mhslim_2'];

/** The real research inputs; Ark-Models carries the plain slug only (its index lists the special ones empty). */
function plan(localEnemyModels) {
  const modelsData = { data: { '1007_slime': { assetList: { '.skel': 'enemy_1007_slime.skel', '.atlas': 'enemy_1007_slime.atlas', '.png': 'enemy_1007_slime.png' } },
    '1305_mhslim': { assetList: {} }, '1305_mhslim_2': { assetList: {} } } };
  return buildPlan({
    assets07: readJson('docs/research/07-assets.json'), ops03: readJson('docs/research/03-operators.json'),
    enemies05: readJson('docs/research/05-enemies.json'), maps05: readJson('docs/research/05-maps.json'),
    audio: indexAudio({}), modelsData, extraEnemyIds: SLUGS, localEnemyModels,
  });
}

describe('D3: special Originium slugs get their own official models', () => {
  test('a local-client model is planned instead of the alias to the plain 源石虫', () => {
    const before = plan(undefined);
    for (const id of SLUGS) assert.equal(before.template.enemies[id].spineAliasOf, 'enemy_1007_slime', `${id}: no local model → the alias stays`);
    const local = {};
    for (const id of SLUGS) local[id] = { dir: `local/spine/enemy/${id}/`, skel: `local/spine/enemy/${id}/${id}.skel`, atlas: `local/spine/enemy/${id}/${id}.atlas`, pngs: [`local/spine/enemy/${id}/${id}.png`] };
    const p = plan(local);
    for (const id of SLUGS) {
      const e = p.template.enemies[id];
      assert.equal(e.spineAliasOf, undefined, `${id} is not drawn with another enemy's model`);
      assert.deepEqual(e.spine, { model: `enemy:${id}` });
      const m = p.models.get(`enemy:${id}`);
      assert.equal(m.skel.rel, `local/spine/enemy/${id}/${id}.skel`);
      assert.equal(m.atlas.rel, `local/spine/enemy/${id}/${id}.atlas`);
      assert.deepEqual(m.pngs.map((x) => x.rel), [`local/spine/enemy/${id}/${id}.png`]);
      assert.equal(m.pma, true, 'premultiplied like the Ark-Models enemies (atlas gets pma: true)');
      assert.deepEqual(m.skel.urls, [], 'on disk only: nothing to download');
    }
    assert.ok(!p.notes.some((n) => /enemy_1305_mhslim.*aliased/.test(n)), 'no alias note');
    // an upstream model still wins over a local copy
    const up = plan({ enemy_1007_slime: { dir: 'local/spine/enemy/enemy_1007_slime/', skel: 'local/spine/enemy/enemy_1007_slime/x.skel', atlas: 'local/spine/enemy/enemy_1007_slime/x.atlas', pngs: ['local/spine/enemy/enemy_1007_slime/x.png'] } });
    assert.equal(up.models.get('enemy:enemy_1007_slime').skel.rel, 'spine/enemy/enemy_1007_slime/enemy_1007_slime.skel');
  });

  test('findLocalEnemyModels: skeleton + same-stem atlas + page PNGs under local/spine/enemy/<id>/', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-local-'));
    try {
      const put = (rel, body = 'x') => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), body); };
      put('local/spine/enemy/enemy_1305_mhslim/enemy_1305_mhslim.skel');
      put('local/spine/enemy/enemy_1305_mhslim/enemy_1305_mhslim.atlas');
      put('local/spine/enemy/enemy_1305_mhslim/enemy_1305_mhslim.png');
      put('local/spine/enemy/enemy_1305_mhslim/enemy_1305_mhslim_2.png');
      put('local/spine/enemy/enemy_x_noatlas/enemy_x_noatlas.skel');
      put('local/spine/enemy/enemy_x_nopng/enemy_x_nopng.skel');
      put('local/spine/enemy/enemy_x_nopng/enemy_x_nopng.atlas');
      put('local/spine/enemy/not-an-enemy/a.skel');
      const found = await findLocalEnemyModels(dir);
      assert.deepEqual(Object.keys(found), ['enemy_1305_mhslim']);
      assert.deepEqual(found.enemy_1305_mhslim, {
        dir: 'local/spine/enemy/enemy_1305_mhslim/', skel: 'local/spine/enemy/enemy_1305_mhslim/enemy_1305_mhslim.skel',
        atlas: 'local/spine/enemy/enemy_1305_mhslim/enemy_1305_mhslim.atlas',
        pngs: ['local/spine/enemy/enemy_1305_mhslim/enemy_1305_mhslim.png', 'local/spine/enemy/enemy_1305_mhslim/enemy_1305_mhslim_2.png'],
      });
      assert.deepEqual(await findLocalEnemyModels(path.join(dir, 'missing')), {});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the generated manifest never aliases an enemy whose own local model is on disk', { skip: !existsSync(path.join(ROOT, 'public/assets')) && 'public/assets not downloaded' }, () => {
    const m = readJson('data/assets.json');
    for (const [id, e] of Object.entries(m.enemies)) {
      if (!e.spineAliasOf) continue;
      assert.ok(!existsSync(path.join(ROOT, 'public/assets/local/spine/enemy', id)), `${id}: aliased to ${e.spineAliasOf} although its own model was extracted — re-run npm run assets`);
    }
    for (const id of SLUGS) {
      if (!existsSync(path.join(ROOT, 'public/assets/local/spine/enemy', id))) continue;
      const sp = m.enemies[id].spine;
      assert.ok(sp && sp.skel.endsWith(`/${id}/${id}.skel`), `${id} drawn with its own skeleton (${sp && sp.skel})`);
      assert.equal(sp.pma, true);
      for (const u of [sp.skel, sp.atlas, ...sp.textures]) assert.ok(existsSync(path.join(ROOT, 'public', u)), u);
      assert.ok(sp.anims.idle && sp.anims.move && sp.anims.attack && sp.anims.die, `${id}: roles resolved`);
    }
  });
});

const PY = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0);
describe('D3: tools/local-extract/extract.py enemy Spine job (no UnityPy needed)', { skip: !PY && 'no python3' }, () => {
  const TOOL = path.join(ROOT, 'tools/local-extract');
  const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  test('--print-jobs lists the enemy models; container matching and --only selection', () => {
    const r = spawnSync(PY, [path.join(TOOL, 'extract.py'), '--print-jobs'], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).enemySpines, { bundles: 'refs/arts/enm_art_*.ab', sub: 'spine/enemy', ids: SLUGS });
    const src = `import sys, json\nsys.path.insert(0, ${JSON.stringify(TOOL)})\nimport extract as e\nW = set(e.ENEMY_SPINES)\n`
      + `print(json.dumps([e.enemy_spine_id('Assets/Torappu/Arts/Enemies/Spines/enemy_1305_mhslim/2/enemy_1305_mhslim_2_SkeletonData.asset', W),`
      + ` e.enemy_spine_id('Assets/Torappu/Arts/Enemies/Spines/enemy_1305_mhslim/1/enemy_1305_mhslim_SkeletonData.asset', W),`
      + ` e.enemy_spine_id('Assets/Torappu/Arts/Enemies/Spines/enemy_1007_slime/enemy_1007_slime_SkeletonData.asset', W),`
      + ` e.enemy_spine_id('Assets/Torappu/Arts/Enemies/Spines/enemy_1305_mhslim/1/enemy_1305_mhslim_Material.mat', W),`
      + ` [e.wants_sub(o, 'spine/enemy') for o in ([], ['spine'], ['spine/enemy'], ['spine/enemy/enemy_1305_mhslim'], ['spine/token_x'], ['map'])]]))`;
    const o = spawnSync(PY, ['-c', src], { encoding: 'utf8', env: ENV });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(JSON.parse(o.stdout), ['enemy_1305_mhslim_2', 'enemy_1305_mhslim', null, null, [true, true, true, true, false, false]]);
  });
});
