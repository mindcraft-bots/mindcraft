# Folder 18 validation: Giant grandfather clock

## Inputs and output

- Preserved source blueprint: [18_giant_grandfather_clock.json](18_giant_grandfather_clock.json). Its geometry and state values were not edited; no alphabetic property-order normalization was needed.
- Compiled output: [18_giant_grandfather_clock.schem](../18_giant_grandfather_clock.schem).
- Tooling instructions: [BLUEPRINT_TOOLING.md](../BLUEPRINT_TOOLING.md). No compiler, validator, dependency, or unrelated source was changed.
- Format: gzip-compressed Sponge v2 NBT, DataVersion 4189, dimensions 13 × 33 × 11, zero offset, 4,719 total voxels, 1,309 non-air and 3,410 air, 52 palette entries, 4,719 block-data bytes.
- Final file size: 1,438 bytes. SHA-256: `87ea5d4a5747d9a09e898670f6fa570c6710e3a7fb3c4f06961c2c5cd33916a6`.

## Validation results

- Compile: [`python3 schematics/compile_blueprint.py compile schematics/blueprints/18_giant_grandfather_clock.json schematics/18_giant_grandfather_clock.schem`](../compile_blueprint.py) — PASS. This also reloads and verifies the NBT with nbtlib.
- Independent binary validation: [`python3 schematics/compile_blueprint.py validate schematics/blueprints/18_giant_grandfather_clock.json schematics/18_giant_grandfather_clock.schem`](../compile_blueprint.py) — PASS. Confirmed tag types, DataVersion, dimensions, zero offset, complete 52-state palette, canonical signed-byte VarInt stream and ordering, full voxel decode, volume and all expected state counts.
- VarInt boundary test: [`python3 schematics/compile_blueprint.py test-varints`](../compile_blueprint.py) — PASS; 1-, 2-, 3-, 4-, and 5-byte boundaries accepted and overlong encoding rejected.
- Application validation: [`node schematics/validate_blueprint.mjs schematics/blueprints/18_giant_grandfather_clock.json schematics/18_giant_grandfather_clock.schem`](../validate_blueprint.mjs) — PASS against the installed Minecraft 1.21.4 full-state registry and production schematic reader. All 4,719/4,719 voxels (air included) compared; 0 mismatches. All 52 legend entries registry-validated; all 19 spot checks passed; derived counts matched (3,410 air, 1,309 non-air).
- Determinism: ran the compile command above a second time with its output directed inside a fresh `mktemp -d` directory; the two [`sha256sum`](../18_giant_grandfather_clock.schem) values matched the output hash above, and [`cmp`](../18_giant_grandfather_clock.schem) reported byte-identical output. The temporary directory was removed.

## Exact voxel/state counts

