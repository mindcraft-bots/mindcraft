import { isSchematicAirName, requireSchematicCells } from "./obstruction_policy.js";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createTrustedStateReader, hasObservedBlockEntity, sameStateProperties } from "./trusted_block_state.js";

/**
 * Advisory, read-only classification of an already transformed, fixed-origin plan.
 * This is not an authorization, a durable snapshot, or proof of placement safety.
 * Callers must establish world identity and lease, and revalidate before any edits.
 */
function* inspectContinuation(bot, build, Vec3Class, check = () => {}, validatedCells = null) {
  if (typeof bot?.blockAt !== "function" || typeof Vec3Class !== "function")
    throw new TypeError("Continuation analysis requires a world reader and vector class");
  if (Array.isArray(build?.cells) && build.cells.length > 250_000)
    throw new Error("Continuation analysis exceeds inspection budget");
  const cells = validatedCells ?? requireSchematicCells(build);
  const reader = createTrustedStateReader(bot);
  const counts = { exact: 0, missing: 0, air: 0, conflicts: 0, unloaded: 0, blockEntities: 0 };
  const results = [];
  for (const cell of cells) {
    check();
    let expectedProperties;
    try {
      expectedProperties = reader.validate(cell.name, cell.stateId, cell.properties);
    } catch {
      throw new Error("Continuation analysis requires valid expected names, state IDs and properties");
    }
    const position = { ...cell.position };
    let block, actual, entity = false;
    try {
      block = bot.blockAt(new Vec3Class(position.x, position.y, position.z));
      entity = hasObservedBlockEntity(block);
      if (!block) throw new Error("Unavailable block");
      actual = reader.read(block);
    } catch {
      const category = entity ? "conflicts" : "unloaded";
      if (entity) counts.blockEntities++;
      counts[category]++;
      results.push({ position, category, blockEntity: entity });
      yield;
      continue;
    }
    const expectedAir = isSchematicAirName(cell.name);
    const actualAir = isSchematicAirName(actual.name);
    let category;
    if (entity) {
      counts.blockEntities++;
      category = "conflicts";
    } else if (expectedAir && actualAir) category = "air";
    else if (!expectedAir && actualAir) category = "missing";
    else if (!expectedAir && actual.name === cell.name && actual.stateId === cell.stateId
        && sameStateProperties(actual.properties, expectedProperties)) category = "exact";
    else category = "conflicts";
    counts[category]++;
    results.push({ position, category, ...actual, blockEntity: entity });
    yield;
  }
  check();
  return { counts, cells: results };
}

export function analyzeContinuation(bot, build, Vec3Class) {
  const inspection = inspectContinuation(bot, build, Vec3Class);
  let step;
  do { step = inspection.next(); } while (!step.done);
  return step.value;
}

export async function analyzeContinuationAsync(bot, build, Vec3Class, check = () => {}) {
  const deadline = performance.now() + 2000;
  const checked = () => {
    check();
    if (performance.now() >= deadline) throw new Error("Continuation analysis timed out");
  };
  const cells = build?.cells;
  const { width, height, length } = build?.dimensions ?? {};
  const volume = width * height * length;
  if (!Array.isArray(cells) || !cells.length || ![width, height, length].every(v => Number.isSafeInteger(v) && v > 0)
      || !Number.isSafeInteger(volume) || volume > 250_000 || cells.length !== volume)
    throw new Error("Continuation analysis requires every cell in a bounded transformed volume");
  const seen = new Set(), min = { x: Infinity, y: Infinity, z: Infinity };
  let validated = 0;
  for (const cell of cells) {
    checked();
    const p = cell?.position;
    if (!p || ![p.x, p.y, p.z].every(Number.isSafeInteger)) throw new Error("Invalid continuation cell position");
    const key = `${p.x},${p.y},${p.z}`;
    if (seen.has(key)) throw new Error("Duplicate continuation cell position");
    seen.add(key);
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    if (++validated % 128 === 0) { await yieldToEvents(); checked(); }
  }
  for (const { position: p } of cells) {
    checked();
    if (p.x < min.x || p.x >= min.x + width || p.y < min.y || p.y >= min.y + height || p.z < min.z || p.z >= min.z + length)
      throw new Error("Continuation cells do not form the declared rectangular bounds");
    if (++validated % 128 === 0) { await yieldToEvents(); checked(); }
  }
  const inspection = inspectContinuation(bot, build, Vec3Class, checked, cells);
  let count = 0, step;
  while (!(step = inspection.next()).done) {
    if (++count % 128 === 0) { await yieldToEvents(); checked(); }
  }
  return step.value;
}
