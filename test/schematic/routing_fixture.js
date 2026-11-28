import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { syntheticSponge } from './synthetic_sponge.js';
import { writeFixtureProvenance } from './provenance_fixture.js';

export function createRoutingFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'schematic-routing-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pack = path.join(root, 'schems/pack2');
  mkdirSync(pack, { recursive: true });
  writeFileSync(path.join(pack, 'index.json'), JSON.stringify({ schemaVersion: 2,
    groups: { 2: { 1: '09_garden.schem', 2: '17_tower.schem' } } }));
  const bytes = syntheticSponge('1.21.4', ['minecraft:stone', 'minecraft:chain[axis=y,waterlogged=false]']);
  for (const name of ['09_garden', '17_tower']) {
    const file = path.join(pack, `${name}.mc1.21.4.schem`);
    writeFileSync(file, bytes);
    writeFixtureProvenance(file, bytes, 'STRICT_VALIDATED');
  }
  return root;
}
