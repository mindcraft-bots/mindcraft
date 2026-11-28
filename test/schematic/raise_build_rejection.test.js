import assert from "node:assert/strict";
import test from "node:test";
import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";
import { resolvePlacementOptions } from "../../src/utils/schematic/placement_options.js";

const options = resolvePlacementOptions({ schematic_placement_mode: "raise" });

function fixture(world, session = undefined) {
  const calls = [];
  const logs = [];
  const unexpected = name => () => { calls.push(name); throw new Error(`Unexpected ${name}`); };
  const bot = {
    game: { gameMode: "creative", dimension: "overworld" }, world,
    blockAt: unexpected("read"), dig: unexpected("dig"), placeBlock: unexpected("place"),
    equip: unexpected("equip"), chat: unexpected("chat"),
    creative: { setInventorySlot: unexpected("slot") },
    pathfinder: { goto: unexpected("navigation") },
  };
  const dependencies = {
    placementOptions: options, resumeSession: session, writeLog: message => logs.push(message),
    resolvePath: unexpected("resolve"), makeBuild: unexpected("plan"),
    startSupply: unexpected("supply"), changeGameMode: unexpected("mode"),
    executeBuild: unexpected("builder"), clearObstructions: unexpected("clear"),
  };
  return { bot, calls, logs, run: () => buildSchematic(bot, "synthetic.schem", 0, 64, 0, dependencies) };
}

test("raise recovery is disabled and a saved session is cancelled before any operation", async () => {
  const session = { cancelled: false, resumeEligible: true, context: { placementOptions: options, origin: { x: 0, y: 64, z: 0 } } };
  const f = fixture({}, session);
  assert.equal(await f.run(), false);
  assert.equal(session.cancelled, true);
  assert.equal(session.resumeEligible, false);
  assert.equal(session.context, null);
  assert.deepEqual(f.calls, []);
});
