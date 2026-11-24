import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { createRequire } from "node:module";
import { fixture } from "./destructive_ingress_fixture.js";
import { trackAuthenticatedChatConnection } from "../../src/utils/authenticated_chat.js";
import { authorizedGameplayEdit } from "../../src/utils/schematic/authorized_gameplay_edit.js";
import { captureSchematicAttemptIdentity, isSchematicAttemptIdentityCurrent } from "../../src/utils/schematic/obstruction_policy.js";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");
const nbt = require("prismarine-nbt");
const position = new Vec3(0, 64, 0);
const tick = () => new Promise(setImmediate);

function modernFixture(version = "1.21.4") {
  const f = fixture(["cobblestone"], 1, version);
  f.world.set("0,64,0", "dirt");
  f.bot.game.gameMode = "creative";
  const client = f.bot._client;
  const id = "22222222-2222-4222-8222-222222222222";
  Object.assign(client, { state: "play", uuid: id, username: "Andy", socket: { destroyed: false },
    session: { selectedProfile: { id: id.replaceAll("-", ""), name: "Andy" } },
    serverFeatures: { enforcesSecureChat: true } });
  trackAuthenticatedChatConnection(f.bot, "microsoft");
  client.emit("encryption_begin", { shouldAuthenticate: true });
  client.cipher = {}; client.decipher = {};
  client.emit("login", { enforcesSecureChat: true });
  f.dependencies.serverWorld = new Map([["0,64,0", "dirt"]]);
  f.dependencies.noConfirmation = true;
  f.dependencies.noReadConfirmation = true;
  f.dependencies.digTimeMs = 1000;
  f.phases = [];
  f.packets = [];
  f.bot.on("schematicEditAuthorization", event => f.phases.push(event));
  f.dependencies.onWrite = (name, packet) => {
    f.packets.push([name, packet]);
    if (name === "chat_command") setImmediate(() => f.replyRead(packet));
  };
  return f;
}

function dig(f, timeoutMs = 150) {
  const identity = captureSchematicAttemptIdentity(f.bot);
  const block = f.bot.blockAt(position);
  return authorizedGameplayEdit(f.bot, {
    kind: "dig", block, target: position, identity, timeoutMs,
    assertCurrent() {
      assert.equal(f.bot.interrupt_code, false, "operation cancelled");
      assert.ok(isSchematicAttemptIdentityCurrent(f.bot, identity), "operation identity changed");
      assert.equal(f.bot.game.gameMode, "creative");
    },
    authorize() {
      assert.equal(f.bot.blockAt(position).stateId, block.stateId, "final target changed");
    },
  });
}

function air(f, packet, { acknowledge = true, section = false } = {}) {
  f.dependencies.serverWorld.set("0,64,0", "air");
  if (section) f.inboundSection(position, "air");
  else f.inbound(position, "air");
  if (acknowledge) f.acknowledge(position, { sequenceId: packet.sequence });
}

function assertClean(f) {
  for (const event of ["block_change", "multi_block_change", "acknowledge_player_digging", "system_chat"]) {
    assert.equal(f.bot._client.listenerCount(event), 0, event);
  }
  assert.equal(f.bot.listenerCount("game"), 0);
}

for (const section of [false, true]) {
  test(`1.21.4 owned start fence plus read-only target-air confirmation (${section ? "section" : "single"} update)`, async () => {
    const f = modernFixture();
    const writer = f.dependencies.onWrite;
    f.dependencies.onWrite = (name, packet) => {
      writer(name, packet);
      if (name === "block_dig" && packet.status === 0) setImmediate(() => air(f, packet, { section }));
    };
    await dig(f);
    assert.deepEqual(f.packets.filter(([n]) => n === "block_dig").map(([, p]) => p.status), [0]);
    assert.ok(f.packets.find(([n]) => n === "block_dig")[1].sequence >= 0x40000000);
    assert.ok(f.phases.some(e => e.phase === "dig-authoritative-target-air-observed"));
    assertClean(f);
  });
}

test("1.21.4 cumulative latest-owned fence retires start and raced native finish", async () => {
  const f = modernFixture();
  f.dependencies.digTimeMs = 1;
  const writer = f.dependencies.onWrite;
  f.dependencies.onWrite = (name, packet) => {
    writer(name, packet);
    if (name === "block_dig" && packet.status === 2) setImmediate(() => air(f, packet));
  };
  await dig(f);
  const packets = f.packets.filter(([n]) => n === "block_dig").map(([, p]) => p);
  assert.deepEqual(packets.map(p => p.status), [0, 2]);
  assert.equal(packets[1].sequence, packets[0].sequence + 1);
  assertClean(f);
});

