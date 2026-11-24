import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import { captureSchematicAttemptIdentity, isSchematicAttemptIdentityCurrent, requireSchematicCells } from "./obstruction_policy.js";
import { assertBalancedTargets, isSupportedBalancedPassiveState } from "./balanced_physics_policy.js";

// This is a deliberately narrow local screen, not a general physics or terrain
// provenance detector. In particular, a player can have placed natural blocks.
const GROUND = new Set(["stone", "granite", "diorite", "andesite", "deepslate", "tuff", "calcite", "dirt", "coarse_dirt", "rooted_dirt", "grass_block", "podzol", "mycelium", "mud", "clay", "netherrack", "end_stone", "basalt", "blackstone"]);
const AIR = new Set(["air", "cave_air", "void_air"]);
const MARGIN = 2;
const HARD = Object.freeze({ footprint: 256, height: 64, rise: 32, depth: 32, edits: 4096, reads: 100000, milliseconds: 2000 });
const plans = new WeakMap();
const key = p => `${p.x},${p.y},${p.z}`;
const error = (code, message) => Object.assign(new Error(message), { code });
const unsafe = message => error("SCHEMATIC_SITE_UNSAFE", message);
const budget = message => error("SCHEMATIC_SITE_BUDGET", message);
const frozenPosition = p => Object.freeze({ x: p.x, y: p.y, z: p.z });

