// Missing/null retain the legacy unrestricted policy. An empty list denies all
// external senders; malformed values must never be interpreted as a reset.
function validCommandSenders(value) {
    if (value === null || value === undefined) return true;
    if (!Array.isArray(value)) return false;
    for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index) || typeof value[index] !== 'string' || !value[index].trim())
            return false;
    }
    return true;
}

export function validateTrustedCommandSenders(value) {
    if (!validCommandSenders(value))
        throw new TypeError('trusted_command_senders must be an array of non-empty strings, null, or missing');
}

export function isTrustedCommandSender(value, sender) {
    // Also fail closed if code mutates the shared runtime store after validation.
    return validCommandSenders(value)
        && (value === null || value === undefined || value.includes(sender));
}
