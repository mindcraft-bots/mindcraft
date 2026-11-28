import { setImmediate as yieldToEvents } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { inspectSchematicCell, inspectSchematicObstructions, isSchematicAttemptIdentityCurrent } from "./obstruction_policy.js";
import { assertBalancedTargets, BALANCED_NEIGHBOR_MARGIN, balancedCandidateExtraReads, isSupportedBalancedClearableState, isSupportedBalancedPassiveState } from "./balanced_physics_policy.js";

// Deliberately narrower than "solid": no falling blocks, fluids, machinery,
// block entities, partial shapes, or modded blocks are accepted as foundation.
const FOUNDATION = /^(?:stone|granite|diorite|andesite|deepslate|tuff|calcite|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|netherrack|end_stone|basalt|blackstone)$/;
const unsafe = message => Object.assign(new Error(message), { code: "SCHEMATIC_SITE_UNSAFE" });
const key = p => `${p.x},${p.y},${p.z}`;

export function captureBalancedBlockState(block, position) {
  if (!block || typeof block.name !== "string" || !block.name) throw unsafe(`Unavailable block at ${key(position)}`);
  let properties, attached;
  try {
    properties = typeof block.getProperties === "function" ? block.getProperties() : (block._properties ?? block.properties);
    attached = JSON.stringify([block.entity ?? null, block.blockEntity ?? null, block._blockEntity ?? null, block.nbt ?? null]);
  }
  catch { throw unsafe(`Unreadable block state at ${key(position)}`); }
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw unsafe(`Unreadable block state at ${key(position)}`);
  return { position: { ...position }, name: block.name, stateId: block.stateId, properties: { ...properties }, attached, diggable: block.diggable };
}

function read(bot, position, Vec3Class, beforeRead = () => {}) {
  beforeRead();
  try { return bot.blockAt(new Vec3Class(position.x, position.y, position.z)); }
  catch { throw unsafe(`Cannot inspect ${key(position)}`); }
}

function foundation(bot, position, Vec3Class, beforeRead) {
  const block = read(bot, position, Vec3Class, beforeRead);
  const snapshot = captureBalancedBlockState(block, position);
  const definition = bot.registry?.blocksByName?.[block.name];
  const definitions = definition?.states;
  const names = Object.keys(snapshot.properties);
  const validState = Array.isArray(definitions) && names.length === definitions.length && definitions.every(item => {
    if (!Object.hasOwn(snapshot.properties, item.name) || /water|fluid/i.test(item.name)) return false;
    const value = snapshot.properties[item.name];
    if (item.type === "bool") return typeof value === "boolean";
    if (item.type === "enum") return Array.isArray(item.values) && item.values.includes(String(value));
    if (item.type === "int") return Number.isInteger(value) && value >= 0 && value < item.num_values;
    return false;
  });
  if (!FOUNDATION.test(block.name) || !validState
      || block.entity || block.blockEntity || block._blockEntity || block.nbt
      || !Array.isArray(block.shapes) || !block.shapes.some(shape => Array.isArray(shape)
        && shape.length === 6 && shape.every((value, i) => value === [0, 0, 0, 1, 1, 1][i]))) {
    throw unsafe(`Unsupported or uninspectable foundation at ${key(position)}`);
  }
  return snapshot;
}

function equal(a, b) {
  const keys = Object.keys(a.properties).sort();
  const other = Object.keys(b.properties).sort();
  return a.name === b.name && a.attached === b.attached && a.diggable === b.diggable && keys.length === other.length
    && keys.every((name, i) => name === other[i] && a.properties[name] === b.properties[name]);
}

function assertVolumeState(bot, snapshot) {
  if (snapshot.attached !== "[null,null,null,null]"
      || !(isSupportedBalancedPassiveState(bot.registry, snapshot)
        || isSupportedBalancedClearableState(bot.registry, snapshot))) {
    throw unsafe(`Unsupported balanced volume state ${snapshot.name} at ${key(snapshot.position)}`);
  }
}

