import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_AUTONOMOUS_STEPS,
    MAX_CONSECUTIVE_FAILURES,
    getAutonomousCommandNames,
    getAutonomousStopReason,
    isAutonomousCommandNameAllowed,
    parseTaskDecision
} from '../src/agent/autonomous_policy.js';

test('parses an active autonomous decision', () => {
    const decision = parseTaskDecision(JSON.stringify({
        status: 'active',
        plan: ['inspect', 'collect'],
        current_step: 'inspect',
        reason: 'Need world evidence',
        command: '!nearbyBlocks'
    }));
    assert.equal(decision.status, 'active');
    assert.equal(decision.command, '!nearbyBlocks');
    assert.deepEqual(decision.plan, ['inspect', 'collect']);
});

test('extracts JSON from reasoning and markdown fences', () => {
    const decision = parseTaskDecision('<think>private</think>```json\n' + JSON.stringify({
        status: 'completed',
        plan: ['collect'],
        current_step: 'verify',
        reason: 'Inventory proves success',
        command: '!restart'
    }) + '\n```');
    assert.equal(decision.status, 'completed');
    assert.equal(decision.command, '');
});

test('normalizes plan text and caps the plan length', () => {
    const decision = parseTaskDecision(JSON.stringify({
        status: 'active',
        plan: [' inspect ', '', ...Array.from({ length: 12 }, (_, i) => `step ${i}`)],
        current_step: ' inspect ',
        reason: ' test ',
        command: ' !stats '
    }));
    assert.equal(decision.plan.length, 10);
    assert.equal(decision.plan[0], 'inspect');
    assert.equal(decision.current_step, 'inspect');
    assert.equal(decision.reason, 'test');
    assert.equal(decision.command, '!stats');
});

test('rejects non-object and unknown task decisions', () => {
    assert.throws(() => parseTaskDecision('null'), /JSON object/);
    assert.throws(() => parseTaskDecision('{"status":"done"}'), /Invalid task status/);
});

test('requires a command while active', () => {
    assert.throws(() => parseTaskDecision('{"status":"active","command":""}'), /requires a command/);
});

test('allows bounded observation and world-action commands', () => {
    for (const command of ['!stats', 'inventory', '!collectBlocks', '!craftRecipe', '!goToSurface']) {
        assert.equal(isAutonomousCommandNameAllowed(command), true, command);
    }
});

test('blocks process, code-generation, external, persistent, and unbounded commands', () => {
    for (const command of [
        '!newAction',
        '!stop',
        '!stfu',
        '!restart',
        '!clearChat',
        '!goal',
        '!endGoal',
        '!searchWiki',
        '!followPlayer',
        '!stay',
        '!setMode',
        '!smeltItem',
        '!attack',
        '!attackPlayer',
        '!startConversation',
        '!endConversation',
        '!taskStatus',
        '!help',
        '!doesNotExist'
    ]) {
        assert.equal(isAutonomousCommandNameAllowed(command), false, command);
    }
});

test('returns a defensive copy of the autonomous command list', () => {
    const commands = getAutonomousCommandNames();
    commands.push('!restart');
    assert.equal(isAutonomousCommandNameAllowed('!restart'), false);
    assert.equal(getAutonomousCommandNames().includes('!restart'), false);
});

test('stops at the configured step and failure limits', () => {
    assert.match(
        getAutonomousStopReason({ stepsTaken: MAX_AUTONOMOUS_STEPS }),
        /60 steps/
    );
    assert.match(
        getAutonomousStopReason({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES }),
        /4 consecutive failed actions/
    );
});

test('continues below the configured limits', () => {
    assert.equal(getAutonomousStopReason({
        stepsTaken: MAX_AUTONOMOUS_STEPS - 1,
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1
    }), null);
});
