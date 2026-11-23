import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadRelease } from '../../schematics/tooling/history_registry.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.HISTORY_TEST_PYTHON || 'python3';
const prelude = String.raw`
import gzip, io, json, pathlib, sys
sys.dont_write_bytecode = True
sys.path.insert(0, 'schematics/tooling')
import nbtlib
from nbtlib import tag
import compile_blueprint as compiler

directory = pathlib.Path(sys.argv[1])
source = directory / 'source.json'

def decode(data):
    # Deliberately independent of the compiler's palette and VarInt helpers.
    root = nbtlib.File.parse(io.BytesIO(gzip.decompress(data)))
    assert root.root_name == 'Schematic'
    assert int(root['Version']) == 2
    assert list(root['Offset']) == [0, 0, 0]
    assert len(root['Entities']) == len(root['BlockEntities']) == 0
    dims = tuple(int(root[k]) for k in ('Width', 'Height', 'Length'))
    palette = {int(index): state for state, index in root['Palette'].items()}
    assert sorted(palette) == list(range(int(root['PaletteMax'])))
    numbers, value, shift = [], 0, 0
    for byte in (int(b) & 255 for b in root['BlockData']):
        value |= (byte & 127) << shift
        if byte & 128:
            shift += 7
            assert shift < 35
        else:
            numbers.append(value)
            value, shift = 0, 0
    assert shift == 0 and len(numbers) == dims[0] * dims[1] * dims[2]
    def parse_state(state):
        name, sep, props = state.partition('[')
        if not sep:
            return (name, ())
        assert props.endswith(']')
        return (name, tuple(sorted(tuple(p.split('=', 1)) for p in props[:-1].split(','))))
    voxels = { (i % dims[0], i // (dims[0] * dims[2]), (i // dims[0]) % dims[2]): parse_state(palette[n])
               for i, n in enumerate(numbers) }
    return (int(root['DataVersion']), dims, voxels)

def compile_to(name, **kwargs):
    path = directory / name
    _, packed = compiler.compile_blueprint(source, path, **kwargs)
    assert path.read_bytes() == packed
    return packed
`;