function passiveNeighbor(bot, position, Vec3Class, beforeRead) {
  const block = read(bot, position, Vec3Class, beforeRead);
  const snapshot = captureBalancedBlockState(block, position);
  if (!isSupportedBalancedPassiveState(bot.registry, snapshot)
      || block.entity || block.blockEntity || block._blockEntity || block.nbt) {
    throw unsafe(`Unsupported balanced neighbor ${snapshot.name} at ${key(position)}`);
  }
  return snapshot;
}

function* neighborPositions(box) {
  const margin = BALANCED_NEIGHBOR_MARGIN;
  if (![box.min.x - margin, box.min.y - margin, box.min.z - margin,
    box.max.x + margin, box.max.y + margin, box.max.z + margin].every(Number.isSafeInteger)) throw unsafe("Neighbor bounds exceed safe coordinates");
  for (let x = box.min.x - margin; x < box.max.x + margin; x++) {
    for (let y = box.min.y - margin; y < box.max.y + margin; y++) {
      for (let z = box.min.z - margin; z < box.max.z + margin; z++) {
        if (x >= box.min.x && x < box.max.x && y >= box.min.y && y < box.max.y && z >= box.min.z && z < box.max.z) continue;
        yield { x, y, z };
      }
    }
  }
}

function bounds(build, dx = 0, dz = 0) {
  const min = build.cells.reduce((p, cell) => ({ x: Math.min(p.x, cell.position.x), y: Math.min(p.y, cell.position.y), z: Math.min(p.z, cell.position.z) }), { x: Infinity, y: Infinity, z: Infinity });
  min.x += dx; min.z += dz;
  const { width, height, length } = build.dimensions;
  const max = { x: min.x + width, y: min.y + height, z: min.z + length };
  if (![min.x, min.y, min.z, max.x, max.y, max.z, min.y - 1].every(Number.isSafeInteger)) throw unsafe("Site bounds exceed safe coordinates");
  return { min, max };
}

