export const DEFAULT_BALANCED_RADIUS = 4;
export const DEFAULT_BALANCED_THRESHOLD = 9;
const MODES = ['safe', 'destructive', 'balanced'];

function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
    return value;
}

function mode(value, name) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !MODES.includes(value.toLowerCase()))
        throw new TypeError(`${name} must be safe, destructive, balanced, or null`);
    return value.toLowerCase();
}

// Validate the complete configuration even when an individual build overrides it.
export function resolvePlacementOptions(settings = {}, overrides = {}) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)
        || Object.keys(overrides).some(key => !['mode', 'radius', 'threshold'].includes(key)))
        throw new TypeError('Invalid schematic placement configuration or overrides');
    const configuredMode = mode(settings.schematic_placement_mode, 'schematic_placement_mode');
    const radius = integer(settings.schematic_balanced_radius === undefined ? DEFAULT_BALANCED_RADIUS : settings.schematic_balanced_radius, 'schematic_balanced_radius', 0, 16);
    const threshold = integer(settings.schematic_balanced_threshold === undefined ? DEFAULT_BALANCED_THRESHOLD : settings.schematic_balanced_threshold, 'schematic_balanced_threshold', 1, 4097);
    const selectedMode = overrides.mode == null ? configuredMode : mode(overrides.mode, 'mode');
    if ((overrides.radius != null || overrides.threshold != null) && selectedMode !== 'balanced')
        throw new TypeError('radius and threshold overrides require balanced mode');
    return Object.freeze({
        mode: selectedMode,
        radius: overrides.radius == null ? radius : integer(overrides.radius, 'radius', 0, 16),
        threshold: overrides.threshold == null ? threshold : integer(overrides.threshold, 'threshold', 1, 4097),
    });
}

export function validateResolvedPlacementOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['mode', 'radius', 'threshold'].includes(key))
        || !Object.hasOwn(options, 'mode') || options.mode === undefined || !Object.hasOwn(options, 'radius') || !Object.hasOwn(options, 'threshold'))
        throw new TypeError('Invalid resolved schematic placement options');
    const selectedMode = mode(options.mode, 'mode');
    return Object.freeze({ mode: selectedMode, radius: integer(options.radius, 'radius', 0, 16), threshold: integer(options.threshold, 'threshold', 1, 4097) });
}
