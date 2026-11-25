import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { isHostile } from '../src/utils/mcdata.js';
import autoEat from 'mineflayer-auto-eat';

// Item 11: neutral mobs must not be treated as hostile.
assert.equal(isHostile({ type: 'mob', name: 'enderman' }), false);
assert.equal(isHostile({ type: 'hostile', name: 'enderman' }), false);
assert.equal(isHostile({ type: 'mob', name: 'zombified_piglin' }), false);
assert.equal(isHostile({ type: 'hostile', name: 'zombified_piglin' }), false);

// Ordinary hostiles and golems remain classified as before.
assert.equal(isHostile({ type: 'mob', name: 'zombie' }), true);
assert.equal(isHostile({ type: 'hostile', name: 'creeper' }), true);
assert.equal(isHostile({ type: 'mob', name: 'skeleton' }), true);
assert.equal(isHostile({ type: 'mob', name: 'spider' }), true);
assert.equal(isHostile({ type: 'mob', name: 'iron_golem' }), false);
assert.equal(isHostile({ type: 'mob', name: 'snow_golem' }), false);
assert.equal(isHostile(null), false);
assert.equal(isHostile({}), false);

// Item 13: source must merge into plugin defaults instead of replacing them.
const agentSource = readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
assert.match(agentSource, /Object\.assign\(this\.bot\.autoEat\.options,\s*\{/);
assert.doesNotMatch(agentSource, /this\.bot\.autoEat\.options\s*=\s*\{/);
assert.match(agentSource, /offhand:\s*false/);

// Simulate the plugin defaults and the intended override.
const bot = new EventEmitter();
bot.autoEat = {};
bot.supportFeature = () => true;
bot.inventory = { slots: {} };
bot.entity = { id: 1 };
bot._client = new EventEmitter();
autoEat.plugin(bot);

const defaults = { ...bot.autoEat.options };
assert.equal(defaults.eatingTimeout, 3000);
assert.equal(defaults.offhand, true);

Object.assign(bot.autoEat.options, {
    priority: 'foodPoints',
    startAt: 14,
    bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'],
    offhand: false
});

assert.equal(bot.autoEat.options.eatingTimeout, defaults.eatingTimeout);
assert.equal(bot.autoEat.options.ignoreInventoryCheck, defaults.ignoreInventoryCheck);
assert.equal(bot.autoEat.options.equipOldItem, defaults.equipOldItem);
assert.equal(bot.autoEat.options.priority, 'foodPoints');
assert.equal(bot.autoEat.options.startAt, 14);
assert.deepEqual(bot.autoEat.options.bannedFood, ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken']);
assert.equal(bot.autoEat.options.offhand, false);

console.log('regression_issue858_items_11_13: PASS');
