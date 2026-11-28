const slotQueues = new WeakMap();

function getSlotQueue(bot, slot) {
    let slots = slotQueues.get(bot);
    if (!slots) {
        slots = new Map();
        slotQueues.set(bot, slots);
    }
    let queue = slots.get(slot);
    if (!queue) {
        queue = { tail: Promise.resolve(), generation: 0, quarantineError: null };
        slots.set(slot, queue);
    }
    return queue;
}

/** Serializes an application creative-slot write with all other writers to that bot/slot. */
export function serializeCreativeSlotWrite(bot, slot, write) {
    const queue = getSlotQueue(bot, slot);
    if (queue.quarantineError) return Promise.reject(queue.quarantineError);
    const generation = queue.generation;
    const previous = queue.tail;
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    queue.tail = previous.catch(() => {}).then(() => hold);

    const operation = previous.catch(() => {}).then(() => {
        if (queue.quarantineError || generation !== queue.generation) {
            throw queue.quarantineError ?? new Error(`Creative slot ${slot} lease was quarantined`);
        }
        return write();
    });
    operation.finally(release).catch(() => {});
    return operation;
}

/**
 * Reserves a slot for a multi-step owner (such as schematic supply). Ordinary
 * writers remain queued until release; lease writes are serialized among themselves.
 * A quarantined lease is deliberately permanent for this bot/slot: when an
 * underlying write never settles, there is no safe signal that a late packet
 * can no longer arrive. Reconnect to obtain a fresh slot queue.
 */
export function acquireCreativeSlotLease(bot, slot) {
    const queue = getSlotQueue(bot, slot);
    if (queue.quarantineError) return Promise.reject(queue.quarantineError);
    const generation = queue.generation;
    const previous = queue.tail;
    let releaseHold;
    const hold = new Promise((resolve) => { releaseHold = resolve; });
    queue.tail = previous.catch(() => {}).then(() => hold);

    return previous.catch(() => {}).then(() => {
        if (queue.quarantineError || generation !== queue.generation) {
            throw queue.quarantineError ?? new Error(`Creative slot ${slot} lease was quarantined`);
        }
        let released = false;
        let releasePromise = null;
        let ownerTail = Promise.resolve();
        let quarantineError = null;
        return {
            write(writeOperation) {
                if (released) return Promise.reject(new Error(`Creative slot ${slot} lease is released`));
                const operation = ownerTail.then(writeOperation);
                ownerTail = operation.catch(() => {});
                return operation;
            },
            release() {
                if (releasePromise) return releasePromise;
                releasePromise = (async () => {
                    if (quarantineError) return;
                    await ownerTail;
                    released = true;
                    releaseHold();
                })();
                return releasePromise;
            },
            quarantine(error) {
                if (released) return;
                quarantineError = error;
                queue.quarantineError = error;
                queue.generation += 1;
                // Unblock queued callers so they can reject with the explicit
                // quarantine error instead of remaining pending indefinitely.
                releaseHold();
            },
            whenIdle() {
                return ownerTail;
            },
        };
    });
}
