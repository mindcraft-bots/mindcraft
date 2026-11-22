# Focused pack1 integration review

Identifier displays in this historical review were normalized later to separate group and ID fields; numerical meanings and recorded outcomes are unchanged.

## Preserved wardrobe byte-rebuild failure

The [original wardrobe schematic](../../../schems/pack1/01_wardrobe_nether_portal.schem) remains 535 bytes, SHA-256 **8deb5fee1a8930b321ad9ff066b955854bb4caedf8f5a8cf17eb710c5da7a383**. A temporary rebuild of the HEAD legacy blueprint is 505 bytes, SHA-256 **a6ec7d5919590a27d895af6081a8080ae2b804e271a45c247d4a56164ecea886** on zlib 1.3.1. The original matches all 168 legacy voxels, including 90 non-air cells. The current repaired blueprint intentionally changes four door hinge voxels; the 1.21.4 variant matches that repaired blueprint voxel-for-voxel. Exact legacy byte reproducibility remains **FAIL**; the historical [audit](batch_validation.json) is not a current validation run.

The [diagnostic regression test](../../../../test/schematic/wardrobe_reproducibility.test.js) compiles twice into temporary files, compares headers, decompressed NBT, palette mappings and decoded states, and logs structured evidence with the WARDROBE_REBUILD_DIAGNOSIS marker in the [full test log](npm_test.log). It also proves that changing only the following encoding choices reconstructs all 535 original bytes in memory:

| Layer | Original asset | Current compiler |
| --- | --- | --- |
| Palette IDs | Legend insertion order; dark oak planks = 1, obsidian = 2 | Lexically sorted states; dark oak planks = 6, obsidian = 13 |
| Root tag order | Palette before PaletteMax | PaletteMax before Palette |
| Block data | Indices into the original palette | Remapped indices into the sorted palette; identical decoded states |
| Gzip first ten bytes | 1f8b0808c1eef96a02ff | 1f8b08000000000002ff |
| Gzip filename | wardrobe_nether_portal.schem | No embedded filename |
| Gzip modification time | 1794764481; 2026-11-15 17:41:21 UTC | Zero |
| Gzip trailer | 9c0881f6d4050000 | 16db9e95d4050000 |
| Decompressed SHA-256 | bb3ffe6c546bb32b5c535254db7980406f21d845ec67a75dac85e2c204dc8ade | 1c623daf9879dc4a0dc78fff9c2a470f1fa1b5e482d8ccfbde5d969f3cf2c309 |

All other NBT tags, tag types, root name, dimensions, offset and empty entity lists match. Both uncompressed streams are 1492 bytes; their different CRCs are explained by the palette/tag encoding, not by voxel corruption. This is **not** merely a timestamp difference, and normalizing only the gzip header is insufficient.

Available Git history confirms that the asset is byte-identical to the 535-byte file introduced in commit 9228ba0; commit b4f562f relocated it without changing the bytes. The [compiler](../../compile_blueprint.py:129) already sorted palette states, wrote the size tag first, and cleared gzip filename/time in commit 9228ba0. Thus the mismatch predates the multiple-pack changes. The original writer's source/provenance was not found in the available history; its filename and timestamp are observed from the asset, not independently supplied build inputs.

**Disposition:** do not special-case the asset in the compiler, accept semantic equality as a byte pass, replace the historical hash, or overwrite the original. Reconstructing bytes using metadata copied from the asset diagnoses the cause but does not independently reproduce it. Exact regeneration would require a separately reviewed, provenance-backed legacy serialization profile and its inputs, or an explicitly approved normalized derivative stored separately from the original. Until then, retain the audit failure and original asset. Historical logs and report text outside the generated audit section are not rewritten.

## Runtime integration and remaining placement limitations

The [real-pack integration tests](../../../../test/schematic/real_pack_integration.test.js) enumerate 30 manifest entries and 90 physical files, check version selection, resolve every ID, stem and filename, and read all 60 explicit variants. Public wardrobe selectors reach the real reader and planner but are refused before world mutation because door placement has an unproven multi-block physics footprint. A simulated bee build tests reader and planner integration; it is not evidence of actual Minecraft placement.

This exposed missing inventory mappings for wall banners and cocoa. The narrow [adapter fix](../../../../src/utils/schematic/modern_build.js:9) maps wall banners to the corresponding colored banner item and cocoa to cocoa beans while preserving requested block states. The [adapter tests](../../../../test/schematic/modern_build.test.js) cover both mappings. Actual banner orientation, cocoa attachment/growth, and other server state transitions remain untested.

Current canonical build-plan preflight accepts **22/30** assets on both tested engines. Six containing multi-block placements are refused for safety, including the wardrobe; the pagoda and giant grandfather clock fail on potted plant mappings. Potted plants require pot placement followed by planting, not a fake single inventory-item alias. No fallback or geometry change was added. The binary/reader audit does not measure live placeability.

The [tooling tests](../../../../test/schematic/tooling_paths.test.js) exercise repository-relative inputs from another working directory, another positive-numbered pack path, Minecraft 1.20.4 / DataVersion 3700, and rejection of explicit version mismatches, incorrect DataVersion, unavailable versions and outside-repository inputs. Version support is limited by the installed registry and reader; it is not arbitrary-version support. Tool executable paths still have to be reachable from the shell's working directory.

No live server, Minecraft whisper delivery, server permission provider, or LLM natural-language request was tested. Private-message routing was inspected in source only. Image fidelity and actual world placement were not tested.

## Historical audit and test results

The following records an earlier validation, not the current suite or current repaired blueprint. The later reported full-suite result was 163 passed, 9 failed and 3 cancelled; see current focused test output for the fixes, not these historical counts.

The subsequent focused run of 16 related test files passed 127 tests with zero failures or cancellations. The full suite was not rerun, and no live server placement was tested.

| Check | Result |
| --- | --- |
| [Full pack1 audit run](integration_pack1_audit.log) | Exit 1: binary 30/30, production reader 30/30, deterministic bytes 29/30; only wardrobe fails bytes |
| [Full schematic suite](npm_test.log) | Exit 0: 78 tests passed, zero failed or skipped |
| [VarInt boundaries](varint_test.log) | Exit 0: canonical 1–5 byte values and overlong-encoding rejection pass |
| [Separate temporary-pack audit](integration_other_pack_audit.json) | Exit 0: one stone voxel, Minecraft 1.20.4 / DataVersion 3700; binary, reader, byte rebuild and both test commands pass |

The temporary second pack used a newly allocated positive numeric pack name, an explicit ID manifest, matching blueprint/schematic files and validation notes. Its full 78-test suite also passed. The evidence records its actual paths and command; those scratch directories and their generated outputs were then removed, rather than left as user assets. All 30 canonical binary assets and all blueprint JSONs were verified unchanged by this review. Existing historical validation evidence and report text outside the generated audit section were preserved. Current moved-tooling references in the schematic guides/prompts resolve; unrelated pre-existing root README links to the absent local settings file were not changed.
