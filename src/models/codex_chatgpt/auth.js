import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';
import open from 'open';
import {
    CODEX_AUTH_KEY,
    CODEX_ISSUER,
    CODEX_OAUTH_CLIENT_ID,
    CODEX_REFRESH_TOKEN_URL,
    DEFAULT_KEYS_PATH,
    DEFAULT_LOGIN_PORT,
    DEFAULT_ORIGINATOR,
    LOGIN_TIMEOUT_MS
} from './constants.js';
import { codexFetch } from './transport.js';
import { codexHttpError, expandHomePath, sanitizeCodexError, sleep, trimTrailingSlash } from './utils.js';

export function hasCodexChatGPTAuth(authPath = DEFAULT_KEYS_PATH) {
    return canReadCodexChatGPTAuth(expandHomePath(authPath));
}

export async function ensureCodexChatGPTAuth({
    authPath,
    keysPath,
    allowLogin = true,
    loginRunner = runCodexBrowserLogin,
    issuer = CODEX_ISSUER,
    clientId = CODEX_OAUTH_CLIENT_ID,
    port = DEFAULT_LOGIN_PORT,
    openBrowser = true,
    forcedChatgptWorkspaceId = null,
    originator = DEFAULT_ORIGINATOR
} = {}) {
    const resolvedAuthPath = expandHomePath(authPath || keysPath || DEFAULT_KEYS_PATH);
    if (canReadCodexChatGPTAuth(resolvedAuthPath)) {
        return readCodexChatGPTAuth(resolvedAuthPath);
    }
    if (allowLogin && (isInteractiveTerminal() || loginRunner !== runCodexBrowserLogin)) {
        const authJson = await loginRunner({ authPath: resolvedAuthPath, keysPath: resolvedAuthPath, issuer, clientId, port, openBrowser, forcedChatgptWorkspaceId, originator });
        if (authJson) {
            writeKeysCodexAuth(resolvedAuthPath, authJson);
        }
        return readCodexChatGPTAuth(resolvedAuthPath);
    }
    throw new Error(`Codex ChatGPT auth is missing in ${resolvedAuthPath}. Start with an interactive terminal and choose the codex profile to login here.`);
}

export function readCodexChatGPTAuth(authPath = DEFAULT_KEYS_PATH) {
    const resolvedAuthPath = expandHomePath(authPath);
    const config = readJsonFile(resolvedAuthPath);
    const authJson = extractCodexAuth(config);
    if (!authJson || typeof authJson !== 'object') {
        throw new Error(`Missing Codex ChatGPT auth in ${resolvedAuthPath}.`);
    }
    return normalizeCodexAuth(authJson, resolvedAuthPath);
}

export async function refreshCodexChatGPTAuth(auth, authPath = auth.authPath || DEFAULT_KEYS_PATH, originator = DEFAULT_ORIGINATOR) {
    if (!auth.refreshToken) {
        throw new Error('Codex ChatGPT auth has no refresh token. Login again from this project.');
    }
    const response = await codexFetch(CODEX_REFRESH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'originator': originator,
            'User-Agent': `${originator}/mindcraft-native-tool`
        },
        body: JSON.stringify({
            client_id: CODEX_OAUTH_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: auth.refreshToken
        })
    });

    if (!response.ok) {
        throw await codexHttpError(response);
    }
    const refreshed = await response.json();
    const next = structuredClone(auth.raw || {});
    next.tokens = next.tokens || {};
    if (refreshed.id_token) next.tokens.id_token = refreshed.id_token;
    if (refreshed.access_token) next.tokens.access_token = refreshed.access_token;
    if (refreshed.refresh_token) next.tokens.refresh_token = refreshed.refresh_token;
    next.last_refresh = new Date().toISOString();
    writeKeysCodexAuth(authPath, next);
    return readCodexChatGPTAuth(authPath);
}

export async function runCodexBrowserLogin({
    authPath,
    keysPath,
    issuer = CODEX_ISSUER,
    clientId = CODEX_OAUTH_CLIENT_ID,
    port = DEFAULT_LOGIN_PORT,
    openBrowser = true,
    forcedChatgptWorkspaceId = null,
    originator = DEFAULT_ORIGINATOR
} = {}) {
    const resolvedAuthPath = expandHomePath(authPath || keysPath || DEFAULT_KEYS_PATH);
    const baseUrl = trimTrailingSlash(issuer);
    const pkce = generatePkce();
    const state = generateState();
    const requestedPort = port === 0 ? 0 : Number.parseInt(port || DEFAULT_LOGIN_PORT, 10);
    const server = await startCallbackServer(requestedPort);
    const redirectUri = `http://localhost:${server.port}/auth/callback`;
    const authUrl = buildAuthorizeUrl({
        issuer: baseUrl,
        clientId,
        redirectUri,
        pkce,
        state,
        forcedChatgptWorkspaceId,
        originator
    });

    try {
        printBrowserLoginPrompt(authUrl, redirectUri);
        if (openBrowser) {
            open(authUrl).catch(err => {
                console.log(`Could not open browser automatically: ${sanitizeCodexError(err)}`);
            });
        }
        const code = await waitForOAuthCallback(server, state);
        const tokens = await exchangeAuthorizationCodeForTokens(baseUrl, clientId, redirectUri, pkce, code);
        const authJson = toCodexAuthJson(tokens);
        writeKeysCodexAuth(resolvedAuthPath, authJson);
        return authJson;
    } finally {
        await closeServer(server.server);
    }
}

