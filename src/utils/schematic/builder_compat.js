import { createRequire } from 'node:module';
import { acquireCreativeSlotLease } from '../creative_slot.js';

const require = createRequire(import.meta.url);
const { builder: schematicBuilder } = require('mineflayer-schem');
const minecraftData = require('minecraft-data');
const prismarineItem = require('prismarine-item');

const CANCELLATION_SAFETY_VERSION = 'mindcraft-cancellation-v1';
const CREATIVE_SUPPLY_SLOT = 36;
const WRITE_SETTLEMENT_TIMEOUT_MS = 6_000;
const RESTORE_ACK_TIMEOUT_MS = 10_000;
const supplySessions = new WeakMap();

function isCreative(bot) {
    return bot.game?.gameMode === 'creative';
}

function creativeSlotWritesHaveNoAck(bot) {
    return bot.supportFeature?.('noAckOnCreateSetSlotPacket') === true;
}

function assertSupplyAvailable(bot, session) {
    if (session.cancelled || session.closed || supplySessions.get(bot) !== session) {
        throw new Error('Creative schematic supply session is cancelled or closed');
    }
    if (!isCreative(bot)) {
        throw new Error('Schematic builder item supply requires Creative mode');
    }
}

function getInventorySlot(bot, slot) {
    return bot.inventory?.slots?.[slot] ?? null;
}

function itemsEqual(Item, first, second) {
    return Item.equal(first, second, true);
}

function forceCreativeSlotWrite(bot, slot, item) {
    if (typeof bot._client?.write !== 'function') {
        throw new Error('Mineflayer client packet writer is unavailable for Creative slot restoration');
    }
    const Item = prismarineItem(bot.version);
    bot._client.write('set_creative_slot', { slot, item: Item.toNotch(item) });
}

function finishSupplySession(bot, session) {
    if (session.closed || session.pendingWrites.length > 0 || !session.restoreAcknowledged) return;
    session.closed = true;
    if (session.onSlotUpdate) {
        session.inventory.off?.(`updateSlot:${CREATIVE_SUPPLY_SLOT}`, session.onSlotUpdate);
    }
    if (supplySessions.get(bot) === session) supplySessions.delete(bot);
    session.releaseLease?.();
    session.resolveSafe?.();
}

function withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}

function quarantineSupplySession(bot, session, lease, cause) {
    const error = new Error(
        `Creative slot ${CREATIVE_SUPPLY_SLOT} remains quarantined because its final state is uncertain; `
        + 'queued slot writers and later schematic supplies will fail instead of waiting indefinitely.',
        { cause },
    );
    session.closed = true;
    session.quarantineError = error;
    if (session.onSlotUpdate) {
        session.inventory.off?.(`updateSlot:${CREATIVE_SUPPLY_SLOT}`, session.onSlotUpdate);
        session.onSlotUpdate = null;
    }
    if (supplySessions.get(bot) === session) supplySessions.delete(bot);
    lease.quarantine(error);
    return error;
}

function observeRestoration(bot, session, _oldItem, newItem) {
    const Item = prismarineItem(bot.version);
    const pendingIndex = session.pendingWrites.findIndex((write) => itemsEqual(Item, write.item, newItem));
    if (pendingIndex !== -1) session.pendingWrites.splice(pendingIndex, 1);

    if (itemsEqual(Item, session.originalSlot, newItem)) {
        session.restoreAcknowledged = true;
        finishSupplySession(bot, session);
        return;
    }

    if (!session.restorationRequested) return;

    // A delayed acknowledgement for an earlier supply can update the local slot
    // after the restore packet. Correct local state; the server has already
    // processed the later restoration packet, so another packet is unnecessary.
    session.inventory.slots[CREATIVE_SUPPLY_SLOT] = session.originalSlot;
    finishSupplySession(bot, session);
}

function trackSupplyWrite(bot, session, item) {
    const Item = prismarineItem(bot.version);
    const write = { item, pending: false };
    let operation;
    try {
        operation = session.leaseReady.then((lease) => lease.write(() => {
            assertSupplyAvailable(bot, session);
            write.pending = !itemsEqual(Item, getInventorySlot(bot, CREATIVE_SUPPLY_SLOT), item);
            if (write.pending) session.pendingWrites.push(write);
            return bot.creative.setInventorySlot(CREATIVE_SUPPLY_SLOT, item);
        }));
    } catch (error) {
        if (write.pending && /cancelled due to calling/.test(String(error?.message))) {
            const index = session.pendingWrites.indexOf(write);
            if (index !== -1) session.pendingWrites.splice(index, 1);
        }
        throw error;
    }
    const forgetWrite = () => {
        if (write.pending) {
            const index = session.pendingWrites.indexOf(write);
            if (index !== -1) session.pendingWrites.splice(index, 1);
        }
    };
    return withTimeout(
        Promise.resolve(operation),
        WRITE_SETTLEMENT_TIMEOUT_MS,
        `Creative slot ${CREATIVE_SUPPLY_SLOT} supply write did not settle`,
    ).then(() => {
        forgetWrite();
    }, (error) => {
        const message = String(error?.message ?? error);
        if (/cancelled due to calling|server rejected/i.test(message)) {
            forgetWrite();
        }
        throw error;
    });
}

