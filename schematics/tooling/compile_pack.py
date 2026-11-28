#!/usr/bin/env python3
"""Compile a pack into new, independently selectable versioned variants."""
import json
import hashlib
import os
import re
import sys
import tempfile
from pathlib import Path

from compile_blueprint import PROJECT_ROOT, compile_blueprint, require, validate_schematic, variant_path


def pack_directory(root: Path, pack: str) -> Path:
    schematics = PROJECT_ROOT / "schematics"
    directory = root / pack
    require(schematics.resolve().is_relative_to(PROJECT_ROOT), "schematics directory escapes project root")
    require(root.resolve(strict=True).is_relative_to(schematics.resolve()), f"directory escapes schematics: {root}")
    require(not directory.is_symlink() and directory.is_dir(), f"missing or symlinked pack directory: {directory}")
    require(directory.resolve(strict=True).is_relative_to(root.resolve()), f"pack escapes root: {directory}")
    return directory


def compile_pack(pack: str, version: str, allow_unverified: bool = False) -> dict:
    require(re.fullmatch(r"pack[1-9]\d*", pack) is not None, "pack must match packN with a positive decimal N")
    require(re.fullmatch(r"\d+(?:\.\d+)+", version) is not None, "target version must be a numeric Minecraft release")
    source_dir = pack_directory(PROJECT_ROOT / "schematics" / "blueprints", pack)
    output_dir = pack_directory(PROJECT_ROOT / "schematics" / "schems", pack)
    sources = sorted(source_dir.glob("*.json"), key=lambda path: path.name)
    require(sources, f"no blueprints in {pack}")
    for source in sources:
        require(not source.is_symlink() and source.is_file(), f"unsafe blueprint: {source}")
        require("\\" not in source.name and source.name not in (".", ".."), f"unsafe blueprint name: {source.name!r}")
    targets = [variant_path(output_dir / f"{source.stem}.schem", version, allow_unverified) for source in sources]
    label = ".nonvalidated" if allow_unverified else ""
    report_path = output_dir / f"conversion.mc{version}{label}.json"
    metadata_targets = [p.with_name(p.name + ".provenance.json") for p in targets]
    digest_targets = [p.with_name(p.name + ".provenance.sha256") for p in targets]
    for path in [*targets, *metadata_targets, *digest_targets, report_path]:
        require(not os.path.lexists(path), f"refusing to overwrite existing variant or report: {path.name}")

    # Stage on the destination filesystem. Hard links publish atomically and fail if
    # a concurrent invocation created a destination after the preflight check.
    published = []
    with tempfile.TemporaryDirectory(prefix=".compile-pack-", dir=output_dir) as temporary:
        stage = Path(temporary)
        entries = []
        for source, target in zip(sources, targets):
            staged = stage / target.name
            compile_blueprint(source, staged, convert_to=version, allow_unverified=allow_unverified)
            result = validate_schematic(source, staged, convert_to=version, allow_unverified=allow_unverified)
            conversion = result.pop("conversion")
            conversion.pop("legend")
            entries.append({"blueprint": source.name, "schematic": target.name, **conversion, **result})
        report = {"schemaVersion": 2, "pack": pack, "targetVersion": version,
                  "validation": "NONVALIDATED" if allow_unverified else "STRICT_VALIDATED", "entries": entries}
        staged_report = stage / report_path.name
        staged_report.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        for target, digest_target in zip(metadata_targets, digest_targets):
            staged_metadata = stage / target.name
            metadata = json.loads(staged_metadata.read_text(encoding="utf-8"))
            metadata.update(packReport=report_path.name, packReportSha256=hashlib.sha256(staged_report.read_bytes()).hexdigest())
            staged_metadata.write_text(json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            (stage / digest_target.name).write_text(
                hashlib.sha256(staged_metadata.read_bytes()).hexdigest() + "\n", encoding="ascii")
        try:
            for source, target in [(stage / p.name, p) for p in digest_targets + metadata_targets + targets] + [(staged_report, report_path)]:
                os.link(source, target, follow_symlinks=False)
                published.append((source, target))
        except Exception:
            for source, target in reversed(published):
                try:
                    if os.path.samestat(source.stat(), target.stat()):
                        target.unlink()
                except FileNotFoundError:
                    pass
            raise
    return report


def main() -> int:
    if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] != "--allow-unverified"):
        print("usage: compile_pack.sh <packN> <target-version> [--allow-unverified]", file=sys.stderr)
        return 2
    try:
        allow_unverified = len(sys.argv) == 4
        report = compile_pack(sys.argv[1], sys.argv[2], allow_unverified)
        print(json.dumps({"pack": report["pack"], "targetVersion": report["targetVersion"],
                          "compiled": len(report["entries"]),
                          "validation": report["validation"],
                          "report": f"conversion.mc{report['targetVersion']}{'.nonvalidated' if allow_unverified else ''}.json"}, sort_keys=True))
        return 0
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
