import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { beginCreativeSupply } from "./builder_compat.js";
import { normalizeGameMode, setGameMode } from "./game_mode.js";
import { createModernBuild } from "./modern_build.js";
import {
  clearSchematicObstructions,
  captureSchematicAttemptIdentity,
  isSchematicAttemptIdentityCurrent,
  isSafeNaturalObstruction,
  isKnownNaturalObstructionName,
  isSchematicAirName,
  withSchematicDestructionGuards,
} from "./obstruction_policy.js";
import { resolveSchematicPath } from "./paths.js";
import { getBotWorldGeneration, trackBotWorldLifecycle } from "./world_lifecycle.js";
import { readSchematic as readProductionSchematic, validateSchematicSource } from "./reader.js";
import { acquireBuildLifecycle, runBuild } from "./run_build.js";

const require = createRequire(import.meta.url);
const { Schematic } = require("prismarine-schematic");
const Vec3 = require("vec3");
const CLEANUP_TIMEOUT_MS = 1_500;

function createPosition(bot, x, y, z, Vec3Class) {
  if ([x, y, z].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
    return new Vec3Class(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  const position = bot.position ?? bot.entity?.position;
  if (!position || typeof position.offset !== "function") {
    throw new TypeError("Bot position is unavailable; provide finite x, y, and z coordinates");
  }
  const offset = position.offset(2, 0, 2);
  return typeof offset.floored === "function"
    ? offset.floored()
    : new Vec3Class(Math.floor(offset.x), Math.floor(offset.y), Math.floor(offset.z));
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function logSafely(log, message) {
  try {
    log?.(message);
  } catch {
    // Logging must not prevent mode or inventory cleanup.
  }
}

function propertiesFor(block) {
  try {
    return block?.getProperties?.() ?? block?._properties ?? block?.properties ?? {};
  } catch {
    return {};
  }
}

function sameProperties(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function inspectBuildWorld(bot, build, Vec3Class) {
  const states = [];
  for (const expected of build.cells ?? build.plan ?? []) {
    const { x, y, z } = expected.position;
    let block;
    try {
      block = bot.blockAt(new Vec3Class(x, y, z));
    } catch {
      return null;
    }
    if (!block) return null;
    states.push({ position: expected.position, name: block.name, properties: { ...propertiesFor(block) } });
  }
  return states;
}

function worldIdentity(bot) {
  trackBotWorldLifecycle(bot);
  return {
    dimension: bot.game?.dimension,
    world: bot.world,
    client: bot._client,
    version: bot.version,
    registry: bot.registry,
    worldGeneration: getBotWorldGeneration(bot),
  };
}

function isSameWorld(bot, identity) {
  if (!bot || bot.game?.dimension !== identity.dimension) return false;
  if (identity.worldGeneration == null || getBotWorldGeneration(bot) !== identity.worldGeneration) return false;
  if (identity.world != null && bot.world !== identity.world) return false;
  if (identity.client != null && bot._client !== identity.client) return false;
  if (bot.version !== identity.version || bot.registry !== identity.registry) return false;
  if (bot._client?.ended || bot._client?.socket?.destroyed) return false;
  if (!bot.entity || (typeof bot.health === "number" && bot.health <= 0)) return false;
  return true;
}

function canContinuePlan(bot, build, originalStates, Vec3Class) {
  if (!originalStates) return false;
  const originalByPosition = new Map(originalStates.map((state) => [
    `${state.position.x},${state.position.y},${state.position.z}`,
    state,
  ]));
  for (const expected of build.cells ?? build.plan ?? []) {
    const { x, y, z } = expected.position;
    let actual;
    try {
      actual = bot.blockAt(new Vec3Class(x, y, z));
    } catch {
      return false;
    }
    if (!actual) return false;
    const properties = propertiesFor(actual);
    const expectedAir = isSchematicAirName(expected.name);
    const alreadyPlaced = expectedAir
      ? isSchematicAirName(actual.name)
      : actual.name === expected.name
      && Object.entries(expected.properties ?? {}).every(([key, value]) => properties[key] === value);
    const original = originalByPosition.get(`${x},${y},${z}`);
    if (original && isKnownNaturalObstructionName(original.name, bot.version)
        && !isSafeNaturalObstruction({ name: original.name, properties: original.properties }, bot.version)) {
      return false;
    }
    const unchanged = original && actual.name === original.name && sameProperties(properties, original.properties);
    const naturallyCleared = isSchematicAirName(actual.name)
      && isSafeNaturalObstruction({ name: original?.name, properties: original?.properties }, bot.version);
    if (!alreadyPlaced && !unchanged && !naturallyCleared) return false;
  }
  return true;
}

function verifyBuild(bot, build, Vec3Class) {
  const mismatches = [];
  for (const expected of build.cells ?? build.plan ?? []) {
    const { x, y, z } = expected.position;
    let actual;
    try {
      actual = bot.blockAt(new Vec3Class(x, y, z));
    } catch (error) {
      mismatches.push(`${x},${y},${z}: could not inspect block (${describeError(error)})`);
      continue;
    }

    const expectedAir = isSchematicAirName(expected.name);
    if (!actual || (expectedAir ? !isSchematicAirName(actual.name) : actual.name !== expected.name)) {
      mismatches.push(`${x},${y},${z}: expected ${expectedAir ? "air" : expected.name}, found ${actual?.name ?? "unavailable"}`);
      continue;
    }

    const actualProperties = propertiesFor(actual);
    for (const [key, value] of Object.entries(expected.properties ?? {})) {
      if (actualProperties[key] !== value) {
        mismatches.push(`${x},${y},${z}: expected ${expected.name} ${key}=${value}, found ${actualProperties[key] ?? "unset"}`);
      }
    }
  }
  return mismatches;
}

function boundedCleanup(cleanup, timeoutMs) {
  let timer;
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(cleanup).then(
      () => ({ timedOut: false }),
      (error) => ({ timedOut: false, error }),
    ),
    timed,
  ]).finally(() => clearTimeout(timer));
}

/** Build one supported schematic with bounded supply cleanup and guaranteed mode restoration. */
export async function buildSchematic(bot, fileName, x = null, y = null, z = null, dependencies = {}) {
  const {
    resolvePath = resolveSchematicPath,
    fsAccess = access,
    fsReadFile = readFile,
    SchematicClass = Schematic,
    readSchematic,
    validateSource = validateSchematicSource,
    Vec3Class = Vec3,
    makeBuild = createModernBuild,
    startSupply = beginCreativeSupply,
    executeBuild = runBuild,
    clearObstructions = clearSchematicObstructions,
    guardDestruction = withSchematicDestructionGuards,
    changeGameMode = setGameMode,
    writeLog,
    cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
    resumeSession,
  } = dependencies;
  const report = (message) => logSafely(writeLog, message);

  // Bind the full asynchronous read/parse/preflight path to the world's event
  // generation, not merely the identity observed after those awaits complete.
  const invocationIdentity = captureSchematicAttemptIdentity(bot);

  let resolvedPath;
  let source;
  let schematic;
  let build;
  let startPosition;
  const saved = resumeSession?.context;
  const isResume = Boolean(saved && !resumeSession?.cancelled);
  if (isResume) resumeSession.resumeEligible = false;
  try {
    if (isResume) {
      resolvedPath = saved.resolvedPath;
      source = saved.source;
      schematic = saved.schematic;
      startPosition = new Vec3Class(saved.origin.x, saved.origin.y, saved.origin.z);
      if (!isSameWorld(bot, saved.worldIdentity)) {
        throw new Error("Cannot resume schematic build after death, disconnect, or dimension/world change");
      }
    } else {
      resolvedPath = await resolvePath(fileName, undefined, { version: bot.version });
      await fsAccess(resolvedPath);
      source = await fsReadFile(resolvedPath);
    }
  } catch (error) {
    report(`Could not read schematic ${fileName}: ${describeError(error)}`);
    if (resumeSession && isResume) {
      resumeSession.cancelled = true;
      resumeSession.resumeEligible = false;
      resumeSession.context = null;
    }
    return false;
  }

  if (path.extname(resolvedPath).toLowerCase() === ".litematic") {
    report(".litematic files can be listed but are not supported by the schematic reader. Convert this file to .schem or .schematic first.");
    if (resumeSession && isResume) {
      resumeSession.cancelled = true;
      resumeSession.resumeEligible = false;
      resumeSession.context = null;
    }
    return false;
  }

  try {
    if (!isResume) {
      await validateSource(source, bot.version, bot.registry);
      schematic = readSchematic
        ? await readSchematic(source, bot.version, undefined, bot.registry)
        : SchematicClass === Schematic
          ? await readProductionSchematic(source, bot.version, SchematicClass, bot.registry)
          : await SchematicClass.read(source, bot.version);
      startPosition = createPosition(bot, x, y, z, Vec3Class);
    }
    // Preflight block support before changing the bot's game mode or inventory.
    build = makeBuild(schematic, bot, startPosition);
    if (isResume && !canContinuePlan(bot, build, saved.originalStates, Vec3Class)) {
      throw new Error("World blocks no longer match the interrupted schematic build; refusing unsafe resume");
    }
  } catch (error) {
    report(`Could not parse or build schematic ${fileName}: ${describeError(error)}. Supported formats are .schem and .schematic; .litematic must be converted first.`);
    if (resumeSession) {
      resumeSession.cancelled = true;
      resumeSession.context = null;
    }
    return false;
  }

  if (!isResume && resumeSession) {
    const originalStates = inspectBuildWorld(bot, build, Vec3Class);
    resumeSession.context = {
      resolvedPath,
      source: Buffer.isBuffer(source) ? Buffer.from(source) : source,
      schematic,
      origin: { x: startPosition.x, y: startPosition.y, z: startPosition.z },
      originalStates,
      worldIdentity: worldIdentity(bot),
    };
    resumeSession.isWorldValid = (candidateBot) => isSameWorld(candidateBot, resumeSession.context?.worldIdentity);
    resumeSession.resumeEligible = false;
  }

  const lifecycle = acquireBuildLifecycle(bot);
  if (!lifecycle) {
    report("Schematic build is busy: a previous build is still settling for this bot.");
    if (isResume && resumeSession && !resumeSession.cancelled
        && isSameWorld(bot, resumeSession.context?.worldIdentity)) {
      resumeSession.resumeEligible = true;
    }
    return false;
  }
  const attemptIdentity = captureSchematicAttemptIdentity(bot, lifecycle);
  if (!isSchematicAttemptIdentityCurrent(bot, invocationIdentity)) {
    lifecycle.release();
    report("Schematic build stopped because the bot world changed during preflight.");
    if (resumeSession) {
      resumeSession.cancelled = true;
      resumeSession.resumeEligible = false;
      resumeSession.context = null;
    }
    return false;
  }

  const previousMode = normalizeGameMode(bot.game?.gameMode || "survival");
  const modes = bot.modes;
  const canManageUnstuck = modes?.exists?.("unstuck")
    && typeof modes.pause === "function"
    && typeof modes.unpause === "function";
  const wasUnstuckPaused = canManageUnstuck && typeof modes.isPaused === "function"
    ? modes.isPaused("unstuck")
    : false;
  let supplyCleanup;
  let modeSwitchAttempted = false;
  let success = false;
  let failed = false;
  let interruptedBuild = false;

  try {
    if (canManageUnstuck) modes.pause("unstuck");

    // setGameMode skips the command only when the reported mode already matches.
    // Remember whether a transition was needed so an unchanged Creative mode does
    // not require a redundant restoration event that the server will never emit.
    modeSwitchAttempted = bot.game?.gameMode !== "creative";
    let enteredCreative = false;
    try {
      enteredCreative = await changeGameMode(bot, "creative", 800);
    } catch (error) {
      report(`Could not switch to Creative mode: ${describeError(error)}`);
    }
    if (!enteredCreative) {
      report("Schematic build requires Creative mode and permission to run /gamemode creative. Grant the bot operator permission (/op) or configure Creative mode.");
      failed = true;
    } else {
      try {
        const clearing = await guardDestruction(bot, build, Vec3Class, () => clearObstructions(bot, build, {
          Vec3Class,
          isInterrupted: () => Boolean(bot.interrupt_code),
          attemptIdentity,
        }), undefined, attemptIdentity);
        if (clearing.cleared > 0) report(`Cleared ${clearing.cleared} allowlisted natural obstruction(s) inside the schematic volume.`);
      } catch (error) {
        report(`Schematic obstruction preflight/clearing failed: ${describeError(error)}`);
        if (bot.interrupt_code || error?.code === "SCHEMATIC_CLEAR_CANCELLED") interruptedBuild = true;
        else failed = true;
      }

      if (!failed && !interruptedBuild) {
        supplyCleanup = startSupply(bot);
        let builderSettlement = null;
        const result = await guardDestruction(bot, build, Vec3Class, () => executeBuild(bot, build, {
          lifecycle,
          onCancel: () => supplyCleanup?.cancel?.(),
          onPendingSettlement: (pending) => { builderSettlement = pending; },
        }), () => builderSettlement, attemptIdentity);
        interruptedBuild ||= result?.status === "interrupted";
        if (result?.status !== "finished") {
          const details = result?.errors?.map(describeError).join("; ");
          report(`Schematic build ${result?.status ?? "failed"}${details ? `: ${details}` : "."}`);
          if (!interruptedBuild || details) failed = true;
        } else {
          const mismatches = verifyBuild(bot, build, Vec3Class);
          if (mismatches.length > 0) {
            report(`Schematic verification failed: ${mismatches.join("; ")}. Mineflayer-schem has limited orientation metadata; unsupported orientations are reported as state mismatches.`);
            failed = true;
          } else {
            success = true;
          }
        }
      }
    }
  } catch (error) {
    report(`Schematic build failed: ${describeError(error)}`);
    failed = true;
  } finally {
    if (supplyCleanup) {
      try {
        supplyCleanup.cancel?.();
        const cleanupResult = await boundedCleanup(supplyCleanup, cleanupTimeoutMs);
        if (cleanupResult.timedOut) {
          supplyCleanup.abort?.();
          report("Creative inventory cleanup timed out; supply was cancelled to prevent further inventory writes.");
          failed = true;
          success = false;
        } else if (cleanupResult.error) {
          report(`Creative inventory cleanup failed: ${describeError(cleanupResult.error)}`);
          failed = true;
          success = false;
        }
      } catch (error) {
        report(`Creative inventory cleanup failed: ${describeError(error)}`);
        failed = true;
        success = false;
      }
    }

    if (previousMode !== "creative" || modeSwitchAttempted) {
      try {
        // Force a restoration command even if the client still reports the old mode;
        // a timed-out Creative transition may be acknowledged by the server late.
        const restored = await changeGameMode(bot, previousMode, 800, { force: true });
        if (!restored) {
          report(`Could not restore the previous game mode (${previousMode}).`);
          failed = true;
          success = false;
        }
      } catch (error) {
        report(`Could not restore the previous game mode (${previousMode}): ${describeError(error)}`);
        failed = true;
        success = false;
      }
    }

    if (canManageUnstuck && !wasUnstuckPaused) {
      try {
        modes.unpause("unstuck");
      } catch (error) {
        report(`Could not restore the unstuck mode state: ${describeError(error)}`);
        failed = true;
        success = false;
      }
    }
    lifecycle.release();
  }

  if (success && !failed) {
    if (resumeSession) {
      resumeSession.cancelled = true;
      resumeSession.resumeEligible = false;
      resumeSession.context = null;
    }
    report(`Successfully built and verified schematic ${path.basename(resolvedPath)}.`);
    return true;
  }
  if (resumeSession) {
    if (interruptedBuild && !failed && resumeSession.context?.originalStates != null && !resumeSession.cancelled
        && isSameWorld(bot, resumeSession.context?.worldIdentity)) {
      resumeSession.resumeEligible = true;
    } else if (!resumeSession.cancelled) {
      resumeSession.cancelled = true;
      resumeSession.resumeEligible = false;
      resumeSession.context = null;
    }
  }
  return false;
}
