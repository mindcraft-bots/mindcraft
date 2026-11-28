import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

test('relocated pack1 evidence is complete, hash-bound, and singly rooted', () => {
    const base = 'schematics/tooling/validation/pack1/build_logs';
    const inventory = JSON.parse(readFileSync('schematics/tooling/validation/pack1/build_log_inventory.json', 'utf8'));
    assert.equal(inventory.algorithm, 'sha256');
    assert.equal(inventory.entries.length, 177);
    assert.equal(inventory.missing_historical_references.length, 87);
    assert.equal(existsSync('schematics/tooling/validation/build_logs/pack1'), false);
    assert.equal(new Set(inventory.entries.map(entry => entry.original)).size, 177);
    assert.equal(new Set(inventory.entries.map(entry => entry.destination)).size, 177);
    for (const [lineage, count] of [['pre_relocation', 87], ['pack_organized', 90]]) {
        const entries = inventory.entries.filter(entry => entry.destination.startsWith(`${base}/${lineage}/`));
        assert.equal(entries.length, count);
        assert.deepEqual(entries.map(entry => path.basename(entry.destination)).sort(), readdirSync(`${base}/${lineage}`).sort());
        for (const entry of entries) {
            assert.equal(path.basename(entry.original), path.basename(entry.destination));
            assert.equal(createHash('sha256').update(readFileSync(entry.destination)).digest('hex'), entry.sha256);
        }
    }
});

test('active schematic Markdown build-log links resolve', () => {
    const visit = dir => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, item.name);
            if (item.isDirectory()) visit(file);
            else if (item.isFile() && file.endsWith('.md')) {
                for (const match of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+build_logs\/[^)]*)\)/g)) {
                    assert.equal(existsSync(path.resolve(path.dirname(file), match[1].split('#')[0])), true, `${file}: ${match[1]}`);
                }
            }
        }
    };
    visit('schematics');
});