// Compatibility helper for explicit tests/dev flows. The default login path intentionally
// uses the local browser callback flow above, matching `codex login` rather than
// `codex login --device-auth`.
export async function runCodexDeviceLogin({ authPath, keysPath, issuer = CODEX_ISSUER, clientId = CODEX_OAUTH_CLIENT_ID } = {}) {
    const resolvedAuthPath = expandHomePath(authPath || keysPath || DEFAULT_KEYS_PATH);
    const baseUrl = trimTrailingSlash(issuer);
    const device = await requestDeviceCode(baseUrl, clientId);
    printDeviceCodePrompt(device.verification_url, device.user_code);
    const code = await pollDeviceAuthorization(baseUrl, device);
    const tokens = await exchangeAuthorizationCodeForTokens(baseUrl, clientId, `${baseUrl}/deviceauth/callback`, { code_verifier: code.code_verifier }, code.authorization_code);
    const authJson = toCodexAuthJson(tokens);
    writeKeysCodexAuth(resolvedAuthPath, authJson);
    return authJson;
}

export function writeKeysCodexAuth(authPath, authJson) {
    const resolvedAuthPath = expandHomePath(authPath);
    const normalized = toCodexAuthJson(authJson);
    const existing = existsSync(resolvedAuthPath) ? readJsonFile(resolvedAuthPath) : {};
    if (looksLikeUnifiedKeysConfig(existing) || Object.prototype.hasOwnProperty.call(existing, CODEX_AUTH_KEY)) {
        const section = getKeysSection(existing, true);
        section[CODEX_AUTH_KEY] = normalized;
        writeFileSync(resolvedAuthPath, `${JSON.stringify(existing, null, 4)}\n`, { mode: 0o600 });
        console.log(`Saved Codex ChatGPT auth to ${resolvedAuthPath} at keys.${CODEX_AUTH_KEY}`);
        return;
    }
    writeFileSync(resolvedAuthPath, `${JSON.stringify(normalized, null, 4)}\n`, { mode: 0o600 });
    console.log(`Saved Codex ChatGPT auth to ${resolvedAuthPath}`);
}

function extractCodexAuth(config) {
    if (config?.tokens?.access_token) {
        return config;
    }
    const section = getKeysSection(config);
    return section?.[CODEX_AUTH_KEY];
}

function looksLikeUnifiedKeysConfig(config) {
    return Boolean(config?.keys || config?.models || config?.embeddings);
}

function getKeysSection(config, create = false) {
    if (config?.keys && typeof config.keys === 'object') {
        return config.keys;
    }
    if (create && (config.models || config.embeddings)) {
        config.keys = {};
        return config.keys;
    }
    return config;
}

async function requestDeviceCode(baseUrl, clientId) {
    const response = await codexFetch(`${baseUrl}/api/accounts/deviceauth/usercode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId })
    });
    if (!response.ok) {
        throw await codexHttpError(response);
    }
    const body = await response.json();
    return {
        verification_url: `${baseUrl}/codex/device`,
        user_code: body.user_code || body.usercode,
        device_auth_id: body.device_auth_id,
        interval: Number.parseInt(body.interval || '5', 10)
    };
}

async function pollDeviceAuthorization(baseUrl, device) {
    const started = Date.now();
    while (Date.now() - started < LOGIN_TIMEOUT_MS) {
        const response = await codexFetch(`${baseUrl}/api/accounts/deviceauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_auth_id: device.device_auth_id,
                user_code: device.user_code
            })
        });
        if (response.ok) {
            return await response.json();
        }
        if (![403, 404].includes(response.status)) {
            throw await codexHttpError(response);
        }
        await sleep(Math.max(1, device.interval) * 1000);
    }
    throw new Error('Codex device login timed out after 15 minutes.');
}

async function exchangeAuthorizationCodeForTokens(baseUrl, clientId, redirectUri, pkce, authorizationCode) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: pkce.code_verifier
    });
    const response = await codexFetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    if (!response.ok) {
        throw await codexHttpError(response);
    }
    return await response.json();
}

