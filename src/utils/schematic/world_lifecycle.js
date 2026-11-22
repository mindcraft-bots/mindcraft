const botWorldLifecycles = new WeakMap();

/**
 * Track Mineflayer protocol/world lifecycle transitions from bot creation onward.
 * The respawn packet is the authoritative event for a dimension/world switch;
 * Mineflayer may retain the same world and entity objects across it.
 */
export function trackBotWorldLifecycle(bot) {
  if (!bot || (typeof bot !== "object" && typeof bot !== "function")) return null;
  const previous = botWorldLifecycles.get(bot);
  if (previous) return previous;

  const state = { generation: 0, tracked: false, terminal: false, listeners: [] };
  botWorldLifecycles.set(bot, state);

  const addListener = (emitter, event, listener) => {
    if (typeof emitter?.on !== "function") return false;
    emitter.on(event, listener);
    state.listeners.push({ emitter, event, listener });
    return true;
  };
  const removeListeners = () => {
    for (const { emitter, event, listener } of state.listeners.splice(0)) {
      if (typeof emitter.off === "function") emitter.off(event, listener);
      else emitter.removeListener?.(event, listener);
    }
  };
  const transition = () => {
    state.generation++;
  };
  const disconnect = () => {
    if (state.terminal) return;
    transition();
    state.terminal = true;
    removeListeners();
  };

  // Mineflayer's health plugin emits bot 'respawn' for the client's actual
  // respawn packet. Listen to the protocol client directly so the transition is
  // recorded even if higher-level listeners have not been installed yet.
  const client = bot._client;
  const clientTracked = addListener(client, "respawn", transition);
  const deathTracked = addListener(bot, "death", transition);
  const disconnectTracked = ["end", "kicked", "disconnect"].map((event) =>
    addListener(bot, event, disconnect));
  const worldTracked = addListener(bot, "world", transition);
  state.tracked = clientTracked && deathTracked && disconnectTracked.every(Boolean) && worldTracked;
  return state;
}

export function getBotWorldGeneration(bot) {
  return trackBotWorldLifecycle(bot)?.generation ?? null;
}

export function isBotWorldLifecycleTracked(bot) {
  const state = trackBotWorldLifecycle(bot);
  return state?.tracked === true && state.terminal !== true;
}
