const activeBuilds = new WeakMap();
const buildLifecycles = new WeakMap();
const DEFAULT_POLL_MS = 500;
const DEFAULT_STALL_MS = 30_000;
const MAX_GRACE_MS = 3_999;

function remainingActions(build) {
  return Array.isArray(build?.actions) ? build.actions.length : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addError(errors, error) {
  errors.push(error instanceof Error ? error : new Error(String(error)));
}

function isThenable(value) {
  return value != null && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

/** Acquire per-bot ownership before a build changes mode or inventory. */
export function acquireBuildLifecycle(bot) {
  if (!bot || (typeof bot !== "object" && typeof bot !== "function")) {
    throw new TypeError("A bot object is required to acquire schematic build ownership");
  }
  if (buildLifecycles.has(bot)) return null;

  const owner = { holds: 0, releaseRequested: false, released: false };
  const finalize = () => {
    if (owner.releaseRequested && owner.holds === 0 && !owner.released) {
      owner.released = true;
      if (buildLifecycles.get(bot) === owner) buildLifecycles.delete(bot);
    }
  };
  const lease = {
    isCurrent() {
      return !owner.releaseRequested && !owner.released && buildLifecycles.get(bot) === owner;
    },
    hasPending() {
      return owner.holds > 0;
    },
    hold(promise) {
      if (owner.released) return;
      owner.holds++;
      const settled = () => {
        owner.holds--;
        finalize();
      };
      Promise.resolve(promise).then(settled, settled);
    },
    release() {
      owner.releaseRequested = true;
      finalize();
    },
  };
  buildLifecycles.set(bot, owner);
  return lease;
}

function cancelBuild(bot, build, onCancel, errors) {
  try {
    bot.builder?.stop?.();
  } catch (error) {
    addError(errors, error);
  }

  try {
    build?.cancel?.();
  } catch (error) {
    addError(errors, error);
  }

  try {
    if (typeof bot.pathfinder?.setGoal === 'function') {
      bot.pathfinder.setGoal(null);
    } else {
      bot.pathfinder?.stop?.();
    }
  } catch (error) {
    addError(errors, error);
  }

  if (typeof onCancel === 'function') {
    try {
      const cancellation = onCancel();
      if (isThenable(cancellation)) {
        Promise.resolve(cancellation).catch((error) => addError(errors, error));
      }
    } catch (error) {
      addError(errors, error);
    }
  }
}

/** Run one schematic build with cancellation, error, and stalled-progress bounds. */
export async function runBuild(bot, build, {
  isInterrupted = () => bot.interrupt_code,
  pollMs = DEFAULT_POLL_MS,
  stallMs = DEFAULT_STALL_MS,
  graceMs = 4_000,
  onCancel,
  onPendingSettlement,
  lifecycle,
} = {}) {
  const active = activeBuilds.get(bot);
  if (active && !active.settled) {
    throw new Error('A schematic build is still running for this bot; refusing to overlap it');
  }
  if (active) activeBuilds.delete(bot);

  const errors = [];
  const result = (status) => ({ status, errors, remaining: remainingActions(build) });
  let status;
  let started = false;
  let lastRemaining = remainingActions(build);
  let lastProgressAt = Date.now();
  let record;
  let settledPromise;
  let removeErrorListener;

  const onBuilderError = (error) => addError(errors, error ?? new Error('Schematic builder reported an error'));

  try {
    if (typeof bot?.builder?.build !== 'function') {
      addError(errors, new Error('bot.builder.build is not available'));
      return result('error');
    }

    if (typeof bot.on === 'function') {
      bot.on('builder_error', onBuilderError);
      removeErrorListener = () => {
        if (typeof bot.off === 'function') bot.off('builder_error', onBuilderError);
        else bot.removeListener?.('builder_error', onBuilderError);
      };
    }

    let interrupted;
    try {
      interrupted = Boolean(isInterrupted());
    } catch (error) {
      addError(errors, error);
      return result('error');
    }
    if (interrupted) {
      status = 'interrupted';
      cancelBuild(bot, build, onCancel, errors);
      return result(status);
    }

    record = { settled: false };
    activeBuilds.set(bot, record);
    started = true;

    let resolveBuild;
    let rejectBuild;
    settledPromise = new Promise((resolve, reject) => {
      resolveBuild = resolve;
      rejectBuild = reject;
    });
    lifecycle?.hold?.(settledPromise);
    onPendingSettlement?.(settledPromise);
    // Both outcomes are observed immediately so a promise that outlives this
    // call cannot later create an unhandled rejection.
    Promise.resolve()
      .then(() => bot.builder.build(build))
      .then(
        (value) => {
          record.settled = true;
          if (activeBuilds.get(bot) === record) activeBuilds.delete(bot);
          resolveBuild({ ok: true, value });
        },
        (error) => {
          record.settled = true;
          if (activeBuilds.get(bot) === record) activeBuilds.delete(bot);
          addError(errors, error);
          resolveBuild({ ok: false, error });
        },
      );

    while (true) {
      if (errors.length > 0) {
        status = 'error';
        break;
      }

      try {
        if (isInterrupted()) {
          status = 'interrupted';
          break;
        }
      } catch (error) {
        addError(errors, error);
        status = 'error';
        break;
      }

      const remaining = remainingActions(build);
      if (remaining < lastRemaining) {
        lastRemaining = remaining;
        lastProgressAt = Date.now();
      } else if (remaining > lastRemaining) {
        lastRemaining = remaining;
      }

      if (record.settled) {
        const completion = await settledPromise;
        if (!completion.ok || errors.length > 0) {
          status = 'error';
        } else if (remainingActions(build) === 0) {
          status = 'finished';
        } else {
          addError(errors, new Error(`Schematic builder returned with ${remainingActions(build)} actions remaining`));
          status = 'error';
        }
        break;
      }

      if (Number.isFinite(stallMs) && stallMs >= 0 && Date.now() - lastProgressAt >= stallMs) {
        status = 'stalled';
        break;
      }

      const waitMs = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS;
      await delay(waitMs);
    }

    if (status !== 'finished' && !record.settled) {
      cancelBuild(bot, build, onCancel, errors);
      const boundedGrace = Number.isFinite(graceMs)
        ? Math.max(0, Math.min(graceMs, MAX_GRACE_MS))
        : MAX_GRACE_MS;
      let graceTimer;
      await Promise.race([
        settledPromise,
        new Promise((resolve) => {
          graceTimer = setTimeout(resolve, boundedGrace);
        }),
      ]);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }

    return result(status ?? 'error');
  } catch (error) {
    addError(errors, error);
    if (!status) status = 'error';
    if (started && record && !record.settled) {
      cancelBuild(bot, build, onCancel, errors);
    }
    return result(status);
  } finally {
    removeErrorListener?.();
    // A pending promise remains registered as a quarantine until its settlement
    // handler clears it; only settled records are safe to release here.
    if (record?.settled && activeBuilds.get(bot) === record) activeBuilds.delete(bot);
  }
}
