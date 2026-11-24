import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import {
  captureSchematicAttemptIdentity,
  inspectSchematicCell,
  isSchematicAirName,
  isSchematicAttemptIdentityCurrent,
  requireSchematicCells,
} from "./obstruction_policy.js";
import { captureBalancedBlockState } from "./balanced_site_safety.js";
import { balancedCandidateExtraReads } from "./balanced_physics_policy.js";

const MAX_READS = 250_000;
const MAX_DURATION_MS = 2_000;

function planningError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Read-only candidate ranking, NOT an authorization to write or build.
 * A caller must separately validate terrain, entities, neighbor physics and the
 * selected site after any asynchronous transition, before every mutation.
 */
export async function planBalancedSchematicSite(bot, build, {
  Vec3Class,
  radius = 4,
  threshold = 9,
  attemptIdentity = captureSchematicAttemptIdentity(bot),
  isInterrupted = () => Boolean(bot.interrupt_code),
  inspectCandidate = null,
} = {}) {
  if (!Number.isInteger(radius) || radius < 0 || radius > 16) {
    throw new RangeError("Balanced radius must be an integer from 0 to 16");
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 4097) {
    throw new RangeError("Balanced threshold must be an integer from 1 to 4097");
  }
  if (!Array.isArray(build?.cells) || !build.cells.length) {
    throw new TypeError("Balanced planning requires a complete schematic cell plan");
  }
  const offsets = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const distanceSquared = dx * dx + dz * dz;
      if (distanceSquared <= radius * radius) offsets.push({ dx: dx || 0, dz: dz || 0, distanceSquared });
    }
  }
  offsets.sort((a, b) => a.distanceSquared - b.distanceSquared || a.dx - b.dx || a.dz - b.dz);
  const supportReads = inspectCandidate ? balancedCandidateExtraReads(build) : 0;
  if ((build.cells.length + supportReads) * offsets.length > MAX_READS) {
    throw planningError("SCHEMATIC_SITE_BUDGET", "Balanced search exceeds the full-volume read budget; no site was selected");
  }
  const deadline = performance.now() + MAX_DURATION_MS;
  // Candidate scans yield to the event loop; snapshot the caller's plan so
  // those yields cannot mix different schematic versions.
  const dimensions = { ...build.dimensions };
  const cells = build.cells.map(cell => ({
    ...cell,
    position: { ...cell.position },
    properties: { ...cell.properties },
  }));
  requireSchematicCells({ dimensions, cells });
  if (!Vec3Class || typeof bot?.blockAt !== "function") {
    throw new TypeError("Balanced planning requires block inspection and a vector implementation");
  }
  const check = () => {
    if (isInterrupted() || build.isCancelled || !isSchematicAttemptIdentityCurrent(bot, attemptIdentity)) {
      throw planningError("SCHEMATIC_CLEAR_CANCELLED", "Balanced search cancelled or world identity changed");
    }
    if (performance.now() > deadline) {
      throw planningError("SCHEMATIC_SITE_BUDGET", "Balanced search timed out; no site was selected");
    }
    return false;
  };
  let best = null;
  let firstUnsafeReason;
  for (const offset of offsets) {
    check();
    let count = 0;
    let rejected = false;
    const states = inspectCandidate ? [] : null;
    for (let index = 0; index < cells.length; index++) {
      check();
      const cell = cells[index];
      const shifted = { ...cell, position: {
        x: cell.position.x + offset.dx, y: cell.position.y, z: cell.position.z + offset.dz,
      } };
      if (!Number.isSafeInteger(shifted.position.x) || !Number.isSafeInteger(shifted.position.z)) {
        throw new RangeError("Balanced candidate coordinates exceed safe integer bounds");
      }
      try {
        const obstruction = inspectSchematicCell(bot, shifted, Vec3Class, block => {
          let properties;
          try {
            properties = typeof block.getProperties === "function" ? block.getProperties() : (block._properties ?? block.properties ?? {});
          } catch {
            throw planningError("SCHEMATIC_SITE_UNSAFE", "Block properties are unavailable during balanced planning");
          }
          if (!properties || typeof properties !== "object") throw planningError("SCHEMATIC_SITE_UNSAFE", "Block properties are unavailable during balanced planning");
          const expectedProperties = cell.properties ?? {};
          const keys = Object.keys(properties);
          const matches = isSchematicAirName(cell.name) ? isSchematicAirName(block.name)
            : block.name === cell.name && keys.length === Object.keys(expectedProperties).length
              && Object.entries(expectedProperties).every(([key, value]) => properties[key] === value);
          if (!matches) count++;
          if (states) states.push(captureBalancedBlockState(block, shifted.position));
        });
        // A non-air state that only partially matches must not be implicitly
        // approved merely because the legacy policy accepts a property subset.
        if (!obstruction && states?.length && !isSchematicAirName(states.at(-1).name)
            && states.at(-1).name === cell.name
            && Object.keys(states.at(-1).properties).length !== Object.keys(cell.properties ?? {}).length) rejected = true;
      } catch (error) {
        if (error?.code !== "SCHEMATIC_OBSTRUCTION" && error?.code !== "SCHEMATIC_SITE_UNSAFE") throw error;
        rejected = true;
      }
      check();
      if ((index + 1) % 128 === 0) {
        await yieldToEvents();
        check();
      }
    }
    if (rejected) count = Infinity;
    let safety;
    if (!rejected && inspectCandidate) {
      try {
        safety = await inspectCandidate(offset, states, check);
        check();
      } catch (error) {
        if (error?.code !== "SCHEMATIC_SITE_UNSAFE") throw error;
        firstUnsafeReason ??= error.message;
        count = Infinity;
      }
    }
    if (count < threshold && (!best || count < best.obstructions)) {
      best = { dx: offset.dx, dz: offset.dz, obstructions: count };
      if (inspectCandidate) Object.defineProperty(best, "safety", { value: safety, enumerable: false });
    }
    // Yield so cancellation and lifecycle events can be observed between scans.
    await yieldToEvents();
  }
  check();
  if (!best) throw planningError("SCHEMATIC_NO_SITE", `No fully inspected balanced candidate met the strict obstruction threshold${firstUnsafeReason ? `; first safety refusal: ${firstUnsafeReason}` : ""}`);
  return Object.freeze(best);
}
