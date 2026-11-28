import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runBuild } from '../../src/utils/schematic/run_build.js';

function fakeBot(buildFn = (build) => { build.actions.length = 0; }) {
  const bot = new EventEmitter();
  const calls = { stop: 0, cancel: 0, goals: [] };
  bot.interrupt_code = false;
  bot.pathfinder = {
    setGoal(goal) { calls.goals.push(goal); },
  };
  bot.builder = {
    build: buildFn,
    stop() { calls.stop++; },
  };
  const build = {
    actions: [{}],
    cancel() { calls.cancel++; },
  };
  return { bot, build, calls };
}

const short = { pollMs: 2, stallMs: 100, graceMs: 12 };

test('returns finished only after all build actions are consumed', async () => {
  const { bot, build } = fakeBot((value) => { value.actions.length = 0; });
  const result = await runBuild(bot, build, short);

  assert.equal(result.status, 'finished');
  assert.deepEqual(result.errors, []);
  assert.equal(result.remaining, 0);
  assert.equal(bot.listenerCount('builder_error'), 0);
});

test('captures builder_error events even when the plugin resolves successfully', async () => {
  const { bot, build, calls } = fakeBot(() => {
    bot.emit('builder_error', new Error('placement failed'));
  });
  const result = await runBuild(bot, build, short);

  assert.equal(result.status, 'error');
  assert.match(result.errors[0].message, /placement failed/);
  assert.equal(calls.stop, 0);
  assert.equal(bot.listenerCount('builder_error'), 0);
});

test('captures rejected builder promises', async () => {
  const expected = new Error('build rejected');
  const { bot, build } = fakeBot(() => { throw expected; });
  const result = await runBuild(bot, build, short);

  assert.equal(result.status, 'error');
  assert.equal(result.errors[0], expected);
  assert.equal(bot.listenerCount('builder_error'), 0);
});

test('an already interrupted bot does not start the build and runs cancellation hooks', async () => {
  const { bot, build, calls } = fakeBot(() => { throw new Error('must not run'); });
  let cancelled = 0;
  bot.interrupt_code = true;
  const result = await runBuild(bot, build, { ...short, onCancel: () => { cancelled++; } });

  assert.equal(result.status, 'interrupted');
  assert.equal(cancelled, 1);
  assert.equal(calls.stop, 1);
  assert.equal(calls.cancel, 1);
  assert.deepEqual(calls.goals, [null]);
  assert.equal(bot.listenerCount('builder_error'), 0);
});

test('bounds cancellation of a hung build, cleans listeners, and quarantines it until settlement', async () => {
  let releaseBuild;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { releaseBuild = resolve; });
  const { bot, build, calls } = fakeBot(() => {
    started();
    return pending;
  });
  let cancelled = 0;
  const run = runBuild(bot, build, {
    pollMs: 2,
    stallMs: 500,
    graceMs: 15,
    isInterrupted: () => bot.interrupt_code,
    onCancel: () => { cancelled++; },
  });
  await didStart;
  bot.interrupt_code = true;
  const before = Date.now();
  const result = await run;

  assert.equal(result.status, 'interrupted');
  assert.ok(Date.now() - before < 150);
  assert.equal(cancelled, 1);
  assert.equal(calls.stop, 1);
  assert.equal(calls.cancel, 1);
  assert.deepEqual(calls.goals, [null]);
  assert.equal(bot.listenerCount('builder_error'), 0);
  await assert.rejects(runBuild(bot, { actions: [] }, short), /still running/);

  releaseBuild();
  await new Promise((resolve) => setTimeout(resolve, 0));
  bot.interrupt_code = false;
  assert.equal((await runBuild(bot, { actions: [] }, short)).status, 'finished');
});

test('reports a stalled build when remaining actions stop decreasing', async () => {
  let releaseBuild;
  const pending = new Promise((resolve) => { releaseBuild = resolve; });
  const { bot, build, calls } = fakeBot(() => pending);
  const result = await runBuild(bot, build, { pollMs: 2, stallMs: 14, graceMs: 8 });

  assert.equal(result.status, 'stalled');
  assert.equal(result.remaining, 1);
  assert.equal(calls.stop, 1);
  assert.equal(bot.listenerCount('builder_error'), 0);
  releaseBuild();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('does not report finished if a resolved builder leaves actions behind', async () => {
  const { bot, build } = fakeBot(() => {});
  const result = await runBuild(bot, build, short);

  assert.equal(result.status, 'error');
  assert.match(result.errors[0].message, /actions remaining/);
});

test('clears runner polling and grace timers and removes its event listener', async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const activeTimers = new Set();
  globalThis.setTimeout = (callback, ms, ...args) => {
    let timer;
    timer = nativeSetTimeout(() => {
      activeTimers.delete(timer);
      callback(...args);
    }, ms);
    activeTimers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    activeTimers.delete(timer);
    return nativeClearTimeout(timer);
  };

  try {
    const { bot, build } = fakeBot((value) => { value.actions.length = 0; });
    const result = await runBuild(bot, build, short);
    assert.equal(result.status, 'finished');
    assert.equal(bot.listenerCount('builder_error'), 0);
    assert.equal(activeTimers.size, 0);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});
