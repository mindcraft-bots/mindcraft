import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { getBotWorldGeneration } from "./world_lifecycle.js";
import { hasAuthenticatedServerConnection } from "../authenticated_chat.js";

const require = createRequire(import.meta.url);
const injectDigging = require("mineflayer/lib/plugins/digging.js");
const injectGenericPlace = require("mineflayer/lib/plugins/generic_place.js");
const injectPlaceBlock = require("mineflayer/lib/plugins/place_block.js");
const nativeVersion = require("mineflayer/package.json").version;
const minecraftData = require("minecraft-data");
const { simplify } = require("prismarine-nbt");
const busy = new WeakSet();
const nextSequence = new WeakMap();
// Private adapter range, disjoint from the reviewed native plugins' zero / low
// counters. Never reuse or wrap on a connection, including failed operations.
function allocateSequence(client) {
  const sequence = nextSequence.get(client) ?? 0x40000000;
  if (sequence > 0x7fffffff) throw new Error("Authorized dig sequence range exhausted; reconnect required");
  nextSequence.set(client, sequence + 1);
  return sequence;
}
const sequenceAck = ["container", [{ name: "sequenceId", type: "varint" }]];
function modernDig(bot) {
  return bot.version === "1.21.4"
    && JSON.stringify(minecraftData(bot.version)?.protocol?.play?.toClient?.types?.packet_acknowledge_player_digging) === JSON.stringify(sequenceAck);
}
const key = p => `${p.x},${p.y},${p.z}`;
const isPosition = p => p && [p.x, p.y, p.z].every(Number.isSafeInteger);
const direction = face => face.y < 0 ? 0 : face.y > 0 ? 1 : face.z < 0 ? 2 : face.z > 0 ? 3 : face.x < 0 ? 4 : 5;

// This adapter depends on reviewed native plugin control flow and the modern
// section-long block-update encoding. Do not guess at other plugin/protocols.
export function assertAuthorizedGameplaySupport(bot, kind) {
  if (nativeVersion !== "4.39.0"
      || !bot.supportFeature?.("usesMultiblockSingleLong")
      || !bot.supportFeature?.("usesMultiblock3DChunkCoords")
      || !bot.supportFeature?.("blockPlaceHasInsideBlock")
      || typeof bot._client?.write !== "function"
      || typeof bot._client?.on !== "function"
      || typeof bot._client?.removeListener !== "function"
      || typeof bot.digTime !== "function") {
    throw new Error("Destructive final-write authorization requires reviewed Mineflayer 4.39.0 and modern section-long block updates / inside-block placement protocol support");
  }
  if (kind === "dig") {
    // 1.19+ reuses this packet name for a sequence-only processing fence. Only
    // exact 1.21.4 has the separately reviewed authenticated read-back path;
    // native digging and an uncorrelated block update alone prove no outcome.
    const ack = minecraftData(bot.version)?.protocol?.play?.toClient?.types?.packet_acknowledge_player_digging;
    if (modernDig(bot) && hasAuthenticatedServerConnection(bot)
        && JSON.stringify(minecraftData(bot.version)?.protocol?.play?.toServer?.types?.packet_chat_command)
          === JSON.stringify(["container", [{ name: "command", type: "string" }]])) return;
    if (JSON.stringify(ack) !== JSON.stringify(["container", [
      { name: "location", type: "position" }, { name: "block", type: "varint" },
      { name: "status", type: "varint" }, { name: "successful", type: "bool" },
    ]])) {
      throw new Error("Authorized digging requires detailed acknowledgement or reviewed Java 1.21.4 authenticated server read-back; sequence-only or unknown digging protocols alone cannot distinguish the outcome");
    }
  }
}

/**
 * Invoke installed native gameplay code with an operation-private bot/client.
 * No shared packet writer or native method is patched. Every native edit write,
 * including timer-delayed dig completion, must pass synchronous authorization.
 * The callbacks also make this usable by a future separately-reviewed placement
 * policy; this module itself grants no bounds/material/foundation permission.
 */
