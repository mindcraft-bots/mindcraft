import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';

const { GPT } = await import('../src/models/gpt.js');
const { strictFormat } = await import('../src/utils/text.js');

// Item 14: stop retention for custom endpoints
const stopCases = [
    { model: 'qwen2.5', keepStop: true },
    { model: 'gemini-2.5', keepStop: true },
    { model: '35b', keepStop: true },
    { model: 'o1', keepStop: false },
    { model: 'o3', keepStop: false },
    { model: 'gpt-5', keepStop: false },
];
for (const c of stopCases) {
    const gpt = new GPT(c.model, 'http://example.invalid', {});
    let captured;
    gpt.openai = {
        chat: {
            completions: {
                create: async (pack) => {
                    captured = pack;
                    return { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] };
                }
            }
        }
    };
    const res = await gpt.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    assert.equal(res, 'ok', `${c.model} request failed`);
    const hasStop = Object.prototype.hasOwnProperty.call(captured, 'stop');
    assert.equal(hasStop, c.keepStop, `${c.model}: stop present=${hasStop}, expected keep=${c.keepStop}`);
    console.log(`stop case ${c.model}: stopPresent=${hasStop} (expected ${c.keepStop}) PASS`);
}

// Item 15: strictFormat must not mutate input
const input = [
    { role: 'system', content: '  hi  ' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'x' },
    { role: 'assistant', content: 'y' },
];
const before = JSON.stringify(input);
const out1 = strictFormat(input);
const after = JSON.stringify(input);
assert.equal(after, before, 'strictFormat mutated its input');
const out2 = strictFormat(input);
assert.equal(JSON.stringify(out2), JSON.stringify(out1), 'repeated formatting differs');
// ensure returned messages are independent copies
out1[0].content = 'MUTATED';
assert.notEqual(input[0].content, 'MUTATED', 'output shares reference with input');

console.log('strictFormat non-mutation + repeatability PASS');
console.log('ALL REGRESSIONS PASS');