function installCreativeEquip(bot, builder) {
    builder.equipItem = async function equipItem(itemId) {
        const session = supplySessions.get(bot);
        if (!session) {
            throw new Error('Start a Creative supply session before building');
        }
        assertSupplyAvailable(bot, session);

        const pendingEquip = session.queue.then(async () => {
            assertSupplyAvailable(bot, session);
            const data = minecraftData(bot.version);
            const itemInfo = data.items[itemId];
            if (!itemInfo) {
                throw new Error(`Unknown Minecraft item id ${itemId}`);
            }

            const Item = prismarineItem(bot.version);
            const count = Math.min(64, itemInfo.stackSize || 64);
            const itemToSupply = new Item(itemInfo.id, count, 0);

            // One reserved hotbar slot is reused for every palette type. This is
            // intentionally on-demand, so large palettes never need pre-stocking.
            await trackSupplyWrite(bot, session, itemToSupply);
            assertSupplyAvailable(bot, session);

            const equippedItem = getInventorySlot(bot, CREATIVE_SUPPLY_SLOT)
                ?? bot.inventory?.items?.().find((item) => item.type === itemInfo.id);
            if (!equippedItem || equippedItem.type !== itemInfo.id) {
                throw new Error(`Creative supply failed to place item ${itemInfo.name} in slot ${CREATIVE_SUPPLY_SLOT}`);
            }

            assertSupplyAvailable(bot, session);
            await bot.equip(equippedItem, 'hand');
            return equippedItem;
        });

        // Keep the queue usable after failures, while returning this operation's
        // rejection to the caller (mineflayer-schem expects equipItem to reject).
        session.queue = pendingEquip.catch(() => {});
        return await pendingEquip;
    };
}

/**
 * Loads mineflayer-schem while restoring pathfinder's movement policy after its
 * injector installs its own build-specific movements.
 */
export function loadSchematicBuilder(bot) {
    if (schematicBuilder.cancellationSafetyVersion !== CANCELLATION_SAFETY_VERSION) {
        throw new Error(
            'mineflayer-schem cancellation-safety patch is missing or incompatible. '
            + 'Reinstall dependencies with npm install and ensure patches/mineflayer-schem+1.5.2.patch applies.',
        );
    }
    if (!bot || typeof bot.loadPlugin !== 'function') {
        throw new Error('Load mineflayer-pathfinder before mineflayer-schem');
    }

    // Mineflayer queues plugins until inject_allowed. Register compatibility as
    // its own plugin so it runs after the previously queued pathfinder plugin.
    bot.loadPlugin((injectedBot) => {
        if (!injectedBot.pathfinder) {
            throw new Error('Load mineflayer-pathfinder before mineflayer-schem');
        }

        const priorMovements = injectedBot.pathfinder.movements;
        const priorSearchRadius = injectedBot.pathfinder.searchRadius;
        try {
            injectedBot.loadPlugin(schematicBuilder);
            if (!injectedBot.builder) {
                throw new Error('mineflayer-schem did not install bot.builder');
            }
            if (injectedBot.pathfinder.movements !== priorMovements) {
                injectedBot.pathfinder.setMovements(priorMovements);
            }
        } finally {
            injectedBot.pathfinder.searchRadius = priorSearchRadius;
        }

        installCreativeEquip(injectedBot, injectedBot.builder);
        const pluginCancel = injectedBot.builder.cancel?.bind(injectedBot.builder);
        injectedBot.builder.cancel = function cancel() {
            supplySessions.get(injectedBot)?.cancel();
            pluginCancel?.();
        };
        injectedBot.builder.stop = function stop() {
            injectedBot.builder.cancel();
            if (typeof injectedBot.pathfinder.setGoal === 'function') {
                injectedBot.pathfinder.setGoal(null);
            } else {
                injectedBot.pathfinder.stop?.();
            }
        };
    });

    return bot.builder;
}

/**
 * Starts an on-demand Creative inventory supply session. Call the returned
 * async cleanup function (or its close method) when the schematic build ends.
 */
