import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("legacy wardrobe encoding and four repaired hinges are independently accounted for", () => {
  // Reconstruction below deliberately reads historical encoding metadata from the
  // asset. It diagnoses the difference; it is NOT independent reproducibility.
  const script = `
import gzip, hashlib, io, json, pathlib, struct, subprocess, sys, tempfile, zlib
sys.dont_write_bytecode = True
sys.path.insert(0, 'schematics/tooling')
import compile_blueprint as compiler

blueprint_path = pathlib.Path('schematics/blueprints/pack1/01_wardrobe_nether_portal.json')
asset_path = pathlib.Path('schematics/schems/pack1/01_wardrobe_nether_portal.schem')
variant_path = pathlib.Path('schematics/schems/pack1/01_wardrobe_nether_portal.mc1.21.4.schem')
canonical = asset_path.read_bytes()
variant = variant_path.read_bytes()
sha = lambda data: hashlib.sha256(data).hexdigest()
with tempfile.TemporaryDirectory(prefix='wardrobe-diagnosis-') as directory:
    legacy_path = pathlib.Path(directory) / 'legacy.json'
    # Pin the actual pre-repair revision; HEAD may already contain the repair.
    legacy_path.write_bytes(subprocess.check_output(['git', 'show', '8ff5b2c^:' + str(blueprint_path)]))
    _, rebuilt = compiler.compile_blueprint(legacy_path, pathlib.Path(directory) / 'first.nonvalidated.schem', allow_unverified=True)
    _, repeated = compiler.compile_blueprint(legacy_path, pathlib.Path(directory) / 'second.nonvalidated.schem', allow_unverified=True)
    roots = [compiler.nbtlib.File.parse(io.BytesIO(gzip.decompress(data))) for data in (canonical, rebuilt, variant)]
    original, current, _ = roots
    blueprint, voxels = compiler.read_blueprint(legacy_path)
    repaired, repaired_voxels = compiler.read_blueprint(blueprint_path)
    decoded = []
    for root in roots:
        states = {int(value): state for state, value in root['Palette'].items()}
        indices = compiler.decode_varints(bytes(int(value) & 255 for value in root['BlockData']), len(voxels), len(states))
        decoded.append([states[index] for index in indices])
    # Reverse only the observed palette/tag/header choices and require an exact
    # match. No byte from this reconstruction is written to the canonical path.
    palette = {state: index for index, state in enumerate(dict.fromkeys(blueprint['legend'].values()))}
    current['Palette'] = compiler.tag.Compound({state: compiler.tag.Int(index) for state, index in palette.items()})
    current['BlockData'] = compiler.tag.ByteArray([palette[state] for state in voxels])
    legacy = compiler.nbtlib.File({key: current[key] for key in original}, root_name=current.root_name)
    raw = io.BytesIO()
    legacy.write(raw)
    assert canonical[3] == 8, 'expected only the original FNAME gzip flag'
    filename = canonical[10:canonical.index(b'\\0', 10)].decode()
    mtime = struct.unpack('<I', canonical[4:8])[0]
    packed = io.BytesIO()
    with gzip.GzipFile(filename=filename, fileobj=packed, mode='wb', compresslevel=9, mtime=mtime) as stream:
        stream.write(raw.getvalue())
    print(json.dumps({
        'zlib': zlib.ZLIB_RUNTIME_VERSION,
        'canonical_sha256': sha(canonical), 'rebuilt_sha256': sha(rebuilt),
        'canonical_bytes': len(canonical), 'rebuilt_bytes': len(rebuilt),
        'canonical_header': canonical[:10].hex(), 'rebuilt_header': rebuilt[:10].hex(),
        'canonical_trailer': canonical[-8:].hex(), 'rebuilt_trailer': rebuilt[-8:].hex(),
        'canonical_raw_sha256': sha(gzip.decompress(canonical)),
        'rebuilt_raw_sha256': sha(gzip.decompress(rebuilt)),
        'canonical_gzip_filename': filename, 'canonical_gzip_mtime': mtime,
        'canonical_tag_order': list(original), 'rebuilt_tag_order': list(roots[1]),
        'canonical_palette': {key: int(value) for key, value in original['Palette'].items()},
        'rebuilt_palette': compiler.state_palette(blueprint)[0],
        'byte_match': canonical == rebuilt, 'repeated_rebuild_match': rebuilt == repeated,
        'decoded_voxels_match': decoded[0] == decoded[1] == voxels,
        'variant_voxels_match': decoded[2] == repaired_voxels,
        'hinge_changes': [[i % 6, i // 24, (i // 6) % 4, old, new] for i, (old, new) in enumerate(zip(voxels, repaired_voxels)) if old != new],
        'compared_voxels': len(voxels),
        'legacy_raw_reconstructed_exactly': raw.getvalue() == gzip.decompress(canonical),
        'legacy_gzip_reconstructed_exactly': packed.getvalue() == canonical,
        'canonical_unchanged': asset_path.read_bytes() == canonical,
        'variant_unchanged': variant_path.read_bytes() == variant,
    }))
`;
  const child = spawnSync("python3", ["-c", script], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const diagnosis = JSON.parse(child.stdout);
  assert.equal(diagnosis.canonical_sha256, "8deb5fee1a8930b321ad9ff066b955854bb4caedf8f5a8cf17eb710c5da7a383");
  assert.equal(diagnosis.canonical_bytes, 535);
  assert.equal(diagnosis.canonical_gzip_filename, "wardrobe_nether_portal.schem");
  assert.equal(diagnosis.canonical_gzip_mtime, 1794764481);
  assert.equal(diagnosis.byte_match, false);
  assert.equal(diagnosis.repeated_rebuild_match, true);
  assert.equal(diagnosis.decoded_voxels_match, true);
  assert.equal(diagnosis.variant_voxels_match, true);
  assert.deepEqual(diagnosis.hinge_changes.map(([x, y, z]) => [x, y, z]), [[2, 0, 1], [3, 0, 1], [2, 1, 1], [3, 1, 1]]);
  for (const [, , , oldState, newState] of diagnosis.hinge_changes) {
    assert.match(oldState, /dark_oak_door/);
    assert.equal(oldState.replace(/hinge=(left|right)/, (_, side) => `hinge=${side === "left" ? "right" : "left"}`), newState);
  }
  assert.equal(diagnosis.compared_voxels, 168);
  assert.equal(diagnosis.legacy_raw_reconstructed_exactly, true);
  assert.equal(diagnosis.legacy_gzip_reconstructed_exactly, true);
  assert.equal(diagnosis.canonical_unchanged, true);
  assert.equal(diagnosis.variant_unchanged, true);
  console.log("WARDROBE_REBUILD_DIAGNOSIS " + JSON.stringify(diagnosis));
});
