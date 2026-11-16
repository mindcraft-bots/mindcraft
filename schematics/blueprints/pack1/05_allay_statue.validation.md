# Folder 05 — Allay statue validation

## Result

**Overall: PASS.** The permanent source blueprint ([`05_allay_statue.json`](05_allay_statue.json)) was compiled unchanged to [`05_allay_statue.schem`](../05_allay_statue.schem). The compiled Sponge v2 NBT uses DataVersion 4189 and gzip compression.

| Check | Result |
| --- | --- |
| Dimensions | 17 × 14 × 6 (volume 1,428) |
| Non-air / air | 284 / 1,144 |
| Palette | 13 states: air, eight non-stair block states, and four stair-facing states |
| Blueprint spot checks | 23/23 passed |
| Independent binary validation | PASS; all 1,428 voxels, counts, palette, dimensions, tags, and spot checks validated |
| Canonical VarInt tests | PASS; 1–5 byte boundaries accepted and overlong encoding rejected |
| Registry validation | PASS; all 13 legend states valid in the Minecraft 1.21.4 registry |
| Production-reader validation | PASS; 1,428/1,428 full states, including air, match; no parser mismatches |
| Deterministic compile | PASS; temporary second compile was byte-identical and SHA-256 matched |
| Artifact presence | PASS; both source JSON and compiled schematic are nonempty |

## Commands and results

Run from the repository root. The commands below were run against only this folder05 blueprint and its output.

1. Compile using Python `nbtlib`; compilation also reloads and independently validates the gzip Sponge v2 NBT:

   `python3` [`compile_blueprint.py`](../compile_blueprint.py) `compile` [`05_allay_statue.json`](05_allay_statue.json) [`05_allay_statue.schem`](../05_allay_statue.schem)

   Result: DataVersion 4189; 17 × 14 × 6; volume 1,428; block-data stream 1,428 bytes; 284 non-air; 1,144 air; 13 palette entries; 23 spot checks; 509-byte output.

2. Independently validate the compiled binary and exercise canonical VarInt boundary cases:

   `python3` [`compile_blueprint.py`](../compile_blueprint.py) `validate` [`05_allay_statue.json`](05_allay_statue.json) [`05_allay_statue.schem`](../05_allay_statue.schem)

   `python3` [`compile_blueprint.py`](../compile_blueprint.py) `test-varints`

   Result: binary validation passed with the expected dimensions, volume, counts, palette and all 23 spot checks. VarInt tests passed for 1-, 2-, 3-, 4- and 5-byte values and rejected overlong encoding.

3. Validate registry states, then compare every voxel and full canonical state through the production reader:

   `node` [`validate_blueprint.mjs`](../validate_blueprint.mjs) [`05_allay_statue.json`](05_allay_statue.json) [`05_allay_statue.schem`](../05_allay_statue.schem)

   Result: registry `minecraft-data` 1.21.4; 13/13 legend entries valid; dimensions and counts match; 1,428/1,428 voxel and state comparisons passed, including all air cells; parser-derived counts matched; 23/23 spot checks passed; zero parser mismatches.

4. Determinism and nonempty-artifact checks:

   Re-ran `python3` [`compile_blueprint.py`](../compile_blueprint.py) `compile` [`05_allay_statue.json`](05_allay_statue.json) to a fresh temporary output, then compared it byte-for-byte with [`05_allay_statue.schem`](../05_allay_statue.schem) using `cmp -s` and compared SHA-256 using `sha256sum`. Both outputs had SHA-256 `b835dd1491230d604dd1596073837b81feedb517bf48405f33241d16aa9676cb`; comparison passed.

   `test -s` passed for both source and output. Sizes: JSON 13,514 bytes; schematic 509 bytes.

## Material inventory

The nine distinct printed block material types are represented by twelve non-air palette states because the stone-brick stair material has four explicit facing states. Counts below come from the blueprint and were independently matched by both validators.

| Printed material / block state | Count |
| --- | ---: |
| White concrete (`minecraft:white_concrete`) | 4 |
| Light-blue concrete (`minecraft:light_blue_concrete`) | 130 |
| Light-blue wool (`minecraft:light_blue_wool`) | 46 |
| Cyan concrete (`minecraft:cyan_concrete`) | 29 |
| Sea lantern (`minecraft:sea_lantern`) | 9 |
| Chiseled stone bricks (`minecraft:chiseled_stone_bricks`) | 12 |
| Stone bricks (`minecraft:stone_bricks`) | 24 |
| Stone (`minecraft:stone`) | 18 |
| Stone-brick stairs, facing east; half=top, shape=straight, waterlogged=false | 3 |
| Stone-brick stairs, facing north; half=top, shape=straight, waterlogged=false | 3 |
| Stone-brick stairs, facing south; half=top, shape=straight, waterlogged=false | 3 |
| Stone-brick stairs, facing west; half=top, shape=straight, waterlogged=false | 3 |
| Air (`minecraft:air`) | 1,144 |

## Geometry notes and limitations

The blueprint preserves the architect's explicit states and inferred assembled envelope unchanged. It records a printed 5×5×5 head cube, 3×3×5 torso, two 8×4 wing silhouettes, two four-block arms, and a 5×5×3 pedestal. Component offsets and the overall 17×14×6 envelope are inferred from the render, not printed measurements. A one-block air gap floats the statue above the pedestal. Concealed geometry includes the solid head interior, inferred torso/rear patterns and wing thickness/symmetry, and the pedestal's concealed stone core and stair half/orientation choices; cutouts and pixel boundaries are approximations. The blueprint documents the assumptions in full, and no geometry or intended block states were altered to accommodate validation.

This validates local NBT consistency, registry legality, and the installed production-reader output only. It does not establish unique photographic reconstruction, neighbor-update appearance, survival placement feasibility, pathfinding, or live-server build success. **No live-server tests were run.**
