#!/usr/bin/env python3
"""Audit versioned pack assets for the blueprints' explicit source release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMATICS = ROOT / "schematics"
TOOLING = SCHEMATICS / "tooling"
COMPILER = TOOLING / "compile_blueprint.py"
READER_VALIDATOR = TOOLING / "validate_blueprint.mjs"
BEGIN = "<!-- BEGIN GENERATED BATCH AUDIT -->"
END = "<!-- END GENERATED BATCH AUDIT -->"
PACK_RE = re.compile(r"^pack[1-9][0-9]*$")


def create_output_dir(raw: str) -> Path:
    """Create a fresh directory below tmp without following symlink components.

    Parent directories are retained on failure. This is not protection against
    concurrent renames after creation; use a trusted, stable workspace.
    """
    parts = raw.split("/")
    if len(parts) < 2 or parts[0] != "tmp" or any(p in ("", ".", "..") or "\\" in p for p in parts):
        raise ValueError("--output-dir must be a relative new directory under project tmp/")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(ROOT, flags)
    try:
        for index, part in enumerate(parts):
            last = index == len(parts) - 1
            try:
                os.mkdir(part, mode=0o700, dir_fd=fd)
            except FileExistsError:
                if last:
                    raise
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
    finally:
        os.close(fd)
    return ROOT.joinpath(*parts)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def run_logged(command: list[str], log_path: Path) -> dict:
    completed = subprocess.run(command, cwd=ROOT, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, check=False)
    rendered = "$ " + " ".join(command) + f"\n[exit code: {completed.returncode}]\n" + completed.stdout
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(rendered, encoding="utf-8")
    return {"command": command, "exit_code": completed.returncode,
            "output": completed.stdout, "log": rel(log_path)}


def parse_json_output(check: dict) -> dict | None:
    try:
        return json.loads(check["output"])
    except (TypeError, json.JSONDecodeError):
        return None


def file_meta(path: Path) -> dict:
    return {"path": rel(path), "bytes": path.stat().st_size,
            "sha256": sha256(path), "nonempty": path.stat().st_size > 0}


def positive_safe_integer(raw: str, label: str, path: Path) -> int:
    if not isinstance(raw, str) or not re.fullmatch(r"[0-9]+", raw):
        raise ValueError(f"invalid {label} {raw!r} in {path}")
    number = int(raw)
    if number < 1 or number > 9007199254740991:
        raise ValueError(f"{label} must be a positive safe integer in {path}: {raw!r}")
    return number


def reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def load_index(schems_dir: Path) -> dict[str, tuple[int, int]]:
    path = schems_dir / "index.json"
    if not path.exists() and not path.is_symlink():
        return {}
    packs_real = schems_dir.parent.resolve(strict=True)
    pack_real = schems_dir.resolve(strict=True)
    if packs_real not in pack_real.parents:
        raise ValueError(f"pack directory resolves outside its schems directory: {schems_dir}")
    index_real = path.resolve(strict=True)
    if pack_real not in index_real.parents or not index_real.is_file():
        raise ValueError(f"manifest must be a regular file contained by its pack directory: {path}")
    data = json.loads(index_real.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicate_json_keys)
    if not isinstance(data, dict) or set(data) != {"schemaVersion", "groups"} or data.get("schemaVersion") != 2:
        raise ValueError(f"invalid versioned groups manifest in {path}")
    groups = data.get("groups")
    if not isinstance(groups, dict):
        raise ValueError(f"groups must be an object in {path}")

    mappings: dict[str, tuple[int, int]] = {}
    normalized_groups: set[int] = set()
    for raw_group, ids in groups.items():
        group = positive_safe_integer(raw_group, "group", path)
        if group in normalized_groups:
            raise ValueError(f"duplicate normalized group {group} in {path}")
        normalized_groups.add(group)
        if not isinstance(ids, dict):
            raise ValueError(f"group {raw_group!r} must map IDs to filenames in {path}")
        normalized_ids: set[int] = set()
        for raw_id, filename in ids.items():
            identifier = positive_safe_integer(raw_id, "id", path)
            if identifier in normalized_ids:
                raise ValueError(f"duplicate normalized id {identifier} in group {group} in {path}")
            normalized_ids.add(identifier)
            if (not isinstance(filename, str) or not filename or filename in {".", ".."}
                    or "\0" in filename or "/" in filename or "\\" in filename
                    or Path(filename).name != filename
                    or Path(filename).suffix.lower() not in {".schem", ".schematic", ".litematic"}):
                raise ValueError(f"invalid schematic filename {filename!r} in {path}")
            if filename in mappings:
                raise ValueError(f"duplicate schematic filename {filename!r} in {path}")
            logical = schems_dir / filename
            if logical.exists() or logical.is_symlink():
                candidate = logical.resolve(strict=True)
                if candidate == pack_real or pack_real not in candidate.parents or not candidate.is_file():
                    raise ValueError(f"unsafe or non-file schematic target {filename!r} in {path}")
            mappings[filename] = (group, identifier)
    return mappings


def result_status(check: dict) -> str:
    if check["exit_code"] == 0:
        return "PASS"
    data = parse_json_output(check)
    if data and (data.get("parserMismatches", 0) or data.get("spotCheckFailures") or not data.get("parserDerivedCountsMatch", True)):
        return "MISMATCH"
    return "ERROR"


def make_rows(audit: dict, pack: str, report_dir: Path | None = None) -> list[str]:
    report_dir = report_dir or (SCHEMATICS / "schems" / pack)
    rows = []
    for item in audit["builds"]:
        blueprint = Path(item["blueprint"]["path"])
        schematic = Path(item["schematic"]["path"])
        stem = blueprint.stem
        group = item.get("group")
        identifier = item.get("id")
        selector = f"{pack}:{group}:{identifier}" if group is not None and identifier is not None else f"{pack}:{schematic.stem}"
        dimensions = item.get("dimensions")
        dim_text = "×".join(map(str, dimensions)) if dimensions else "—"
        reader = item["checks"]["production_reader"]
        binary = item["checks"]["binary"]
        deterministic = item["checks"]["deterministic_regeneration"]
        binary_text = binary["result"]
        if deterministic["result"] == "PASS":
            determinism_text = "MATCH"
        elif deterministic.get("exit_code") == 0:
            determinism_text = "DIFFERENT HASH"
        else:
            determinism_text = "FAIL"
        if reader["result"] == "PASS":
            reader_text = f"PASS ({reader.get('compared_voxels') or 0} voxels)"
        elif reader["result"] == "MISMATCH":
            reader_text = f"MISMATCH ({reader.get('mismatch_count', '?')} voxels; exit {reader['exit_code']})"
        else:
            reader_text = f"{reader['result']} (exit {reader['exit_code']})"
        title = item.get("title", stem).replace("|", "\\|")
        bp_link = f"[{{blueprint.name}}]({os.path.relpath(ROOT / blueprint, report_dir)})"
        schem_link = f"[{{schematic.name}}]({os.path.relpath(ROOT / schematic, report_dir)})"
        action_link = f"[`!buildSchematic(\"{selector}\")`]({os.path.relpath(ROOT / 'src/agent/commands/actions.js', report_dir)}:492)"
        rows.append(f"| {item.get('group', '—')} | {item.get('id', '—')} | {title} | {bp_link} / {schem_link} | {dim_text} | {item.get('non_air_count', '—')} | {binary_text} / {determinism_text} | {reader_text} | {action_link} |".format(blueprint=blueprint, schematic=schematic))
    return rows


def update_report(audit: dict, report: Path, pack: str) -> None:
    rows = make_rows(audit, pack, report.parent)
    summary = audit["summary"]
    coverage = audit["coverage"]
    tests = audit["tests"]
    section = [
        BEGIN,
        f"## Current audit for `{pack}` (generated)",
        "",
        f"Audit timestamp: `{audit['checked_at_utc']}`. This run read explicit-target versioned artifacts and regenerated only temporary schematics.",
        "",
        "| Group | ID | Title | Blueprint / schematic | X×Y×Z | Non-air | Binary / deterministic | Production-reader result | Stable command |",
        "| ---: | ---: | --- | --- | --- | ---: | --- | --- | --- |",
        *rows,
        "",
        f"**Aggregate:** {summary['build_count']} blueprints inspected; binary validations {summary['binary_pass']} passed / {summary['binary_fail']} failed; deterministic regenerations {summary['deterministic_pass']} matched / {summary['deterministic_fail']} failed; production-reader comparisons {summary['reader_pass']} passed, {summary['reader_mismatch']} mismatched, {summary['reader_error']} errored/not run. Blueprint inventory coverage: {coverage['blueprint_count']} JSON; {coverage['schematic_count']} matching schematics; {coverage['notes_nonempty_count']} nonempty validation notes. Missing/empty artifacts: `{json.dumps(coverage['artifact_issues'], ensure_ascii=False)}`.",
        "",
        f"**Tests:** VarInt test exit {tests['varint']['exit_code']} ([log](varint_test.log)); `npm run test:schematic` exit {tests['npm_test']['exit_code']} ([log](npm_test.log)). Per-build logs are in [the pack audit logs](build_logs/).",
        "",
        "Reader mismatches and command errors are retained as failures; a binary pass is not a reader pass. No live-server placement or image-fidelity test is implied. Existing reports and baseline evidence outside this generated section are historical records.",
        "",
        f"Machine-readable results: [batch_validation.json](batch_validation.json). Reproducible runner: [audit_batch.py]({os.path.relpath(Path(__file__), report.parent)}).",
        END,
    ]
    generated = "\n".join(section)
    if report.exists():
        original = report.read_text(encoding="utf-8")
    else:
        original = f"# {pack} schematic audit\n\nHistorical notes, if any, remain outside the generated section.\n"
    if BEGIN in original and END in original:
        before = original.split(BEGIN, 1)[0].rstrip()
        after = original.split(END, 1)[1].lstrip()
        content = before + "\n\n" + generated + ("\n\n" + after if after else "\n")
    else:
        content = original.rstrip() + "\n\n" + generated + "\n"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(content, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", default="pack1", help="pack directory name (default: pack1)")
    parser.add_argument("--minecraft-version", required=True, help="explicit target matching each blueprint source release")
    parser.add_argument("--output-dir", required=True, help="new, non-existing directory under project tmp/ for reports and logs")
    parser.add_argument("--data-version", type=int, help="require this DataVersion; otherwise use each blueprint's metadata")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)+", args.minecraft_version):
        parser.error("--minecraft-version must be a dotted release number")
    if not PACK_RE.fullmatch(args.pack):
        parser.error("--pack must be packN where N is a positive integer")

    blueprints_dir = SCHEMATICS / "blueprints" / args.pack
    schems_dir = SCHEMATICS / "schems" / args.pack
    if not blueprints_dir.is_dir():
        print(f"ERROR: no blueprint directory for {args.pack}: {rel(blueprints_dir)}", file=sys.stderr)
        return 2
    blueprint_files = sorted(blueprints_dir.glob("*.json"))
    if not blueprint_files:
        print(f"ERROR: no blueprint JSON files found for {args.pack}: {rel(blueprints_dir)}", file=sys.stderr)
        return 2

    try:
        ids = load_index(schems_dir)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    try:
        validation_dir = create_output_dir(args.output_dir)
    except (OSError, ValueError) as error:
        parser.error(f"cannot create fresh output directory: {error}")
    report_path = validation_dir / "batch_report.md"
    filenames_to_tuples = ids
    build_logs = validation_dir / "build_logs"

    version_lines = {
        "node": subprocess.run(["node", "--version"], cwd=ROOT, text=True, capture_output=True).stdout.strip(),
        "npm": subprocess.run(["npm", "--version"], cwd=ROOT, text=True, capture_output=True).stdout.strip(),
        "python": sys.version.split()[0],
    }
    try:
        import nbtlib
        version_lines["nbtlib"] = nbtlib.__version__
    except Exception as error:
        version_lines["nbtlib"] = f"unavailable: {error}"
    for package in ("minecraft-data", "prismarine-schematic"):
        proc = subprocess.run(["node", "-e", f"console.log(require('{package}/package.json').version)"], cwd=ROOT, text=True, capture_output=True)
        version_lines[package] = proc.stdout.strip() if proc.returncode == 0 else "unavailable"

    builds = []
    artifact_issues = []
    for blueprint_path in blueprint_files:
        stem = blueprint_path.stem
        schematic_path = schems_dir / f"{stem}.mc{args.minecraft_version}.schem"
        notes_path = blueprints_dir / f"{stem}.validation.md"
        try:
            blueprint = json.loads(blueprint_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            artifact_issues.append(f"invalid blueprint {rel(blueprint_path)}: {error}")
            blueprint = {}
        version = args.minecraft_version or blueprint.get("minecraft_version")
        data_version = args.data_version if args.data_version is not None else blueprint.get("data_version")
        item = {
            "folder": stem[:2] if len(stem) >= 2 else "—",
            "title": blueprint.get("source_title", blueprint.get("title", stem)),
            "group": filenames_to_tuples.get(f"{stem}.schem", (None, None))[0],
            "id": filenames_to_tuples.get(f"{stem}.schem", (None, None))[1],
            "blueprint": file_meta(blueprint_path),
            "schematic": {"path": rel(schematic_path), "exists": schematic_path.is_file(), "bytes": schematic_path.stat().st_size if schematic_path.is_file() else 0,
                          "sha256": sha256(schematic_path) if schematic_path.is_file() else None, "nonempty": schematic_path.is_file() and schematic_path.stat().st_size > 0},
            "validation_notes": {"path": rel(notes_path), "exists": notes_path.is_file(), "bytes": notes_path.stat().st_size if notes_path.is_file() else 0,
                                 "nonempty": notes_path.is_file() and notes_path.stat().st_size > 0},
            "minecraft_version": version,
            "data_version": data_version,
            "dimensions": [blueprint.get("width_x"), blueprint.get("height_y"), blueprint.get("length_z")],
            "non_air_count": blueprint.get("non_air_count", sum(int(count) for state, count in blueprint.get("expected_counts", {}).items() if state != "minecraft:air")),
            "checks": {},
        }
        if args.minecraft_version and blueprint.get("minecraft_version") not in (None, args.minecraft_version):
            artifact_issues.append(f"Minecraft version mismatch in {rel(blueprint_path)}: {blueprint.get('minecraft_version')} != {args.minecraft_version}")
        if args.data_version is not None and blueprint.get("data_version") not in (None, args.data_version):
            artifact_issues.append(f"DataVersion mismatch in {rel(blueprint_path)}: {blueprint.get('data_version')} != {args.data_version}")
        if not item["blueprint"]["nonempty"]:
            artifact_issues.append(f"empty blueprint: {rel(blueprint_path)}")
        if not item["schematic"]["nonempty"]:
            artifact_issues.append(f"missing/empty schematic: {rel(schematic_path)}")
        if not item["validation_notes"]["nonempty"]:
            artifact_issues.append(f"missing/empty validation notes: {rel(notes_path)}")

        if item["schematic"]["nonempty"] and item["blueprint"]["nonempty"]:
            bp_arg, schem_arg = rel(blueprint_path), rel(schematic_path)
            binary_command = ["python3", rel(COMPILER), "validate", bp_arg, schem_arg]
            if version:
                binary_command.extend(["--target-version", version])
            binary = run_logged(binary_command, build_logs / f"{stem}.binary.log")
            binary_json = parse_json_output(binary)
            item["checks"]["binary"] = {"command": binary["command"], "exit_code": binary["exit_code"], "result": "PASS" if binary["exit_code"] == 0 else "FAIL",
                                           "log": binary["log"], "output": binary_json or binary["output"]}
            if binary_json:
                item["dimensions"] = binary_json["dimensions"]
                item["non_air_count"] = binary_json["non_air"]
                item["air_count"] = binary_json["air"]
                item["volume"] = binary_json["volume"]
                item["binary_details"] = binary_json

            reader_command = ["node", rel(READER_VALIDATOR), bp_arg, schem_arg]
            if version:
                reader_command.append(version)
            reader = run_logged(reader_command, build_logs / f"{stem}.reader.log")
            reader_json = parse_json_output(reader)
            item["checks"]["production_reader"] = {
                "command": reader["command"], "exit_code": reader["exit_code"], "result": result_status(reader), "log": reader["log"],
                "compared_voxels": reader_json.get("comparedVoxels") if reader_json else None,
                "mismatch_count": reader_json.get("parserMismatches") if reader_json else None,
                "count_match": reader_json.get("parserDerivedCountsMatch") if reader_json else None,
                "spot_check_count": reader_json.get("spotChecks") if reader_json else None,
                "spot_check_failures": reader_json.get("spotCheckFailures") if reader_json else None,
                "first_mismatches": reader_json.get("firstMismatches") if reader_json else None,
                "output": reader_json or reader["output"],
            }
            with tempfile.TemporaryDirectory(prefix=f"schematic-audit-{args.pack}-{stem}-") as temp_dir:
                temp_output = Path(temp_dir) / f"{stem}.schem"
                regenerate_command = ["python3", rel(COMPILER), "compile", bp_arg, str(temp_output)]
                if version:
                    regenerate_command.extend(["--target-version", version])
                regenerate = run_logged(regenerate_command, build_logs / f"{stem}.determinism.log")
                regenerated_sha = sha256(temp_output) if temp_output.is_file() else None
                deterministic = regenerate["exit_code"] == 0 and regenerated_sha == item["schematic"]["sha256"]
                item["checks"]["deterministic_regeneration"] = {
                    "command": regenerate["command"], "exit_code": regenerate["exit_code"], "result": "PASS" if deterministic else "FAIL",
                    "temporary_output_only": True, "canonical_sha256": item["schematic"]["sha256"], "regenerated_sha256": regenerated_sha,
                    "log": regenerate["log"], "output": regenerate["output"],
                }
        else:
            item["checks"] = {name: {"result": "NOT_RUN", "exit_code": None} for name in ("binary", "production_reader", "deterministic_regeneration")}
        builds.append(item)

    varint = run_logged(["python3", rel(COMPILER), "test-varints"], validation_dir / "varint_test.log")
    npm_test = run_logged(["npm", "run", "test:schematic"], validation_dir / "npm_test.log")
    audit = {
        "schema_version": 2,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "project": "github.com/mindcraft-bots/mindcraft",
        "pack": args.pack,
        "pack_index_schema_version": 2 if (schems_dir / "index.json").is_file() else None,
        "requested_constraints": {"minecraft_version": args.minecraft_version, "data_version": args.data_version},
        "scope": f"All blueprint JSONs in schematics/blueprints/{args.pack} and explicit-target versioned schematics in schematics/schems/{args.pack}; deterministic regeneration uses temporary output only.",
        "versions": version_lines,
        "commands": {
            "binary": "python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/<pack>/<name>.json schematics/schems/<pack>/<name>.mc<MC_VERSION>.schem --target-version <MC_VERSION>",
            "production_reader": "node schematics/tooling/validate_blueprint.mjs schematics/blueprints/<pack>/<name>.json schematics/schems/<pack>/<name>.mc<MC_VERSION>.schem <MC_VERSION>",
            "deterministic": "python3 schematics/tooling/compile_blueprint.py compile <blueprint.json> <temporary.schem> [--target-version <MC_VERSION>]",
            "varint": "python3 schematics/tooling/compile_blueprint.py test-varints",
            "npm_test": "npm run test:schematic",
        },
        "coverage": {"blueprint_count": len(blueprint_files), "schematic_count": sum(item["schematic"]["nonempty"] for item in builds),
                      "notes_nonempty_count": sum(item["validation_notes"]["nonempty"] for item in builds), "artifact_issues": artifact_issues},
        "tests": {
            "varint": {"command": varint["command"], "exit_code": varint["exit_code"], "result": "PASS" if varint["exit_code"] == 0 else "FAIL", "log": varint["log"], "output": varint["output"]},
            "npm_test": {"command": npm_test["command"], "exit_code": npm_test["exit_code"], "result": "PASS" if npm_test["exit_code"] == 0 else "FAIL", "log": npm_test["log"], "output": npm_test["output"]},
        },
        "builds": builds,
    }
    audit["summary"] = {
        "build_count": len(builds),
        "binary_pass": sum(b["checks"]["binary"]["result"] == "PASS" for b in builds),
        "binary_fail": sum(b["checks"]["binary"]["result"] != "PASS" for b in builds),
        "deterministic_pass": sum(b["checks"]["deterministic_regeneration"]["result"] == "PASS" for b in builds),
        "deterministic_fail": sum(b["checks"]["deterministic_regeneration"]["result"] != "PASS" for b in builds),
        "reader_pass": sum(b["checks"]["production_reader"]["result"] == "PASS" for b in builds),
        "reader_mismatch": sum(b["checks"]["production_reader"]["result"] == "MISMATCH" for b in builds),
        "reader_error": sum(b["checks"]["production_reader"]["result"] in ("ERROR", "NOT_RUN") for b in builds),
    }
    output_path = validation_dir / "batch_validation.json"
    output_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_report(audit, report_path, args.pack)
    print(json.dumps({"audit": rel(output_path), "report": rel(report_path), "pack": args.pack,
                      "builds": audit["summary"], "coverage": audit["coverage"],
                      "tests": {key: value["exit_code"] for key, value in audit["tests"].items()}}, ensure_ascii=False, indent=2))
    failed = bool(artifact_issues) or any(
        check["result"] != "PASS"
        for item in builds for check in item["checks"].values()
    ) or varint["exit_code"] != 0 or npm_test["exit_code"] != 0
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
