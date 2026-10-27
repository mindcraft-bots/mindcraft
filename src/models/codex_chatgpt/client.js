import { randomUUID } from 'crypto';
import { createNativeToolResponse, toResponsesInputItems } from '../native_tools.js';
import { setLastTokenUsage } from '../token_usage.js';
import {
    CONTINUITY_BASELINE_INPUT,
    DEFAULT_CODEX_BASE_URL,
    DEFAULT_KEYS_PATH,
    DEFAULT_LOGIN_PORT,
    DEFAULT_ORIGINATOR,
    DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS,
    RESPONSES_WEBSOCKET_BETA_HEADER_VALUE
} from './constants.js';
import { ensureCodexChatGPTAuth, refreshCodexChatGPTAuth } from './auth.js';
import {
    buildCodexInclude,
    buildCodexReasoning,
    buildScopedPromptCacheKey,
    codexRequestSignature,
    expandContinuityRequestBody,
    getIncrementalResponsesInput,
    isChatGptCodexUrl,
    normalizeResponsesItemsForContinuity,
    parseCodexResponsesSse,
    synthesizeCodexOutputItems,
    toCodexResponsesTools,
    toResponseCreateWebSocketRequest
} from './protocol.js';
import {
    codexFetch,
    connectCodexResponsesWebSocket,
    isResponsesWebSocketOpen,
    streamCodexResponsesWebSocket,
    toWebSocketUrl
} from './transport.js';
import {
    codexHttpError,
    expandHomePath,
    isAbortError,
    sanitizeCodexError,
    structuredCloneSafe,
    trimTrailingSlash
} from './utils.js';

export class CodexChatGPT {
    static prefix = 'codex';

    constructor(model_name, url, params = {}) {
        this.model_name = model_name;
        this.url = trimTrailingSlash(url || params?.baseUrl || params?.base_url || DEFAULT_CODEX_BASE_URL);
        this.params = { ...(params || {}) };
        delete this.params.baseUrl;
        delete this.params.base_url;
        this.provider = 'codex-chatgpt';
        this.default_model = 'gpt-5.5';
        this.supportsNativeToolCalls = true;
        this.authPath = expandHomePath(
            this.params.authPath ||
            this.params.auth_path ||
            this.params.codexAuthPath ||
            this.params.codex_auth_path ||
            this.params.keysPath ||
            this.params.keys_path ||
            DEFAULT_KEYS_PATH
        );
        this.keysPath = this.authPath;
        this.allowLogin = this.params.allowLogin ?? this.params.allow_login ?? true;
        this.loginRunner = this.params.loginRunner;
        this.issuer = this.params.issuer;
        this.clientId = this.params.clientId || this.params.client_id;
        this.loginPort = Number.parseInt(this.params.loginPort || this.params.login_port || DEFAULT_LOGIN_PORT, 10);
        this.openBrowser = this.params.openBrowser ?? this.params.open_browser ?? true;
        this.forcedChatgptWorkspaceId = this.params.forcedChatgptWorkspaceId || this.params.forced_chatgpt_workspace_id;
        delete this.params.keysPath;
        delete this.params.keys_path;
        delete this.params.authPath;
        delete this.params.auth_path;
        delete this.params.codexAuthPath;
        delete this.params.codex_auth_path;
        delete this.params.allowLogin;
        delete this.params.allow_login;
        delete this.params.loginRunner;
        delete this.params.issuer;
        delete this.params.clientId;
        delete this.params.client_id;
        delete this.params.loginPort;
        delete this.params.login_port;
        delete this.params.openBrowser;
        delete this.params.open_browser;
        delete this.params.forcedChatgptWorkspaceId;
        delete this.params.forced_chatgpt_workspace_id;
        this.sessionIdWasExplicit = Boolean(this.params.sessionId || this.params.session_id);
        this.sessionId = this.params.sessionId || this.params.session_id || randomUUID();
        delete this.params.sessionId;
        delete this.params.session_id;
        this.originator = this.params.originator || process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || DEFAULT_ORIGINATOR;
        delete this.params.originator;
        const transport = String(this.params.transport || this.params.codexTransport || this.params.codex_transport || '').toLowerCase();
        const webSocketParam = this.params.responsesWebSocket ?? this.params.responses_websocket ?? this.params.useResponsesWebSocket ?? this.params.use_responses_websocket;
        this.useResponsesWebSocket = webSocketParam ?? (transport ? transport === 'websocket' || transport === 'ws' : isChatGptCodexUrl(this.url));
        this.responsesWebSocketDisabled = transport === 'http' || transport === 'https';
        this.responsesWebSocket = null;
        this.responsesWebSocketHeaders = null;
        this.responsesWebSocketQueue = Promise.resolve();
        this.responsesWebSocketIdleTimeoutMs = Number.parseInt(this.params.responsesWebSocketIdleTimeoutMs || this.params.responses_websocket_idle_timeout_ms || DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS, 10);
        delete this.params.transport;
        delete this.params.codexTransport;
        delete this.params.codex_transport;
        delete this.params.responsesWebSocket;
        delete this.params.responses_websocket;
        delete this.params.useResponsesWebSocket;
        delete this.params.use_responses_websocket;
        delete this.params.responsesWebSocketIdleTimeoutMs;
        delete this.params.responses_websocket_idle_timeout_ms;
        this.enablePreviousResponseId = Boolean(this.params.enablePreviousResponseId || this.params.enable_previous_response_id);
        delete this.params.enablePreviousResponseId;
        delete this.params.enable_previous_response_id;
        this.turnStateByKey = new Map();
        this.responseContinuityByKey = new Map();
        this.requestStateByOptions = new WeakMap();
        this.lastCompletedRequestState = null;
        this.lastRequestCacheTrace = null;
    }