function limitsFor(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid site limits");
  for (const name of Object.keys(input)) if (!Object.hasOwn(HARD, name)) throw new TypeError(`Unknown site limit ${name}`);
  const result = {};
  for (const [name, max] of Object.entries(HARD)) {
    const value = input[name] ?? max;
    const min = name === "rise" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid site limit ${name}`);
    result[name] = value;
  }
  return Object.freeze(result);
}

function propertiesOf(block) {
  let value;
  try { value = typeof block.getProperties === "function" ? block.getProperties() : (block.properties ?? block._properties); }
  catch { throw unsafe("Block properties are unavailable"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unsafe("Block properties are unavailable");
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    if (!["string", "boolean", "number"].includes(typeof item) || (typeof item === "number" && !Number.isFinite(item))) throw unsafe("Invalid block properties");
    result[name] = item;
  }
  return Object.freeze(result);
}

function state(bot, block, position) {
  if (!block || typeof block.name !== "string" || !block.name) throw unsafe(`Unavailable block at ${key(position)}`);
  if (block.entity != null || block.blockEntity != null || block._blockEntity != null || block.nbt != null) throw unsafe(`Block entity at ${key(position)}`);
  const snapshot = { position: frozenPosition(position), name: block.name, properties: propertiesOf(block) };
  if (!isSupportedBalancedPassiveState(bot.registry, snapshot)) throw unsafe(`Unsupported state ${block.name} at ${key(position)}`);
  return Object.freeze(snapshot);
}

function fullCube(block) {
  return Array.isArray(block.shapes) && block.shapes.some(shape => Array.isArray(shape) && shape.length === 6
    && shape.every((value, i) => value === [0, 0, 0, 1, 1, 1][i]));
}

function sameState(a, b) {
  const keys = Object.keys(a.properties);
  return a.name === b.name && keys.length === Object.keys(b.properties).length
    && keys.every(name => Object.hasOwn(b.properties, name) && a.properties[name] === b.properties[name]);
}

function checkEntities(bot, box) {
  if (!bot.entities || typeof bot.entities !== "object" || Array.isArray(bot.entities) || !bot.entity) throw unsafe("Entity occupancy unavailable");
  const entities = Object.values(bot.entities);
  if (entities.length > 4096) throw budget("Entity inspection limit exceeded");
  if (!entities.includes(bot.entity)) entities.push(bot.entity);
  for (const entity of entities) {
    const p = entity?.position, width = entity?.width, height = entity?.height;
    if (!p || ![p.x, p.y, p.z, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw unsafe("Entity bounds unavailable");
    if (p.x + width / 2 > box.min.x && p.x - width / 2 < box.max.x
      && p.y + height > box.min.y && p.y < box.max.y
      && p.z + width / 2 > box.min.z && p.z - width / 2 < box.max.z) throw unsafe("Entity occupies the screened site");
  }
}

function context(bot, identity, build, interrupted, limits, Vec3Class) {
  const deadline = performance.now() + limits.milliseconds;
  let reads = 0;
  const check = () => {
    if (build.isCancelled || bot.interrupt_code || interrupted() !== false || !isSchematicAttemptIdentityCurrent(bot, identity)) {
      throw error("SCHEMATIC_CLEAR_CANCELLED", "Site planning cancelled or identity changed");
    }
    if (performance.now() > deadline) throw budget("Site inspection timed out");
  };
  const read = position => {
    check();
    if (++reads > limits.reads) throw budget("Site read limit exceeded");
    let block;
    try { block = bot.blockAt(new Vec3Class(position.x, position.y, position.z)); }
    catch { throw unsafe(`Cannot inspect ${key(position)}`); }
    check();
    return { block, snapshot: state(bot, block, position) };
  };
  const tick = async () => { if (reads && reads % 128 === 0) { await yieldToEvents(); check(); } };
  return { check, read, tick };
}

function snapshotBuild(build, origin, limits) {
  if (!origin || ![origin.x, origin.y, origin.z].every(Number.isSafeInteger)) throw new TypeError("Integer requested origin required");
  const { width, height, length } = build?.dimensions ?? {};
  const dimensions = { width, height, length };
  if (![width, height, length].every(v => Number.isSafeInteger(v) && v > 0)
      || width * length > limits.footprint || height > limits.height || width * height * length > limits.reads) throw budget("Transformed volume exceeds site limits");
  if (!Array.isArray(build.cells) || build.cells.length !== width * height * length) throw unsafe("Complete transformed volume required");
  const cells = build.cells.map(cell => {
    if (!cell || typeof cell.name !== "string" || !Number.isSafeInteger(cell.stateId)) throw unsafe("Invalid target cell");
    return { position: frozenPosition(cell.position ?? {}), name: cell.name, stateId: cell.stateId, properties: propertiesOf({ properties: cell.properties }) };
  });
  requireSchematicCells({ dimensions, cells });
  const min = { x: Math.min(...cells.map(c => c.position.x)), y: Math.min(...cells.map(c => c.position.y)), z: Math.min(...cells.map(c => c.position.z)) };
  return { dimensions: Object.freeze(dimensions), cells, min: frozenPosition(min) };
}

/**
 * Read-only fixed-X/Z, lowest-Y search from the requested anchor, inclusive.
 * The transformed volume may have an offset from that anchor. worldBounds are
 * caller-supplied inclusive Y bounds. Volume cells must be air or already
 * exactly match their non-air target. Each footprint column is
 * filled only through air down to a reviewed full-cube terrain block. The
 * two-block halo and entity screen are conservative local checks, not proof
 * against remote physics, plugins, unseen entities, or player-placed terrain.
 * Stateful targets are deliberately unsupported: this module does not decode
 * state IDs to prove their properties. Returns an immutable advisory plan; it
 * does not authorize or perform writes.
 */
export async function planSafeSchematicSite(bot, build, { origin, worldBounds, Vec3Class, limits: requestedLimits, isInterrupted = () => false, lifecycle = null } = {}) {
  if (!bot || typeof bot.blockAt !== "function" || typeof Vec3Class !== "function" || typeof isInterrupted !== "function") throw new TypeError("Block reader, vector and interruption check required");
  if (!worldBounds || !Number.isSafeInteger(worldBounds.minY) || !Number.isSafeInteger(worldBounds.maxY) || worldBounds.minY > worldBounds.maxY) throw new TypeError("Inclusive dimension Y bounds required");
  const limits = limitsFor(requestedLimits);
  const copied = snapshotBuild(build, origin, limits);
  origin = frozenPosition(origin);
  const { width, height, length } = copied.dimensions;
  const min = copied.min;
  const minY = worldBounds.minY, maxY = worldBounds.maxY;
  if (![min.x - MARGIN, min.z - MARGIN, min.x + width + MARGIN, min.z + length + MARGIN,
    min.y - limits.depth - MARGIN, min.y + limits.rise + height + MARGIN,
    origin.y + limits.rise].every(Number.isSafeInteger)) throw unsafe("Site bounds exceed safe coordinates");
  const identity = captureSchematicAttemptIdentity(bot, lifecycle);
  const ctx = context(bot, identity, build, isInterrupted, limits, Vec3Class);
  ctx.check();
  assertBalancedTargets(bot, copied);
  if (copied.cells.some(cell => Object.keys(cell.properties).length !== 0)) throw unsafe("Stateful targets are not supported by safe planning");
  if (!isSupportedBalancedPassiveState(bot.registry, { name: "dirt", properties: {} })) throw unsafe("Dirt state unavailable in registry");
  for (let rise = 0; rise <= limits.rise; rise++) {
    const y = min.y + rise;
    if (y < minY) continue;
    if (y + height - 1 > maxY) throw unsafe("Transformed volume exceeds dimension bounds");
    const cells = copied.cells.map(cell => Object.freeze({ ...cell, position: frozenPosition({ x: cell.position.x, y: cell.position.y + rise, z: cell.position.z }) }));
    const observations = new Map();
    const observe = position => {
      const k = key(position);
      if (!observations.has(k)) observations.set(k, ctx.read(position));
      return observations.get(k);
    };
    let obstructed = false;
    for (const cell of cells) {
      const { block, snapshot } = observe(cell.position);
      if (!AIR.has(snapshot.name) && !(!AIR.has(cell.name) && sameState(cell, snapshot))) {
        if (!GROUND.has(snapshot.name) || !fullCube(block)) throw unsafe(`Non-terrain obstruction at ${key(cell.position)}`);
        obstructed = true;
      }
      await ctx.tick();
    }
    if (obstructed) continue;
    const dirt = [];
    let lowest = y;
    let groundMissing = false;
    for (let x = min.x; x < min.x + width; x++) for (let z = min.z; z < min.z + length; z++) {
      let found = false;
      for (let depth = 1; depth <= limits.depth; depth++) {
        const p = { x, y: y - depth, z };
        if (p.y < minY) break;
        const { block, snapshot } = observe(p);
        if (AIR.has(snapshot.name)) dirt.push(frozenPosition(p));
        else {
          if (!GROUND.has(snapshot.name) || !fullCube(block)) throw unsafe(`Unsupported ground at ${key(p)}`);
          found = true; lowest = Math.min(lowest, p.y); break;
        }
        await ctx.tick();
      }
      if (!found) groundMissing = true;
    }
    if (groundMissing) continue;
    const solidTargets = cells.filter(c => !AIR.has(c.name) && AIR.has(observations.get(key(c.position)).snapshot.name));
    if (dirt.length + solidTargets.length > limits.edits) throw budget("Planned edits exceed site limit");
    dirt.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    const box = { min: { x: min.x - MARGIN, y: lowest - MARGIN, z: min.z - MARGIN }, max: { x: min.x + width + MARGIN, y: y + height + MARGIN, z: min.z + length + MARGIN } };
    if (box.min.y < minY) continue;
    if (box.max.y - 1 > maxY) throw unsafe("Site halo exceeds dimension bounds");
    const volumeKeys = new Set(cells.map(cell => key(cell.position)));
    for (let x = box.min.x; x < box.max.x; x++) for (let by = box.min.y; by < box.max.y; by++) for (let z = box.min.z; z < box.max.z; z++) {
      const p = { x, y: by, z };
      const { block, snapshot } = observe(p);
      if (!volumeKeys.has(key(p)) && !AIR.has(snapshot.name) && (!GROUND.has(snapshot.name) || !fullCube(block))) {
        throw unsafe(`Unsupported terrain or structure in site halo at ${key(p)}`);
      }
      await ctx.tick();
    }
    checkEntities(bot, box);
    ctx.check();
    const plan = Object.freeze({ origin: frozenPosition({ x: origin.x, y: origin.y + rise, z: origin.z }), requestedOrigin: frozenPosition(origin), dimensions: copied.dimensions,
      volume: Object.freeze(cells), dirt: Object.freeze(dirt) });
    plans.set(plan, { bot, build, identity, isInterrupted, Vec3Class, limits, box, observations: [...observations.values()].map(v => v.snapshot),
      ground: new Set([...observations.values()].filter(v => GROUND.has(v.snapshot.name) && !volumeKeys.has(key(v.snapshot.position))).map(v => key(v.snapshot.position))),
      solidTargets });
    return plan;
  }
  ctx.check();
  throw error("SCHEMATIC_NO_SITE", "No air-only site within the bounded elevation range");
}

/**
 * Reinspect the entire frozen site immediately before each prospective write.
 * Completed counts are exact prefixes of plan.dirt and non-air plan.volume,
 * respectively; volume writes are permitted only after all dirt is present.
 * This detects unexpected changes but cannot make inspection and a later write
 * atomic. Call again after every transition and verify the final write too.
 */
function* inspectSafeSchematicSite(bot, plan, { completedDirt = 0, completedVolume = 0 } = {}) {
  const saved = plans.get(plan);
  if (!saved || saved.bot !== bot) throw unsafe("Unknown or foreign safe site plan");
  if (!Number.isSafeInteger(completedDirt) || completedDirt < 0 || completedDirt > plan.dirt.length
      || !Number.isSafeInteger(completedVolume) || completedVolume < 0 || completedVolume > saved.solidTargets.length
      || (completedVolume && completedDirt !== plan.dirt.length)) throw unsafe("Invalid completed edit prefix");
  const ctx = context(bot, saved.identity, saved.build, saved.isInterrupted, saved.limits, saved.Vec3Class);
  ctx.check();
  assertBalancedTargets(bot, { cells: plan.volume });
  const expected = new Map();
  for (const p of plan.dirt.slice(0, completedDirt)) expected.set(key(p), { name: "dirt", properties: {} });
  for (const cell of saved.solidTargets.slice(0, completedVolume)) expected.set(key(cell.position), cell);
  for (const previous of saved.observations) {
    const current = ctx.read(previous.position);
    const wanted = expected.get(key(previous.position)) ?? previous;
    if (!sameState(wanted, current.snapshot) || (saved.ground.has(key(previous.position)) && !fullCube(current.block))
      || (expected.has(key(previous.position)) && wanted.name === "dirt" && !fullCube(current.block))) throw unsafe(`Site changed at ${key(previous.position)}`);
    yield ctx;
  }
  checkEntities(bot, saved.box);
  ctx.check();
  return true;
}

export async function revalidateSafeSchematicSite(bot, plan, options = {}) {
  const inspection = inspectSafeSchematicSite(bot, plan, options);
  for (let step = inspection.next(); !step.done; step = inspection.next()) await step.value.tick();
  return true;
}

/** Synchronous, bounded full-site check for a final gameplay packet authorization. */
export function revalidateSafeSchematicSiteAtDispatch(bot, plan, options = {}) {
  const inspection = inspectSafeSchematicSite(bot, plan, options);
  for (let step = inspection.next(); !step.done; step = inspection.next()) { /* Do not yield before dispatch. */ }
  return true;
}
