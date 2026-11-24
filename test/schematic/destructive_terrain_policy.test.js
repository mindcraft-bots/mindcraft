import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { isReviewedDestructiveTerrain } from "../../src/utils/schematic/destructive_terrain_policy.js";

const require = createRequire(import.meta.url);
const registry = require("minecraft-data")("1.20.4");
const Block = require("prismarine-block")("1.20.4");
const bot = { version: "1.20.4", registry };
const block = name => Block.fromStateId(registry.blocksByName[name].defaultState, 0);

test("reviewed terrain classification is restricted to stateless dirt and plain stone", () => {
  for (const name of ["dirt", "stone"]) assert.equal(isReviewedDestructiveTerrain(bot, block(name)), true, name);
  for (const name of ["air", "grass_block", "coarse_dirt", "granite", "cobblestone", "sand", "diamond_ore", "chest", "birch_leaves", "oak_log", "poppy"]) {
    assert.equal(isReviewedDestructiveTerrain(bot, block(name)), false, name);
  }
});

test("reviewed terrain classification fails closed on attached data, incomplete state or registry", () => {
  for (const mutate of [
    b => { b.nbt = {}; }, b => { b.entity = {}; }, b => { Object.defineProperty(b, "blockEntity", { value: {} }); },
    b => { b._blockEntity = {}; }, b => { b.diggable = false; },
    b => { b.getProperties = () => ({ waterlogged: false }); },
    b => { b.getProperties = () => null; }, b => { b.getProperties = () => { throw new Error("unavailable"); }; },
  ]) {
    const candidate = block("stone");
    mutate(candidate);
    assert.equal(isReviewedDestructiveTerrain(bot, candidate), false);
  }
  assert.equal(isReviewedDestructiveTerrain({ ...bot, version: "unknown" }, block("stone")), false);
  assert.equal(isReviewedDestructiveTerrain({ ...bot, registry: {} }, block("stone")), false);
  const altered = { ...registry.blocksByName.stone, id: -1 };
  assert.equal(isReviewedDestructiveTerrain({ ...bot, registry: { blocksByName: { stone: altered } } }, block("stone")), false);
});