export function buildAuthorizeUrl({
    issuer = CODEX_ISSUER,
    clientId = CODEX_OAUTH_CLIENT_ID,
    redirectUri,
    pkce,
    state,
    forcedChatgptWorkspaceId = null,
    originator = DEFAULT_ORIGINATOR
}) {
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
        code_challenge: pkce.code_challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator
    });
    if (forcedChatgptWorkspaceId) {
        query.set('allowed_workspace_id', forcedChatgptWorkspaceId);
    }
    return `${trimTrailingSlash(issuer)}/oauth/authorize?${query.toString()}`;
}

function generatePkce() {
    const codeVerifier = base64Url(randomBytes(64));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    return { code_verifier: codeVerifier, code_challenge: codeChallenge };
}

function generateState() {
    return base64Url(randomBytes(32));
}

function base64Url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

async function startCallbackServer(preferredPort) {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        let settled = false;
        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            err ? reject(err) : resolve(result);
        };
        server.once('error', async err => {
            if (err?.code === 'EADDRINUSE' && preferredPort !== 0) {
                try {
                    await sendCancelRequest(preferredPort);
                    setTimeout(() => {
                        startCallbackServer(preferredPort).then(resolve, reject);
                    }, 200);
                } catch {
                    finish(err);
                }
                return;
            }
            finish(err);
        });
        server.listen(preferredPort || 0, '127.0.0.1', () => {
            const address = server.address();
            finish(null, { server, port: address.port });
        });
    });
}

function sendCancelRequest(port) {
    return new Promise((resolve, reject) => {
        const req = globalThis.fetch(`http://127.0.0.1:${port}/cancel`, { signal: AbortSignal.timeout(2000) });
        req.then(() => resolve(), reject);
    });
}

function waitForOAuthCallback(serverInfo, expectedState) {
    const { server } = serverInfo;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Codex browser login timed out after 15 minutes.'));
        }, LOGIN_TIMEOUT_MS);

        const cleanup = () => {
            clearTimeout(timeout);
            server.removeListener('request', onRequest);
        };

        const finish = (res, status, body, done, headers = {}) => {
            res.writeHead(status, {
                'Content-Type': 'text/html; charset=utf-8',
                'Connection': 'close',
                ...headers
            });
            res.end(body);
            cleanup();
            done();
        };

        const onRequest = (req, res) => {
            const parsed = new URL(req.url || '/', 'http://localhost');
            if (parsed.pathname === '/cancel') {
                finish(res, 200, 'Login cancelled', () => reject(new Error('Codex browser login cancelled.')));
                return;
            }
            if (parsed.pathname !== '/auth/callback') {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
                return;
            }
            const state = parsed.searchParams.get('state');
            if (state !== expectedState) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Connection': 'close' });
                res.end('<h1>Codex login ignored</h1><p>State mismatch. Return to the newest login tab or retry the latest URL.</p>');
                console.log('Ignored Codex browser login callback with mismatched state; still waiting for the current login.');
                return;
            }
            const error = parsed.searchParams.get('error');
            if (error) {
                const description = parsed.searchParams.get('error_description') || error;
                finish(res, 400, `<h1>Codex login failed</h1><p>${escapeHtml(description)}</p>`, () => reject(new Error(`Codex browser login failed: ${description}`)));
                return;
            }
            const code = parsed.searchParams.get('code');
            if (!code) {
                finish(res, 400, '<h1>Codex login failed</h1><p>Missing authorization code.</p>', () => reject(new Error('Codex browser login callback did not include an authorization code.')));
                return;
            }
            finish(res, 200, codexLoginClosePage(), () => resolve(code));
        };

        server.on('request', onRequest);
    });
}

function closeServer(server) {
    return new Promise(resolve => {
        server.close(() => resolve());
    });
}

function canReadCodexChatGPTAuth(authPath) {
    try {
        readCodexChatGPTAuth(authPath);
        return true;
    } catch {
        return false;
    }
}

function normalizeCodexAuth(authJson, keysPath) {
    const tokens = authJson.tokens || {};
    const accessToken = tokens.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new Error(`Codex ChatGPT auth is missing tokens.access_token in ${keysPath}.`);
    }
    return {
        authPath: keysPath,
        raw: authJson,
        accessToken,
        refreshToken: tokens.refresh_token,
        accountId: tokens.account_id || parseJwtPayload(tokens.id_token)?.chatgpt_account_id
    };
}

