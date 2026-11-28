import assert from "node:assert/strict";
import test from "node:test";

import { ActionManager } from "../../src/agent/action_manager.js";

function makeAgent() {
  const agent = {
    bot: {
      interrupt_code: false,
      output: "",
      emit() {},
    },
    self_prompter: { isActive: () => false },
    isIdle: () => !agent.actions.executing,
    requestInterrupt() { agent.bot.interrupt_code = true; },
    clearBotLogs() {
      agent.bot.output = "";
      agent.bot.interrupt_code = false;
    },
    getBotOutputSummary: () => "",
  };
  agent.actions = new ActionManager(agent);
  return agent;
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("schematic resume retains only combat-mode interruption and resumes after mode completion", async () => {
  const agent = makeAgent();
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let attempts = 0;
  const build = agent.actions.runAction("action:buildSchematic", async () => {
    attempts++;
    started();
    while (!agent.bot.interrupt_code) await wait(1);
  });
  await startedPromise;
  const mode = agent.actions.runAction("mode:self_defense", async () => {});
  const result = await build;
  assert.equal(result.interrupted, true);
  assert.deepEqual(agent.actions.lastInterruption, {
    interruptedLabel: "action:buildSchematic",
    byActionLabel: "mode:self_defense",
    at: agent.actions.lastInterruption.at,
  });
  await mode;

  let permitted = true;
  agent.actions.registerResume("action:buildSchematic", async () => { attempts++; }, {
    guard: () => permitted && agent.actions.lastInterruption?.byActionLabel === "mode:self_defense",
    cancelOnSuccess: true,
  });
  const resumed = await agent.actions.resumeAction();
  assert.equal(resumed.success, true);
  assert.equal(attempts, 2);
  assert.equal(agent.actions.resume_func, null);
});

test("user stop and replacement actions cancel a pending schematic resume", async () => {
  const agent = makeAgent();
  let cancelled = 0;
  agent.actions.registerResume("action:buildSchematic", async () => assert.fail("cancelled resume ran"), {
    guard: () => true,
    onCancel: () => { cancelled++; },
    cancelOnReplacement: true,
  });
  await agent.actions.runAction("action:goToPlayer", async () => {});
  assert.equal(agent.actions.resume_func, null);
  assert.equal(cancelled, 1);

  agent.actions.registerResume("action:buildSchematic", async () => assert.fail("stopped resume ran"), {
    guard: () => true,
    onCancel: () => { cancelled++; },
    cancelOnReplacement: true,
  });
  agent.actions.cancelManagedResumeForUserCommand();
  assert.equal(agent.actions.resume_func, null);
  assert.equal(cancelled, 2);

  agent.actions.registerResume("action:buildSchematic", async () => assert.fail("stopped resume ran"), {
    guard: () => true,
    onCancel: () => { cancelled++; },
  });
  agent.actions.executing = true;
  const stopping = agent.actions.stop();
  setTimeout(() => { agent.actions.executing = false; }, 5);
  await stopping;
  agent.actions.cancelResume(); // !stop calls cancelResume after stop has settled.
  assert.equal(agent.actions.resume_func, null);
  assert.equal(cancelled, 3);
});

test("resume guard rejects stale world or non-combat interruption without replay", async () => {
  const agent = makeAgent();
  let runs = 0;
  agent.actions.lastInterruption = {
    interruptedLabel: "action:buildSchematic",
    byActionLabel: "mode:cowardice",
  };
  agent.actions.registerResume("action:buildSchematic", async () => { runs++; }, {
    guard: () => agent.actions.lastInterruption?.byActionLabel === "mode:self_defense",
  });
  const result = await agent.actions.resumeAction();
  assert.equal(result.success, false);
  assert.equal(runs, 0);
  assert.equal(agent.actions.resume_func, null);
});
