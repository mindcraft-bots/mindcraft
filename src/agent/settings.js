import { resolvePlacementOptions } from '../utils/schematic/placement_options.js';
import { validateTrustedCommandSenders } from '../utils/command_trust.js';

// extremely lightweight obj that can be imported/modified by any file
let settings = {};
export default settings;
export function setSettings(new_settings) {
    resolvePlacementOptions(new_settings);
    validateTrustedCommandSenders(new_settings.trusted_command_senders);
    const entries = Object.entries(new_settings);
    Object.keys(settings).forEach(key => delete settings[key]);
    // Hidden keys are opaque data, including __proto__; never invoke setters on
    // the shared store's prototype when loading an API/startup snapshot.
    for (const [key, value] of entries) {
        Object.defineProperty(settings, key, { value, enumerable: true, writable: true, configurable: true });
    }
}
