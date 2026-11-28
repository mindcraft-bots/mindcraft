import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import {
  captureSchematicAttemptIdentity, inspectSchematicCell, isSchematicAirName,
  isSchematicAttemptIdentityCurrent, requireSchematicCells,
} from "./obstruction_policy.js";
import { captureBalancedBlockState } from "./balanced_site_safety.js";

const MAX_READS = 250_000;
const MAX_DURATION_MS = 2_000;
const planningError = (code, message) => Object.assign(new Error(message), { code });
const order = (a, b) => a.distanceSquared - b.distanceSquared || a.dx - b.dx || a.dz - b.dz;

/** Pure candidate generation. Bisect visits disk-intersecting rectangles breadth-first. */
export function balancedCandidateOffsets({ radius = 4, strategy = "stepped", step = 2, bisectDepth = 2 } = {}) {
  if (!Number.isInteger(radius) || radius < 0 || radius > 16) throw new RangeError("Balanced radius must be an integer from 0 to 16");
  if (!["all", "stepped", "bisect"].includes(strategy)) throw new RangeError("Invalid balanced strategy");
  if (!Number.isInteger(step) || step < 1 || step > 16) throw new RangeError("Balanced step must be an integer from 1 to 16");
  if (!Number.isInteger(bisectDepth) || bisectDepth < 0 || bisectDepth > 3) throw new RangeError("Balanced bisect depth must be an integer from 0 to 3");
  const offsets = [], seen = new Set();
  const add = (dx, dz, level) => {
    const distanceSquared = dx * dx + dz * dz, key = `${dx},${dz}`;
    if (distanceSquared <= radius * radius && !seen.has(key)) {
      seen.add(key); offsets.push({ dx: dx || 0, dz: dz || 0, distanceSquared, level });
    }
  };
  if (strategy !== "bisect") {
    const stride = strategy === "all" ? 1 : step;
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      if (dx % stride === 0 && dz % stride === 0) add(dx, dz, 0);
    }
    offsets.sort(order);
  } else {
    let rectangles = [{ x0: -radius, x1: radius, z0: -radius, z1: radius }];
    const split = (lo, hi) => lo === hi ? [[lo, hi]] : [[lo, Math.floor((lo + hi) / 2)], [Math.floor((lo + hi) / 2) + 1, hi]];
    for (let level = 0; level <= bisectDepth && rectangles.length; level++) {
      const begin = offsets.length, next = [];
      for (const r of rectangles) {
        // Use doubled midpoint distances to avoid fractional arithmetic. Iterating
        // X then Z gives a stable lexicographic tie-break within the rectangle.
        let representative = null, midpointDistance = Infinity;
        for (let dx = r.x0; dx <= r.x1; dx++) for (let dz = r.z0; dz <= r.z1; dz++) {
          if (dx * dx + dz * dz > radius * radius) continue;
          const distance = (2 * dx - r.x0 - r.x1) ** 2 + (2 * dz - r.z0 - r.z1) ** 2;
          if (distance < midpointDistance) { representative = { dx, dz }; midpointDistance = distance; }
        }
        if (!representative) continue;
        add(representative.dx, representative.dz, level);
        if (level < bisectDepth && (r.x1 - r.x0 > step || r.z1 - r.z0 > step)) {
          for (const [x0, x1] of split(r.x0, r.x1)) for (const [z0, z1] of split(r.z0, r.z1)) next.push({ x0, x1, z0, z1 });
        }
      }
      offsets.splice(begin, offsets.length - begin, ...offsets.slice(begin).sort(order));
      rectangles = next;
    }
  }
  return offsets;
}