function run(script, fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'schematic-repro-'));
  try {
    writeFileSync(join(dir, 'source.json'), JSON.stringify(fixture));
    const child = spawnSync(python, ['-c', prelude + script, dir], { cwd: root, encoding: 'utf8' });
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixture(version, dataVersion) {
  const log = 'minecraft:oak_log[axis=x]';
  return {
    minecraft_version: version, data_version: dataVersion,
    width_x: 3, height_y: 2, length_z: 2,
    legend: { a: 'minecraft:air', s: 'minecraft:stone', l: log },
    layers: [['asl', 'sla'], ['las', 'sal']],
    expected_counts: { 'minecraft:air': 4, 'minecraft:stone': 4, [log]: 4 },
    spot_checks: [{ x: 2, y: 1, z: 1, char: 'l' }],
  };
}

test('synthetic blueprints compile deterministically and match an independent encoding semantically', () => {
  for (const [version, dataVersion] of [['1.13', 1519], ['1.21.4', 4189]]) {
    run(String.raw`
blueprint = json.loads(source.read_text())
first = compile_to('first.schem', target_version=blueprint['minecraft_version'])
second = compile_to('different-name.schem', target_version=blueprint['minecraft_version'])
assert first == second
# Gzip header must not contain a timestamp or original filename.
assert first[:4] == b'\x1f\x8b\x08\x00' and first[4:8] == b'\0\0\0\0'
air = ('minecraft:air', ())
stone = ('minecraft:stone', ())
log = ('minecraft:oak_log', (('axis', 'x'),))
expected = (blueprint['data_version'], (3, 2, 2), {
    (0,0,0): air, (1,0,0): stone, (2,0,0): log,
    (0,0,1): stone, (1,0,1): log, (2,0,1): air,
    (0,1,0): log, (1,1,0): air, (2,1,0): stone,
    (0,1,1): stone, (1,1,1): air, (2,1,1): log,
})
assert decode(first) == expected
if blueprint['minecraft_version'] == '1.21.4':
    converted = compile_to('converted.schem', convert_to='1.20.4')
    assert converted == compile_to('converted-again.schem', convert_to='1.20.4')
    assert decode(converted) == (3700, expected[1], expected[2])

# Construct a valid Sponge v2 file from explicit values, not the compiler's NBT,
# palette, or encoder. Reverse palette IDs and tag order; vary gzip metadata.
states = ['minecraft:stone', 'minecraft:oak_log[axis=x]', 'minecraft:air']
indices = [2,0,1, 0,1,2, 1,2,0, 0,2,1]
def alternative(values):
    root = nbtlib.File({
        'Entities': tag.List[tag.Compound]([]),
        'BlockEntities': tag.List[tag.Compound]([]),
        'BlockData': tag.ByteArray(values),
        'Palette': tag.Compound({state: tag.Int(i) for i, state in enumerate(states)}),
        'PaletteMax': tag.Int(3), 'Offset': tag.IntArray([0,0,0]),
        'Length': tag.Short(2), 'Height': tag.Short(2), 'Width': tag.Short(3),
        'DataVersion': tag.Int(blueprint['data_version']), 'Version': tag.Int(2),
    }, root_name='Schematic')
    raw = io.BytesIO()
    root.write(raw)
    compressed = io.BytesIO()
    with gzip.GzipFile(filename='alternate.schem', mode='wb', fileobj=compressed, mtime=123456) as stream:
        stream.write(raw.getvalue())
    return compressed.getvalue()
other = alternative(indices)
assert other != first and decode(other) == expected
other_path = directory / 'alternative.schem'
other_path.write_bytes(other)
compiler.validate_schematic(source, other_path, target_version=blueprint['minecraft_version'])
changed_indices = indices.copy()
changed_indices[0] = 0
changed = alternative(changed_indices)
assert decode(changed) != expected
other_path.write_bytes(changed)
try:
    compiler.validate_schematic(source, other_path, target_version=blueprint['minecraft_version'])
except ValueError as error:
    assert 'full voxel stream differs' in str(error), str(error)
else:
    raise AssertionError('changed voxel was accepted')
`, fixture(version, dataVersion));
  }
});

test('compiler emits and independently decodes multibyte palette VarInts', () => {
  const release = loadRelease('1.21.4');
  const states = Object.entries(release.blocks)
    .filter(([, schema]) => schema && Object.keys(schema.properties).length === 0)
    .map(([name]) => name).sort().slice(0, 130);
  assert.equal(states.length, 130);
  const chars = states.map((_, i) => String.fromCharCode(0x100 + i));
  const blueprint = {
    minecraft_version: '1.21.4', data_version: 4189, width_x: 13, height_y: 2, length_z: 5,
    legend: Object.fromEntries(chars.map((char, i) => [char, states[i]])),
    layers: [0, 1].map(y => [0, 1, 2, 3, 4].map(z => chars.slice((y * 5 + z) * 13, (y * 5 + z + 1) * 13).join(''))),
    expected_counts: Object.fromEntries(states.map(state => [state, 1])), spot_checks: [],
  };
  run(String.raw`
blueprint = json.loads(source.read_text())
packed = compile_to('many.schem', target_version='1.21.4')
assert packed == compile_to('many-again.schem', target_version='1.21.4')
root = nbtlib.File.parse(io.BytesIO(gzip.decompress(packed)))
data = bytes(int(b) & 255 for b in root['BlockData'])
assert data[127:] == bytes([127, 128, 1, 129, 1]), data[127:]
actual = decode(packed)
expected = {}
for y, layer in enumerate(blueprint['layers']):
    for z, row in enumerate(layer):
        for x, char in enumerate(row):
            expected[(x,y,z)] = (blueprint['legend'][char], ())
assert actual == (4189, (13, 2, 5), expected)
`, blueprint);
});

test('existing output and provenance survive collisions and compilation failures', () => {
  run(String.raw`
output = directory / 'existing.schem'
original = b'existing output must not be overwritten'
output.write_bytes(original)
def paths():
    return {p.name: p.read_bytes() for p in directory.iterdir() if p.is_file()}
before = paths()
try:
    compile_to(output.name, target_version='1.21.4')
except FileExistsError:
    pass
else:
    raise AssertionError('existing output was overwritten')
assert paths() == before

# An already compiled output and both of its provenance files are immutable.
compile_to('published.schem', target_version='1.21.4')
before = paths()
try:
    compile_to('published.schem', target_version='1.21.4')
except (ValueError, FileExistsError):
    pass
else:
    raise AssertionError('published output was overwritten')
assert paths() == before

# Preserve an existing artifact even when source validation or post-write
# validation fails; temporary output and provenance must be cleaned up.
valid_source = source.read_bytes()
source.write_text('{}')
before = paths()
try:
    compile_to(output.name)
except ValueError:
    pass
else:
    raise AssertionError('invalid blueprint was accepted')
assert paths() == before
source.write_bytes(valid_source)
before = paths()
validate = compiler.validate_schematic
def fail(*args, **kwargs):
    raise ValueError('injected validation failure')
compiler.validate_schematic = fail
try:
    for name in (output.name, 'never-published.schem'):
        try:
            compile_to(name)
        except ValueError as error:
            assert 'injected validation failure' in str(error)
        else:
            raise AssertionError('injected failure was ignored')
        assert paths() == before
finally:
    compiler.validate_schematic = validate
assert paths() == before

for suffix in ('.provenance.json', '.provenance.sha256'):
    sidecar = directory / ('fresh.schem' + suffix)
    sidecar.write_bytes(b'existing provenance')
    before = paths()
    try:
        compile_to('fresh.schem')
    except ValueError as error:
        assert 'refusing to overwrite provenance' in str(error)
    else:
        raise AssertionError('existing provenance was overwritten')
    assert paths() == before
    sidecar.unlink()
`, fixture('1.21.4', 4189));
});
