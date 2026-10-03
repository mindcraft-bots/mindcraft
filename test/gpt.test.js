import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { GPT } from '../src/models/gpt.js';

function createGPT(url) {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    try {
        return new GPT('unit-test-model', url);
    } finally {
        if (previousKey === undefined)
            delete process.env.OPENAI_API_KEY;
        else
            process.env.OPENAI_API_KEY = previousKey;
    }
}

test('custom endpoints receive unmodified messages without mutating turns', async () => {
    const gpt = createGPT('http://localhost:8080/v1');
    const turns = [
        {role: 'user', content: ' hello '},
        {role: 'assistant', content: 'world'}
    ];
    const originalTurns = structuredClone(turns);
    let request;

    gpt.openai.chat.completions.create = (pack) => {
        request = structuredClone(pack);
        return Promise.resolve({
            choices: [{
                finish_reason: 'stop',
                message: {content: 'adapter-ok'}
            }]
        });
    };

    const response = await gpt.sendRequest(turns, 'system prompt', '<STOP>');

    assert.equal(response, 'adapter-ok');
    assert.deepEqual(turns, originalTurns);
    assert.equal(request.stop, '<STOP>');
    assert.deepEqual(request.messages, [
        {role: 'user', content: 'SYSTEM: system prompt\nhello'},
        {role: 'assistant', content: 'world'}
    ]);
});

test('Responses API prompt shaping does not mutate turns', async () => {
    const gpt = createGPT();
    const turns = [
        {role: 'user', content: 'hello'},
        {role: 'assistant', content: 'world'}
    ];
    const originalTurns = structuredClone(turns);
    let request;

    gpt.openai.responses.create = (pack) => {
        request = structuredClone(pack);
        return Promise.resolve({output_text: 'responses-ok***ignored'});
    };

    const response = await gpt.sendRequest(turns, 'system prompt');

    assert.equal(response, 'responses-ok');
    assert.deepEqual(turns, originalTurns);
    assert.deepEqual(request.input, [
        {role: 'user', content: 'hello***'},
        {role: 'assistant', content: 'world***'}
    ]);
});