export function beginCreativeSupply(bot) {
    if (!bot?.inventory || !bot?.creative?.setInventorySlot) {
        throw new Error('Creative inventory support is required for schematic supply');
    }
    if (supplySessions.has(bot) && !supplySessions.get(bot).closed) {
        throw new Error('A Creative schematic supply session is already active');
    }

    const session = {
        inventory: bot.inventory,
        originalSlot: null,
        cancelled: false,
        closed: false,
        restorationRequested: false,
        restoreAcknowledged: false,
        restoreError: null,
        aborted: false,
        pendingWrites: [],
        queue: Promise.resolve(),
        leaseReady: null,
        cancel() {
            session.cancelled = true;
        },
        close() {
            if (session.closePromise) return session.closePromise;
            if (session.closed) return Promise.resolve();
            session.cancel();
            session.restorationRequested = true;
            session.closePromise = (async () => {
                let lease;
                try {
                    lease = await session.leaseReady;
                } catch (error) {
                    session.closed = true;
                    if (supplySessions.get(bot) === session) supplySessions.delete(bot);
                    throw error;
                }
                session.releaseLease = () => lease.release();
                try {
                    if (typeof bot._client?.write === 'function'
                        && typeof bot.inventory?.on === 'function'
                        && typeof bot.inventory?.off === 'function') {
                        if (creativeSlotWritesHaveNoAck(bot)) {
                            // No-ack calls update the local slot synchronously,
                            // but may still be inside Mineflayer's rejection window.
                            await withTimeout(
                                session.queue,
                                WRITE_SETTLEMENT_TIMEOUT_MS,
                                `Creative slot ${CREATIVE_SUPPLY_SLOT} write did not settle before cleanup`,
                            );
                            await withTimeout(
                                lease.write(() => bot.creative.setInventorySlot(CREATIVE_SUPPLY_SLOT, session.originalSlot)),
                                WRITE_SETTLEMENT_TIMEOUT_MS,
                                `Creative slot ${CREATIVE_SUPPLY_SLOT} restoration did not settle`,
                            );
                            session.inventory.slots[CREATIVE_SUPPLY_SLOT] = session.originalSlot;
                            // The serialized restoration ran after every lease
                            // write settled, so stale no-ack markers are terminal.
                            session.pendingWrites.length = 0;
                            session.restoreAcknowledged = true;
                            finishSupplySession(bot, session);
                            await lease.release();
                            return;
                        }
                    let resolveSafe;
                    const safe = new Promise((resolve) => { resolveSafe = resolve; });
                    session.resolveSafe = resolveSafe;
                    session.onSlotUpdate = observeRestoration.bind(null, bot, session);
                    bot.inventory.on(`updateSlot:${CREATIVE_SUPPLY_SLOT}`, session.onSlotUpdate);
                    session.inventory.slots[CREATIVE_SUPPLY_SLOT] = session.originalSlot;
                    try {
                        // Bypass Mineflayer's equal-item fast path: local inventory may
                        // still show the snapshot while a supply acknowledgement is
                        // outstanding. The restore packet follows it on the same client
                        // connection; keep the lease held until late writes reconcile.
                        forceCreativeSlotWrite(bot, CREATIVE_SUPPLY_SLOT, session.originalSlot);
                    } catch (error) {
                        session.restoreError = error;
                        throw error;
                    }
                    if (session.restoreError) throw session.restoreError;
                    await withTimeout(
                        safe,
                        RESTORE_ACK_TIMEOUT_MS,
                        `Creative slot ${CREATIVE_SUPPLY_SLOT} restoration was not acknowledged`,
                    );
                    await lease.release();
                    return;
                    }

                await withTimeout(
                    session.queue,
                    WRITE_SETTLEMENT_TIMEOUT_MS,
                    `Creative slot ${CREATIVE_SUPPLY_SLOT} write did not settle before cleanup`,
                );
                if (isCreative(bot)) {
                    await withTimeout(
                        lease.write(() => bot.creative.setInventorySlot(CREATIVE_SUPPLY_SLOT, session.originalSlot)),
                        WRITE_SETTLEMENT_TIMEOUT_MS,
                        `Creative slot ${CREATIVE_SUPPLY_SLOT} restoration did not settle`,
                    );
                }
                session.restoreAcknowledged = true;
                finishSupplySession(bot, session);
                await lease.release();
                } catch (cause) {
                    throw quarantineSupplySession(bot, session, lease, cause);
                }
            })();
            return session.closePromise;
        },
    };
    session.leaseReady = acquireCreativeSlotLease(bot, CREATIVE_SUPPLY_SLOT).then((lease) => {
        // Capture after any writer that was already queued has settled, so cleanup
        // restores the slot state this session actually took ownership of.
        session.originalSlot = getInventorySlot(bot, CREATIVE_SUPPLY_SLOT);
        return lease;
    });
    // Keep a failed acquisition observable through equip/close without allowing
    // an unobserved quarantine rejection to become a process-level warning.
    session.leaseReady.catch(() => {});

    // The cleanup function is convenient for `finally`, while properties expose
    // cancellation and explicit close to build lifecycle handlers.
    const cleanup = () => session.close();
    cleanup.cancel = () => session.cancel();
    cleanup.abort = () => {
        // Do not release slot ownership while a request or its acknowledgement
        // may still be outstanding; close() continues its bounded settlement.
        session.cancel();
        session.aborted = true;
    };
    cleanup.close = cleanup;
    cleanup.session = session;
    supplySessions.set(bot, session);
    return cleanup;
}