test("1.21.4 positive read before cache update needs a new read ordered after the update", async () => {
  const f = modernFixture();
  const writer = f.dependencies.onWrite;
  let queries = 0;
  f.dependencies.onWrite = (name, packet) => {
    writer(name, packet);
    if (name === "block_dig" && packet.status === 0) setImmediate(() => {
      f.dependencies.serverWorld.set("0,64,0", "air");
      f.acknowledge(position, { sequenceId: packet.sequence });
    });
    if (name === "chat_command" && packet.command.includes("minecraft:air")) {
      if (++queries === 1) setImmediate(() => setImmediate(() => f.inbound(position, "air")));
    }
  };
  await dig(f);
  assert.equal(queries, 2);
  assert.ok(f.phases.some(e => e.phase === "dig-read-awaiting-server-air-update"));
  assertClean(f);
});

test("1.21.4 successful operations never reuse sequences or accept previous-operation fences and nonces", async () => {
  const f = modernFixture();
  const writer = f.dependencies.onWrite;
  let previousSequence, previousRead;
  let operation = 0;
  f.dependencies.onWrite = (name, packet) => {
    if (operation === 0) writer(name, packet);
    else if (name === "chat_command" && !packet.command.includes("minecraft:air")) writer(name, packet);
    if (name === "chat_command" && packet.command.includes("minecraft:air") && operation === 0) previousRead = packet;
    if (name === "block_dig" && packet.status === 0) setImmediate(() => {
      if (operation === 0) {
        previousSequence = packet.sequence;
        air(f, packet);
      } else {
        assert.ok(packet.sequence > previousSequence);
        air(f, packet, { acknowledge: false });
        f.acknowledge(position, { sequenceId: previousSequence });
        f.replyRead(previousRead);
      }
    });
  };
  await dig(f);
  await tick();
  operation++;
  f.world.set("0,64,0", "dirt");
  f.dependencies.serverWorld.set("0,64,0", "dirt");
  const confirmedBefore = f.phases.filter(e => e.phase === "server-confirmed").length;
  await assert.rejects(dig(f, 55), /Timed out.*confirmation/);
  assert.equal(f.phases.filter(e => e.phase === "server-confirmed").length, confirmedBefore);
  assertClean(f);
});

for (const missing of ["air", "sequence", "read-back", "local-prediction-only", "stale-queued-air"]) {
  test(`1.21.4 fails closed and quarantines dispatched dig with ${missing}`, async () => {
    const f = modernFixture();
    const writer = f.dependencies.onWrite;
    f.dependencies.onWrite = (name, packet) => {
      if (!(name === "chat_command" && packet.command.includes("minecraft:air") && missing === "read-back")) writer(name, packet);
      if (name !== "block_dig" || packet.status !== 0) return;
      setImmediate(() => {
        if (missing === "sequence") {
          air(f, packet, { acknowledge: false });
          f.acknowledge(position, { sequenceId: packet.sequence + 100 });
        } else if (missing === "air") {
          f.acknowledge(position, { sequenceId: packet.sequence });
        } else if (missing === "read-back") air(f, packet);
        else if (missing === "local-prediction-only") {
          f.dependencies.serverWorld.set("0,64,0", "air");
          f.world.set("0,64,0", "air");
          f.bot.emit(`blockUpdate:${position}`, null, { type: 0 });
          f.acknowledge(position, { sequenceId: packet.sequence });
        } else {
          // Old queued packet makes the cache air, but the server still has dirt.
          f.inbound(position, "air");
          f.acknowledge(position, { sequenceId: packet.sequence });
        }
      });
    };
    await assert.rejects(dig(f, 55), /Timed out.*confirmation/);
    assert.equal(f.phases.some(e => e.phase === "server-confirmed"), false);
    await tick();
    assertClean(f);
    await assert.rejects(dig(f), /lacks server confirmation/);
  });
}

test("1.21.4 read permission refusal happens before aim or gameplay write and does not quarantine", async () => {
  const f = modernFixture();
  const writer = f.dependencies.onWrite;
  f.dependencies.onWrite = (name, packet) => { f.packets.push([name, packet]); };
  let aimed = false;
  f.dependencies.onAim = () => { aimed = true; };
  await assert.rejects(dig(f, 35), /Timed out.*confirmation/);
  assert.equal(aimed, false);
  assert.deepEqual(f.writes, []);
  assertClean(f);
  f.dependencies.onWrite = (name, packet) => {
    writer(name, packet);
    if (name === "block_dig" && packet.status === 0) setImmediate(() => air(f, packet));
  };
  await dig(f);
});

test("1.21.4 correlated processing acknowledgement cannot mask a server's non-air dig refusal", async () => {
  const f = modernFixture();
  const writer = f.dependencies.onWrite;
  f.dependencies.onWrite = (name, packet) => {
    writer(name, packet);
    if (name === "block_dig" && packet.status === 0) setImmediate(() => {
      f.inbound(position, "dirt");
      f.acknowledge(position, { sequenceId: packet.sequence });
    });
  };
  await assert.rejects(dig(f, 55), /Timed out.*confirmation/);
  assert.equal(f.bot.blockAt(position).name, "dirt");
  assert.equal(f.phases.some(e => e.phase === "server-confirmed"), false);
  assertClean(f);
  await assert.rejects(dig(f), /lacks server confirmation/);
});