/** Read-only ranking; the caller must revalidate the selected site before edits. */
export async function planBalancedSchematicSite(bot, build, {
  Vec3Class, radius = 4, threshold = 9, strategy = "stepped", step = 2,
  policy = "first_valid", bisectDepth = 2,
  attemptIdentity = captureSchematicAttemptIdentity(bot),
  isInterrupted = () => Boolean(bot.interrupt_code), inspectCandidate = null, excludeMatches = false, diagnostic = () => {},
} = {}) {
  const offsets = balancedCandidateOffsets({ radius, strategy, step, bisectDepth });
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 4097) throw new RangeError("Balanced threshold must be an integer from 1 to 4097");
  if (!["first_valid", "exhaustive"].includes(policy)) throw new RangeError("Invalid balanced policy");
  if (!Array.isArray(build?.cells) || !build.cells.length) throw new TypeError("Balanced planning requires a complete schematic cell plan");
  if (!Vec3Class || typeof bot?.blockAt !== "function") throw new TypeError("Balanced planning requires block inspection and a vector implementation");
  const deadline = performance.now() + MAX_DURATION_MS;
  const dimensions = { ...build.dimensions };
  const cells = build.cells.map(cell => ({ ...cell, position: { ...cell.position }, properties: { ...cell.properties } }));
  const snapshot = { dimensions, cells };
  requireSchematicCells(snapshot);
  const min = cells.reduce((p, cell) => ({ x: Math.min(p.x, cell.position.x), y: Math.min(p.y, cell.position.y), z: Math.min(p.z, cell.position.z) }), { x: Infinity, y: Infinity, z: Infinity });
  const boxAt = offset => ({ min: { x: min.x + offset.dx, y: min.y, z: min.z + offset.dz },
    max: { x: min.x + offset.dx + dimensions.width, y: min.y + dimensions.height, z: min.z + offset.dz + dimensions.length } });
  const overlaps = (a, b) => ["x", "y", "z"].every(axis => a.min[axis] < b.max[axis] && b.min[axis] < a.max[axis]);
  const protectedBoxes = [];
  let reads = 0;
  const check = () => {
    if (isInterrupted() || build.isCancelled || !isSchematicAttemptIdentityCurrent(bot, attemptIdentity)) throw planningError("SCHEMATIC_CLEAR_CANCELLED", "Balanced search cancelled or world identity changed");
    if (performance.now() >= deadline) throw planningError("SCHEMATIC_SITE_BUDGET", "Balanced search timed out; no site was selected");
  };
  const beforeRead = () => {
    check();
    if (reads >= MAX_READS) throw planningError("SCHEMATIC_SITE_BUDGET", "Balanced search exceeded the world-read budget; no site was selected");
    reads++;
  };
  // Protect every possible anchor in the declared radius, even when ranking
  // uses a sampled strategy. A single matching target is only evidence of a
  // possible continuation, not proof of ownership or structure identity.
  let evidence;
  if (excludeMatches) {
    evidence = new Map();
    let inspected = 0;
    for (const offset of balancedCandidateOffsets({ radius, strategy: "all", step, bisectDepth })) {
      let matched = false;
      for (const cell of cells) {
        const position = { x: cell.position.x + offset.dx, y: cell.position.y, z: cell.position.z + offset.dz };
        if (![position.x, position.y, position.z].every(Number.isSafeInteger)) throw planningError("SCHEMATIC_SITE_UNSAFE", "Candidate evidence exceeds safe coordinates");
        const key = `${position.x},${position.y},${position.z}`;
        let state = evidence.get(key);
        if (!state) {
          beforeRead();
          let block;
          try { block = bot.blockAt(new Vec3Class(position.x, position.y, position.z)); }
          catch { throw planningError("SCHEMATIC_SITE_UNSAFE", `Cannot inspect candidate evidence at ${key}`); }
          state = captureBalancedBlockState(block, position);
          if (!Number.isSafeInteger(state.stateId) || state.stateId < 0 || !/^[a-z0-9_]+$/.test(state.name)
              || (bot.registry?.blocksByStateId && bot.registry.blocksByStateId[state.stateId]?.name !== state.name)
              || Object.values(state.properties).some(value => !["string", "boolean", "number"].includes(typeof value)
                || (typeof value === "number" && !Number.isFinite(value)))) {
            throw planningError("SCHEMATIC_SITE_UNSAFE", `Uncertain candidate evidence at ${key}`);
          }
          evidence.set(key, state);
        }
        const expected = cell.properties ?? {};
        const sameProperties = Object.keys(state.properties).length === Object.keys(expected).length
          && Object.entries(expected).every(([name, value]) => Object.hasOwn(state.properties, name) && state.properties[name] === value);
        if (!isSchematicAirName(cell.name) && state.name === cell.name && (sameProperties || state.stateId === cell.stateId)) {
          if (!sameProperties || state.attached !== "[null,null,null,null]" || state.stateId !== cell.stateId) {
            throw planningError("SCHEMATIC_SITE_UNSAFE", `Uncertain matching candidate evidence at ${key}`);
          }
          matched = true;
        }
        if (++inspected % 128 === 0) { await yieldToEvents(); check(); }
      }
      if (matched) {
        protectedBoxes.push(boxAt(offset));
        diagnostic(`Balanced candidate ${offset.dx},${offset.dz} contains existing matches; its entire volume is protected.`);
      }
      check();
    }
  }
  let best = null, firstUnsafeReason, visited = 0;
  for (const offset of offsets) {
    check(); visited++;
    const candidateBox = boxAt(offset);
    if (excludeMatches && protectedBoxes.some(box => overlaps(candidateBox, box))) {
      diagnostic(`Balanced candidate ${offset.dx},${offset.dz} overlaps a protected matching volume.`);
      continue;
    }
    let count = 0, rejected = false, pruned = false;
    const states = inspectCandidate ? [] : null;
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];
      const shifted = { ...cell, position: { x: cell.position.x + offset.dx, y: cell.position.y, z: cell.position.z + offset.dz } };
      if (!Number.isSafeInteger(shifted.position.x) || !Number.isSafeInteger(shifted.position.z)) throw new RangeError("Balanced candidate coordinates exceed safe integer bounds");
      beforeRead();
      try {
        const obstruction = inspectSchematicCell(bot, shifted, Vec3Class, block => {
          let properties;
          try { properties = typeof block.getProperties === "function" ? block.getProperties() : (block._properties ?? block.properties ?? {}); }
          catch { throw planningError("SCHEMATIC_SITE_UNSAFE", "Block properties are unavailable during balanced planning"); }
          if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw planningError("SCHEMATIC_SITE_UNSAFE", "Block properties are unavailable during balanced planning");
          const expected = cell.properties ?? {};
          const matches = isSchematicAirName(cell.name) ? isSchematicAirName(block.name)
            : block.name === cell.name && Object.keys(properties).length === Object.keys(expected).length
              && Object.entries(expected).every(([key, value]) => properties[key] === value);
          // A match appearing after discovery means that evidence has changed.
          if (excludeMatches && !isSchematicAirName(cell.name) && matches) throw planningError("SCHEMATIC_SITE_CHANGED", "Matching candidate appeared after protection discovery");
          if (!matches) count++;
          if (states) states.push(captureBalancedBlockState(block, shifted.position));
        });
        if (!obstruction && states?.length && !isSchematicAirName(states.at(-1).name)
            && states.at(-1).name === cell.name
            && Object.keys(states.at(-1).properties).length !== Object.keys(cell.properties ?? {}).length) rejected = true;
      } catch (error) {
        if (error?.code !== "SCHEMATIC_OBSTRUCTION" && error?.code !== "SCHEMATIC_SITE_UNSAFE") throw error;
        rejected = true;
      }
      check();
      // Partial scans are never eligible: pruning only discards candidates that
      // cannot beat the strict threshold or the fully qualified incumbent.
      if (rejected || count >= threshold || (best && count >= best.obstructions)) {
        pruned = true;
        break;
      }
      if ((index + 1) % 128 === 0) { await yieldToEvents(); check(); }
    }
    if (!pruned) {
      let safety;
      if (inspectCandidate) {
        try { safety = await inspectCandidate(offset, states, check, beforeRead, snapshot); check(); }
        catch (error) {
          if (error?.code !== "SCHEMATIC_SITE_UNSAFE") throw error;
          firstUnsafeReason ??= error.message; rejected = true;
        }
      }
      if (!rejected) {
        best = { dx: offset.dx, dz: offset.dz, obstructions: count };
        if (inspectCandidate) Object.defineProperty(best, "safety", { value: safety });
        if (policy === "first_valid" || count === 0) { await yieldToEvents(); check(); break; }
      }
    }
    await yieldToEvents(); check();
  }
  check();
  const allCount = balancedCandidateOffsets({ radius, strategy: "all", step, bisectDepth }).length;
  if (!best && firstUnsafeReason) throw planningError("SCHEMATIC_SITE_UNSAFE", `No threshold-eligible balanced candidate passed safety inspection; first safety refusal: ${firstUnsafeReason}`);
  if (!best) throw planningError("SCHEMATIC_NO_SITE", `No fully inspected balanced candidate met the strict obstruction threshold (${offsets.length < allCount ? "sampled" : "complete"} search)`);
  if (evidence && best.safety) best.safety.protectionEvidence = evidence;
  Object.defineProperty(best, "plan", { value: snapshot });
  Object.defineProperty(best, "search", { value: Object.freeze({ strategy, policy, sampled: offsets.length < allCount || visited < offsets.length, visited, candidates: offsets.length, reads }) });
  return Object.freeze(best);
}
