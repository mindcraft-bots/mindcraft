import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { resolveContinuationPolicy, resolvePlacementOptions, validateResolvedPlacementOptions } from '../../src/utils/schematic/placement_options.js';
import settings, { setSettings } from '../../src/agent/settings.js';
import { buildSchematic } from '../../src/utils/schematic/build_schematic.js';

test('continuation policy validates administrator settings without request overrides', () => {
    assert.equal(resolveContinuationPolicy(), 'ask');
    for (const policy of ['ask', 'allow', 'deny', 'off']) {
        assert.equal(resolveContinuationPolicy({ schematic_continuation_policy: policy }), policy);
        assert.doesNotThrow(() => resolvePlacementOptions({ schematic_continuation_policy: policy }));
    }
    for (const policy of [null, 'ASK', '', 'enabled', 1, {}]) {
        assert.throws(() => resolvePlacementOptions({ schematic_continuation_policy: policy }), /schematic_continuation_policy/);
    }
    assert.throws(() => resolvePlacementOptions({}, { continuationPolicy: 'allow' }), /Invalid/);
});

test('settings and overrides resolve immutably, default to delicate, and validate complete configuration', () => {
    assert.deepEqual(resolvePlacementOptions(), { mode: 'delicate', radius: 4, threshold: 9, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    assert.deepEqual(resolvePlacementOptions({ schematic_placement_mode: null }, { mode: null }), { mode: 'delicate', radius: 4, threshold: 9, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    const configured = { schematic_placement_mode: 'BALANCED', schematic_balanced_radius: 0, schematic_balanced_threshold: 4097 };
    assert.deepEqual(resolvePlacementOptions(configured), { mode: 'balanced', radius: 0, threshold: 4097, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    assert.deepEqual(resolvePlacementOptions(configured, { mode: null }), { mode: 'balanced', radius: 0, threshold: 4097, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    for (const mode of ['delicate', 'raise', 'balanced', 'destructive'])
        assert.equal(resolvePlacementOptions({}, { mode }).mode, mode);
    assert.throws(() => resolvePlacementOptions({ schematic_placement_mode: 'unknown-mode' }), /must be delicate, raise, balanced, destructive/);
    assert.throws(() => resolvePlacementOptions({}, { mode: 'UNKNOWN-MODE' }), /must be delicate, raise, balanced, destructive/);
    const options = resolvePlacementOptions(configured, { mode: 'RAISE' });
    assert.deepEqual(options, { mode: 'raise', radius: 0, threshold: 4097, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    assert.ok(Object.isFrozen(options));
    assert.deepEqual(resolvePlacementOptions(configured, { radius: 16, threshold: 1 }), { mode: 'balanced', radius: 16, threshold: 1, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    for (const bad of [
        { schematic_placement_mode: '' }, { schematic_placement_mode: 'legacy' },
        { schematic_balanced_radius: -1 }, { schematic_balanced_radius: 17 },
        { schematic_balanced_radius: 1.5 }, { schematic_balanced_radius: '4' },
        { schematic_balanced_threshold: 0 }, { schematic_balanced_threshold: 4098 },
        { schematic_balanced_threshold: null }, { schematic_balanced_threshold: Infinity },
    ]) assert.throws(() => resolvePlacementOptions(bad));
    for (const override of [{ mode: 'unknown' }, { mode: 'raise', radius: 2 }, { threshold: 2 },
        { mode: 'balanced', radius: 17 }, { mode: 'balanced', threshold: 0 }, { mode: 'balanced', radius: 1.2 }, { mode: 'balanced', typo: 2 }])
        assert.throws(() => resolvePlacementOptions({}, override));
    setSettings(configured);
    assert.throws(() => setSettings({ schematic_balanced_radius: 999 }));
    assert.equal(settings.schematic_balanced_radius, 0);
    setSettings({});
    assert.throws(() => validateResolvedPlacementOptions({ mode: undefined, radius: 4, threshold: 9 }));
    for (const orientation of ['north', 'east', 'south', 'west']) {
        const resolved = validateResolvedPlacementOptions({ ...resolvePlacementOptions(), orientation });
        assert.equal(resolved.orientation, orientation);
        assert.ok(Object.isFrozen(resolved));
    }
    for (const orientation of ['EAST', 'zero', 0, null, {}, '__proto__'])
        assert.throws(() => validateResolvedPlacementOptions({ ...resolvePlacementOptions(), orientation }), /orientation/);
    for (const [input, expected] of [['N', 'north'], ['e', 'east'], ['SoUtH', 'south'], ['W', 'west']]) {
        const resolved = resolvePlacementOptions({}, { orientation: input });
        assert.equal(resolved.orientation, expected);
        assert.ok(Object.isFrozen(resolved));
    }
    for (const input of ['northwest', ' east', '', 0, {}, '__proto__'])
        assert.throws(() => resolvePlacementOptions({}, { orientation: input }), /orientation/);
    assert.throws(() => resolvePlacementOptions({ schematic_balanced_radius: -1 }, { orientation: 'east' }), /schematic_balanced_radius/);
    assert.equal(resolvePlacementOptions({ schematic_orientation: 'east' }).orientation, 'north');
});

test('example settings and UI schema agree with runtime defaults', async () => {
    const schema = JSON.parse(await readFile(new URL('../../src/mindcraft/public/settings_spec.json', import.meta.url), 'utf8'));
    assert.equal(schema.schematic_placement_mode.default, 'delicate');
    assert.equal(schema.schematic_balanced_radius.default, 4);
    assert.equal(schema.schematic_balanced_threshold.default, 9);
    for (const [key, value] of Object.entries({ schematic_balanced_strategy: 'stepped', schematic_balanced_step: 2, schematic_balanced_policy: 'first_valid', schematic_balanced_bisect_depth: 2 }))
        assert.equal(schema[key].default, value);
    const sample = (await import(new URL('../../settings.js', import.meta.url))).default;
    assert.deepEqual(resolvePlacementOptions(sample), { mode: 'delicate', radius: 4, threshold: 9, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
});

test('balanced search options validate settings, overrides and resolved snapshots', () => {
    const configured = { schematic_placement_mode: 'balanced', schematic_balanced_strategy: 'all', schematic_balanced_step: 16,
        schematic_balanced_policy: 'exhaustive', schematic_balanced_bisect_depth: 0 };
    const options = resolvePlacementOptions(configured, { strategy: 'bisect', step: 1, policy: 'first_valid', bisectDepth: 3 });
    assert.deepEqual(options, { mode: 'balanced', radius: 4, threshold: 9, orientation: 'north', strategy: 'bisect', step: 1, policy: 'first_valid', bisectDepth: 3 });
    assert.ok(Object.isFrozen(options));
    assert.deepEqual(validateResolvedPlacementOptions(options), options);
    assert.ok(Object.isFrozen(validateResolvedPlacementOptions(options)));
    for (const [setting, override, invalid] of [
        ['schematic_balanced_strategy', 'strategy', ['', 'unknown', 'ALL', 'Stepped', 'BiSeCt', ' all', 'bisect ', null, 2]],
        ['schematic_balanced_step', 'step', [0, 17, 1.5, '2', null]],
        ['schematic_balanced_policy', 'policy', ['', 'first-valid', 'FIRST_VALID', 'First_Valid', 'EXHAUSTIVE', 'Exhaustive', ' exhaustive', null, {}]],
        ['schematic_balanced_bisect_depth', 'bisectDepth', [-1, 4, 1.5, '2', null]],
    ]) for (const value of invalid) {
        assert.throws(() => resolvePlacementOptions({ ...configured, [setting]: value }, { [override]: options[override] }));
        assert.throws(() => validateResolvedPlacementOptions({ ...options, [override]: value }));
        if (value !== null) assert.throws(() => resolvePlacementOptions(configured, { [override]: value }));
    }
    for (const [setting, override, values] of [
        ['schematic_balanced_strategy', 'strategy', ['all', 'stepped', 'bisect']],
        ['schematic_balanced_policy', 'policy', ['first_valid', 'exhaustive']],
    ]) for (const value of values) {
        assert.equal(resolvePlacementOptions({ ...configured, [setting]: value })[override], value);
        assert.equal(resolvePlacementOptions(configured, { [override]: value })[override], value);
        assert.equal(validateResolvedPlacementOptions({ ...options, [override]: value })[override], value);
    }
    for (const override of [{ strategy: 'all' }, { step: 2 }, { policy: 'exhaustive' }, { bisectDepth: 0 }])
        assert.throws(() => resolvePlacementOptions({}, override), /balanced mode/);
    assert.throws(() => validateResolvedPlacementOptions({ ...options, strategy: 'ALL' }));
    assert.deepEqual(validateResolvedPlacementOptions({ mode: 'balanced', radius: 4, threshold: 9 }), resolvePlacementOptions({ schematic_placement_mode: 'balanced' }));
    setSettings(configured);
    assert.throws(() => setSettings({ ...configured, schematic_balanced_step: 0 }));
    assert.throws(() => setSettings({ ...configured, schematic_balanced_strategy: 'ALL' }), /schematic_balanced_strategy/);
    assert.throws(() => setSettings({ ...configured, schematic_balanced_policy: 'EXHAUSTIVE' }), /schematic_balanced_policy/);
    assert.equal(settings.schematic_balanced_step, 16);
    setSettings({});
});

test('build boundary rejects unavailable and invalid options before resolving, including resume context', async () => {
    for (const mode of ['raise', 'destructive']) {
        const log = [];
        let reads = 0;
        const options = resolvePlacementOptions({}, { mode });
        const session = { context: { placementOptions: options, planContract: "rotated-local-v1" }, resumeEligible: true };
        assert.equal(await buildSchematic({}, 'anything', null, null, null, {
            placementOptions: options, resumeSession: session,
            resolvePath: () => { reads++; }, writeLog: message => log.push(message),
        }), false);
        assert.equal(reads, 0);
        assert.equal(session.context, null);
        assert.match(log.join(' '), mode === 'raise' ? /raise schematic auto-resume is unavailable/i : /temporarily unavailable; no build was started/);
    }
    const log = [];
    assert.equal(await buildSchematic({}, 'anything', null, null, null, {
        placementOptions: { mode: 'typo', radius: 4, threshold: 9 }, writeLog: message => log.push(message),
    }), false);
    assert.match(log.join(' '), /must be delicate/);
    assert.equal(await buildSchematic({}, 'anything', null, null, null, {
        placementOptions: null, writeLog: message => log.push(message),
    }), false);
    assert.match(log.at(-1), /Invalid resolved schematic placement options/);
});

test('real skills bridge allows configured balanced and raise overrides to reach selection', () => {
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
        assert.equal(await buildSchematic(bot, 'unresolved.schem', null, null, null, Object.freeze({ mode: 'raise', radius: 6, threshold: 12 })), false);
        assert.match(bot.output, /Could not read schematic/);
        bot.output = '';
        assert.equal(await buildSchematic(bot, 'unresolved.schem', null, null, null, Object.freeze({ mode: 'balanced', radius: 6, threshold: 12, orientation: 'east' })), false);
        assert.match(bot.output, /Could not read schematic/);
    `;
    const child = spawnSync(process.execPath, ['--experimental-loader', loader, '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr + child.stdout);
});