export async function authorizedGameplayEdit(bot, {
  kind, block, face, target, expectedStateId, authorize, assertCurrent,
  identity, timeoutMs = 5_000, onOutcome,
}) {
  assertAuthorizedGameplaySupport(bot, kind);
  if (!["dig", "place"].includes(kind) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid authorized gameplay operation");
  }
  if (!isPosition(target) || !isPosition(block?.position) || typeof block.position.clone !== "function"
      || typeof authorize !== "function" || typeof assertCurrent !== "function" || !identity) {
    throw new Error("Invalid authorized gameplay target or validation callbacks");
  }
  if (kind === "place" && (!Number.isSafeInteger(expectedStateId)
      || !bot.registry?.blocksByStateId?.[expectedStateId]
      || ["air", "cave_air", "void_air"].includes(bot.registry.blocksByStateId[expectedStateId].name))) {
    throw new Error("Authorized placement requires a known non-air expected block state");
  }
  if (kind === "dig" ? key(block.position) !== key(target)
    : !isPosition(face) || typeof face.clone !== "function" || Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) !== 1
      || key(block.position.plus(face)) !== key(target)) {
    throw new Error("Invalid authorized gameplay reference or face");
  }
  if (busy.has(bot)) throw new Error("A destructive gameplay operation is still settling or lacks server confirmation; refusing overlap");
  assertCurrent();
  authorize();
  busy.add(bot);
  const client = bot._client;
  const modern = kind === "dig" && modernDig(bot);
  const gameMode = bot.game?.gameMode;
  const events = new EventEmitter();
  let revoked = false;
  let sent = false;
  let confirmed = false;
  let completed = false;
  // Native promise settlement is deliberately not a confirmation transition.
  // Placement needs a one-shot ordered reply pair. Legacy digging consumes
  // every detailed reply; modern digging fences all writes before fresh reads.
  let confirmationState = "prepared";
  const digStatuses = new Set();
  // Detailed legacy acknowledgements have no request id. Consume every sent
  // action exactly once, in transport order, before releasing this bot's lease.
  // In particular, a delayed instant-break start reply cannot hide a finish
  // already sent by the native timer (whose late reply could poison a later dig).
  const pendingDigStatuses = [];
  let packetOrder = 0;
  let referenceOrder = null;
  const ownedSequences = [];
  let fenceSequence = null;
  let targetRevision = 0;
  let airOrder = null;
  let pendingRead = null;
  let readCount = 0;
  let resolveProbe;
  const probe = new Promise(resolve => { resolveProbe = resolve; });
  let fail;
  let confirm;
  const failure = new Promise((_, reject) => { fail = reject; });
  const confirmation = new Promise(resolve => { confirm = resolve; });
  // Capture coordinates separately from native arguments and caller-owned data.
  const targetKey = key(target);
  const referenceKey = key(block.position);
  const diagnostic = (phase, error, observation = {}) => {
    try {
      bot.emit("schematicEditAuthorization", {
        kind, position: targetKey, phase, message: error?.message,
        confirmationState, pendingDigStatuses: [...pendingDigStatuses], packetOrder, referenceOrder,
        ownedSequences: [...ownedSequences], fenceSequence, targetRevision, airOrder,
        ...observation,
      });
    }
    catch { /* diagnostics cannot grant or prevent cleanup */ }
  };
  const digConfirmationState = () => pendingDigStatuses[0] === 0
    ? pendingDigStatuses.length > 1 ? "dig-awaiting-start-and-finish-acks" : "dig-awaiting-start-ack"
    : pendingDigStatuses.length ? "dig-awaiting-finish-ack" : "dig-awaiting-finish-write";
  const nativeBlock = Object.assign(Object.create(Object.getPrototypeOf(block)), block, { position: block.position.clone() });
  const nativeFace = face?.clone();
  const scopedClient = Object.create(client);
  const scope = new Proxy(events, {
    get(object, property) {
      if (Reflect.has(object, property)) return Reflect.get(object, property);
      const value = bot[property];
      return typeof value === "function" ? value.bind(bot) : value;
    },
  });
  scope._client = scopedClient;
  // Digging's finish timer predicts air. Suppress that prediction only inside
  // this operation; completion must instead come from an actual server update.
  scope._updateBlockState = () => {};
  const rejectOperation = error => {
    if (revoked) return;
    // Revocation is synchronous: no later native write or inbound event may
    // succeed while the rejection is still waiting for a promise continuation.
    revoked = true;
    confirmationState = "revoked";
    diagnostic("rejected", error);
    fail(error);
  };
  const checkCurrent = () => {
    if (revoked) throw new Error("Destructive gameplay operation authorization was revoked");
    assertCurrent();
    if (bot.game?.gameMode !== gameMode) throw new Error("Destructive gameplay operation game mode changed");
    if (modern && !hasAuthenticatedServerConnection(bot, client)) throw new Error("Destructive dig server authentication was lost");
  };
  const requestRead = purpose => {
    checkCurrent();
    if (pendingRead || purpose === "air" && pendingDigStatuses.length) return;
    if (++readCount > 8) throw new Error("Destructive dig authoritative read-back remained unstable");
    const name = purpose === "probe" ? nativeBlock.name : "air";
    if (!/^[a-z0-9_]+$/.test(name) || bot.registry?.blocksByStateId?.[nativeBlock.stateId]?.name !== nativeBlock.name) {
      throw new Error("Invalid authoritative dig read-back block");
    }
    const nonce = `mindcraft-dig-${randomBytes(24).toString("hex")}`;
    pendingRead = { purpose, nonce, revision: targetRevision, fence: fenceSequence, order: packetOrder };
    confirmationState = purpose === "probe" ? "dig-awaiting-read-permission" : "dig-awaiting-authoritative-air-read";
    const coordinates = targetKey.replaceAll(",", " ");
    // Exact 1.21.4 unsigned-command packet: no signable message arguments. Do
    // not use bot.chat's queue/splitting or any player/display ingress event.
    // Both commands require vanilla permission level 2 and change no world data.
    const command = `execute if loaded ${coordinates} if block ${coordinates} minecraft:${name} run tellraw @s ${JSON.stringify({ text: nonce })}`;
    if (purpose === "probe") authorize();
    checkCurrent();
    client.write("chat_command", { command });
    diagnostic(`dig-${purpose}-read-requested`);
  };
  const onGame = () => {
    try { checkCurrent(); } catch (error) { rejectOperation(error); }
  };
  bot.on("game", onGame);
  scopedClient.write = (name, packet) => {
    // Native cleanup may cancel an already-started dig, but never on a new world.
    if (name === "block_dig" && packet.status === 1) {
      if (bot._client === client && bot.world === identity.world
          && bot.game?.dimension === identity.dimension
          && getBotWorldGeneration(bot) === identity.worldGeneration
          && !client.ended && !client.socket?.destroyed) client.write(name, modern ? { ...packet, sequence: allocateSequence(client) } : packet);
      return;
    }
    try {
      checkCurrent();
      const validPacket = kind === "dig"
        ? name === "block_dig" && [0, 2].includes(packet.status) && key(packet.location) === targetKey
        : name === "block_place" && key(packet.location) === referenceKey
          && packet.direction === direction(nativeFace) && packet.hand === 0;
      if (!validPacket) throw new Error("Unexpected native destructive gameplay write");
      authorize();
      checkCurrent();
      if (kind === "place" && bot.heldItem?.name !== bot.registry?.blocksByStateId?.[expectedStateId]?.name) {
        throw new Error("Held item no longer matches the authorized placement target");
      }
      if (kind === "dig") {
        if (confirmed || digStatuses.has(packet.status)) throw new Error("Unexpected repeated or completed native dig action");
        if (packet.status === 2 && !digStatuses.has(0)) throw new Error("Native dig finish without an authorized start");
        digStatuses.add(packet.status);
        pendingDigStatuses.push(packet.status);
        if (modern) {
          packet = { ...packet, sequence: allocateSequence(client) };
          ownedSequences.push(packet.sequence);
          // A raced finish invalidates any earlier read-back, even if its reply
          // is already queued. Only the latest dispatched action can fence it.
          pendingRead = null;
          fenceSequence = null;
        }
        confirmationState = digConfirmationState();
      } else {
        if (confirmationState !== "prepared") throw new Error("Unexpected repeated native placement action");
        confirmationState = "place-awaiting-reference";
      }
      sent = true;
      const result = client.write(name, packet);
      diagnostic("authorized");
      return result;
    } catch (error) {
      // Native dig completion runs in a timer: throwing here would escape its
      // promise and crash the process. Reject the operation and let cleanup stop it.
      rejectOperation(error);
      // The finish timer clears targetDigBlock immediately after this call.
      // Abort now, while native cleanup can still cancel its started dig.
      if (name === "block_dig" && packet.status === 2) {
        try { scope.stopDigging?.(); } catch { /* never throw from the native timer */ }
      }
      if (name !== "block_dig" || packet.status !== 2) throw error;
    }
  };

  const forwarded = [...new Set([targetKey, referenceKey])].map(position => {
    const event = `blockUpdate:(${position.split(",").join(", ")})`;
    const listener = (...args) => events.emit(event, ...args);
    bot.on(event, listener);
    return [event, listener];
  });
  const acceptConfirmation = () => {
    if (confirmed) return;
    confirmed = true;
    confirmationState = "confirmed";
    diagnostic("server-confirmed");
    confirm();
  };
  const observe = (position, stateId) => {
    if (!sent || revoked || !isPosition(position)) return;
    if (confirmed) {
      // Keep a modern proof valid through native/promise settlement, not merely
      // until the echo listener returns. Back-to-back queued packets can still
      // contradict the proof before the caller resumes.
      if (modern && key(position) === targetKey
          && bot.registry?.blocksByStateId?.[stateId]?.name !== "air") {
        rejectOperation(new Error(`Server contradicted destructive dig target-air confirmation at ${targetKey}`));
      }
      return;
    }
    try {
      checkCurrent();
      if (kind === "dig") {
        if (modern && key(position) === targetKey) {
          targetRevision++;
          airOrder = bot.registry?.blocksByStateId?.[stateId]?.name === "air" ? packetOrder : null;
          // Cache synchronization is not proof. A fresh server conditional must
          // follow this revision; never retain a read-back across a later update.
          if (pendingRead?.purpose === "air") {
            pendingRead = null;
            diagnostic("dig-stale-read-rejected");
          }
          if (fenceSequence !== null) requestRead("air");
        }
        // Native digging tolerates non-air updates at start. Neither those nor
        // an uncorrelated air update establishes a successful dig acknowledgement.
        // In particular, unchanged pre-finish updates are not placement refusals.
        if (key(position) === targetKey) diagnostic("dig-update-unconfirmed", undefined, {
          stateId, unchanged: stateId === nativeBlock.stateId, finishDispatched: digStatuses.has(2),
        });
        return;
      }
      if (key(position) === referenceKey) {
        if (confirmationState !== "place-awaiting-reference") {
          throw new Error(`Server did not confirm destructive place at ${targetKey}: ambiguous repeated reference response`);
        }
        referenceOrder = packetOrder;
        confirmationState = "place-awaiting-target";
        diagnostic("placement-reference-observed");
        return;
      }
      if (key(position) !== targetKey) return;
      if (confirmationState !== "place-awaiting-target" || packetOrder <= referenceOrder) {
        // Never retain a matching early state for use after the reference fence.
        diagnostic("placement-target-before-reference-response", undefined, { stateId });
        return;
      }
      // Reviewed place_block.js documents reference then destination replies.
      // A section packet is one observation, not an ordering fence between its
      // records. Local blockUpdate events never advance this state machine.
      if (stateId !== expectedStateId) throw new Error(`Server did not confirm destructive place at ${targetKey}`);
      acceptConfirmation();
    } catch (error) { rejectOperation(error); }
  };
  const onDigAck = packet => {
    if (modern) {
      packetOrder++;
      if (!sent || revoked || confirmed) return;
      try {
        checkCurrent();
        const index = ownedSequences.indexOf(packet.sequenceId);
        if (!Number.isSafeInteger(packet.sequenceId) || index < 0) {
          diagnostic("dig-unowned-sequence-ignored", undefined, { sequenceId: packet.sequenceId });
          return;
        }
        // Vanilla acknowledges the maximum processed sequence per tick, not
        // one reply per action. Only an exact owned value may retire its prefix.
        ownedSequences.splice(0, index + 1);
        pendingDigStatuses.splice(0, index + 1);
        diagnostic("dig-owned-sequence-processed", undefined, { sequenceId: packet.sequenceId });
        if (!pendingDigStatuses.length) {
          fenceSequence = packet.sequenceId;
          requestRead("air");
        }
      } catch (error) { rejectOperation(error); }
      return;
    }
    if (kind !== "dig" || !sent || revoked || confirmed || !isPosition(packet.location)
        || key(packet.location) !== targetKey || !digStatuses.has(packet.status)
        || typeof packet.successful !== "boolean" || !Number.isSafeInteger(packet.block)) return;
    try {
      checkCurrent();
      const stateId = packet.block;
      const name = bot.registry?.blocksByStateId?.[stateId]?.name;
      if (!name) return;
      if (pendingDigStatuses[0] !== packet.status) {
        throw new Error(`Server did not confirm destructive dig at ${targetKey}: ambiguous or out-of-order digging acknowledgement status ${packet.status}`);
      }
      if (!packet.successful) throw new Error(`Server did not confirm destructive dig at ${targetKey}: digging acknowledgement refused status ${packet.status}`);
      pendingDigStatuses.shift();
      if (!["air", "cave_air", "void_air"].includes(name)) {
        if (packet.status === 0 && stateId === nativeBlock.stateId) {
          confirmationState = digConfirmationState();
          diagnostic("dig-start-acknowledged");
          return;
        }
        throw new Error(`Server did not confirm destructive dig at ${targetKey}: ${packet.status === 0 ? "start acknowledgement changed the authorized state" : "finished acknowledgement is not air"}`);
      }
      if (pendingDigStatuses.length) {
        confirmationState = digConfirmationState();
        diagnostic("dig-air-awaiting-acknowledgements");
        return;
      }
      acceptConfirmation();
      // This authoritative server reply can settle the private native waiter
      // even if no blockUpdate event was emitted. Never predict/mutate bot.world.
      queueMicrotask(() => {
        if (!revoked) events.emit(`blockUpdate:${nativeBlock.position}`, null, { type: 0 });
      });
    } catch (error) { rejectOperation(error); }
  };
  const onSystem = packet => {
    packetOrder++;
    if (!modern || revoked || confirmed || !pendingRead || packet.isActionBar !== false) return;
    try {
      // Only the raw server system-chat packet is admissible. Player chat,
      // translated/display events, command feedback and embellished components
      // cannot echo a guessed/replayed token into this state machine.
      const content = simplify(packet.content);
      const text = typeof content === "string" ? content
        : content && Object.keys(content).length === 1 ? content.text : null;
      if (text !== pendingRead.nonce) return;
      checkCurrent();
      const read = pendingRead;
      pendingRead = null;
      if (read.purpose === "probe") {
        authorize();
        diagnostic("dig-read-permission-and-start-state-confirmed");
        resolveProbe();
        return;
      }
      if (read.revision !== targetRevision || read.fence !== fenceSequence || pendingDigStatuses.length) {
        diagnostic("dig-stale-read-rejected");
        if (fenceSequence !== null) requestRead("air");
        return;
      }
      if (airOrder === null || airOrder > read.order || read.order >= packetOrder
          || bot.blockAt(nativeBlock.position)?.name !== "air") {
        confirmationState = "dig-awaiting-server-air-update";
        diagnostic("dig-read-awaiting-server-air-update");
        return;
      }
      diagnostic("dig-authoritative-target-air-observed");
      acceptConfirmation();
      queueMicrotask(() => {
        if (!revoked) events.emit(`blockUpdate:${nativeBlock.position}`, null, { type: 0 });
      });
    } catch (error) { rejectOperation(error); }
  };
  const onSingle = packet => {
    packetOrder++;
    observe(packet.location, packet.type);
  };
  const onMulti = packet => {
    packetOrder++;
    if (!isPosition(packet.chunkCoordinates)) return;
    const updates = [];
    for (const record of packet.records ?? []) {
      // Same modern packed-section layout consumed by Mineflayer's blocks plugin.
      // Number arithmetic avoids signed 32-bit truncation of the state id.
      if (!Number.isSafeInteger(record) || record < 0) continue;
      updates.push([{
        x: packet.chunkCoordinates.x * 16 + (Math.floor(record / 256) & 15),
        y: packet.chunkCoordinates.y * 16 + (record & 15),
        z: packet.chunkCoordinates.z * 16 + (Math.floor(record / 16) & 15),
      }, Math.floor(record / 4096)]);
    }
    if (kind === "place" && sent && !revoked && !confirmed) {
      const references = updates.filter(([position]) => key(position) === referenceKey).length;
      const targets = updates.filter(([position]) => key(position) === targetKey).length;
      // Section records are a set, not the two ordered replies documented by
      // place_block.js. Do not turn either record order into a reference fence,
      // or let a later unrelated destination update repair this ambiguity.
      if ((references && targets) || references > 1 || targets > 1) {
        rejectOperation(new Error(`Server did not confirm destructive place at ${targetKey}: ambiguous combined section reply`));
        return;
      }
    }
    for (const [position, stateId] of updates) observe(position, stateId);
  };
  client.on("block_change", onSingle);
  client.on("multi_block_change", onMulti);
  client.on("acknowledge_player_digging", onDigAck);
  if (modern) client.on("system_chat", onSystem);
  let native;
  let poll;
  let timer;
  try {
    if (kind === "dig") {
      injectDigging(scope);
      scope.digTime = bot.digTime.bind(bot);
    } else {
      injectGenericPlace(scope);
      injectPlaceBlock(scope);
    }
    timer = setTimeout(() => rejectOperation(new Error(`Timed out awaiting server-observed destructive ${kind} confirmation at ${targetKey}${modern
      ? ` (${confirmationState}${!sent ? "; read-only server probe requires vanilla command permission level 2 and a matching starting material" : ""})`
      : ""}`)), timeoutMs);
    poll = setInterval(() => {
      onGame();
    }, 25);
    if (modern) {
      requestRead("probe");
      await Promise.race([probe, failure]);
      checkCurrent();
      authorize();
    }
    native = Promise.resolve().then(() => {
      if (revoked) throw new Error("Destructive gameplay operation authorization was revoked");
      return kind === "dig" ? scope.dig(nativeBlock) : scope.placeBlock(nativeBlock, nativeFace);
    });
    // A suspended native aim retains the lease even after our bounded wait ends.
    // Its isolated writer remains revoked until it eventually settles.
    identity.lifecycle?.hold?.(native);
    const result = await Promise.race([Promise.all([native, confirmation]), failure]);
    checkCurrent();
    if (!confirmed) throw new Error("Missing server-observed destructive edit confirmation");
    if (modern && bot.blockAt(nativeBlock.position)?.name !== "air") {
      throw new Error("Destructive dig confirmed target-air cache changed before settlement");
    }
    completed = true;
    return result[0];
  } finally {
    revoked = true;
    try { onOutcome?.({ sent, completed }); } catch { /* observer must not affect cleanup */ }
    confirmationState = "revoked";
    diagnostic("revoked");
    clearTimeout(timer);
    clearInterval(poll);
    client.removeListener("block_change", onSingle);
    client.removeListener("multi_block_change", onMulti);
    client.removeListener("acknowledge_player_digging", onDigAck);
    if (modern) client.removeListener("system_chat", onSystem);
    bot.removeListener("game", onGame);
    for (const [event, listener] of forwarded) bot.removeListener(event, listener);
    // Observe rejection before aborting the native task.
    native?.catch(() => {});
    try { scope.stopDigging?.(); } catch { /* revoked writer is authoritative */ }
    // After native finishDigging clears targetDigBlock, stopDigging cannot
    // cancel its waiter. Wake that private waiter only; this is neither a world
    // mutation nor server confirmation. A still-suspended aim keeps its lease.
    if (kind === "dig") events.emit(`blockUpdate:${nativeBlock.position}`, null, { type: 0 });
    // Wake any native placement waiter without touching the real bot/world.
    events.emit(`blockUpdate:${nativeBlock.position}`, null, null);
    events.emit(`blockUpdate:${kind === "place" ? nativeBlock.position.plus(nativeFace) : nativeBlock.position}`, null, null);
    const settled = () => {
      events.removeAllListeners();
      // An uncertain edit must not release ownership, even on modern protocols
      // with private sequences and read-back nonces. An unconfirmed dispatched edit
      // quarantines destructive operations on this bot; do not guess settlement.
      if (!sent || completed) busy.delete(bot);
    };
    if (native) native.then(settled, settled);
    else settled();
  }
}