    setSessionIdentity(identity) {
        if (this.sessionIdWasExplicit) return;
        const value = String(identity || '').trim();
        if (value) this.sessionId = value;
    }

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null, options = {}) {
        const requestState = this.beginRequestState(options);
        this.lastTokenUsage = null;
        this.lastThinking = '';
        const model = this.model_name || this.default_model;
        const hasTools = Array.isArray(tools) && tools.length > 0;
        const body = this.buildRequestBody(model, turns, systemMessage, tools, options);
        const endpoint = `${this.url}/responses`;

        console.log(hasTools
            ? `Awaiting Codex ChatGPT native-login response with tool calling (${tools.length} tools) from model ${model}`
            : `Awaiting Codex ChatGPT native-login response from model ${model}`);

        try {
            let auth = await ensureCodexChatGPTAuth({
                authPath: this.authPath,
                allowLogin: this.allowLogin,
                loginRunner: this.loginRunner,
                issuer: this.issuer,
                clientId: this.clientId,
                port: this.loginPort,
                openBrowser: this.openBrowser,
                forcedChatgptWorkspaceId: this.forcedChatgptWorkspaceId,
                originator: this.originator
            });
            let response = await this.fetchResponses(endpoint, body, auth, options);
            if (response.status === 401 && auth.refreshToken) {
                auth = await refreshCodexChatGPTAuth(auth, this.authPath, this.originator);
                response = await this.fetchResponses(endpoint, body, auth, options);
            }
            if (!response.ok) {
                throw await codexHttpError(response);
            }
            this.rememberTurnState(options, response);

            const parsed = await parseCodexResponsesSse(await response.text());
            this.rememberResponseContinuity(response.codexSentOptions || options, response.codexSentBody || body, parsed);
            console.log('Received.');
            requestState.tokenUsage = setLastTokenUsage(this, parsed.usage);
            requestState.thinking = parsed.thinking || '';
            this.lastThinking = requestState.thinking;
            this.lastCompletedRequestState = requestState;
            if (parsed.toolCalls.length > 0) {
                return createNativeToolResponse(parsed.toolCalls, this.provider, { thinking: this.lastThinking });
            }
            let text = parsed.text;
            if (stop_seq && text.includes(stop_seq)) {
                text = text.slice(0, text.indexOf(stop_seq));
            }
            return text || 'No response received.';
        } catch (err) {
            if (isAbortError(err)) {
                console.log('Codex ChatGPT request aborted.');
                throw err;
            }
            console.log(sanitizeCodexError(err));
            return 'My brain disconnected, try again.';
        }
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer, options = {}) {
        const imageMessages = [...(turns || [])];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'input_text', text: '<image>' },
                { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` },
                { type: 'input_text', text: `</image>\n${systemMessage || 'Describe the image.'}` }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage, '***', null, options);
    }

    buildRequestBody(model, turns, systemMessage, tools=null, options = {}) {
        const promptCacheKey = this.getTransportSessionId(options);
        const reasoning = buildCodexReasoning(this.params.reasoning);
        const include = buildCodexInclude(this.params.include, reasoning);
        const body = {
            model,
            instructions: systemMessage || '',
            input: toResponsesInputItems(turns || []),
            tools: toCodexResponsesTools(tools || []),
            parallel_tool_calls: this.params.parallel_tool_calls ?? true,
            reasoning,
            store: false,
            stream: true,
            include,
            prompt_cache_key: promptCacheKey
        };

        for (const [key, value] of Object.entries(this.params)) {
            if (!['tool_choice', 'toolChoice', 'apiKeyName', 'api_key_name', 'defaultModel', 'default_model', 'parallel_tool_calls', 'reasoning', 'include'].includes(key)) {
                body[key] = value;
            }
        }
        this.applyPreviousResponseContinuity(options, body);
        return body;
    }

    getCacheTraceMetadata(options = {}) {
        const scopedSessionId = this.getTransportSessionId(options);
        const responseContinuityKey = this.getResponseContinuityKey(options);
        const responseContinuityEntries = responseContinuityKey
            ? this.responseContinuityByKey.get(responseContinuityKey)
            : null;
        return {
            cache_scope: options?.cacheScope || null,
            transport_cache_scope: this.getTransportCacheScope(options) || null,
            turn_state_key: options?.turnStateKey || null,
            transport_cache: {
                protocol: 'openai-codex-responses',
                prompt_cache_key: scopedSessionId,
                session_id: scopedSessionId,
                turn_state_present: Boolean(this.getTurnState(options)),
                previous_response_id_available: Boolean(responseContinuityEntries?.some(entry => entry.responseId))
            }
        };
    }

    consumeLastRequestTraceMetadata(options = {}) {
        const state = this.consumeRequestState(options);
        return {
            transport_cache: state?.cacheTrace || null,
            token_usage: state?.tokenUsage || null,
            thinking: state?.thinking || ''
        };
    }

    consumeLastRequestCacheTrace(options = {}) {
        return this.consumeLastRequestTraceMetadata(options).transport_cache || null;
    }

    async fetchResponses(endpoint, body, auth, options = {}) {
        this.lastSentResponsesBody = body;
        this.lastSentResponsesOptions = options;
        if (this.useResponsesWebSocket && !this.responsesWebSocketDisabled) {
            try {
                return await this.enqueueResponsesWebSocketRequest(() => this.fetchResponsesWebSocket(endpoint, body, auth, options));
            } catch (err) {
                if (isAbortError(err)) throw err;
                this.closeResponsesWebSocket();
                this.responsesWebSocketDisabled = true;
                console.log(`Codex Responses WebSocket failed; falling back to HTTP. ${sanitizeCodexError(err)}`);
            }
        }
        const httpBody = expandContinuityRequestBody(body);
        const requestState = this.getRequestState(options);
        if (httpBody !== body && requestState.cacheTrace?.incremental_reuse) {
            requestState.cacheTrace = {
                ...requestState.cacheTrace,
                previous_response_id: null,
                incremental_input_items: null,
                full_input_items: Array.isArray(httpBody.input) ? httpBody.input.length : requestState.cacheTrace.full_input_items,
                incremental_reuse: false,
                incremental_reuse_reason: 'http_previous_response_unsupported'
            };
            this.lastRequestCacheTrace = requestState.cacheTrace;
        }
        this.lastSentResponsesBody = httpBody;
        this.lastSentResponsesOptions = options;
        const response = await codexFetch(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(auth, options),
            body: JSON.stringify(httpBody),
            signal: options?.signal
        });
        return attachSentResponsesMetadata(response, httpBody, options);
    }

    async enqueueResponsesWebSocketRequest(task) {
        const previous = this.responsesWebSocketQueue.catch(() => {});
        let release;
        this.responsesWebSocketQueue = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            return await task();
        } finally {
            release?.();
        }
    }

    async fetchResponsesWebSocket(endpoint, body, auth, options = {}) {
        const wsOptions = {
            ...(options || {}),
            transportSupportsPreviousResponseId: true,
            responseContinuityLatestOnly: true
        };
        const wsBody = structuredCloneSafe(expandContinuityRequestBody(body));
        this.applyPreviousResponseContinuity(wsOptions, wsBody);
        this.lastSentResponsesBody = wsBody;
        this.lastSentResponsesOptions = wsOptions;
        const ws = await this.ensureResponsesWebSocket(endpoint, auth, options);
        const responseText = await streamCodexResponsesWebSocket(ws, toResponseCreateWebSocketRequest(wsBody), {
            signal: options?.signal,
            idleTimeoutMs: this.responsesWebSocketIdleTimeoutMs,
            onClosed: () => {
                this.responsesWebSocket = null;
                this.responsesWebSocketHeaders = null;
            }
        });
        return attachSentResponsesMetadata(new Response(responseText, {
            status: 200,
            headers: this.responsesWebSocketHeaders || {}
        }), wsBody, wsOptions);
    }

    async ensureResponsesWebSocket(endpoint, auth, options = {}) {
        if (isResponsesWebSocketOpen(this.responsesWebSocket)) {
            return this.responsesWebSocket;
        }
        this.closeResponsesWebSocket();
        const headers = this.buildWebSocketHeaders(auth, options);
        const { ws, headers: responseHeaders } = await connectCodexResponsesWebSocket(toWebSocketUrl(endpoint), headers, {
            signal: options?.signal,
            timeoutMs: this.responsesWebSocketIdleTimeoutMs
        });
        this.responsesWebSocket = ws;
        this.responsesWebSocketHeaders = responseHeaders;
        ws.once('close', () => {
            if (this.responsesWebSocket === ws) {
                this.responsesWebSocket = null;
                this.responsesWebSocketHeaders = null;
            }
        });
        return ws;
    }

    closeResponsesWebSocket() {
        if (this.responsesWebSocket) {
            try {
                this.responsesWebSocket.close();
            } catch {
                // Best-effort cleanup.
            }
        }
        this.responsesWebSocket = null;
        this.responsesWebSocketHeaders = null;
    }

    buildWebSocketHeaders(auth, options = {}) {
        const headers = { ...this.buildHeaders(auth, options) };
        delete headers['Content-Type'];
        headers['OpenAI-Beta'] = RESPONSES_WEBSOCKET_BETA_HEADER_VALUE;
        return headers;
    }

    buildHeaders(auth, options = {}) {
        const scopedSessionId = this.getTransportSessionId(options);
        const headers = {
            'Authorization': `Bearer ${auth.accessToken}`,
            'ChatGPT-Account-ID': auth.accountId,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'originator': this.originator,
            'session_id': scopedSessionId,
            'x-client-request-id': scopedSessionId,
            'User-Agent': `${this.originator}/mindcraft-native-tool`
        };
        if (!auth.accountId) {
            delete headers['ChatGPT-Account-ID'];
        }
        const turnState = this.getTurnState(options);
        if (turnState) {
            headers['x-codex-turn-state'] = turnState;
        }
        return headers;
    }

    getTurnState(options = {}) {
        const key = this.getTurnStateKey(options);
        return key ? this.turnStateByKey.get(key) : null;
    }

    rememberTurnState(options = {}, response) {
        const key = this.getTurnStateKey(options);
        const value = response?.headers?.get?.('x-codex-turn-state');
        if (!key || !value) return;
        this.turnStateByKey.set(key, value);
        if (this.turnStateByKey.size > 64) {
            const oldestKey = this.turnStateByKey.keys().next().value;
            this.turnStateByKey.delete(oldestKey);
        }
    }

    getTurnStateKey(options = {}) {
        // Match Codex CLI's turn-scoped sticky-routing contract. The backend may
        // return x-codex-turn-state during a ReAct turn; replay it only for
        // follow-up requests in that same turn. Leaking it into the next inbound
        // bot/user message can route an otherwise cacheable prompt to the wrong
        // backend state and cause full prompt-cache misses.
        return this.getTurnScopedContinuityKey(options);
    }

    getResponseContinuityKey(options = {}) {
        // The ChatGPT Codex HTTP endpoint rejects previous_response_id; Codex
        // CLI uses that field only on its websocket transport. Keep the
        // branch-aware continuity machinery behind an explicit transport opt-in
        // so the default HTTP path relies on prompt_cache_key and never 400s.
        if (!this.enablePreviousResponseId && !options?.transportSupportsPreviousResponseId) return null;
        return this.getTransportSessionId(options);
    }

    getTurnScopedContinuityKey(options = {}) {
        const turnStateKey = String(options?.turnStateKey || '').trim();
        if (!turnStateKey) return null;
        const scopedSessionId = this.getTransportSessionId(options);
        return buildScopedPromptCacheKey(scopedSessionId, `turn:${turnStateKey}`);
    }

    applyPreviousResponseContinuity(options = {}, body) {
        const key = this.getResponseContinuityKey(options);
        const previousEntries = key ? this.responseContinuityByKey.get(key) : null;
        const requestState = this.getRequestState(options);
        const baseTrace = {
            protocol: 'openai-codex-responses',
            prompt_cache_key: body.prompt_cache_key,
            session_id: this.getTransportSessionId(options),
            turn_state_present: Boolean(this.getTurnState(options)),
            previous_response_id: null,
            incremental_input_items: null,
            full_input_items: Array.isArray(body.input) ? body.input.length : 0,
            incremental_reuse: false,
            incremental_reuse_reason: 'no_previous_response'
        };

        if (!previousEntries?.length) {
            requestState.cacheTrace = baseTrace;
            this.lastRequestCacheTrace = baseTrace;
            return;
        }

        const requestSignature = codexRequestSignature(body);
        const candidateEntries = options?.responseContinuityLatestOnly
            ? previousEntries.slice(0, 1)
            : previousEntries;
        let sawMatchingSignature = false;
        let bestMatch = null;
        for (const entry of candidateEntries) {
            if (requestSignature !== entry.requestSignature) continue;
            sawMatchingSignature = true;
            const delta = getIncrementalResponsesInput(body.input, entry.baselineInput);
            if (!delta) continue;
            if (!bestMatch || entry.baselineInput.length > bestMatch.entry.baselineInput.length) {
                bestMatch = { entry, delta };
            }
        }

        if (!sawMatchingSignature) {
            requestState.cacheTrace = {
                ...baseTrace,
                incremental_reuse_reason: 'non_input_fields_changed'
            };
            this.lastRequestCacheTrace = requestState.cacheTrace;
            return;
        }

        if (!bestMatch) {
            requestState.cacheTrace = {
                ...baseTrace,
                incremental_reuse_reason: 'input_not_previous_prefix'
            };
            this.lastRequestCacheTrace = requestState.cacheTrace;
            return;
        }

        body.previous_response_id = bestMatch.entry.responseId;
        body.input = bestMatch.delta;
        body[CONTINUITY_BASELINE_INPUT] = bestMatch.entry.baselineInput;
        requestState.cacheTrace = {
            ...baseTrace,
            previous_response_id: bestMatch.entry.responseId,
            incremental_input_items: bestMatch.delta.length,
            incremental_reuse: true,
            incremental_reuse_reason: 'prefix_reused'
        };
        this.lastRequestCacheTrace = requestState.cacheTrace;
    }

    rememberResponseContinuity(options = {}, body, parsed = {}) {
        const responseId = parsed.responseId;
        if (!responseId) return;
        const key = this.getResponseContinuityKey(options);
        if (!key) return;
        const sentInput = body.previous_response_id
            ? [
                ...(body[CONTINUITY_BASELINE_INPUT] || []),
                ...(body.input || [])
            ]
            : (body.input || []);
        const outputItems = synthesizeCodexOutputItems(parsed);
        const entries = this.responseContinuityByKey.get(key) || [];
        entries.unshift({
            responseId,
            requestSignature: codexRequestSignature(body),
            baselineInput: normalizeResponsesItemsForContinuity([
                ...sentInput,
                ...outputItems
            ])
        });
        entries.length = Math.min(entries.length, 32);
        this.responseContinuityByKey.set(key, entries);
        if (this.responseContinuityByKey.size > 64) {
            const oldestKey = this.responseContinuityByKey.keys().next().value;
            this.responseContinuityByKey.delete(oldestKey);
        }
    }

    getTransportCacheScope(options = {}) {
        return String(options?.transportCacheScope ?? options?.transport_cache_scope ?? '').trim();
    }

    getTransportSessionId(options = {}) {
        return buildScopedPromptCacheKey(this.sessionId, this.getTransportCacheScope(options));
    }

    beginRequestState(options = {}) {
        const state = { cacheTrace: null, tokenUsage: null, thinking: '' };
        if (options && typeof options === 'object') {
            this.requestStateByOptions.set(options, state);
        }
        return state;
    }

    getRequestState(options = {}) {
        if (options && typeof options === 'object') {
            const existing = this.requestStateByOptions.get(options);
            if (existing) return existing;
            const state = { cacheTrace: null, tokenUsage: null, thinking: '' };
            this.requestStateByOptions.set(options, state);
            return state;
        }
        if (!this.lastCompletedRequestState) {
            this.lastCompletedRequestState = { cacheTrace: this.lastRequestCacheTrace, tokenUsage: this.lastTokenUsage, thinking: this.lastThinking || '' };
        }
        return this.lastCompletedRequestState;
    }

    consumeRequestState(options = {}) {
        if (options && typeof options === 'object') {
            const state = this.requestStateByOptions.get(options);
            if (state) {
                this.requestStateByOptions.delete(options);
                if (this.lastCompletedRequestState === state) this.lastCompletedRequestState = null;
                return state;
            }
        }
        const state = this.lastCompletedRequestState || { cacheTrace: this.lastRequestCacheTrace, tokenUsage: this.lastTokenUsage, thinking: this.lastThinking || '' };
        this.lastCompletedRequestState = null;
        this.lastRequestCacheTrace = null;
        return state;
    }

    async embed() {
        throw new Error('Codex ChatGPT native-login adapter does not support embeddings. Configure an embedding provider separately.');
    }
}

export {
    buildAuthorizeUrl,
    ensureCodexChatGPTAuth,
    hasCodexChatGPTAuth,
    readCodexChatGPTAuth,
    refreshCodexChatGPTAuth,
    runCodexBrowserLogin,
    runCodexDeviceLogin,
    writeKeysCodexAuth
} from './auth.js';

export {
    buildScopedPromptCacheKey,
    parseCodexResponsesSse,
    toCodexResponseItem,
    toCodexResponsesTools
} from './protocol.js';

function attachSentResponsesMetadata(response, body, options = {}) {
    response.codexSentBody = body;
    response.codexSentOptions = options;
    return response;
}
