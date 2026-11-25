import { access, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

import { beginCreativeSupply } from "./builder_compat.js";
import { normalizeGameMode, setGameMode } from "./game_mode.js";
import { createModernBuild, isModernBuild, translateModernBuild } from "./modern_build.js";
import {
  clearSchematicObstructions,
  captureSchematicAttemptIdentity,
  inspectSchematicObstructions,
  isSchematicAttemptIdentityCurrent,
  isSafeNaturalObstruction,
  isKnownNaturalObstructionName,
  isSchematicAirName,
  requireSchematicCells,
  withSchematicDestructionGuards,
} from "./obstruction_policy.js";
import { isReviewedDestructiveTerrain } from "./destructive_terrain_policy.js";
import { resolveSchematicPath, conservativeBotVersion } from "./paths.js";
import { schematicProvenance, provenanceAllowed } from "./provenance.js";
import { getBotWorldGeneration, trackBotWorldLifecycle } from "./world_lifecycle.js";
import { readSchematic as readProductionSchematic, validateSchematicSource } from "./reader.js";
import { acquireBuildLifecycle, runBuild } from "./run_build.js";
import { resolvePlacementOptions, validateResolvedPlacementOptions } from "./placement_options.js";
import { planBalancedSchematicSite } from "./balanced_site_planner.js";
import { inspectBalancedCandidate, inspectBalancedResume, recordBalancedEdit, revalidateBalancedSite } from "./balanced_site_safety.js";
import { assertBalancedTargets, balancedCandidateExtraReads } from "./balanced_physics_policy.js";
import { assertAuthorizedGameplaySupport, authorizedGameplayEdit } from "./authorized_gameplay_edit.js";
import { planRaiseSchematicSite, revalidateRaiseSchematicSiteAtDispatch } from "./raise_site_planner.js";

const require = createRequire(import.meta.url);
const { Schematic } = require("prismarine-schematic");
const Vec3 = require("vec3");
const CLEANUP_TIMEOUT_MS = 1_500;

// Mineflayer falls back to 0/256 when codec lookup fails. Never mistake that
// fallback for verified dimension metadata, including on custom dimensions.
function raiseDimensionBounds(bot) {
  const game = bot.game, registry = bot.registry;
  if (bot.supportFeature?.("dimensionDataInCodec") !== true || typeof game?.dimension !== "string") {
    throw new Error("Raise mode requires verified active dimension codec bounds");
  }
  const dimension = registry?.dimensionsByName?.[game.dimension];
  const minY = dimension?.minY, height = dimension?.height;
  if (!Number.isSafeInteger(minY) || !Number.isSafeInteger(height) || height <= 0
      || game.minY !== minY || game.height !== height || !Number.isSafeInteger(minY + height - 1)) {
    throw new Error("Raise mode cannot verify active dimension bounds");
  }
  return { minY, maxY: minY + height - 1 };
}

function placementReach(bot, position) {
  const p = bot.entity?.position;
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return false;
  // Conservative reach to the center of the top face; no pathfinding or flight.
  return Math.hypot(p.x - position.x - 0.5, p.y + 1.62 - position.y, p.z - position.z - 0.5) <= 4;
}

function isFullCube(block) {
  return Array.isArray(block?.shapes) && block.shapes.some(shape => Array.isArray(shape)
    && shape.length === 6 && shape.every((value, i) => value === [0, 0, 0, 1, 1, 1][i]));
}

async function placeRaisePlan(bot, plan, targets, Vec3Class, identity, lifecycle, bounds, interrupted) {
  let completedDirt = 0, completedVolume = 0;
  const check = () => {
    const now = raiseDimensionBounds(bot);
    if (now.minY !== bounds.minY || now.maxY !== bounds.maxY || interrupted()
        || !isSchematicAttemptIdentityCurrent(bot, identity) || normalizeGameMode(bot.game?.gameMode) !== "creative") {
      throw Object.assign(new Error("Raise placement cancelled or world, bounds, or Creative mode changed"), { code: "SCHEMATIC_CLEAR_CANCELLED" });
    }
  };
  const validate = () => {
    check();
    revalidateRaiseSchematicSiteAtDispatch(bot, plan, { completedDirt, completedVolume });
  };
  for (const entry of targets) {
    validate();
    const position = new Vec3Class(entry.position.x, entry.position.y, entry.position.z);
    const referencePosition = position.offset(0, -1, 0);
    const face = new Vec3Class(0, 1, 0);
    const item = bot.registry?.itemsByName?.[entry.name];
    if (!item || typeof bot.builder?.equipItem !== "function") throw new Error(`Raise Creative supply unavailable for ${entry.name}`);
    const equip = Promise.resolve(bot.builder.equipItem(item.id));
    lifecycle.hold(equip);
    await equip;
    validate();
    const reference = bot.blockAt(referencePosition), target = bot.blockAt(position);
    if (!isFullCube(reference) || !isSchematicAirName(target?.name) || !placementReach(bot, position)) {
      throw new Error(`Raise placement requires an in-reach full-cube reference and air target at ${position}`);
    }
    const refState = reference.stateId, targetState = target.stateId;
    const authorize = () => {
      validate();
      const liveRef = bot.blockAt(referencePosition), liveTarget = bot.blockAt(position);
      if (!Number.isSafeInteger(refState) || !Number.isSafeInteger(targetState) || liveRef?.stateId !== refState
          || !isFullCube(liveRef) || liveTarget?.stateId !== targetState || !isSchematicAirName(liveTarget?.name)
          || !placementReach(bot, position)) throw new Error(`Raise placement reference, target, or reach changed at ${position}`);
    };
    await authorizedGameplayEdit(bot, { kind: "place", block: reference, face, target: position,
      expectedStateId: entry.stateId, authorize, assertCurrent: check, identity });
    if (bot.blockAt(position)?.stateId !== entry.stateId) throw new Error(`Raise placement cache does not match confirmed state at ${position}`);
    if (entry.dirt) completedDirt++; else completedVolume++;
    validate();
  }
  validate();
}

// Delicate never delegates to the legacy builder: that builder may dig or add
// scaffolding. Every write is a confirmed, authorized placement into air.
function inspectDelicateVolume(bot, build, Vec3Class) {
  requireSchematicCells(build);
  if (build.cells.length + balancedCandidateExtraReads(build) > 250_000)
    throw new Error("Delicate site exceeds inspection budget");
  const targets = [];
  for (const cell of build.cells) {
    const p = new Vec3Class(cell.position.x, cell.position.y, cell.position.z);
    const block = bot.blockAt(p);
    if (!block || !Number.isSafeInteger(block.stateId)) throw new Error(`Delicate cannot inspect block at ${p}`);
    const air = isSchematicAirName(block.name);
    const expectedAir = isSchematicAirName(cell.name);
    const exact = !expectedAir && block.name === cell.name && block.stateId === cell.stateId
      && sameProperties(propertiesFor(block), cell.properties);
    if (!air && !exact) throw new Error(`Delicate blocked by ${block.name} at ${p}; clear it manually or choose another site`);
    if (!expectedAir && air) targets.push(cell);
  }
  return targets;
}

async function placeDelicateTargets(bot, build, targets, safety, Vec3Class, identity, lifecycle, interrupted) {
  const current = () => {
    if (interrupted() || build.isCancelled || !isSchematicAttemptIdentityCurrent(bot, identity)
        || normalizeGameMode(bot.game?.gameMode) !== "creative") {
      throw Object.assign(new Error("Delicate placement cancelled or world or Creative mode changed"), { code: "SCHEMATIC_CLEAR_CANCELLED" });
    }
  };
  const check = () => {
    current();
    revalidateBalancedSite(bot, build, safety, Vec3Class, identity);
    inspectDelicateVolume(bot, build, Vec3Class);
  };
  for (const entry of targets) {
    check();
    const position = new Vec3Class(entry.position.x, entry.position.y, entry.position.z);
    const referencePosition = position.offset(0, -1, 0);
    const item = bot.registry?.itemsByName?.[entry.name];
    const equip = Promise.resolve(bot.builder.equipItem(item.id));
    lifecycle.hold(equip);
    await equip;
    check();
    const reference = bot.blockAt(referencePosition), target = bot.blockAt(position);
    if (!isFullCube(reference) || !isSchematicAirName(target?.name) || !placementReach(bot, position))
      throw new Error(`Delicate placement requires an in-reach full-cube reference and air target at ${position}`);
    const refState = reference.stateId, targetState = target.stateId;
    const authorize = () => {
      check();
      const liveRef = bot.blockAt(referencePosition), liveTarget = bot.blockAt(position);
      if (!Number.isSafeInteger(refState) || !Number.isSafeInteger(targetState) || liveRef?.stateId !== refState
          || !isFullCube(liveRef) || liveTarget?.stateId !== targetState || !isSchematicAirName(liveTarget?.name)
          || !placementReach(bot, position)) throw new Error(`Delicate reference, target, or reach changed at ${position}`);
    };
    await authorizedGameplayEdit(bot, { kind: "place", block: reference, face: new Vec3Class(0, 1, 0), target: position,
      expectedStateId: entry.stateId, authorize, assertCurrent: current, identity });
    if (bot.blockAt(position)?.stateId !== entry.stateId) throw new Error(`Delicate placement cache does not match confirmed state at ${position}`);
    recordBalancedEdit(bot, safety, position, Vec3Class);
    check();
  }
}

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

function obstructionGuidance(error, build, bot) {
  const { width, height, length } = build.dimensions;
  const min = build.cells.reduce((result, { position }) => ({
    x: Math.min(result.x, position.x), y: Math.min(result.y, position.y), z: Math.min(result.z, position.z),
  }), { x: Infinity, y: Infinity, z: Infinity });
  const coordinates = ({ x, y, z }) => `${x},${y},${z}`;
  const max = { x: min.x + width - 1, y: min.y + height - 1, z: min.z + length - 1 };
  const blocker = error.kind === "unloaded" ? "unloaded cell"
    : String(error.blockName ?? "unknown block").replace(/[^a-zA-Z0-9_:.-]/g, "?").slice(0, 64);
  const safety = error.kind === "unloaded" ? "Unloaded cells cannot be checked safely."
    : /_leaves$/.test(error.blockName ?? "")
      ? "Leaves can decay outside the volume; structures/data are protected."
      : "Unsafe blocks and protected structures/data cannot be cleared.";
  return `Blocked: ${blocker} at ${coordinates(error.position)}. ${safety} Volume ${coordinates(min)} to ${coordinates(max)} (${width}x${height}x${length}). Move ${bot.username || "the bot"} to open level ground; retry or use the trusted coordinate build command.`;
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

// The legacy builder does not select a placement face for an axis, and its
// look/metadata handling cannot prove arbitrary directional states. The
// delicate/raise adapters always click an upward face, which can realize a
// vertical log. Keep all existing physics policies in force independently.
function assertRotatedGameplaySupport(build, options) {
  if (options.orientation === "north") return;
  if (!isModernBuild(build) || build.orientation !== options.orientation)
    throw new Error("Rotated builds require the verified modern adapter");
  for (const cell of build.plan) {
    const keys = Object.keys(cell.properties);
    const verticalLog = (options.mode === "delicate" || options.mode === "raise")
      && /^(?:stripped_)?(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(?:log|wood)$/.test(cell.name)
      && keys.length === 1 && cell.properties.axis === "y";
    if (keys.length !== 0 && !verticalLog) {
      throw new Error(`Rotated state ${cell.name} at ${cell.position.x},${cell.position.y},${cell.position.z} cannot be realized by the gameplay placement adapter`);
    }
  }
}

function planIdentity(build, options) {
  return createHash("sha256").update(JSON.stringify([options.orientation, build.dimensions, build.cells])).digest("hex");
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
      : actual.name === expected.name && actual.stateId === expected.stateId
      && sameProperties(properties, expected.properties);
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

    if (!expectedAir && actual.stateId !== expected.stateId) {
      mismatches.push(`${x},${y},${z}: expected state ${expected.stateId}, found ${actual.stateId ?? "unavailable"}`);
    }

    const actualProperties = propertiesFor(actual);
    for (const [key, value] of Object.entries(expected.properties ?? {})) {
      if (actualProperties[key] !== value) {
        mismatches.push(`${x},${y},${z}: expected ${expected.name} ${key}=${value}, found ${actualProperties[key] ?? "unset"}`);
      }
    }
    if (!expectedAir && !sameProperties(actualProperties, expected.properties)) {
      mismatches.push(`${x},${y},${z}: state properties differ`);
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
export function buildSchematic(bot, fileName, x = null, y = null, z = null, dependencies = {}) {
  return buildSchematicAttempt(bot, fileName, x, y, z, dependencies, false);
}

// Internal handoff only: the native human ingress must authorize before calling it.
// The dependencies argument is an internal injection seam, never request data.
export function buildTrustedDestructiveSchematic(bot, fileName, x = null, y = null, z = null, dependencies = {}) {
  return buildSchematicAttempt(bot, fileName, x, y, z, dependencies, true);
}

async function buildSchematicAttempt(bot, fileName, x, y, z, dependencies, trustedDestructive) {
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
    allowNonvalidatedSchematic = false,
    requireStrictSchematicValidation = false,
  } = dependencies;
  const report = (message) => logSafely(writeLog, message);

  let placementOptions;
  try {
    placementOptions = validateResolvedPlacementOptions(Object.hasOwn(dependencies, 'placementOptions')
      ? dependencies.placementOptions : resolvePlacementOptions());
    if (trustedDestructive && placementOptions.mode !== "destructive")
      throw new Error("Trusted destructive build requires destructive placement mode");
    if (!trustedDestructive && !["delicate", "balanced", "raise"].includes(placementOptions.mode))
      throw new Error(`${placementOptions.mode} schematic mode is temporarily unavailable; no build was started`);
    if (trustedDestructive && resumeSession?.context && !resumeSession.cancelled)
      throw new Error("Destructive schematic recovery is unavailable; refusing ambiguous partial terrain resume");
    if (placementOptions.mode === "raise" && resumeSession?.context && !resumeSession.cancelled)
      throw new Error("Raise schematic auto-resume is unavailable; refusing ambiguous partial build");
    const savedOptions = resumeSession?.context?.placementOptions;
    if (resumeSession?.context && !resumeSession.cancelled) {
      if (resumeSession.context.planContract !== "rotated-local-v1" || !savedOptions
          || !Object.hasOwn(savedOptions, 'orientation'))
        throw new Error('Legacy schematic session has no verified orientation; refusing resume');
      const original = validateResolvedPlacementOptions(savedOptions);
      if (JSON.stringify(original) !== JSON.stringify(placementOptions))
        throw new Error('Schematic placement options changed during resume');
      placementOptions = original;
    }
  } catch (error) {
    report(`Schematic placement rejected: ${describeError(error)}`);
    if (resumeSession) {
      resumeSession.cancelled = true;
      resumeSession.resumeEligible = false;
      resumeSession.context = null;
    }
    return false;
  }

  // Bind the full asynchronous read/parse/preflight path to the world's event
  // generation, not merely the identity observed after those awaits complete.
  const invocationIdentity = captureSchematicAttemptIdentity(bot);

  let resolvedPath;
  let source;
  let schematic;
  let provenanceIdentity;
  let build;
  let startPosition;
  // Production resolution returns the very bytes whose release and provenance were
  // checked. Injected resolvers may opt in to the same contract for integration tests.
  const snapshotSelection = resolvePath === resolveSchematicPath || dependencies.requireSelectionSnapshot === true;
  const selectionOptions = { version: conservativeBotVersion(bot), allowNonvalidatedSchematic, requireStrictSchematicValidation,
    ...(snapshotSelection ? { returnSnapshot: true } : {}) };
  const saved = resumeSession?.context;
  const isResume = Boolean(saved && !resumeSession?.cancelled);
  if (isResume) resumeSession.resumeEligible = false;
  try {
    if (isResume) {
      if (!/\.mc\d+(?:\.\d+)+(?:\.nonvalidated)?\.schem$/.test(saved.resolvedPath ?? "")) {
        throw new Error("Cannot resume an unversioned schematic session");
      }
      const selection = await resolvePath(saved.selector ?? fileName, undefined, selectionOptions);
      if (snapshotSelection && (!selection || typeof selection.path !== 'string' || !Buffer.isBuffer(selection.source))) throw new Error("Invalid schematic selection snapshot");
      resolvedPath = snapshotSelection ? selection.path : selection;
      if (resolvedPath !== saved.resolvedPath) throw new Error("Schematic selection changed; cancelling the interrupted build");
      const currentSource = snapshotSelection ? selection.source : await fsReadFile(resolvedPath);
      if (!Buffer.isBuffer(saved.source) || !Buffer.from(currentSource).equals(saved.source)) throw new Error("Schematic asset changed; cancelling the interrupted build");
      const provenance = snapshotSelection ? selection.provenance : await schematicProvenance(resolvedPath, currentSource);
      if (!provenanceAllowed(provenance, { allowNonvalidatedSchematic, requireStrictSchematicValidation })) throw new Error(`Schematic validation status ${provenance.validationStatus}; cannot resume`);
      if (snapshotSelection && (saved.sourceSha256 !== createHash('sha256').update(saved.source).digest('hex')
          || !saved.provenanceIdentity || saved.provenanceIdentity !== provenance.identity)) {
        throw new Error("Schematic snapshot identity changed; cancelling the interrupted build");
      }
      source = Buffer.from(saved.source);
      schematic = saved.schematic;
      startPosition = new Vec3Class(saved.origin.x, saved.origin.y, saved.origin.z);
      if (!isSameWorld(bot, saved.worldIdentity)) {
        throw new Error("Cannot resume schematic build after death, disconnect, or dimension/world change");
      }
    } else {
      const selection = await resolvePath(fileName, undefined, selectionOptions);
      if (snapshotSelection && (!selection || typeof selection.path !== 'string' || !Buffer.isBuffer(selection.source))) throw new Error("Invalid schematic selection snapshot");
      resolvedPath = snapshotSelection ? selection.path : selection;
      if (snapshotSelection) source = Buffer.from(selection.source);
      else {
        await fsAccess(resolvedPath);
        source = await fsReadFile(resolvedPath);
      }
      const provenance = snapshotSelection ? selection.provenance : await schematicProvenance(resolvedPath, source);
      if (!provenanceAllowed(provenance, { allowNonvalidatedSchematic, requireStrictSchematicValidation })) {
        throw new Error(`Validation status ${provenance.validationStatus}: ${provenance.reason ?? 'set allow_nonvalidated_schematic_builds=true to consent to NONVALIDATED output'}`);
      }
      provenanceIdentity = provenance.identity;
      if (provenance.validationStatus !== 'STRICT_VALIDATED') {
        report(`WARNING: schematic validation status ${provenance.validationStatus}; legal block-state combinations are not proven.`);
      }
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
    build = makeBuild(schematic, bot, startPosition, { orientation: placementOptions.orientation });
    assertRotatedGameplaySupport(build, placementOptions);
    if (isResume && (typeof saved.planIdentity !== "string" || saved.planIdentity !== planIdentity(build, placementOptions))) {
      throw new Error("Schematic orientation, origin, or transformed plan changed during resume");
    }
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

  // Fixed-origin delicate snapshots before selection; balanced cannot snapshot until
  // its selected origin is known under the lifecycle lease.
  if (!isResume && resumeSession && placementOptions.mode === "delicate") {
    const originalStates = inspectBuildWorld(bot, build, Vec3Class);
    resumeSession.context = {
      selector: fileName,
      resolvedPath,
      source: Buffer.isBuffer(source) ? Buffer.from(source) : source,
      sourceSha256: Buffer.isBuffer(source) ? createHash('sha256').update(source).digest('hex') : null,
      provenanceIdentity,
      placementOptions,
      planContract: "rotated-local-v1",
      planIdentity: planIdentity(build, placementOptions),
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
  const clearingQualification = trustedDestructive
    ? block => isSchematicAttemptIdentityCurrent(bot, attemptIdentity) && isReviewedDestructiveTerrain(bot, block)
    : null;
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
  let modeSetupStarted = false;
  let unstuckPauseStarted = false;
  let success = false;
  let failed = false;
  let interruptedBuild = false;

  try {
    let balancedSafety;
    let balancedCheck;
    let raisePlan, raiseTargets, raiseBounds;
    let delicateTargets, delicateSafety;
    if (placementOptions.mode === "delicate") {
      const check = () => {
        if (bot.interrupt_code || build.isCancelled || resumeSession?.cancelled || !isSchematicAttemptIdentityCurrent(bot, attemptIdentity))
          throw Object.assign(new Error("Delicate inspection cancelled or world changed"), { code: "SCHEMATIC_CLEAR_CANCELLED" });
      };
      check();
      delicateTargets = inspectDelicateVolume(bot, build, Vec3Class);
      assertBalancedTargets(bot, build);
      delicateSafety = await inspectBalancedResume(bot, build, Vec3Class, check);
      revalidateBalancedSite(bot, build, delicateSafety, Vec3Class, attemptIdentity);
      inspectDelicateVolume(bot, build, Vec3Class);
      if (delicateTargets.length) assertAuthorizedGameplaySupport(bot, "place");
      const earlier = new Set();
      for (const entry of delicateTargets) {
        const p = entry.position, below = new Vec3Class(p.x, p.y - 1, p.z);
        if (!bot.registry?.itemsByName?.[entry.name] || bot.registry?.blocksByStateId?.[entry.stateId]?.name !== entry.name
            || typeof bot.builder?.equipItem !== "function") throw new Error(`Delicate Creative supply unavailable for ${entry.name}`);
        if (!placementReach(bot, p) || (!earlier.has(`${below.x},${below.y},${below.z}`) && !isFullCube(bot.blockAt(below))))
          throw new Error(`Delicate ordered placement has no in-reach upward reference at ${p.x},${p.y},${p.z}`);
        earlier.add(`${p.x},${p.y},${p.z}`);
      }
    }
    if (placementOptions.mode === "raise") {
      raiseBounds = raiseDimensionBounds(bot);
      assertAuthorizedGameplaySupport(bot, "place");
      const anchorBuild = build;
      const interrupted = () => Boolean(bot.interrupt_code || resumeSession?.cancelled);
      raisePlan = await planRaiseSchematicSite(bot, anchorBuild, { origin: startPosition, worldBounds: raiseBounds,
        Vec3Class, lifecycle, isInterrupted: interrupted });
      startPosition = new Vec3Class(raisePlan.origin.x, raisePlan.origin.y, raisePlan.origin.z);
      build = isModernBuild(anchorBuild) ? translateModernBuild(anchorBuild, startPosition) : makeBuild(schematic, bot, startPosition, { orientation: placementOptions.orientation });
      if (build.cells?.length !== raisePlan.volume.length || build.cells.some((cell, i) => {
        const expected = raisePlan.volume[i];
        return cell.position.x !== expected.position.x || cell.position.y !== expected.position.y
          || cell.position.z !== expected.position.z || cell.name !== expected.name
          || cell.stateId !== expected.stateId || !sameProperties(cell.properties, expected.properties);
      })) throw new Error("Transformed schematic changed while selecting a raise site");
      revalidateRaiseSchematicSiteAtDispatch(bot, raisePlan);
      const dirtState = bot.registry?.blocksByName?.dirt?.defaultState;
      if (!Number.isSafeInteger(dirtState) || bot.registry?.blocksByStateId?.[dirtState]?.name !== "dirt") {
        throw new Error("Raise dirt state is unavailable");
      }
      raiseTargets = [
        ...raisePlan.dirt.map(position => ({ position, name: "dirt", stateId: dirtState, dirt: true })),
        ...raisePlan.volume.filter(cell => !isSchematicAirName(cell.name)
          && isSchematicAirName(bot.blockAt(new Vec3Class(cell.position.x, cell.position.y, cell.position.z))?.name)),
      ];
      // Establish the whole deterministic order before changing mode. This first
      // path only places upward on existing full cubes or earlier planned dirt.
      const placedDirt = new Set();
      for (const entry of raiseTargets) {
        const p = entry.position, below = new Vec3Class(p.x, p.y - 1, p.z);
        const belowKey = `${below.x},${below.y},${below.z}`;
        if (!bot.registry?.itemsByName?.[entry.name] || bot.registry?.blocksByStateId?.[entry.stateId]?.name !== entry.name
            || typeof bot.builder?.equipItem !== "function") throw new Error(`Raise Creative supply unavailable for ${entry.name}`);
        if (!placementReach(bot, p) || (!placedDirt.has(belowKey) && !isFullCube(bot.blockAt(below)))) {
          throw new Error(`Raise ordered placement has no in-reach upward reference at ${p.x},${p.y},${p.z}`);
        }
        if (entry.dirt) placedDirt.add(`${p.x},${p.y},${p.z}`);
      }
      report(`Raise site: origin ${startPosition.x},${startPosition.y},${startPosition.z}; dimension Y ${raiseBounds.minY}..${raiseBounds.maxY}; ${raisePlan.dirt.length} dirt and ${raiseTargets.length - raisePlan.dirt.length} volume placements.`);
    }
    if (placementOptions.mode === "balanced" || trustedDestructive) {
      if (trustedDestructive) requireSchematicCells(build);
      assertBalancedTargets(bot, build);
      const check = () => {
        if (bot.interrupt_code || build.isCancelled || resumeSession?.cancelled || !isSchematicAttemptIdentityCurrent(bot, attemptIdentity)) {
          throw Object.assign(new Error("Balanced site inspection cancelled or world changed"), { code: "SCHEMATIC_CLEAR_CANCELLED" });
        }
      };
      balancedCheck = check;
      if (isResume || trustedDestructive) {
        balancedSafety = await inspectBalancedResume(bot, build, Vec3Class, check, clearingQualification);
      } else {
        const anchorBuild = build;
        const selected = await planBalancedSchematicSite(bot, anchorBuild, {
          Vec3Class, radius: placementOptions.radius, threshold: placementOptions.threshold, attemptIdentity,
          strategy: placementOptions.strategy, step: placementOptions.step, policy: placementOptions.policy, bisectDepth: placementOptions.bisectDepth,
          isInterrupted: () => Boolean(bot.interrupt_code || resumeSession?.cancelled),
          inspectCandidate: (offset, states, plannerCheck, beforeRead, snapshot) => inspectBalancedCandidate(bot, snapshot, offset, states, Vec3Class, () => { check(); plannerCheck(); }, beforeRead),
        });
        check();
        startPosition = new Vec3Class(startPosition.x + selected.dx, startPosition.y, startPosition.z + selected.dz);
        build = isModernBuild(anchorBuild) ? translateModernBuild(anchorBuild, startPosition) : makeBuild(schematic, bot, startPosition, { orientation: placementOptions.orientation });
        if (["width", "height", "length"].some(key => build.dimensions?.[key] !== selected.plan.dimensions[key])
            || build.cells?.length !== selected.plan.cells.length || build.cells.some((cell, i) => {
          const previous = selected.plan.cells[i];
          return cell.position.x !== previous.position.x + selected.dx || cell.position.y !== previous.position.y
            || cell.position.z !== previous.position.z + selected.dz || cell.name !== previous.name || cell.stateId !== previous.stateId
            || !sameProperties(cell.properties, previous.properties);
        })) throw new Error("Transformed schematic changed while selecting a balanced site");
        balancedSafety = selected.safety;
        const { min, max } = balancedSafety.box;
        report(`Balanced site: origin ${startPosition.x},${startPosition.y},${startPosition.z}; bounds ${min.x},${min.y},${min.z} to ${max.x - 1},${max.y - 1},${max.z - 1}; ${selected.obstructions} mismatches; ${selected.search.sampled ? "sampled search" : "complete search"} (${selected.search.strategy}/${selected.search.policy}, ${selected.search.visited}/${selected.search.candidates} candidates, ${selected.search.reads} reads).`);
      }
      revalidateBalancedSite(bot, build, balancedSafety, Vec3Class, attemptIdentity, clearingQualification);
      build.beforeSchematicEdit = () => {
        check();
        if (trustedDestructive && normalizeGameMode(bot.game?.gameMode) !== "creative") throw new Error("Destructive schematic editing requires Creative mode");
        revalidateBalancedSite(bot, build, balancedSafety, Vec3Class, attemptIdentity, clearingQualification);
      };
      build.afterSchematicEdit = position => recordBalancedEdit(bot, balancedSafety, position, Vec3Class);
    }
    if (!isResume && resumeSession && balancedSafety && !trustedDestructive) {
      const originalStates = balancedSafety?.states.map(item => ({ ...item, position: { ...item.position }, properties: { ...item.properties } }))
        ?? inspectBuildWorld(bot, build, Vec3Class);
      resumeSession.context = {
        selector: fileName, resolvedPath,
        source: Buffer.isBuffer(source) ? Buffer.from(source) : source,
        sourceSha256: Buffer.isBuffer(source) ? createHash('sha256').update(source).digest('hex') : null,
        provenanceIdentity, placementOptions, schematic, planContract: "rotated-local-v1", planIdentity: planIdentity(build, placementOptions),
        origin: { x: startPosition.x, y: startPosition.y, z: startPosition.z },
        originalStates, worldIdentity: worldIdentity(bot),
      };
      resumeSession.isWorldValid = candidateBot => isSameWorld(candidateBot, resumeSession.context?.worldIdentity);
      resumeSession.resumeEligible = false;
    }
    // This is an early diagnostic only. Guarded clearing performs its own fresh
    // full-volume scan and never relies on these advisory snapshots.
    const preflightObstructions = raisePlan || delicateSafety ? [] : inspectSchematicObstructions(bot, build, { Vec3Class, attemptIdentity, collectSnapshots: trustedDestructive, clearingQualification });
    if (trustedDestructive) {
      // Reject unsupported plans before changing mode, supplying items, or editing.
      // Modern digging additionally needs authenticated read-only server
      // confirmation; a sequence acknowledgement alone never authorizes it.
      assertAuthorizedGameplaySupport(bot, "place");
      if (preflightObstructions.length) assertAuthorizedGameplaySupport(bot, "dig");
    }
    if (delicateSafety && delicateTargets.length === 0) {
      revalidateBalancedSite(bot, build, delicateSafety, Vec3Class, attemptIdentity);
      inspectDelicateVolume(bot, build, Vec3Class);
      success = true;
    } else {
      if (canManageUnstuck) {
        unstuckPauseStarted = true;
        modes.pause("unstuck");
      }

      // setGameMode skips the command only when the reported mode already matches.
      // Remember whether a transition was needed so an unchanged Creative mode does
      // not require a redundant restoration event that the server will never emit.
      modeSetupStarted = true;
      modeSwitchAttempted = bot.game?.gameMode !== "creative";
      let enteredCreative = false;
      try {
        enteredCreative = await changeGameMode(bot, "creative", 800);
      } catch (error) {
        report(`Could not switch to Creative mode: ${describeError(error)}`);
      }
      if (!enteredCreative || (trustedDestructive && normalizeGameMode(bot.game?.gameMode) !== "creative")) {
        report("Schematic build requires Creative mode and permission to run /gamemode creative. Grant the bot operator permission (/op) or configure Creative mode.");
        failed = true;
      } else if (delicateSafety) {
        revalidateBalancedSite(bot, build, delicateSafety, Vec3Class, attemptIdentity);
        inspectDelicateVolume(bot, build, Vec3Class);
        supplyCleanup = startSupply(bot);
        await placeDelicateTargets(bot, build, delicateTargets, delicateSafety, Vec3Class, attemptIdentity, lifecycle,
          () => Boolean(bot.interrupt_code || resumeSession?.cancelled));
        const mismatches = verifyBuild(bot, build, Vec3Class);
        if (mismatches.length) throw new Error(`Delicate schematic verification failed: ${mismatches.join("; ")}`);
        success = true;
      } else if (raisePlan) {
        revalidateRaiseSchematicSiteAtDispatch(bot, raisePlan);
        supplyCleanup = startSupply(bot);
        await placeRaisePlan(bot, raisePlan, raiseTargets, Vec3Class, attemptIdentity, lifecycle, raiseBounds,
          () => Boolean(bot.interrupt_code || resumeSession?.cancelled));
        const mismatches = verifyBuild(bot, build, Vec3Class);
        if (mismatches.length) throw new Error(`Raise schematic verification failed: ${mismatches.join("; ")}`);
        success = true;
      } else {
        try {
          const clearing = await guardDestruction(bot, build, Vec3Class, () => {
            if (balancedSafety) { balancedCheck(); revalidateBalancedSite(bot, build, balancedSafety, Vec3Class, attemptIdentity, clearingQualification); }
            return clearObstructions(bot, build, {
              Vec3Class,
              isInterrupted: () => Boolean(bot.interrupt_code || (balancedSafety && resumeSession?.cancelled)),
              attemptIdentity,
              clearingQualification,
            });
          }, undefined, attemptIdentity, clearingQualification, trustedDestructive);
          if (clearing.cleared > 0) report(trustedDestructive
            ? `Cleared ${clearing.cleared} reviewed obstruction(s) inside the schematic volume.`
            : `Cleared ${clearing.cleared} allowlisted natural obstruction(s) inside the schematic volume.`);
        } catch (error) {
          report(error?.code === "SCHEMATIC_OBSTRUCTION"
            ? obstructionGuidance(error, build, bot)
            : `Schematic obstruction preflight/clearing failed: ${describeError(error)}`);
          if (bot.interrupt_code || error?.code === "SCHEMATIC_CLEAR_CANCELLED") interruptedBuild = true;
          else failed = true;
        }

        if (!failed && !interruptedBuild) {
          if (balancedSafety) { balancedCheck(); revalidateBalancedSite(bot, build, balancedSafety, Vec3Class, attemptIdentity, clearingQualification); }
          supplyCleanup = startSupply(bot);
          let builderSettlement = null;
          const result = await guardDestruction(bot, build, Vec3Class, () => {
            if (balancedSafety) { balancedCheck(); revalidateBalancedSite(bot, build, balancedSafety, Vec3Class, attemptIdentity, clearingQualification); }
            return executeBuild(bot, build, {
              lifecycle,
              onCancel: () => supplyCleanup?.cancel?.(),
              onPendingSettlement: (pending) => { builderSettlement = pending; },
            });
          }, () => builderSettlement, attemptIdentity, clearingQualification, trustedDestructive);
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
    }
  } catch (error) {
    report(error?.code === "SCHEMATIC_OBSTRUCTION"
      ? obstructionGuidance(error, build, bot)
      : `Schematic build failed: ${describeError(error)}`);
    if (error?.code === "SCHEMATIC_CLEAR_CANCELLED") interruptedBuild = true;
    else failed = true;
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

    if (modeSetupStarted && (previousMode !== "creative" || modeSwitchAttempted)) {
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

    if (unstuckPauseStarted && !wasUnstuckPaused) {
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
    if (trustedDestructive && interruptedBuild) report("Destructive schematic recovery is unavailable; refusing ambiguous partial terrain resume.");
    if (!trustedDestructive && placementOptions.mode !== "raise" && interruptedBuild && !failed && resumeSession.context?.originalStates != null && !resumeSession.cancelled
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
