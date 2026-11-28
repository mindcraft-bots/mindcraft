"""Deterministic fake compiler used to test cache mechanics, not compiler semantics."""
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def compile_fixture(snapshot, pack, version, unverified=False):
    output = snapshot / 'schematics' / 'schems' / pack
    label = '.nonvalidated' if unverified else ''
    validation = 'NONVALIDATED' if unverified else 'STRICT_VALIDATED'
    entries = []
    sources = sorted((snapshot / 'schematics' / 'blueprints' / pack).glob('*.json'))
    for source in sources:
        name = f'{source.stem}.mc{version}{label}.schem'
        data = b'fixture schematic\n' + source.read_bytes()
        (output / name).write_bytes(data)
        blueprint = json.loads(source.read_bytes())
        dimensions = [blueprint[key] for key in ('width_x', 'height_y', 'length_z')]
        volume = dimensions[0] * dimensions[1] * dimensions[2]
        entries.append({'blueprint': source.name, 'schematic': name, 'sha256': digest(data),
                        'sourceVersion': blueprint['minecraft_version'], 'sourceDataVersion': blueprint['data_version'],
                        'targetVersion': version, 'targetDataVersion': 4189, 'validation': validation,
                        'dimensions': dimensions, 'volume': volume, 'non_air': volume, 'air': 0,
                        'palette_entries': 1, 'block_data_bytes': volume, 'bytes': len(data),
                        'spot_checks': len(blueprint['spot_checks']), 'changes': []})
    report_name = f'conversion.mc{version}{label}.json'
    report = {'schemaVersion': 2, 'pack': pack, 'targetVersion': version,
              'validation': validation, 'entries': entries}
    report_bytes = (json.dumps(report, sort_keys=True) + '\n').encode()
    (output / report_name).write_bytes(report_bytes)
    for source, entry in zip(sources, entries):
        name = entry['schematic']
        metadata = {'schemaVersion': 1, 'targetVersion': None, 'artifact': name, 'blueprint': f'schematics/blueprints/{pack}/{source.name}',
                    'blueprintSha256': digest(source.read_bytes()), 'sha256': entry['sha256'],
                    'packReport': report_name, 'packReportSha256': digest(report_bytes),
                    'validation': validation, 'convertTo': version}
        data = (json.dumps(metadata, sort_keys=True) + '\n').encode()
        (output / (name + '.provenance.json')).write_bytes(data)
        (output / (name + '.provenance.sha256')).write_text(digest(data) + '\n')