| Full block state | Voxels |
| --- | ---: |
| minecraft:air | 3,410 |
| minecraft:bookshelf | 14 |
| minecraft:brick_stairs[facing=south,half=bottom,shape=straight,waterlogged=false] | 1 |
| minecraft:bricks | 19 |
| minecraft:campfire[facing=south,lit=false,signal_fire=false,waterlogged=false] | 1 |
| minecraft:chain[axis=x,waterlogged=false] | 2 |
| minecraft:chain[axis=y,waterlogged=false] | 2 |
| minecraft:cobweb | 1 |
| minecraft:daylight_detector[inverted=false,power=0] | 1 |
| minecraft:deepslate_brick_slab[type=bottom,waterlogged=false] | 2 |
| minecraft:deepslate_brick_slab[type=double,waterlogged=false] | 49 |
| minecraft:deepslate_brick_stairs[facing=east,half=bottom,shape=straight,waterlogged=false] | 21 |
| minecraft:deepslate_brick_stairs[facing=west,half=bottom,shape=straight,waterlogged=false] | 21 |
| minecraft:deepslate_bricks | 2 |
| minecraft:dispenser[facing=south,triggered=false] | 1 |
| minecraft:glass_pane[east=false,north=true,south=true,waterlogged=false,west=false] | 24 |
| minecraft:gray_concrete | 50 |
| minecraft:ladder[facing=south,waterlogged=false] | 17 |
| minecraft:lightning_rod[facing=up,powered=false,waterlogged=false] | 8 |
| minecraft:potted_fern | 1 |
| minecraft:red_carpet | 8 |
| minecraft:redstone_wire[east=none,north=side,power=0,south=side,west=none] | 3 |
| minecraft:smooth_quartz | 184 |
| minecraft:smooth_quartz_slab[type=bottom,waterlogged=false] | 9 |
| minecraft:smooth_quartz_stairs[facing=east,half=bottom,shape=straight,waterlogged=false] | 44 |
| minecraft:smooth_quartz_stairs[facing=east,half=top,shape=straight,waterlogged=false] | 2 |
| minecraft:smooth_quartz_stairs[facing=west,half=bottom,shape=straight,waterlogged=false] | 45 |
| minecraft:smooth_quartz_stairs[facing=west,half=top,shape=straight,waterlogged=false] | 2 |
| minecraft:spruce_button[face=wall,facing=south,powered=false] | 7 |
| minecraft:spruce_door[facing=south,half=lower,hinge=left,open=false,powered=false] | 1 |
| minecraft:spruce_door[facing=south,half=upper,hinge=left,open=false,powered=false] | 1 |
| minecraft:spruce_fence[east=false,north=false,south=false,waterlogged=false,west=false] | 23 |
| minecraft:spruce_planks | 591 |
| minecraft:spruce_slab[type=bottom,waterlogged=false] | 11 |
| minecraft:spruce_slab[type=double,waterlogged=false] | 32 |
| minecraft:spruce_slab[type=top,waterlogged=false] | 11 |
| minecraft:spruce_stairs[facing=east,half=bottom,shape=straight,waterlogged=false] | 3 |
| minecraft:spruce_stairs[facing=east,half=top,shape=straight,waterlogged=false] | 8 |
| minecraft:spruce_stairs[facing=north,half=bottom,shape=straight,waterlogged=false] | 2 |
| minecraft:spruce_stairs[facing=north,half=top,shape=straight,waterlogged=false] | 13 |
| minecraft:spruce_stairs[facing=south,half=top,shape=straight,waterlogged=false] | 16 |
| minecraft:spruce_stairs[facing=west,half=bottom,shape=straight,waterlogged=false] | 3 |
| minecraft:spruce_stairs[facing=west,half=top,shape=straight,waterlogged=false] | 8 |
| minecraft:spruce_trapdoor[facing=east,half=bottom,open=true,powered=false,waterlogged=false] | 13 |
| minecraft:spruce_trapdoor[facing=north,half=bottom,open=true,powered=false,waterlogged=false] | 1 |
| minecraft:spruce_trapdoor[facing=south,half=bottom,open=true,powered=false,waterlogged=false] | 1 |
| minecraft:spruce_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false] | 13 |
| minecraft:stripped_spruce_log[axis=z] | 1 |
| minecraft:torch | 1 |
| minecraft:waxed_cut_copper | 11 |
| minecraft:waxed_cut_copper_stairs[facing=east,half=bottom,shape=straight,waterlogged=false] | 2 |
| minecraft:waxed_cut_copper_stairs[facing=west,half=bottom,shape=straight,waterlogged=false] | 2 |
| **Total** | **4,719** |

Nineteen configured spot checks were tested in both validators, with zero failures. They cover foundation, both door halves, hatch ladder, pendulum materials and rod, dial hub/hands, side pane, empty dispenser, daylight detector, chimney endpoints, roof ridge/eave, air in the envelope, fireplace, bookshelf, and cobweb.

## Blueprint audit and limits

The authored printed-callout audit ties the build to a 7 × 7 × 7 starting room, subsequent spruce floor/wall levels, a 15-block chimney, a gray-concrete/copper pendulum, an upper clock head and dial, glass windows, a quartz/spruce/deepslate roof, and static dispenser/redstone/daylight-detector geometry. It also records integrated bookshelves, carpet, fern, benches, fireplace, and cobweb. The material audit covers those components; the distinct-build audit treats all construction stages and cutaway views as one clock and excludes background buildings and player/chicken entities.

The source cautions that only the original room dimensions and incremental heights/chimney height are printed. The total 13 × 33 × 11 envelope, upper width, cornice depths, roof pitch/overhang, rear surfaces, hidden redstone paths, some pendulum/dial details, and exact interior placements are inferred. The chosen double-slab foundation interpretation is explicitly uncertain. Spruce fence connections are static and can change after neighboring updates. The dispenser has no inventory; eggs, entities, active campfire behavior, fluids, and complex NBT are excluded. Redstone continuity, placement physics, and live-server behavior were not tested or claimed.

The tooling documentation notes an upstream parser state-ID conversion limitation for some integer-valued properties with nonzero minima (example: pink candle count). No such state occurs in this blueprint, and this run's full reader state comparison passed; the general parser limitation is not hidden or worked around.
