import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { normalizeGameMode, setGameMode } from "../../src/utils/schematic/game_mode.js";

function makeBot(gameMode = "survival", chat = () => {}) {
  const bot = new EventEmitter();
  bot.game = { gameMode };
  bot.chat = chat;
  return bot;
}

test("normalizeGameMode accepts supported modes and defaults invalid values to survival", () => {
  for (const mode of ["survival", "creative", "adventure", "spectator"]) {
    assert.equal(normalizeGameMode(mode), mode);
  }
  assert.equal(normalizeGameMode(" Creative "), "creative");
  for (const mode of [undefined, null, "", "hardcore", 1]) {
    assert.equal(normalizeGameMode(mode), "survival");
  }
});

test("setGameMode returns immediately when the bot already has the target mode", async () => {
  let chatCount = 0;
  const bot = makeBot("creative", () => { chatCount += 1; });

  assert.equal(await setGameMode(bot, "creative"), true);
  assert.equal(chatCount, 0);
  assert.equal(bot.listenerCount("game"), 0);
});

test("forced setGameMode sends restoration even when the client already reports the target mode", async () => {
  let command;
  const bot = makeBot("survival", (value) => { command = value; });

  assert.equal(await setGameMode(bot, "survival", 50, { force: true }), false);
  assert.equal(command, "/gamemode survival");
  assert.equal(bot.listenerCount("game"), 0);
});

test("setGameMode registers before chat and resolves when the target mode is observed", async () => {
  const bot = makeBot("survival", (command) => {
    assert.equal(command, "/gamemode creative");
    assert.equal(bot.listenerCount("game"), 1);
    bot.game.gameMode = "creative";
    bot.emit("game", bot.game);
  });

  assert.equal(await setGameMode(bot, "creative"), true);
  assert.equal(bot.listenerCount("game"), 0);
});

test("setGameMode continues waiting after unrelated game events", async () => {
  const bot = makeBot("survival", () => {
    setTimeout(() => {
      bot.game.gameMode = "adventure";
      bot.emit("game", bot.game);
      setTimeout(() => {
        bot.game.gameMode = "spectator";
        bot.emit("game", bot.game);
      }, 0);
    }, 0);
  });

  assert.equal(await setGameMode(bot, "spectator", 100), true);
  assert.equal(bot.listenerCount("game"), 0);
});

test("setGameMode resolves false on timeout when the mode never changes", async () => {
  const bot = makeBot();

  assert.equal(await setGameMode(bot, "creative", 5), false);
  assert.equal(bot.listenerCount("game"), 0);
});

test("invalid requested modes safely target survival", async () => {
  const bot = makeBot("creative", (command) => {
    assert.equal(command, "/gamemode survival");
    bot.game.gameMode = "survival";
    bot.emit("game", bot.game);
  });

  assert.equal(await setGameMode(bot, "invalid", 50), true);
  assert.equal(bot.listenerCount("game"), 0);
});

test("setGameMode handles synchronous chat errors and rejected chat promises", async () => {
  const syncBot = makeBot("survival", () => { throw new Error("chat failed"); });
  assert.equal(await setGameMode(syncBot, "creative", 50), false);
  assert.equal(syncBot.listenerCount("game"), 0);

  const rejectedBot = makeBot("survival", () => Promise.reject(new Error("chat rejected")));
  assert.equal(await setGameMode(rejectedBot, "creative", 50), false);
  assert.equal(rejectedBot.listenerCount("game"), 0);
});
