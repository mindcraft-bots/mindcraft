export const DEFAULT_BALANCED_RADIUS = 4;
export const DEFAULT_BALANCED_THRESHOLD = 9;
export const DEFAULT_BALANCED_STRATEGY = 'stepped';
export const DEFAULT_BALANCED_STEP = 2;
export const DEFAULT_BALANCED_POLICY = 'first_valid';
export const DEFAULT_BALANCED_BISECT_DEPTH = 2;
const MODES = ['delicate', 'raise', 'balanced', 'destructive'];
const STRATEGIES = ['all', 'stepped', 'bisect'];
const POLICIES = ['first_valid', 'exhaustive'];
const OPTION_KEYS = ['mode', 'radius', 'threshold', 'orientation', 'strategy', 'step', 'policy', 'bisectDepth'];

function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
    return value;
}

function choice(value, name, allowed) {
    if (typeof value !== 'string' || !allowed.includes(value))
        throw new TypeError(`${name} must be ${allowed.join(', ')}`);
    return value;
}

function mode(value, name) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !MODES.includes(value.toLowerCase()))
        throw new TypeError(`${name} must be delicate, raise, balanced, destructive, or null`);
    return value.toLowerCase();
}

function orientation(value) {
    if (typeof value !== 'string') throw new TypeError('orientation must be north, east, south, west, or a cardinal shorthand');
    const directions = { n: 'north', e: 'east', s: 'south', w: 'west', north: 'north', east: 'east', south: 'south', west: 'west' };
    const key = value.toLowerCase();
    if (!Object.hasOwn(directions, key)) throw new TypeError('orientation must be north, east, south, west, or a cardinal shorthand');
    return directions[key];
}

// Validate the complete configuration even when an individual build overrides it.
export function resolvePlacementOptions(settings = {}, overrides = {}) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)
        || Object.keys(overrides).some(key => !OPTION_KEYS.includes(key)))
        throw new TypeError('Invalid schematic placement configuration or overrides');
    resolveContinuationPolicy(settings);
    const configuredMode = mode(settings.schematic_placement_mode, 'schematic_placement_mode') ?? 'delicate';
    const radius = integer(settings.schematic_balanced_radius === undefined ? DEFAULT_BALANCED_RADIUS : settings.schematic_balanced_radius, 'schematic_balanced_radius', 0, 16);
    const threshold = integer(settings.schematic_balanced_threshold === undefined ? DEFAULT_BALANCED_THRESHOLD : settings.schematic_balanced_threshold, 'schematic_balanced_threshold', 1, 4097);
    const strategy = choice(settings.schematic_balanced_strategy === undefined ? DEFAULT_BALANCED_STRATEGY : settings.schematic_balanced_strategy, 'schematic_balanced_strategy', STRATEGIES);
    const step = integer(settings.schematic_balanced_step === undefined ? DEFAULT_BALANCED_STEP : settings.schematic_balanced_step, 'schematic_balanced_step', 1, 16);
    const policy = choice(settings.schematic_balanced_policy === undefined ? DEFAULT_BALANCED_POLICY : settings.schematic_balanced_policy, 'schematic_balanced_policy', POLICIES);
    const bisectDepth = integer(settings.schematic_balanced_bisect_depth === undefined ? DEFAULT_BALANCED_BISECT_DEPTH : settings.schematic_balanced_bisect_depth, 'schematic_balanced_bisect_depth', 0, 3);
    const selectedMode = overrides.mode == null ? configuredMode : mode(overrides.mode, 'mode');
    if (['radius', 'threshold', 'strategy', 'step', 'policy', 'bisectDepth'].some(key => overrides[key] != null) && selectedMode !== 'balanced')
        throw new TypeError('balanced search overrides require balanced mode');
    return Object.freeze({
        mode: selectedMode,
        radius: overrides.radius == null ? radius : integer(overrides.radius, 'radius', 0, 16),
        threshold: overrides.threshold == null ? threshold : integer(overrides.threshold, 'threshold', 1, 4097),
        orientation: overrides.orientation == null ? 'north' : orientation(overrides.orientation),
        strategy: overrides.strategy == null ? strategy : choice(overrides.strategy, 'strategy', STRATEGIES),
        step: overrides.step == null ? step : integer(overrides.step, 'step', 1, 16),
        policy: overrides.policy == null ? policy : choice(overrides.policy, 'policy', POLICIES),
        bisectDepth: overrides.bisectDepth == null ? bisectDepth : integer(overrides.bisectDepth, 'bisectDepth', 0, 3),
    });
}

// Keep this separate from per-request placement options: requests must not be
// able to override the administrator's setting.
export function resolveContinuationPolicy(settings = {}) {
    return choice(settings.schematic_continuation_policy === undefined ? 'ask' : settings.schematic_continuation_policy,
        'schematic_continuation_policy', ['ask', 'allow', 'deny', 'off']);
}

export function validateResolvedPlacementOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !OPTION_KEYS.includes(key))
        || !Object.hasOwn(options, 'mode') || options.mode == null || !Object.hasOwn(options, 'radius') || !Object.hasOwn(options, 'threshold'))
        throw new TypeError('Invalid resolved schematic placement options');
    const selectedMode = mode(options.mode, 'mode');
    const orientation = options.orientation === undefined ? 'north' : options.orientation;
    if (!['north', 'east', 'south', 'west'].includes(orientation))
        throw new TypeError('orientation must be canonical north, east, south, or west');
    return Object.freeze({ mode: selectedMode, radius: integer(options.radius, 'radius', 0, 16), threshold: integer(options.threshold, 'threshold', 1, 4097), orientation,
        strategy: choice(Object.hasOwn(options, 'strategy') ? options.strategy : DEFAULT_BALANCED_STRATEGY, 'strategy', STRATEGIES),
        step: integer(Object.hasOwn(options, 'step') ? options.step : DEFAULT_BALANCED_STEP, 'step', 1, 16),
        policy: choice(Object.hasOwn(options, 'policy') ? options.policy : DEFAULT_BALANCED_POLICY, 'policy', POLICIES),
        bisectDepth: integer(Object.hasOwn(options, 'bisectDepth') ? options.bisectDepth : DEFAULT_BALANCED_BISECT_DEPTH, 'bisectDepth', 0, 3) });
}
