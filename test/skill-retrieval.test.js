import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// The deployment-specific root settings file is not required for document discovery.
const loader = `
    export function resolve(specifier, context, nextResolve) {
        if (specifier === '../../../settings.js' && context.parentURL?.endsWith('/src/agent/library/skills.js')) {
            return { url: 'data:text/javascript,export default %7B%7D', shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);
const { SkillLibrary } = await import('../src/agent/library/skill_library.js');
const { getSkillDocs } = await import('../src/agent/library/index.js');
const { Prompter } = await import('../src/models/prompter.js');
const { Ollama } = await import('../src/models/ollama.js');
const { setSettings } = await import('../src/agent/settings.js');

const docs = getSkillDocs();
const target = docs.find(doc => doc.startsWith('skills.craftRecipe\n'));
assert.ok(target);
const originalCwd = process.cwd();
const temp = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-skill-retrieval-'));
process.chdir(temp);
setSettings({ base_profile: 'survival', num_examples: 1, allow_insecure_coding: true });
after(() => {
    process.chdir(originalCwd);
    rmSync(temp, { recursive: true, force: true });
    setSettings({});
});

function profile(embedding) {
    const result = {
        name: 'test-bot', model: 'ollama/test-chat',
        conversation_examples: [[{ role: 'user', content: 'craft recipe' }]],
        coding_examples: [[{ role: 'user', content: 'craft recipe' }]]
    };
    if (embedding !== undefined) result.embedding = embedding;
    return result;
}

async function assertFullCorpus(library) {
    const result = await library.getRelevantSkillDocs('anything', -1);
    for (const doc of docs) assert.ok(result.includes(doc), `missing ${doc.split('\n')[0]}`);
    assert.deepEqual(await library.getAllSkillDocs(), docs);
}

test('explicit none disables all example and skill embedding calls', async () => {
    let calls = 0;
    const original = Ollama.prototype.embed;
    Ollama.prototype.embed = async () => { calls++; throw new Error('unexpected embedding call'); };
    try {
        const prompter = new Prompter({}, profile('none'));
        assert.equal(prompter.embedding_model, null);
        await prompter.initExamples();
        await prompter.convo_examples.getRelevant([{ role: 'user', content: 'craft recipe' }]);
        await prompter.coding_examples.getRelevant([{ role: 'user', content: 'craft recipe' }]);
        assert.ok((await prompter.skill_libary.getRelevantSkillDocs(target, 1)).includes(target));
        await assertFullCorpus(prompter.skill_libary);
        assert.equal(calls, 0);
    } finally {
        Ollama.prototype.embed = original;
    }
});

test('omitted, legacy falsy and unknown selectors retain default provider behavior', () => {
    for (const embedding of [undefined, null, false, '', 'unknown-embedding-selector']) {
        const prompter = new Prompter({}, profile(embedding));
        assert.ok(prompter.embedding_model instanceof Ollama);
        assert.equal(prompter.embedding_model.model_name, undefined);
    }
});

test('explicit supported embedding provider retains its model and URL', () => {
    const prompter = new Prompter({}, profile({ api: 'ollama', model: 'ollama/custom-embed', url: 'http://localhost:12345' }));
    assert.ok(prompter.embedding_model instanceof Ollama);
    assert.equal(prompter.embedding_model.model_name, 'custom-embed');
    assert.equal(prompter.embedding_model.url, 'http://localhost:12345');
    const stringSelector = new Prompter({}, profile('ollama/custom-embed'));
    assert.equal(stringSelector.embedding_model.model_name, 'custom-embed');
});

test('default embedding provider is used for example and skill initialization', async () => {
    let calls = 0;
    const original = Ollama.prototype.embed;
    Ollama.prototype.embed = async () => { calls++; return [1, 0]; };
    try {
        const prompter = new Prompter({}, profile());
        await prompter.initExamples();
        assert.equal(calls, docs.length + 2);
        await prompter.convo_examples.getRelevant([{ role: 'user', content: 'craft recipe' }]);
        await prompter.skill_libary.getRelevantSkillDocs('semantic query', 1);
        assert.equal(calls, docs.length + 4);
    } finally {
        Ollama.prototype.embed = original;
    }
});

for (const scenario of ['disabled', 'all-failed', 'partially-failed', 'missing-vector', 'missing-cache-key']) {
    test(`${scenario} embeddings rank the entire corpus using word overlap`, async () => {
        let calls = 0;
        const model = scenario === 'disabled' ? null : {
            async embed(text) {
                calls++;
                if (scenario === 'all-failed' || (scenario === 'partially-failed' && text.startsWith('skills.craftRecipe'))) {
                    throw new Error('simulated embedding failure');
                }
                if (scenario === 'missing-vector' && text.startsWith('skills.craftRecipe')) return undefined;
                return [1, 0];
            }
        };
        const library = new SkillLibrary({}, model);
        await library.initSkillLibrary();
        if (scenario === 'missing-cache-key') delete library.skill_docs_embeddings[target];
        const callsAfterInit = calls;
        await assertFullCorpus(library);
        const result = await library.getRelevantSkillDocs(target, 1);
        assert.ok(result.includes(target), 'most relevant document must be selected');
        for (const name of library.always_show_skills) assert.ok(result.includes(name));
        assert.equal(calls, callsAfterInit, 'fallback and all-documents retrieval should not embed the query');
    });
}

test('successful embeddings retain cosine ranking and all-documents mode skips the query', async () => {
    let calls = 0;
    const model = { async embed(text) {
        calls++;
        return text === 'semantic query' || text.startsWith('skills.craftRecipe') ? [1, 0] : [0, 1];
    } };
    const library = new SkillLibrary({}, model);
    await library.initSkillLibrary();
    assert.equal(calls, docs.length);
    await assertFullCorpus(library);
    assert.equal(calls, docs.length);
    assert.ok((await library.getRelevantSkillDocs('semantic query', 1)).includes(target));
    assert.equal(calls, docs.length + 1);
});

test('query embedding failure falls back to word overlap', async () => {
    let calls = 0;
    const model = { async embed(text) {
        calls++;
        if (text === target) throw new Error('simulated query failure');
        return [1, 0];
    } };
    const library = new SkillLibrary({}, model);
    await library.initSkillLibrary();
    assert.ok((await library.getRelevantSkillDocs(target, 1)).includes(target));
    assert.ok((await library.getRelevantSkillDocs(target, 1)).includes(target));
    assert.equal(calls, docs.length + 1);
});

test('missing query embedding falls back to word overlap', async () => {
    const model = { async embed(text) { return text === target ? null : [1, 0]; } };
    const library = new SkillLibrary({}, model);
    await library.initSkillLibrary();
    assert.ok((await library.getRelevantSkillDocs(target, 1)).includes(target));
});

test('selection count clamps to corpus size and still includes always-show skills at zero', async () => {
    const library = new SkillLibrary({}, null);
    await library.initSkillLibrary();
    const all = await library.getRelevantSkillDocs(target, docs.length + 10);
    for (const doc of docs) assert.ok(all.includes(doc));
    const none = await library.getRelevantSkillDocs(target, 0);
    for (const name of library.always_show_skills) assert.ok(none.includes(name));
    assert.ok(!none.includes(target));
});
