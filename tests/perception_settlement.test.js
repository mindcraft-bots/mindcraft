import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { formatPerception, formatSettlementLine, fetchPerception, clearPerceptionCache } from '../src/agent/topography/service.js';
import settings from '../src/agent/settings.js';

// Topography is off by default; these tests exercise it switched on.
settings.cartography_enabled = true;

const BASE = { center: { x: 281, z: -747 }, size_chunks: 16, missing_chunks: 0, biome: 'minecraft:plains' };

test('settlement line: inside, nearest, outpost, weak signal, and nothing when absent', () => {
    assert.equal(formatSettlementLine(undefined), '');
    assert.equal(formatSettlementLine([]), '');
    assert.equal(
        formatSettlementLine([{ kind: 'settlement', inside: true, building_count: 12, distance: 14, direction: 'south', confidence: 0.95, center: { x: 277, z: -733 } }]),
        'settlement: you are inside one (12 buildings; centre 14 blocks south)');
    assert.equal(
        formatSettlementLine([
            { kind: 'settlement', building_count: 5, distance: 90, direction: 'west', confidence: 0.9, center: { x: 0, z: 0 } },
            { kind: 'outpost', building_count: 2, distance: 40, direction: 'north', confidence: 0.6, center: { x: 1, z: 1 } },
        ]),
        'outpost: nearest is 40 blocks north (2 buildings)', 'nearest wins when not inside');
    assert.match(formatSettlementLine([{ kind: 'settlement', building_count: 3, distance: 20, direction: 'east', confidence: 0.35, center: { x: 1, z: 1 } }]), /\(weak signal\)$/);
    assert.equal(formatSettlementLine([{ kind: 'settlement', building_count: 1, distance: 5, direction: 'east', confidence: 0.1, center: { x: 1, z: 1 } }]), '', 'very weak signals are not shown');
    assert.match(formatSettlementLine([{ kind: 'settlement', inside: true, center: { x: 10.4, z: -3.6 } }]), /centre \(10,-4\)/);
});

test('the settlement line sits before the tail of the block, so truncation cannot cut it', () => {
    const block = formatPerception({
        ...BASE,
        settlements_nearby: [{ kind: 'settlement', inside: true, building_count: 12, distance: 14, direction: 'south', confidence: 0.95, center: { x: 277, z: -733 } }],
        composition: { natural: 90, engineered: 1, liquid: 9, top_blocks: [['minecraft:stone', 5]] },
    });
    assert.match(block, /settlement: you are inside one \(12 buildings/);
    assert.ok(block.indexOf('settlement:') < block.indexOf('composition:'));
    assert.doesNotMatch(formatPerception(BASE), /settlement/, 'no settlement data, no line');
});

function serve(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('fetchPerception adds the settlement line, and still injects the block when /settlements fails', async () => {
    const perception = JSON.stringify({ service: 'topography', ...BASE, lod: [], water: { at_center: false, nearest: { distance: 23, direction: 'east' } } });
    let settlementsOk = true;
    const server = await serve((req, res) => {
        if (req.url.startsWith('/perception')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(perception); return; }
        if (req.url.startsWith('/settlements') && settlementsOk) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ settlements: [{ kind: 'settlement', inside: true, building_count: 12, distance: 14, direction: 'south', confidence: 0.95, center: { x: 277, z: -733 } }] }));
            return;
        }
        res.writeHead(500); res.end('{"error":"boom"}');
    });
    const previous = process.env.CARTOGRAPHY_SERVICE_URL;
    process.env.CARTOGRAPHY_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    try {
        const agent = { name: 'Bot', prompter: { profile: {} }, bot: { entity: { position: { x: 281, y: 64, z: -747 } }, game: { dimension: 'overworld' } } };
        clearPerceptionCache();
        const withVillage = await fetchPerception(agent);
        assert.match(withVillage, /settlement: you are inside one \(12 buildings; centre 14 blocks south\)/);
        assert.match(withVillage, /nearest water: east, 23 blocks/);

        settlementsOk = false;
        clearPerceptionCache();
        const without = await fetchPerception(agent);
        assert.match(without, /nearest water: east, 23 blocks/, 'perception survives a failing /settlements');
        assert.doesNotMatch(without, /settlement/);
    } finally {
        if (previous === undefined) delete process.env.CARTOGRAPHY_SERVICE_URL; else process.env.CARTOGRAPHY_SERVICE_URL = previous;
        clearPerceptionCache();
        server.close();
    }
});
