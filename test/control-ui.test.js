import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/mindcraft/public/index.html', import.meta.url), 'utf8');

test('control page inline script parses', () => {
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    const inline = scripts.map(match => match[1]).filter(Boolean).join('\n');
    assert.ok(inline.length > 1000);
    assert.doesNotThrow(() => new vm.Script(inline));
});

test('control page exposes autonomous task controls', () => {
    assert.match(html, /function renderControlAgent/);
    assert.match(html, /function updateTaskPanel/);
    assert.match(html, /function startGoal/);
    assert.match(html, /!taskStatus/);
    assert.match(html, /!endGoal/);
});
