import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { resolvePlacementOptions, validateResolvedPlacementOptions } from '../../src/utils/schematic/placement_options.js';
import settings, { setSettings } from '../../src/agent/settings.js';
import { buildSchematic } from '../../src/utils/schematic/build_schematic.js';

test('settings and overrides resolve immutably, retain legacy, and validate complete configuration', () => {
    assert.deepEqual(resolvePlacementOptions(), { mode: null, radius: 4, threshold: 9 });
    const configured = { schematic_placement_mode: 'BALANCED', schematic_balanced_radius: 0, schematic_balanced_threshold: 4097 };
    assert.deepEqual(resolvePlacementOptions(configured), { mode: 'balanced', radius: 0, threshold: 4097 });
    const options = resolvePlacementOptions(configured, { mode: 'SAFE' });
    assert.deepEqual(options, { mode: 'safe', radius: 0, threshold: 4097 });
    assert.ok(Object.isFrozen(options));
    assert.deepEqual(resolvePlacementOptions(configured, { radius: 16, threshold: 1 }), { mode: 'balanced', radius: 16, threshold: 1 });
    for (const bad of [
        { schematic_placement_mode: '' }, { schematic_placement_mode: 'legacy' },
        { schematic_balanced_radius: -1 }, { schematic_balanced_radius: 17 },
        { schematic_balanced_radius: 1.5 }, { schematic_balanced_radius: '4' },
        { schematic_balanced_threshold: 0 }, { schematic_balanced_threshold: 4098 },
        { schematic_balanced_threshold: null }, { schematic_balanced_threshold: Infinity },
    ]) assert.throws(() => resolvePlacementOptions(bad));
    for (const override of [{ mode: 'unknown' }, { mode: 'safe', radius: 2 }, { threshold: 2 },
        { mode: 'balanced', radius: 17 }, { mode: 'balanced', threshold: 0 }, { mode: 'balanced', radius: 1.2 }, { mode: 'balanced', typo: 2 }])
        assert.throws(() => resolvePlacementOptions({}, override));
    setSettings(configured);
    assert.throws(() => setSettings({ schematic_balanced_radius: 999 }));
    assert.equal(settings.schematic_balanced_radius, 0);
    setSettings({});
    assert.throws(() => validateResolvedPlacementOptions({ mode: undefined, radius: 4, threshold: 9 }));
});

test('example settings and UI schema agree with runtime defaults', async () => {
    const schema = JSON.parse(await readFile(new URL('../../src/mindcraft/public/settings_spec.json', import.meta.url), 'utf8'));
    assert.equal(schema.schematic_placement_mode.default, null);
    assert.equal(schema.schematic_balanced_radius.default, 4);
    assert.equal(schema.schematic_balanced_threshold.default, 9);
    for (const name of ['andy', 'alice']) {
        const sample = (await import(new URL(`../../settings-${name}.js`, import.meta.url))).default;
        assert.deepEqual(resolvePlacementOptions(sample), { mode: null, radius: 4, threshold: 9 });
    }
});

test('build boundary rejects unavailable and invalid options before resolving, including resume context', async () => {
    for (const mode of ['safe', 'destructive']) {
        const log = [];
        let reads = 0;
        const options = resolvePlacementOptions({}, { mode });
        const session = { context: { placementOptions: options }, resumeEligible: true };
        assert.equal(await buildSchematic({}, 'anything', null, null, null, {
            placementOptions: options, resumeSession: session,
            resolvePath: () => { reads++; }, writeLog: message => log.push(message),
        }), false);
        assert.equal(reads, 0);
        assert.equal(session.context, null);
        assert.match(log.join(' '), mode === 'safe' ? /safe schematic auto-resume is unavailable/i : /temporarily unavailable; no build was started/);
    }
    const log = [];
    assert.equal(await buildSchematic({}, 'anything', null, null, null, {
        placementOptions: { mode: 'typo', radius: 4, threshold: 9 }, writeLog: message => log.push(message),
    }), false);
    assert.match(log.join(' '), /must be safe/);
    assert.equal(await buildSchematic({}, 'anything', null, null, null, {
        placementOptions: null, writeLog: message => log.push(message),
    }), false);
    assert.match(log.at(-1), /Invalid resolved schematic placement options/);
});

test('real skills bridge allows configured balanced and safe overrides to reach selection', () => {
    const loader = fileURLToPath(new URL('./commands-loader.js', import.meta.url));
    const skills = new URL('../../src/agent/library/skills.js', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        globalThis.__testSettings = { schematic_placement_mode: 'balanced', schematic_balanced_radius: 6, schematic_balanced_threshold: 12 };
        const { buildSchematic } = await import(${JSON.stringify(skills)});
        const bot = { output: '' };
        assert.equal(await buildSchematic(bot, 'unresolved.schem'), false);
        assert.match(bot.output, /Could not read schematic/);
        bot.output = '';
        assert.equal(await buildSchematic(bot, 'unresolved.schem', null, null, null, Object.freeze({ mode: 'safe', radius: 6, threshold: 12 })), false);
        assert.match(bot.output, /Could not read schematic/);
    `;
    const child = spawnSync(process.execPath, ['--experimental-loader', loader, '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr + child.stdout);
});
