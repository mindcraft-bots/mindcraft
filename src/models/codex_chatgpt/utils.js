import path from 'path';

export function expandHomePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return filePath;
    }
    return filePath === '~' || filePath.startsWith('~/')
        ? path.join(process.env.HOME || '', filePath.slice(2))
        : filePath;
}

export function trimTrailingSlash(value) {
    return String(value).replace(/\/+$/, '');
}

export function structuredCloneSafe(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fall through to JSON clone.
        }
    }
    return JSON.parse(JSON.stringify(value));
}

export function stableJson(value) {
    return JSON.stringify(sortJsonKeys(value));
}

function sortJsonKeys(value) {
    if (Array.isArray(value)) return value.map(sortJsonKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((out, key) => {
        out[key] = sortJsonKeys(value[key]);
        return out;
    }, {});
}

export function abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

export function isAbortError(err) {
    return err?.name === 'AbortError' || String(err?.message || err || '').includes('aborted');
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function codexHttpError(response) {
    const body = await response.text().catch(() => '');
    const message = extractErrorMessage(body) || response.statusText || 'Codex ChatGPT request failed';
    const error = new Error(`status=${response.status} ${message}`);
    error.status = response.status;
    return error;
}

function extractErrorMessage(body) {
    try {
        const parsed = JSON.parse(body);
        return parsed?.error?.message || parsed?.message || body;
    } catch {
        return body.slice(0, 300);
    }
}

export function formatFetchError(error) {
    const cause = error?.cause;
    const nestedCodes = Array.isArray(cause?.errors)
        ? cause.errors.map(item => item.code).filter(Boolean).join(',')
        : '';
    return [error?.message || String(error), cause?.code, nestedCodes, cause?.message]
        .filter(Boolean)
        .join(' | ');
}

export function sanitizeCodexError(error) {
    return formatFetchError(error)
        .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED_TOKEN]')
        .replace(/(access_token|refresh_token|id_token)":"[^"]+"/g, '$1":"[REDACTED_TOKEN]"')
        .slice(0, 500);
}
