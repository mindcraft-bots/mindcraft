import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { beginCreativeSupply } from "./builder_compat.js";
import { normalizeGameMode, setGameMode } from "./game_mode.js";
import { createModernBuild } from "./modern_build.js";
import { resolveSchematicPath } from "./paths.js";
import { validateSchematicSource } from "./reader.js";
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

function verifyBuild(bot, build, Vec3Class) {
  const mismatches = [];
  for (const expected of build.plan ?? []) {
    const { x, y, z } = expected.position;
    let actual;
    try {
      actual = bot.blockAt(new Vec3Class(x, y, z));
    } catch (error) {
      mismatches.push(`${x},${y},${z}: could not inspect block (${describeError(error)})`);
      continue;
    }

    if (!actual || actual.name !== expected.name) {
      mismatches.push(`${x},${y},${z}: expected ${expected.name}, found ${actual?.name ?? "unavailable"}`);
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
    changeGameMode = setGameMode,
    writeLog,
    cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  } = dependencies;
  const report = (message) => logSafely(writeLog, message);

  let resolvedPath;
  let source;
  try {
    resolvedPath = await resolvePath(fileName);
    await fsAccess(resolvedPath);
    source = await fsReadFile(resolvedPath);
  } catch (error) {
    report(`Could not read schematic ${fileName}: ${describeError(error)}`);
    return false;
  }

  if (path.extname(resolvedPath).toLowerCase() === ".litematic") {
    report(".litematic files can be listed but are not supported by the schematic reader. Convert this file to .schem or .schematic first.");
    return false;
  }

  let schematic;
  let build;
  let startPosition;
  try {
    await validateSource(source, bot.version, bot.registry);
    schematic = readSchematic
      ? await readSchematic(source, bot.version)
      : await SchematicClass.read(source, bot.version);
    startPosition = createPosition(bot, x, y, z, Vec3Class);
    // Preflight block support before changing the bot's game mode or inventory.
    build = makeBuild(schematic, bot, startPosition);
  } catch (error) {
    report(`Could not parse or build schematic ${fileName}: ${describeError(error)}. Supported formats are .schem and .schematic; .litematic must be converted first.`);
    return false;
  }

  const lifecycle = acquireBuildLifecycle(bot);
  if (!lifecycle) {
    report("Schematic build is busy: a previous build is still settling for this bot.");
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
      supplyCleanup = startSupply(bot);
      const result = await executeBuild(bot, build, {
        lifecycle,
        onCancel: () => supplyCleanup?.cancel?.(),
      });
      if (result?.status !== "finished") {
        const details = result?.errors?.map(describeError).join("; ");
        report(`Schematic build ${result?.status ?? "failed"}${details ? `: ${details}` : "."}`);
        failed = true;
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
    report(`Successfully built and verified schematic ${path.basename(resolvedPath)}.`);
    return true;
  }
  return false;
}
