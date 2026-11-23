import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('archived wardrobe encoding and four repaired hinges retain documented evidence', () => {
  // Reconstruct the uncompressed legacy NBT, not a zlib-version-dependent gzip stream.
  const script = String.raw`
import gzip, hashlib, io, json, pathlib, struct, sys, tempfile
sys.dont_write_bytecode = True
sys.path.insert(0, 'schematics/tooling')
import compile_blueprint as compiler

sha = lambda b: hashlib.sha256(b).hexdigest()
fixture = pathlib.Path('test/schematic/pack1/fixtures/wardrobe.pre-repair.json')
source = pathlib.Path('schematics/blueprints/pack1/01_wardrobe_nether_portal.json')
archive = pathlib.Path('schematic-archive/pack1_originals/01_wardrobe_nether_portal.schem')
variant = pathlib.Path('schematics/schems/pack1/01_wardrobe_nether_portal.mc1.21.4.schem')
inventory = json.loads(pathlib.Path('schematic-archive/pack1_originals/inventory.json').read_text())
legacy_bytes, canonical, current_bytes = fixture.read_bytes(), archive.read_bytes(), variant.read_bytes()
assert sha(legacy_bytes) == '8af8f528ecc8d1b784c6dc82cdc0eb60c601d4e7fa0707bfed696a1ecb0d23b0'
entry = next(x for x in inventory['files'] if x['name'] == archive.name)
assert (entry['sha256'], entry['bytes'], entry['data_version']) == ('8deb5fee1a8930b321ad9ff066b955854bb4caedf8f5a8cf17eb710c5da7a383', 535, 4189)
assert (sha(canonical), len(canonical)) == (entry['sha256'], entry['bytes'])
assert canonical[3] == 8 and struct.unpack('<I', canonical[4:8])[0] == 1794764481
assert canonical[10:canonical.index(b'\0', 10)] == b'wardrobe_nether_portal.schem'
assert sha(gzip.decompress(canonical)) == 'bb3ffe6c546bb32b5c535254db7980406f21d845ec67a75dac85e2c204dc8ade'
before, old_voxels = compiler.read_blueprint(fixture)
after, new_voxels = compiler.read_blueprint(source)
with tempfile.TemporaryDirectory(prefix='wardrobe-archive-') as directory:
    _, rebuilt = compiler.compile_blueprint(fixture, pathlib.Path(directory) / 'rebuilt.nonvalidated.schem', allow_unverified=True)
    _, repeated = compiler.compile_blueprint(fixture, pathlib.Path(directory) / 'repeated.nonvalidated.schem', allow_unverified=True)
    assert rebuilt == repeated and rebuilt != canonical
    original, modern, variant_root = [compiler.nbtlib.File.parse(io.BytesIO(gzip.decompress(b))) for b in (canonical, rebuilt, current_bytes)]
    order = ['Version', 'DataVersion', 'Width', 'Height', 'Length', 'Offset', 'Palette', 'PaletteMax', 'BlockData', 'BlockEntities', 'Entities']
    assert list(original) == order and list(modern) != order
    old_palette = {state: index for index, state in enumerate(dict.fromkeys(before['legend'].values()))}
    assert {state: int(index) for state, index in original['Palette'].items()} == old_palette
    assert {state: int(index) for state, index in modern['Palette'].items()} != old_palette
    def decode(root):
        palette = {int(index): state for state, index in root['Palette'].items()}
        ids = compiler.decode_varints(bytes(int(v) & 255 for v in root['BlockData']), len(old_voxels), len(palette))
        return [palette[i] for i in ids]
    assert decode(original) == decode(modern) == old_voxels
    assert decode(variant_root) == new_voxels
    modern['Palette'] = compiler.tag.Compound({state: compiler.tag.Int(index) for state, index in old_palette.items()})
    modern['BlockData'] = compiler.tag.ByteArray([old_palette[state] for state in old_voxels])
    reconstructed = compiler.nbtlib.File({key: modern[key] for key in order}, root_name=modern.root_name)
    raw = io.BytesIO(); reconstructed.write(raw)
    assert raw.getvalue() == gzip.decompress(canonical)
    changes = [(i % 6, i // 24, (i // 6) % 4, a, b) for i, (a,b) in enumerate(zip(old_voxels,new_voxels)) if a != b]
    assert len(old_voxels) == len(new_voxels) == 168
    assert [c[:3] for c in changes] == [(2,0,1),(3,0,1),(2,1,1),(3,1,1)]
    for _, _, _, old, new in changes:
        assert 'dark_oak_door' in old
        assert old.replace('hinge=left', 'hinge=TEMP').replace('hinge=right', 'hinge=left').replace('hinge=TEMP', 'hinge=right') == new
assert archive.read_bytes() == canonical and variant.read_bytes() == current_bytes
`;
  const child = spawnSync(process.env.HISTORY_TEST_PYTHON || 'python3', ['-B', '-c', script], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
