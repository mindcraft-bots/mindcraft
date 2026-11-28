import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import nbt from 'prismarine-nbt';
import { decodeVarints } from '../../../schematics/tooling/audit_pack_symmetry.mjs';
import { convertBlueprint } from '../../../schematics/tooling/convert_history.mjs';

const root = new URL('../../../', import.meta.url);
const read = name => readFileSync(new URL(name, root));
const json = name => JSON.parse(read(name));
const states = (data, legend = data.legend) => data.layers.flatMap(layer => layer.flatMap(row => [...row].map(c => legend[c])));

test('wardrobe historical blueprint repair and current versioned voxels', async () => {
  const fixture = read('test/schematic/pack1/fixtures/wardrobe.pre-repair.json');
  assert.equal(createHash('sha256').update(fixture).digest('hex'), '8af8f528ecc8d1b784c6dc82cdc0eb60c601d4e7fa0707bfed696a1ecb0d23b0');
  const before = JSON.parse(fixture), after = json('schematics/blueprints/pack1/01_wardrobe_nether_portal.json');
  for (const data of [before, after]) assert.deepEqual([data.width_x, data.height_y, data.length_z], [6,7,4]);
  const oldStates = states(before), newStates = states(after);
  assert.equal(oldStates.length, 168); assert.equal(newStates.length, 168);
  const changes = oldStates.flatMap((old, i) => old === newStates[i] ? [] : [{pos:[i%6,Math.floor(i/24),Math.floor(i/6)%4], old, current:newStates[i]}]);
  assert.deepEqual(changes.map(c => c.pos), [[2,0,1],[3,0,1],[2,1,1],[3,1,1]]);
  assert.deepEqual(changes.map(({old, current}) => [old.match(/hinge=(left|right)/)?.[1], current.match(/hinge=(left|right)/)?.[1]]),
    [['left','right'],['right','left'],['left','right'],['right','left']]);
  for (const {old, current} of changes) {
    assert.match(old, /^minecraft:dark_oak_door\[/);
    assert.equal(current, old.replace('hinge=left', 'hinge=TEMP').replace('hinge=right', 'hinge=left').replace('hinge=TEMP', 'hinge=right'));
  }
  const history = json('schematics/tooling/block_history.v1.json');
  for (const [version, dv] of [['1.21.4',4189],['26.1',4786]]) {
    const {parsed} = await nbt.parse(read(`schematics/schems/pack1/01_wardrobe_nether_portal.mc${version}.schem`));
    const tags = parsed.value;
    assert.equal(tags.DataVersion.value, dv);
    assert.deepEqual([tags.Width.value, tags.Height.value, tags.Length.value], [6,7,4]);
    const palette = [];
    for (const [state, id] of Object.entries(tags.Palette.value)) palette[id.value] = state;
    const actual = decodeVarints(tags.BlockData.value, 168, palette.length).map(id => palette[id]);
    assert.deepEqual(actual, states(after, convertBlueprint(after, version, history).legend));
  }
});
