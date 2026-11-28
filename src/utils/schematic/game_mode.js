const GAME_MODES = new Set(["survival", "creative", "adventure", "spectator"]);

export function normalizeGameMode(mode) {
  const normalized = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  return GAME_MODES.has(normalized) ? normalized : "survival";
}

export async function setGameMode(bot, mode, timeoutMs = 800, { force = false } = {}) {
  const targetMode = normalizeGameMode(mode);
  if (!bot?.game || !bot?.on || typeof bot.chat !== "function") return false;
  if (!force && bot.game.gameMode === targetMode) return true;

  const result = await new Promise((resolve) => {
    let timer;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      try {
        bot.removeListener?.("game", onGame);
      } catch {
        // Cleanup should not replace the transition result.
      }
    };

    const finish = (success) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(success);
    };

    const onGame = (game) => {
      const observedMode = game?.gameMode ?? bot.game?.gameMode;
      if (observedMode === targetMode) finish(true);
    };

    try {
      bot.on("game", onGame);
      timer = setTimeout(() => finish(false), timeoutMs);
      const chatResult = bot.chat(`/gamemode ${targetMode}`);
      Promise.resolve(chatResult).catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
  return result;
}
