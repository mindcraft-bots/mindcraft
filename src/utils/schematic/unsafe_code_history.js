// Generated code receives the mutable bot and can retain it after execution.
// Once exposed, event-based human provenance cannot be recovered for that bot.
const exposedBots = new WeakSet();

export function markBotExposedToGeneratedCode(bot) {
    if (bot && (typeof bot === 'object' || typeof bot === 'function')) exposedBots.add(bot);
}

export function wasBotExposedToGeneratedCode(bot) {
    return Boolean(bot && exposedBots.has(bot));
}