test("authenticated modern neighbors remain unsupported; exact 1.21.4 review is not a version range", async () => {
  for (const version of ["1.20.5", "1.21.3", "1.21.5"]) {
    const f = modernFixture(version);
    await assert.rejects(dig(f), /sequence-only.*cannot distinguish/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.commands, []);
    assertClean(f);
  }
});

test("1.21.4 contradictory update invalidates a queued positive read-back; stale nonce cannot repair it", async () => {
  const f = modernFixture();
  let oldRead;
  f.dependencies.onWrite = (name, packet) => {
    f.packets.push([name, packet]);
    if (name === "chat_command") {
      if (!packet.command.includes("minecraft:air")) setImmediate(() => f.replyRead(packet));
      else if (!oldRead) {
        oldRead = packet;
        setImmediate(() => {
          // Queue a formerly valid echo, then observe a newer authoritative dirt.
          const token = JSON.parse(oldRead.command.slice(oldRead.command.indexOf('{'))).text;
          f.dependencies.serverWorld.set("0,64,0", "dirt");
          f.inboundSection(position, "dirt");
          f.receive("system_chat", { content: nbt.comp({ text: nbt.string(token) }), isActionBar: false });
        });
      }
    } else if (name === "block_dig" && packet.status === 0) setImmediate(() => air(f, packet));
  };
  await assert.rejects(dig(f, 55), /Timed out.*confirmation/);
  assert.ok(f.phases.some(e => e.phase === "dig-stale-read-rejected"));
  assert.equal(f.phases.some(e => e.phase === "server-confirmed"), false);
  assertClean(f);
});

test("1.21.4 back-to-back contradictory target packet revokes proof before promise settlement", async () => {
  const f = modernFixture();
  const writer = f.dependencies.onWrite;
  f.dependencies.onWrite = (name, packet) => {
    if (name === "chat_command" && packet.command.includes("minecraft:air")) {
      setImmediate(() => {
        f.replyRead(packet);
        f.dependencies.serverWorld.set("0,64,0", "dirt");
        f.inbound(position, "dirt");
      });
    } else writer(name, packet);
    if (name === "block_dig" && packet.status === 0) setImmediate(() => air(f, packet));
  };
  await assert.rejects(dig(f), /contradicted|revoked/);
  assertClean(f);
  await assert.rejects(dig(f), /lacks server confirmation/);
});

for (const revoke of ["cancel", "world", "creative", "authentication"]) {
  test(`1.21.4 ${revoke} revocation before target-air echo cannot confirm or write again`, async () => {
    const f = modernFixture();
    const writer = f.dependencies.onWrite;
    f.dependencies.onWrite = (name, packet) => {
      if (name === "chat_command" && packet.command.includes("minecraft:air")) {
        setImmediate(() => {
          if (revoke === "cancel") f.bot.interrupt_code = true;
          if (revoke === "world") f.bot._client.emit("respawn", {});
          if (revoke === "creative") f.bot.game.gameMode = "survival";
          if (revoke === "authentication") f.bot._client.emit("end");
          f.replyRead(packet);
        });
      } else writer(name, packet);
      if (name === "block_dig" && packet.status === 0) setImmediate(() => air(f, packet));
    };
    await assert.rejects(dig(f), /cancelled|identity changed|creative|authentication/);
    const count = f.writes.length;
    await tick();
    assert.equal(f.writes.length, count);
    assert.equal(f.phases.some(e => e.phase === "server-confirmed"), false);
    assertClean(f);
    await assert.rejects(dig(f), /lacks server confirmation|requires detailed acknowledgement/);
  });
}

test("1.21.4 native last-dispatch target validation survives the read-only probe and asynchronous aim", async () => {
  const f = modernFixture();
  f.dependencies.onAim = () => { f.world.set("0,64,0", "chest"); };
  await assert.rejects(dig(f), /final target changed/);
  assert.deepEqual(f.writes, []);
  assertClean(f);
});

test("1.21.4 actionbar, player/display echoes and wrong nonce are not server read-back", async () => {
  const f = modernFixture();
  f.dependencies.onWrite = (name, packet) => {
    if (name !== "chat_command") return;
    setImmediate(() => {
      f.replyRead(packet, { isActionBar: true });
      f.replyRead(packet, { token: "mindcraft-dig-wrong" });
      const token = JSON.parse(packet.command.slice(packet.command.indexOf('{'))).text;
      f.bot.emit("message", { text: token });
      f.bot._client.emit("playerChat", { plainMessage: token, verified: true });
    });
  };
  await assert.rejects(dig(f, 35), /Timed out.*confirmation/);
  assert.deepEqual(f.writes, []);
  assertClean(f);
});
