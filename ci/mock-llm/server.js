import http from 'node:http';
import process from 'node:process';

// The goal contains only a constrained fixture selector, coordinates and facing.
// Never interpret arbitrary prompt text as a command.
export function responseFor(messages) {
    const text = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const matches = [...text.matchAll(/\bCI_BUILD (single|pattern) (-?\d+) (-?\d+) (-?\d+) (north|east|south|west)\b/g)];
    if (!matches.length) throw new Error('No recognized CI_BUILD goal');
    const [, fixture, x, y, z, facing] = matches.at(-1);
    return `!buildSchematic("ci/${fixture}.mc1.21.4.schem", ${x}, ${y}, ${z}, "delicate", null, null, "${facing}")`;
}

export function createResponder() {
    const emittedCommands = new Set();
    return messages => {
        const command = responseFor(messages);
        if (emittedCommands.has(command)) return '';
        emittedCommands.add(command);
        return command;
    };
}

export function createServer() {
    const respond = createResponder();
    return http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); return res.end('ok'); }
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
        req.on('end', () => {
            try {
                const request = JSON.parse(body);
                console.log('mock request:', JSON.stringify(request.messages.map(m => ({ role: m.role, length: typeof m.content === 'string' ? m.content.length : 0, goals: typeof m.content === 'string' ? m.content.match(/CI_BUILD (?:single|pattern) -?\d+ -?\d+ -?\d+ (?:north|east|south|west)/g) : [] }))));
                const content = respond(request.messages);
                console.log('mock response:', content);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 0, model: 'mock', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }));
            } catch (error) {
                console.error('mock rejected request:', error.message);
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: error.message } }));
            }
        });
    });
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) createServer().listen(8080, '0.0.0.0', () => console.log('Mock LLM listening on 8080'));
