import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Prompter } from '../src/models/prompter.js';
import { setSettings } from '../src/agent/settings.js';
import { clearPerceptionCache } from '../src/agent/topography/service.js';

// The topography prompt hooks ($TOPOGRAPHY / $TOPO_GUIDE) must be present in the
// default templates, render when the layer is on, and leave prompts untouched
// (identical to develop) when `cartography_enabled: false`.

const root = process.cwd();
const temporary = mkdtempSync(path.join(tmpdir(), 'mindcraft-prompts-'));
const realFetch = globalThis.fetch;
test.before(() => {
    process.chdir(temporary);
    globalThis.fetch = (url) => {
        const body = String(url).includes('/settlements') ? { settlements: [] }
            : { center: { x: 0, z: 0 }, size_chunks: 16, lod: [], biome: 'minecraft:plains' };
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    };
});
test.after(() => {
    globalThis.fetch = realFetch;
    process.chdir(root);
    rmSync(temporary, { recursive: true, force: true });
});

function make(profile = {}) {
    setSettings({ base_profile: 'assistant', num_examples: 0 });
    clearPerceptionCache();
    const agent = {
        name: 'TestBot', history: { memory: 'old-memory' }, blocked_actions: [],
        bot: { entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' } },
    };
    return new Prompter(agent, { name: 'TestBot', model: 'ollama/test', cooldown: 0, ...profile });
}

// Placeholders that need a live bot and are unrelated to what is under test.
const UNRELATED = ['$STATS', '$INVENTORY', '$COMMAND_DOCS', '$CODE_DOCS', '$EXAMPLES', '$SELF_PROMPT'];
async function render(prompter, template) {
    let text = template;
    for (const key of UNRELATED) text = text.replaceAll(key, '');
    return await prompter.replaceStrings(text, [{ role: 'user', content: 'hi' }], null, [{ role: 'user', content: 'hi' }]);
}
const STRAY = /\$[A-Z][A-Z_]{2,}/;

test('default prompts carry both topography placeholders', () => {
    const p = make();
    for (const key of ['conversing', 'coding'])
        assert.ok(p.profile[key].includes('$TOPOGRAPHY'), `${key} template lacks $TOPOGRAPHY`);
    assert.ok(p.profile.conversing.includes('$TOPO_GUIDE'));
});

test('topography on: prompts render the block and the compass guide', async () => {
    const p = make({ cartography_enabled: true });
    const out = await render(p, p.profile.conversing);
    assert.match(out, /TOPOGRAPHY 16x16 chunks/);
    assert.match(out, /North is -Z/);
    assert.match(out, /use !overview/);
    assert.doesNotMatch(out, STRAY);
    const coding = await render(p, p.profile.coding);
    assert.match(coding, /TOPOGRAPHY 16x16 chunks/);
    assert.doesNotMatch(coding, STRAY);
});

test('topography off: prompts render exactly as develop (no terrain text)', async () => {
    const p = make({ cartography_enabled: false });
    for (const key of ['conversing', 'coding']) {
        const out = await render(p, p.profile[key]);
        assert.doesNotMatch(out, /TOPOGRAPHY|North is -Z|topograph/i, key);
        assert.doesNotMatch(out, /!overview/, key);
        assert.doesNotMatch(out, STRAY, key);
    }
});

test('topography off by default: no setting renders prompts as develop', async () => {
    const p = make();
    for (const key of ['conversing', 'coding', 'saving_memory']) {
        const out = await render(p, p.profile[key]);
        assert.doesNotMatch(out, /TOPOGRAPHY|North is -Z|topograph/i, key);
        assert.doesNotMatch(out, STRAY, key);
    }
});
