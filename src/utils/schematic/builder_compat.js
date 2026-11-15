import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { builder: schematicBuilder } = require('mineflayer-schem');
const minecraftData = require('minecraft-data');
const prismarineItem = require('prismarine-item');

const CANCELLATION_SAFETY_VERSION = 'mindcraft-cancellation-v1';
const CREATIVE_SUPPLY_SLOT = 36;
const supplySessions = new WeakMap();

function isCreative(bot) {
    return bot.game?.gameMode === 'creative';
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
    session.inventory.off?.(`updateSlot:${CREATIVE_SUPPLY_SLOT}`, session.onSlotUpdate);
    if (supplySessions.get(bot) === session) supplySessions.delete(bot);
    session.resolveSafe?.();
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
    const pending = !itemsEqual(Item, getInventorySlot(bot, CREATIVE_SUPPLY_SLOT), item);
    const write = { item };
    if (pending) session.pendingWrites.push(write);
    let operation;
    try {
        operation = bot.creative.setInventorySlot(CREATIVE_SUPPLY_SLOT, item);
    } catch (error) {
        if (pending && /cancelled due to calling/.test(String(error?.message))) {
            const index = session.pendingWrites.indexOf(write);
            if (index !== -1) session.pendingWrites.splice(index, 1);
        }
        throw error;
    }
    const forgetWrite = () => {
        if (pending) {
            const index = session.pendingWrites.indexOf(write);
            if (index !== -1) session.pendingWrites.splice(index, 1);
        }
    };
    return Promise.resolve(operation).then(() => {
        forgetWrite();
    }, (error) => {
        if (/cancelled due to calling/.test(String(error?.message))) forgetWrite();
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
        originalSlot: getInventorySlot(bot, CREATIVE_SUPPLY_SLOT),
        cancelled: false,
        closed: false,
        restorationRequested: false,
        restoreAcknowledged: false,
        restoreError: null,
        aborted: false,
        pendingWrites: [],
        queue: Promise.resolve(),
        cancel() {
            session.cancelled = true;
        },
        close() {
            if (session.closed) return;
            if (session.closePromise) return session.closePromise;
            session.cancel();
            session.restorationRequested = true;
            session.closePromise = (async () => {
                if (typeof bot._client?.write === 'function'
                    && typeof bot.inventory?.on === 'function'
                    && typeof bot.inventory?.off === 'function') {
                    let resolveSafe;
                    const safe = new Promise((resolve) => { resolveSafe = resolve; });
                    session.resolveSafe = resolveSafe;
                    session.onSlotUpdate = observeRestoration.bind(null, bot, session);
                    bot.inventory.on(`updateSlot:${CREATIVE_SUPPLY_SLOT}`, session.onSlotUpdate);
                    session.inventory.slots[CREATIVE_SUPPLY_SLOT] = session.originalSlot;
                    try {
                        // Bypass Mineflayer's equal-item fast path: local inventory may
                        // still show the snapshot while the server already applied a supply write.
                        forceCreativeSlotWrite(bot, CREATIVE_SUPPLY_SLOT, session.originalSlot);
                    } catch (error) {
                        session.restoreError = error;
                        throw error;
                    }
                    await session.queue;
                    if (session.restoreError) throw session.restoreError;
                    await safe;
                    return;
                }

                await session.queue;
                if (session.aborted) return;
                if (isCreative(bot)) await bot.creative.setInventorySlot(CREATIVE_SUPPLY_SLOT, session.originalSlot);
                session.restoreAcknowledged = true;
                finishSupplySession(bot, session);
            })();
            return session.closePromise;
        },
    };

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
