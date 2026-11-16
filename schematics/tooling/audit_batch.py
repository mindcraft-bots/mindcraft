#!/usr/bin/env python3
"""Reproducibly audit every 02–19 blueprint without touching canonical artifacts."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCHEMATICS = ROOT / "schematics"
BLUEPRINTS = SCHEMATICS / "blueprints"
VALIDATION = SCHEMATICS / "validation"
COMPILER = SCHEMATICS / "compile_blueprint.py"
READER_VALIDATOR = SCHEMATICS / "validate_blueprint.mjs"
BEGIN = "<!-- BEGIN GENERATED BATCH AUDIT -->"
END = "<!-- END GENERATED BATCH AUDIT -->"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_logged(command: list[str], cwd: Path, log_path: Path) -> dict:
    completed = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, check=False)
    rendered = "$ " + " ".join(command) + f"\n[exit code: {completed.returncode}]\n" + completed.stdout
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(rendered, encoding="utf-8")
    return {"command": command, "exit_code": completed.returncode,
            "output": completed.stdout, "log": str(log_path.relative_to(ROOT))}


def parse_json_output(check: dict) -> dict | None:
    try:
        return json.loads(check["output"])
    except (TypeError, json.JSONDecodeError):
        return None


def file_meta(path: Path) -> dict:
    return {"path": str(path.relative_to(ROOT)), "bytes": path.stat().st_size,
            "sha256": sha256(path), "nonempty": path.stat().st_size > 0}


def record_summary(audit: dict) -> str:
    rows = []
    for item in audit["builds"]:
        bp = Path(item["blueprint"]["path"]).name
        schem = Path(item["schematic"]["path"]).name
        stem = Path(bp).stem
        dims = item.get("dimensions")
        dim_text = "×".join(map(str, dims)) if dims else "—"
        non_air = item.get("non_air_count", "—")
        reader = item["checks"]["production_reader"]["result"]
        if reader == "PASS":
            reader_text = f"PASS ({item['checks']['production_reader'].get('compared_voxels', 0)} voxels)"
        elif reader == "MISMATCH":
            reader_text = f"MISMATCH ({item['checks']['production_reader'].get('mismatch_count', '?')} voxels; exit {item['checks']['production_reader']['exit_code']})"
        else:
            reader_text = f"{reader} (exit {item['checks']['production_reader']['exit_code']})"
        title = item.get("title", stem)
        command = f'[`!buildSchematic("{schem}")`](../src/agent/commands/actions.js:492)'
        rows.append(f"| {item['folder']} | {title.replace('|', '\\|')} | [{bp}](blueprints/{bp}) / [{schem}]({schem}) | {dim_text} | {non_air} | {reader_text} | {command} |")

    summary = audit["summary"]
    tests = audit["tests"]
    suite = tests["npm_test"]
    varint = tests["varint"]
    coverage = audit["coverage"]
    section = [
        BEGIN,
        "## Consolidated final audit (generated)",
        "",
        f"Audit timestamp: `{audit['checked_at_utc']}`. Artifacts are existing canonical JSON/.schem pairs; audit regeneration used temporary outputs only.",
        "",
        "| Folder | Title | Blueprint / schematic | X×Y×Z | Non-air | Production-reader result | Build command |",
        "| --- | --- | --- | --- | ---: | --- | --- |",
        *rows,
        "",
        f"**Aggregate:** {summary['build_count']} builds audited across folders 02–19; folder coverage {coverage['covered_count']}/18; {summary['binary_pass']} binary validations passed, {summary['deterministic_pass']} deterministic regenerations matched, {summary['reader_pass']} production-reader full-state passes, {summary['reader_mismatch']} production-reader mismatches, {summary['reader_error']} reader validation errors. No blueprint or canonical schematic was changed.",
        "",
        f"**Tests:** [`npm run test:schematic`](validation/npm_test.log) exit {suite['exit_code']}; VarInt synthetic boundary test including multi-byte values and overlong rejection exit {varint['exit_code']} ([log](validation/varint_test.log)). Full command output is retained in these logs and per-build `validation/build_logs/` files.",
        "",
        "**Interpretation and limits:** binary validity is the independent gzip/NBT/VarInt/full-voxel/count/spot-check result from `nbtlib`; reader mismatches are actual production `readSchematic`/registry comparison failures and are not marked DONE or hidden. A valid binary does not certify visual fidelity: obscured/unprinted details are inferred and are documented per build. Fluids, entities, inventories/complex block-entity NBT, and other non-block details are excluded where the blueprint notes say so. No live-server placement, behavior, or image-fidelity tests were performed. Existing wardrobe assets were excluded and preserved.",
        "",
        f"**Inventory checks:** {coverage['json_count']} prefixed JSON blueprints, {coverage['schematic_count']} matching schematics, and {coverage['notes_nonempty_count']} nonempty per-build validation notes. Missing/empty artifacts: `{json.dumps(coverage['artifact_issues'], ensure_ascii=False)}`. Folder gaps: `{json.dumps(coverage['missing_folders'])}`.",
        "",
        f"Machine-readable results: [batch_validation.json](validation/batch_validation.json). Reproducible runner: [audit_batch.py](audit_batch.py).",
        END,
    ]
    return "\n".join(section)


def update_report(audit: dict) -> None:
    report = SCHEMATICS / "batch_report.md"
    original = report.read_text(encoding="utf-8")
    generated = record_summary(audit)
    if BEGIN in original and END in original:
        before = original.split(BEGIN, 1)[0].rstrip()
        after = original.split(END, 1)[1].lstrip()
        content = before + "\n\n" + generated + ("\n\n" + after if after else "\n")
    else:
        content = original.rstrip() + "\n\n" + generated + "\n"
    report.write_text(content, encoding="utf-8")


def main() -> int:
    VALIDATION.mkdir(parents=True, exist_ok=True)
    build_logs = VALIDATION / "build_logs"
    build_logs.mkdir(parents=True, exist_ok=True)

    version_lines = {
        "node": subprocess.run(["node", "--version"], cwd=ROOT, text=True, capture_output=True).stdout.strip(),
        "npm": subprocess.run(["npm", "--version"], cwd=ROOT, text=True, capture_output=True).stdout.strip(),
        "python": sys.version.split()[0],
        "minecraft": "1.21.4",
        "minecraft_data_version": 4189,
    }
    try:
        import nbtlib
        version_lines["nbtlib"] = nbtlib.__version__
    except Exception as error:
        version_lines["nbtlib"] = f"unavailable: {error}"
    for package in ("minecraft-data", "prismarine-schematic"):
        proc = subprocess.run(["node", "-e", f"console.log(require('{package}/package.json').version)"],
                              cwd=ROOT, text=True, capture_output=True)
        version_lines[package] = proc.stdout.strip() if proc.returncode == 0 else "unavailable"

    builds = []
    artifact_issues = []
    json_files = sorted(p for p in BLUEPRINTS.glob("[0-9][0-9]_*.json") if 2 <= int(p.name[:2]) <= 19)
    folders_found = {p.name[:2] for p in json_files}
    for blueprint_path in json_files:
        stem = blueprint_path.stem
        folder = stem[:2]
        schematic_path = SCHEMATICS / f"{stem}.schem"
        notes_path = BLUEPRINTS / f"{stem}.validation.md"
        bp_data = json.loads(blueprint_path.read_text(encoding="utf-8"))
        item = {
            "folder": folder,
            "title": bp_data.get("source_title", bp_data.get("title", stem)),
            "blueprint": file_meta(blueprint_path),
            "schematic": {"path": str(schematic_path.relative_to(ROOT)), "exists": schematic_path.is_file(),
                          "bytes": schematic_path.stat().st_size if schematic_path.is_file() else 0,
                          "sha256": sha256(schematic_path) if schematic_path.is_file() else None,
                          "nonempty": schematic_path.is_file() and schematic_path.stat().st_size > 0},
            "validation_notes": {"path": str(notes_path.relative_to(ROOT)), "exists": notes_path.is_file(),
                                 "bytes": notes_path.stat().st_size if notes_path.is_file() else 0,
                                 "nonempty": notes_path.is_file() and notes_path.stat().st_size > 0},
            "dimensions": [bp_data.get("width_x"), bp_data.get("height_y"), bp_data.get("length_z")],
            "non_air_count": bp_data.get("non_air_count"),
            "checks": {},
        }
        if not item["blueprint"]["nonempty"]:
            artifact_issues.append(f"empty blueprint: {blueprint_path.relative_to(ROOT)}")
        if not item["schematic"]["nonempty"]:
            artifact_issues.append(f"missing/empty schematic: {schematic_path.relative_to(ROOT)}")
        if not item["validation_notes"]["nonempty"]:
            artifact_issues.append(f"missing/empty validation notes: {notes_path.relative_to(ROOT)}")

        if schematic_path.is_file() and schematic_path.stat().st_size:
            binary = run_logged(["python3", str(COMPILER.relative_to(ROOT)), "validate",
                                 str(blueprint_path.relative_to(ROOT)), str(schematic_path.relative_to(ROOT))],
                                ROOT, build_logs / f"{stem}.binary.log")
            binary_json = parse_json_output(binary)
            item["checks"]["binary"] = {"command": binary["command"], "exit_code": binary["exit_code"],
                                         "result": "PASS" if binary["exit_code"] == 0 else "FAIL",
                                         "log": binary["log"], "output": binary_json or binary["output"]}
            if binary_json:
                item["dimensions"] = binary_json["dimensions"]
                item["non_air_count"] = binary_json["non_air"]
                item["air_count"] = binary_json["air"]
                item["volume"] = binary_json["volume"]
                item["binary_details"] = binary_json

            reader = run_logged(["node", str(READER_VALIDATOR.relative_to(ROOT)),
                                 str(blueprint_path.relative_to(ROOT)), str(schematic_path.relative_to(ROOT))],
                                ROOT, build_logs / f"{stem}.reader.log")
            reader_json = parse_json_output(reader)
            if reader_json and reader["exit_code"] == 0:
                reader_result = "PASS"
            elif reader_json and reader_json.get("parserMismatches", 0) > 0:
                reader_result = "MISMATCH"
            else:
                reader_result = "ERROR"
            item["checks"]["production_reader"] = {
                "command": reader["command"], "exit_code": reader["exit_code"], "result": reader_result,
                "log": reader["log"], "compared_voxels": reader_json.get("comparedVoxels") if reader_json else None,
                "mismatch_count": reader_json.get("parserMismatches") if reader_json else None,
                "count_match": reader_json.get("parserDerivedCountsMatch") if reader_json else None,
                "spot_check_count": reader_json.get("spotChecks") if reader_json else None,
                "spot_check_failures": reader_json.get("spotCheckFailures") if reader_json else None,
                "first_mismatches": reader_json.get("firstMismatches") if reader_json else None,
                "output": reader_json or reader["output"],
            }

            with tempfile.TemporaryDirectory(prefix=f"schematic-audit-{stem}-") as temp_dir:
                temp_output = Path(temp_dir) / f"{stem}.schem"
                regenerate = run_logged(["python3", str(COMPILER.relative_to(ROOT)), "compile",
                                         str(blueprint_path.relative_to(ROOT)), str(temp_output)],
                                        ROOT, build_logs / f"{stem}.determinism.log")
                regenerated_sha = sha256(temp_output) if temp_output.is_file() else None
                deterministic = regenerate["exit_code"] == 0 and regenerated_sha == item["schematic"]["sha256"]
                item["checks"]["deterministic_regeneration"] = {
                    "command": regenerate["command"], "exit_code": regenerate["exit_code"],
                    "result": "PASS" if deterministic else "FAIL", "temporary_output_only": True,
                    "canonical_sha256": item["schematic"]["sha256"], "regenerated_sha256": regenerated_sha,
                    "log": regenerate["log"], "output": regenerate["output"],
                }
        else:
            for check_name in ("binary", "production_reader", "deterministic_regeneration"):
                item["checks"][check_name] = {"result": "NOT_RUN", "exit_code": None}
        builds.append(item)

    varint = run_logged(["python3", str(COMPILER.relative_to(ROOT)), "test-varints"],
                        ROOT, VALIDATION / "varint_test.log")
    npm_test = run_logged(["npm", "run", "test:schematic"], ROOT, VALIDATION / "npm_test.log")
    expected_folders = [f"{number:02d}" for number in range(2, 20)]
    schem_count = sum((SCHEMATICS / f"{Path(item['blueprint']['path']).stem}.schem").is_file() for item in builds)
    notes_count = sum(item["validation_notes"]["nonempty"] for item in builds)
    audit = {
        "schema_version": 1,
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "project": "github.com/mindcraft-bots/mindcraft",
        "scope": "all 02_ through 19_ blueprint JSONs and matching canonical schematics; audit does not modify canonical artifacts, source or dependencies; installed reader patches are exercised",
        "versions": version_lines,
        "reader_dependency_patches": [file_meta(path) for path in sorted((ROOT / "patches").glob("prismarine-schematic+*.patch"))],
        "commands": {
            "binary": "python3 schematics/compile_blueprint.py validate <blueprint.json> <canonical.schem>",
            "production_reader": "node schematics/validate_blueprint.mjs <blueprint.json> <canonical.schem>",
            "deterministic": "python3 schematics/compile_blueprint.py compile <blueprint.json> <temporary.schem>",
            "varint": "python3 schematics/compile_blueprint.py test-varints",
            "npm_test": "npm run test:schematic",
        },
        "coverage": {
            "expected_folders": expected_folders,
            "covered_folders": sorted(folders_found),
            "missing_folders": sorted(set(expected_folders) - folders_found),
            "covered_count": len(folders_found), "json_count": len(json_files),
            "schematic_count": schem_count, "notes_nonempty_count": notes_count,
            "artifact_issues": artifact_issues,
        },
        "tests": {
            "varint": {"command": varint["command"], "exit_code": varint["exit_code"],
                       "result": "PASS" if varint["exit_code"] == 0 else "FAIL", "log": varint["log"], "output": varint["output"]},
            "npm_test": {"command": npm_test["command"], "exit_code": npm_test["exit_code"],
                         "result": "PASS" if npm_test["exit_code"] == 0 else "FAIL", "log": npm_test["log"], "output": npm_test["output"]},
        },
        "builds": builds,
    }
    audit["summary"] = {
        "build_count": len(builds),
        "binary_pass": sum(b["checks"]["binary"]["result"] == "PASS" for b in builds),
        "deterministic_pass": sum(b["checks"]["deterministic_regeneration"]["result"] == "PASS" for b in builds),
        "reader_pass": sum(b["checks"]["production_reader"]["result"] == "PASS" for b in builds),
        "reader_mismatch": sum(b["checks"]["production_reader"]["result"] == "MISMATCH" for b in builds),
        "reader_error": sum(b["checks"]["production_reader"]["result"] in ("ERROR", "NOT_RUN") for b in builds),
    }
    output_path = VALIDATION / "batch_validation.json"
    output_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_report(audit)
    print(json.dumps({"audit": str(output_path.relative_to(ROOT)), "builds": audit["summary"],
                      "coverage": audit["coverage"], "tests": {k: v["exit_code"] for k, v in audit["tests"].items()}},
                     ensure_ascii=False, indent=2))
    return 0 if not artifact_issues and not audit["coverage"]["missing_folders"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