function toCodexAuthJson(input) {
    const tokens = input.tokens || input;
    const idToken = tokens.id_token;
    const payload = parseJwtPayload(idToken) || {};
    return {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
            id_token: idToken,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            account_id: tokens.account_id || payload.chatgpt_account_id
        },
        last_refresh: input.last_refresh || new Date().toISOString()
    };
}

function parseJwtPayload(jwt) {
    if (typeof jwt !== 'string') return null;
    const part = jwt.split('.')[1];
    if (!part) return null;
    try {
        return JSON.parse(Buffer.from(base64UrlToBase64(part), 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

function base64UrlToBase64(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    return padded + '='.repeat((4 - padded.length % 4) % 4);
}

function readJsonFile(filePath) {
    return JSON.parse(readFileSync(expandHomePath(filePath), 'utf8'));
}

function printBrowserLoginPrompt(authUrl) {
    console.log(`
Login to ChatGPT is required to enable Codex native account capabilities.

Please open this login link in your browser:
${authUrl}

You will be redirected back to Mindcraft after login; waiting for login to complete...
`);
}

function codexLoginClosePage() {
    return '<!doctype html>'
        + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Codex login complete</title>'
        + '<style>'
        + ':root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 10%,#f7fbff 0,#f8fafc 45%,#e8edf3 100%);font-family:"OpenAI Sans",Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;overflow:hidden}'
        + '.card{position:relative;z-index:3;width:min(440px,calc(100vw - 40px));text-align:center;background:rgba(255,255,255,.9);border:1px solid rgba(148,163,184,.32);border-radius:22px;padding:34px 32px;box-shadow:0 22px 70px rgba(15,23,42,.14);backdrop-filter:blur(10px)}'
        + '.mark{width:56px;height:56px;margin:0 auto 18px;border-radius:17px;display:grid;place-items:center;background:#111827;color:white;font-size:29px;box-shadow:0 12px 30px rgba(15,23,42,.18)}h1{font-size:26px;line-height:1.2;margin:0 0 10px;font-weight:650;letter-spacing:-.03em}p{margin:6px 0;color:#475569;font-size:15px;letter-spacing:-.01em}.hint{margin-top:18px;font-size:13px;color:#64748b}'
        + '.confetti{position:fixed;bottom:18px;width:5px;height:9px;border-radius:1.5px;opacity:0;z-index:4;animation:confettiFly 2.7s cubic-bezier(.16,.82,.22,1) both;will-change:transform,opacity;pointer-events:none}.confetti.left{left:38px}.confetti.right{right:38px}@keyframes confettiFly{0%{opacity:0;transform:translate(0,0) rotate(0deg) scale(.7)}6%{opacity:.95}58%{opacity:.9}78%{opacity:.18}100%{opacity:0;transform:translate(var(--x),var(--y)) rotate(var(--r)) scale(.9)}}'
        + '@media (prefers-color-scheme:dark){body{background:radial-gradient(circle at 50% 10%,#172033 0,#0f172a 48%,#020617 100%);color:#f8fafc}.card{background:rgba(15,23,42,.78);border-color:rgba(148,163,184,.22)}.mark{background:#f8fafc;color:#111827}p{color:#cbd5e1}.hint{color:#94a3b8}}'
        + '</style>'
        + '<body><div class="card"><div class="mark">&#10003;</div><h1>Codex login complete</h1><p>Mindcraft is connected to ChatGPT/Codex.</p><p class="hint">You can close this page and return to the terminal.</p></div>'
        + '<script>'
        + '(function(){'
        + 'var colors=["#ef4444","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ec4899"];'
        + 'function piece(side,i){var el=document.createElement("i");el.className="confetti "+side;var dir=side==="left"?1:-1;var spread=(i%12-5.5)*7;var distance=200+Math.random()*240;el.style.background=colors[i%colors.length];el.style.setProperty("--x",(dir*(distance+Math.random()*70))+"px");el.style.setProperty("--y",(-210-Math.random()*260+spread)+"px");el.style.setProperty("--r",(dir*(180+Math.random()*520))+"deg");el.style.animationDelay=(Math.random()*0.28)+"s";el.style.animationDuration=(2.15+Math.random()*0.45)+"s";document.body.appendChild(el);} '
        + 'for(var i=0;i<72;i++){piece("left",i);piece("right",i+72);}'
        + 'function closeTab(){try{window.open("","_self");window.close();}catch(e){}}'
        + 'setTimeout(closeTab,1400);setTimeout(closeTab,2600);'
        + '})();'
        + '</script></body>';
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function printDeviceCodePrompt(verificationUrl, code) {
    console.log(`\nCodex ChatGPT login required for this project.\nOpen this URL and sign in:\n\n  ${verificationUrl}\n\nEnter this one-time code:\n\n  ${code}\n\nWaiting for login to complete...\n`);
}

function isInteractiveTerminal() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
