#!/usr/bin/env python3
"""Compile and independently validate layers[y][z][x] Sponge v2 blueprints."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

import nbtlib
from nbtlib import tag


STATE_RE = re.compile(r"^([a-z0-9_.-]+):([a-z0-9_./-]+)(?:\[(.*)\])?$")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_VALIDATOR = PROJECT_ROOT / "schematics" / "tooling" / "validate_registry.mjs"


def repo_input(path: Path) -> Path:
    """Resolve repository-relative inputs consistently, regardless of cwd."""
    candidate = path if path.is_absolute() else PROJECT_ROOT / path
    resolved = candidate.resolve(strict=True)
    require(resolved.is_relative_to(PROJECT_ROOT), f"input path escapes project root: {path}")
    require(resolved.is_file(), f"input is not a regular file: {path}")
    return resolved


def cli_output(path: Path) -> Path:
    """Resolve relative output names from the project root; absolute temp paths are supported."""
    return path if path.is_absolute() else PROJECT_ROOT / path


def blueprint_data_version(blueprint: dict) -> int:
    value = blueprint.get("data_version")
    require(type(value) is int and value > 0, "blueprint must declare a positive integer data_version")
    return value


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_target(blueprint_path: Path, blueprint: dict, target_version: str | None) -> None:
    """Require exact blueprint metadata and registry-valid states for an explicit target."""
    if target_version is None:
        return
    require(isinstance(target_version, str) and bool(target_version.strip()), "target Minecraft version must be nonempty")
    require(blueprint.get("minecraft_version") == target_version,
            f"target Minecraft version {target_version} does not match blueprint minecraft_version {blueprint.get('minecraft_version')!r}")
    try:
        result = subprocess.run(
            ["node", str(REGISTRY_VALIDATOR), str(blueprint_path), target_version],
            cwd=PROJECT_ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False,
        )
    except OSError as error:
        raise ValueError(f"cannot run Minecraft registry validator for target {target_version}: {error}") from error
    require(result.returncode == 0,
            f"Minecraft {target_version} registry validation failed: {result.stdout.strip() or 'no diagnostic'}")


def read_blueprint(path: Path) -> tuple[dict, list[str]]:
    blueprint = json.loads(path.read_text(encoding="utf-8"))
    for key in ("width_x", "height_y", "length_z", "legend", "layers", "expected_counts", "spot_checks"):
        require(key in blueprint, f"blueprint missing required field {key!r}")
    width, height, length = (blueprint[k] for k in ("width_x", "height_y", "length_z"))
    require(all(type(v) is int and v > 0 for v in (width, height, length)), "dimensions must be positive integers")
    require(len(blueprint["layers"]) == height, f"expected {height} y-layers, found {len(blueprint['layers'])}")
    legend = blueprint["legend"]
    require(isinstance(legend, dict) and legend and all(isinstance(k, str) and len(k) == 1 for k in legend), "legend must map single characters to states")
    for y, layer in enumerate(blueprint["layers"]):
        require(isinstance(layer, list) and len(layer) == length, f"layer y={y} must contain {length} z-rows")
        for z, row in enumerate(layer):
            require(isinstance(row, str) and len(row) == width, f"row y={y}, z={z} must contain {width} x-cells")
            unknown = sorted(set(row) - set(legend))
            require(not unknown, f"unknown legend character(s) {unknown} at y={y}, z={z}")
    states = []
    for char, state in legend.items():
        require(isinstance(state, str) and STATE_RE.fullmatch(state), f"malformed state for legend {char!r}: {state!r}")
        states.append(state)
    voxels = [legend[ch] for layer in blueprint["layers"] for row in layer for ch in row]
    require(len(voxels) == width * height * length, "layer volume mismatch")
    counts = Counter(voxels)
    require(dict(counts) == blueprint["expected_counts"], f"expected_counts mismatch: expected {blueprint['expected_counts']}, found {dict(counts)}")
    non_air = len(voxels) - counts.get("minecraft:air", 0)
    if "non_air_count" in blueprint:
        require(non_air == blueprint["non_air_count"], f"non_air_count mismatch: expected {blueprint['non_air_count']}, found {non_air}")
    for check in blueprint["spot_checks"]:
        x, y, z = (check[k] for k in ("x", "y", "z"))
        require(0 <= x < width and 0 <= y < height and 0 <= z < length, f"spot check out of bounds: {check}")
        actual = blueprint["layers"][y][z][x]
        require(actual == check["char"], f"spot check ({x},{y},{z}) expected {check['char']!r}, got {actual!r}")
    return blueprint, voxels


def encode_varint(value: int) -> bytes:
    require(type(value) is int and value >= 0, f"VarInt palette index must be nonnegative: {value}")
    out = bytearray()
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def decode_varints(data: bytes, count: int, palette_max: int) -> list[int]:
    values, cursor = [], 0
    while cursor < len(data):
        start, value, shift = cursor, 0, 0
        while True:
            require(cursor < len(data), "truncated VarInt")
            byte = data[cursor]
            cursor += 1
            require(shift < 35, "VarInt exceeds five bytes")
            value |= (byte & 0x7F) << shift
            if byte < 0x80:
                break
            shift += 7
        encoded = data[start:cursor]
        require(encoded == encode_varint(value), f"non-canonical VarInt encoding at byte offset {start}")
        require(value < palette_max, f"palette index {value} is outside PaletteMax={palette_max}")
        values.append(value)
    require(len(values) == count, f"decoded {len(values)} VarInts, expected {count}")
    return values


def test_varint_boundaries() -> None:
    cases = [0, 1, 127, 128, 255, 16_383, 16_384, 2_097_151, 2_097_152, (1 << 28) - 1, 1 << 28, (1 << 31) - 1]
    for value in cases:
        encoded = encode_varint(value)
        decoded = decode_varints(encoded, 1, value + 1)
        require(decoded == [value], f"VarInt boundary round trip failed for {value}")
    require(encode_varint(127) == b"\x7f" and encode_varint(128) == b"\x80\x01", "VarInt known encodings failed")
    try:
        decode_varints(b"\x80\x00", 1, 1)
    except ValueError as error:
        require("non-canonical" in str(error), "overlong VarInt was rejected for the wrong reason")
    else:
        raise ValueError("overlong VarInt was accepted")


def state_palette(blueprint: dict) -> tuple[dict[str, int], list[str]]:
    states = sorted(set(blueprint["legend"].values()))
    return {state: index for index, state in enumerate(states)}, states


def gzip_nbt(root: nbtlib.File) -> bytes:
    raw = io.BytesIO()
    root.write(raw)
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, compresslevel=9, mtime=0) as stream:
        stream.write(raw.getvalue())
    return compressed.getvalue()


def compile_blueprint(blueprint_path: Path, output_path: Path, target_version: str | None = None) -> tuple[dict, bytes]:
    blueprint, voxels = read_blueprint(blueprint_path)
    validate_target(blueprint_path, blueprint, target_version)
    data_version = blueprint_data_version(blueprint)
    palette, _ = state_palette(blueprint)
    block_data = b"".join(encode_varint(palette[state]) for state in voxels)
    width, height, length = (blueprint[k] for k in ("width_x", "height_y", "length_z"))
    palette_tag = tag.Compound({state: tag.Int(index) for state, index in palette.items()})
    root = nbtlib.File({
        "Version": tag.Int(2),
        "DataVersion": tag.Int(data_version),
        "Width": tag.Short(width),
        "Height": tag.Short(height),
        "Length": tag.Short(length),
        "Offset": tag.IntArray([0, 0, 0]),
        "PaletteMax": tag.Int(len(palette)),
        "Palette": palette_tag,
        "BlockData": tag.ByteArray([byte if byte < 128 else byte - 256 for byte in block_data]),
        "BlockEntities": tag.List[tag.Compound]([]),
        "Entities": tag.List[tag.Compound]([]),
    }, root_name="Schematic")
    packed = gzip_nbt(root)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(packed)
    return blueprint, packed


def validate_schematic(blueprint_path: Path, schematic_path: Path, target_version: str | None = None) -> dict:
    blueprint, voxels = read_blueprint(blueprint_path)
    validate_target(blueprint_path, blueprint, target_version)
    packed = schematic_path.read_bytes()
    require(bool(packed), f"empty schematic: {schematic_path}")
    raw = gzip.decompress(packed)
    root = nbtlib.File.parse(io.BytesIO(raw))
    expected_tags = {
        "Version": tag.Int, "DataVersion": tag.Int, "Width": tag.Short, "Height": tag.Short,
        "Length": tag.Short, "Offset": tag.IntArray, "PaletteMax": tag.Int,
        "Palette": tag.Compound, "BlockData": tag.ByteArray,
    }
    for key, expected_type in expected_tags.items():
        require(key in root, f"NBT missing {key}")
        require(type(root[key]) is expected_type, f"{key} tag type is {type(root[key]).__name__}, expected {expected_type.__name__}")
    for key in ("BlockEntities", "Entities"):
        require(type(root[key]) is tag.List[tag.Compound], f"{key} must be a List[Compound] tag")
    require(root.root_name == "Schematic", f"unexpected NBT root name {root.root_name!r}")
    require(int(root["Version"]) == 2, "Sponge schematic Version must be 2")
    expected_data_version = blueprint_data_version(blueprint)
    require(int(root["DataVersion"]) == expected_data_version,
            f"DataVersion {int(root['DataVersion'])} does not match blueprint data_version {expected_data_version}")
    dims = [int(root[k]) for k in ("Width", "Height", "Length")]
    expected_dims = [blueprint[k] for k in ("width_x", "height_y", "length_z")]
    require(dims == expected_dims, f"dimensions {dims} do not match blueprint {expected_dims}")
    require(list(root["Offset"]) == [0, 0, 0], "Offset must be [0,0,0]")
    require(len(root["BlockEntities"]) == 0 and len(root["Entities"]) == 0, "BlockEntities and Entities must be empty")
    require(root["BlockEntities"].subtype is tag.Compound and root["Entities"].subtype is tag.Compound, "entity lists must be List[Compound]")
    palette = root["Palette"]
    for key, value in palette.items():
        require(type(value) is tag.Int, f"Palette[{key!r}] must be an Int tag")
    ids = [int(value) for value in palette.values()]
    require(len(ids) == len(set(ids)) and sorted(ids) == list(range(len(ids))), "palette IDs must be unique, contiguous, and zero-based")
    expected_palette = set(blueprint["legend"].values())
    require(set(palette) == expected_palette,
            "serialized palette states do not exactly match the blueprint's state set")
    require(int(root["PaletteMax"]) == len(palette), "PaletteMax does not match palette size")
    byte_data = bytes(int(value) & 0xFF for value in root["BlockData"])
    volume = dims[0] * dims[1] * dims[2]
    decoded = decode_varints(byte_data, volume, int(root["PaletteMax"]))
    ordered_states = [state for state, _ in sorted(palette.items(), key=lambda item: int(item[1]))]
    actual_voxels = [ordered_states[index] for index in decoded]
    expected_voxels = [blueprint["legend"][ch] for layer in blueprint["layers"] for row in layer for ch in row]
    require(actual_voxels == expected_voxels, "full voxel stream differs from blueprint (order is x-fastest, z-next, y-next)")
    require(len(actual_voxels) == volume, "voxel count differs from volume")
    for spot in blueprint["spot_checks"]:
        offset = spot["x"] + dims[0] * (spot["z"] + dims[2] * spot["y"])
        require(actual_voxels[offset] == blueprint["legend"][spot["char"]], f"binary spot-check mismatch at {spot}")
    return {
        "dimensions": dims,
        "volume": volume,
        "non_air": sum(state != "minecraft:air" for state in actual_voxels),
        "air": sum(state == "minecraft:air" for state in actual_voxels),
        "palette_entries": len(palette),
        "block_data_bytes": len(byte_data),
        "sha256": hashlib.sha256(packed).hexdigest(),
        "bytes": len(packed),
        "spot_checks": len(blueprint["spot_checks"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    compile_parser = subparsers.add_parser("compile", help="compile blueprint JSON to deterministic gzip Sponge v2")
    compile_parser.add_argument("blueprint", type=Path)
    compile_parser.add_argument("output", type=Path)
    compile_parser.add_argument("--target-version", help="require matching blueprint metadata and validate its palette against minecraft-data")
    validate_parser = subparsers.add_parser("validate", help="reload gzip NBT and validate every voxel")
    validate_parser.add_argument("blueprint", type=Path)
    validate_parser.add_argument("schematic", type=Path)
    validate_parser.add_argument("--target-version", help="require matching blueprint metadata and validate its palette against minecraft-data")
    subparsers.add_parser("test-varints", help="exercise canonical multibyte VarInt boundaries")
    args = parser.parse_args()
    try:
        test_varint_boundaries()
        if args.command == "compile":
            blueprint_path = repo_input(args.blueprint)
            output_path = cli_output(args.output)
            blueprint, packed = compile_blueprint(blueprint_path, output_path, args.target_version)
            result = validate_schematic(blueprint_path, output_path, args.target_version)
            print(json.dumps({"compiled": str(args.output), "blueprint": str(args.blueprint), **result}, sort_keys=True))
        elif args.command == "validate":
            blueprint_path = repo_input(args.blueprint)
            schematic_path = repo_input(args.schematic)
            print(json.dumps(validate_schematic(blueprint_path, schematic_path, args.target_version), sort_keys=True))
        else:
            print("canonical VarInt boundaries passed (including 1-, 2-, 3-, 4-, and 5-byte values; overlong encoding rejected)")
        return 0
    except Exception as error:  # CLI diagnostics should retain concise context.
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