function entities(bot, box) {
  if (!bot.entities || typeof bot.entities !== "object" || Array.isArray(bot.entities) || !bot.entity) throw unsafe("Entity occupancy is unavailable");
  const all = Object.values(bot.entities);
  if (all.length > 4096) throw unsafe("Entity occupancy exceeds inspection budget");
  if (!all.includes(bot.entity)) all.push(bot.entity);
  for (const entity of all) {
    const p = entity?.position;
    const { width, height } = entity ?? {};
    if (!p || ![p.x, p.y, p.z, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      throw unsafe("Entity position or bounding box is unavailable");
    }
    if (p.x + width / 2 > box.min.x && p.x - width / 2 < box.max.x
        && p.y + height > box.min.y && p.y < box.max.y
        && p.z + width / 2 > box.min.z && p.z - width / 2 < box.max.z) {
      throw unsafe("Entity occupies the schematic volume");
    }
  }
}

/** Candidate inspection is read-only and yields during large footprints. */
export async function inspectBalancedCandidate(bot, build, offset, states, Vec3Class, check, beforeRead = () => {}) {
  for (let i = 0; i < build.cells.length; i += 128) {
    check();
    assertBalancedTargets(bot, { cells: build.cells.slice(i, i + 128) });
    if (i + 128 < build.cells.length) { await yieldToEvents(); check(); }
  }
  for (let i = 0; i < states.length; i++) {
    check(); assertVolumeState(bot, states[i]);
    if ((i + 1) % 128 === 0) { await yieldToEvents(); check(); }
  }
  const box = bounds(build, offset.dx, offset.dz);
  const support = [];
  for (let x = box.min.x; x < box.max.x; x++) for (let z = box.min.z; z < box.max.z; z++) {
    check();
    support.push(foundation(bot, { x, y: box.min.y - 1, z }, Vec3Class, beforeRead));
    if (support.length % 128 === 0) { await yieldToEvents(); check(); }
  }
  const neighbors = [];
  for (const position of neighborPositions(box)) {
    check();
    neighbors.push(passiveNeighbor(bot, position, Vec3Class, beforeRead));
    if (neighbors.length % 128 === 0) { await yieldToEvents(); check(); }
  }
  entities(bot, box);
  check();
  return { states, support, neighbors, box };
}

/** Resume inspects the frozen origin directly; it does not rank or relocate. */
export async function inspectBalancedResume(bot, build, Vec3Class, check, clearingQualification = null) {
  assertBalancedTargets(bot, build);
  if (build.cells.length + balancedCandidateExtraReads(build) > 250_000) throw unsafe("Balanced resume exceeds inspection budget");
  const deadline = performance.now() + 2_000;
  const boundedCheck = () => { check(); if (performance.now() > deadline) throw unsafe("Balanced resume inspection timed out"); };
  const states = [];
  for (const cell of build.cells) {
    boundedCheck();
    inspectSchematicCell(bot, cell, Vec3Class, block => states.push(captureBalancedBlockState(block, cell.position)), clearingQualification);
    if (states.length % 128 === 0) { await yieldToEvents(); boundedCheck(); }
  }
  return inspectBalancedCandidate(bot, build, { dx: 0, dz: 0 }, states, Vec3Class, boundedCheck);
}

/** Compare against the selected snapshot, never silently approve a changed site. */
export function revalidateBalancedSite(bot, build, safety, Vec3Class, attemptIdentity, clearingQualification = null) {
  const deadline = clearingQualification || safety.protectionEvidence ? performance.now() + 2_000 : Infinity;
  const check = () => {
    if (bot.interrupt_code || build.isCancelled || !isSchematicAttemptIdentityCurrent(bot, attemptIdentity)) {
      throw Object.assign(new Error("Balanced site validation cancelled or world changed"), { code: "SCHEMATIC_CLEAR_CANCELLED" });
    }
    if (performance.now() > deadline) throw unsafe("Site revalidation timed out");
  };
  let reads = 0;
  const beforeRead = () => {
    check();
    if (safety.protectionEvidence && ++reads > 250_000) throw unsafe("Site revalidation exceeded the world-read budget");
  };
  check();
  assertBalancedTargets(bot, build);
  for (const original of safety.protectionEvidence?.values() ?? []) {
    check();
    const current = captureBalancedBlockState(read(bot, original.position, Vec3Class, beforeRead), original.position);
    if (current.stateId !== original.stateId || !equal(original, current)) throw unsafe(`Selected site changed or candidate protection evidence changed at ${key(original.position)}`);
  }
  inspectSchematicObstructions(bot, build, { Vec3Class, attemptIdentity, collectSnapshots: false, clearingQualification,
    inspectionCheck: safety.protectionEvidence ? beforeRead : clearingQualification ? check : null });
  for (const original of safety.states) {
    check();
    const current = captureBalancedBlockState(read(bot, original.position, Vec3Class, beforeRead), original.position);
    assertVolumeState(bot, current);
    if (!equal(original, current)) throw unsafe(`Selected site changed at ${key(original.position)}`);
  }
  for (const original of safety.support) {
    check();
    if (!equal(original, foundation(bot, original.position, Vec3Class, beforeRead))) throw unsafe(`Selected foundation changed at ${key(original.position)}`);
  }
  for (const original of safety.neighbors) {
    check();
    if (!equal(original, passiveNeighbor(bot, original.position, Vec3Class, beforeRead))) throw unsafe(`Selected balanced neighbor changed at ${key(original.position)}`);
  }
  entities(bot, safety.box);
  check();
}

/** Advance only the cell actually edited by the guarded builder. */
export function recordBalancedEdit(bot, safety, position, Vec3Class) {
  const index = safety.states.findIndex(item => key(item.position) === key(position));
  if (index < 0) throw unsafe("Edited cell is outside selected site");
  const current = captureBalancedBlockState(read(bot, position, Vec3Class), position);
  assertVolumeState(bot, current);
  safety.states[index] = current;
  if (safety.protectionEvidence?.has(key(position))) safety.protectionEvidence.set(key(position), current);
}
