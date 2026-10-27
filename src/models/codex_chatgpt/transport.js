import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS } from './constants.js';
import { abortError, sanitizeCodexError } from './utils.js';

const DEFAULT_FETCH = globalThis.fetch;

export function isResponsesWebSocketOpen(ws) {
    return ws?.readyState === WebSocket.OPEN;
}

export function toWebSocketUrl(endpoint) {
    const url = new URL(endpoint);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    return url.toString();
}

export async function connectCodexResponsesWebSocket(url, headers, { signal, timeoutMs = DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS } = {}) {
    if (signal?.aborted) throw abortError();
    return await new Promise((resolve, reject) => {
        let settled = false;
        let responseHeaders = {};
        const ws = new WebSocket(url, {
            headers,
            perMessageDeflate: true,
            family: 4,
            handshakeTimeout: Math.min(Math.max(timeoutMs, 1000), 30000)
        });

        const cleanup = () => {
            ws.off('open', onOpen);
            ws.off('upgrade', onUpgrade);
            ws.off('unexpected-response', onUnexpectedResponse);
            ws.off('error', onError);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                ws.close();
            } catch {
                // Best-effort cleanup.
            }
            reject(error);
        };
        const onAbort = () => fail(abortError());
        const onUpgrade = response => {
            responseHeaders = normalizeNodeHeaders(response?.headers || {});
        };
        const onOpen = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ ws, headers: responseHeaders });
        };
        const onUnexpectedResponse = (_request, response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const error = new Error(`WebSocket upgrade failed with status=${response.statusCode} ${body.slice(0, 300)}`);
                error.status = response.statusCode;
                fail(error);
            });
            response.on('error', fail);
        };
        const onError = error => fail(error);

        ws.once('open', onOpen);
        ws.once('upgrade', onUpgrade);
        ws.once('unexpected-response', onUnexpectedResponse);
        ws.once('error', onError);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

export async function streamCodexResponsesWebSocket(ws, payload, { signal, idleTimeoutMs = DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS, onClosed } = {}) {
    if (signal?.aborted) throw abortError();
    return await new Promise((resolve, reject) => {
        let settled = false;
        const chunks = [];
        const timeout = setTimeout(() => {
            fail(new Error('idle timeout waiting for Codex Responses WebSocket'));
        }, Math.max(1000, idleTimeoutMs));

        const cleanup = () => {
            clearTimeout(timeout);
            ws.off('message', onMessage);
            ws.off('error', onError);
            ws.off('close', onClose);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(chunks.join(''));
        };
        const onAbort = () => {
            try {
                ws.close();
            } catch {
                // Best-effort cleanup.
            }
            fail(abortError());
        };
        const onError = error => fail(error);
        const onClose = () => {
            onClosed?.();
            fail(new Error('websocket closed before response.completed'));
        };
        const onMessage = data => {
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
            let event = null;
            try {
                event = JSON.parse(text);
            } catch {
                return;
            }
            if (event?.type === 'error') {
                const message = event.error?.message || event.message || text;
                const error = new Error(message);
                error.status = event.status || event.status_code;
                fail(error);
                return;
            }
            chunks.push(`data: ${text}\n\n`);
            if (event?.type === 'response.failed') {
                const error = new Error(event.response?.error?.message || 'Codex Responses WebSocket failed');
                error.status = event.response?.status;
                fail(error);
                return;
            }
            if (event?.type === 'response.completed') {
                finish();
            }
        };

        ws.on('message', onMessage);
        ws.once('error', onError);
        ws.once('close', onClose);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        ws.send(JSON.stringify(payload), error => {
            if (error) fail(error);
        });
    });
}

function normalizeNodeHeaders(headers = {}) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers)) {
        normalized[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return normalized;
}

export async function codexFetch(url, init = {}) {
    if (shouldUseFetch(url)) {
        return await fetch(url, init);
    }
    try {
        return await curlFetch(url, init);
    } catch (curlError) {
        console.warn(`System curl transport failed for Codex HTTP request; retrying with Node fetch: ${sanitizeCodexError(curlError)}`);
        return await fetch(url, init);
    }
}

function shouldUseFetch(url) {
    if (globalThis.fetch !== DEFAULT_FETCH) {
        return true;
    }
    try {
        const { hostname } = new URL(String(url));
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
        return false;
    }
}

async function curlFetch(url, init = {}) {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mindcraft-codex-curl-'));
    const headersPath = path.join(tempDir, 'headers.txt');
    const bodyPath = path.join(tempDir, 'body.bin');
    const requestBodyPath = path.join(tempDir, 'request-body.bin');
    const configPath = path.join(tempDir, 'curl.conf');
    try {
        const method = init.method || (init.body ? 'POST' : 'GET');
        const config = [
            `url = ${curlQuote(String(url))}`,
            `request = ${curlQuote(method)}`,
            `dump-header = ${curlQuote(headersPath)}`,
            `output = ${curlQuote(bodyPath)}`,
            'silent',
            'show-error',
            'location',
            'max-time = 300'
        ];

        for (const [name, value] of headerEntries(init.headers)) {
            config.push(`header = ${curlQuote(`${name}: ${value}`)}`);
        }

        if (init.body !== undefined && init.body !== null) {
            writeFileSync(requestBodyPath, bodyToString(init.body));
            config.push(`data-binary = ${curlQuote(`@${requestBodyPath}`)}`);
        }

        writeFileSync(configPath, `${config.join('\n')}\n`, { mode: 0o600 });
        await runCurl(configPath);
        const headersText = readFileSync(headersPath, 'utf8');
        const body = readFileSync(bodyPath);
        const { status, headers } = parseCurlHeaders(headersText);
        return new Response(body, { status, headers });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function runCurl(configPath) {
    return new Promise((resolve, reject) => {
        const child = spawn('curl', ['--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`curl exited with code ${code}: ${stderr.trim()}`));
            }
        });
    });
}

function headerEntries(headers = {}) {
    if (headers instanceof Headers) {
        return Array.from(headers.entries());
    }
    if (Array.isArray(headers)) {
        return headers;
    }
    return Object.entries(headers || {});
}

function bodyToString(body) {
    if (body instanceof URLSearchParams) {
        return body.toString();
    }
    if (Buffer.isBuffer(body)) {
        return body;
    }
    return String(body);
}

function curlQuote(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseCurlHeaders(headersText) {
    const blocks = headersText.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const block = blocks[blocks.length - 1] || '';
    const lines = block.split(/\r?\n/);
    const statusMatch = lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/);
    const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;
    const headers = new Headers();
    for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx > 0) {
            headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
        }
    }
    return { status, headers };
}
