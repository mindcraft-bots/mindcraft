import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { getCommandDocs } from '../agent/commands/index.js';
import { getCommandToolDefinitions, getNativeToolDocs } from '../agent/commands/tool_adapter.js';
import { isNativeToolResponse, normalizeThinkingText } from './native_tools.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, selectEmbeddingAPI, createModel } from './_model_map.js';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPT_FILE_KEYS = [
    'conversing',
    'coding',
    'saving_memory',
    'bot_responder',
    'image_analysis',
    'goal_setting'
];


export function stripVolatileConversationPlaceholders(prompt) {
    return String(prompt || '')
        .replaceAll('$SELF_PROMPT', '')
        .replace(/^.*\$MEMORY.*(?:\r?\n)?/gm, '')
        .replace(/^\s*\$STATS\s*(?:\r?\n)?/gm, '')
        .replace(/^\s*\$INVENTORY\s*(?:\r?\n)?/gm, '')
        .replace(/^.*\$COMMAND_DOCS.*(?:\r?\n)?/gm, '')
        .replace(/^.*\$EXAMPLES.*(?:\r?\n)?/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        const defaults_dir = path.join(__dirname, '../../profiles/defaults');
        let default_profile = JSON.parse(readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = path.join(defaults_dir, 'survival.json');
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = path.join(defaults_dir, 'assistant.json');
        } else if (settings.base_profile.includes('creative')) {
            base_fp = path.join(defaults_dir, 'creative.json');
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = path.join(defaults_dir, 'god_mode.json');
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base
        resolvePromptFileRefs(this.profile, defaults_dir);

        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;
        this.last_conversation_response_metadata = {};

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        this.chat_model = createModel(cloneModelProfile(chat_model_profile));
        this.applyModelSessionIdentity(this.chat_model, chat_model_profile, 'conversation');

        const code_model_profile = hasModelSelection(this.profile.code_model)
            ? selectAPI(this.profile.code_model)
            : cloneModelProfile(chat_model_profile);
        this.code_model = createModel(cloneModelProfile(code_model_profile));
        this.applyModelSessionIdentity(this.code_model, code_model_profile, 'coding');

        if (hasModelSelection(this.profile.vision_model)) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
            this.applyModelSessionIdentity(this.vision_model, vision_model_profile, 'vision');
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (hasModelSelection(this.profile.embedding)) {
            try {
                embedding_model_profile = selectEmbeddingAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        if (embedding_model_profile) {
            this.embedding_model = createModel(embedding_model_profile);
        }
        else {
            this.embedding_model = null;
        }

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    getName() {
        return this.profile.name;
    }

    applyModelSessionIdentity(model, modelProfile, purpose) {
        if (typeof model?.setSessionIdentity !== 'function') return;
        model.setSessionIdentity(stableModelSessionIdentity({
            cwd: process.cwd(),
            agent: this.profile.name,
            purpose,
            provider: modelProfile?.provider || model?.provider || null,
            api: modelProfile?.api || model?.constructor?.prefix || null,
            model: modelProfile?.model || model?.model_name || null
        }));
    }

    getInitModes() {
        return this.profile.modes;
    }

    isNativeToolMode() {
        return this.profile.use_native_tools !== false && Boolean(this.chat_model?.supportsNativeToolCalls);
    }

    async initPromptResources() {
        try {
            await this.skill_libary.initSkillLibrary();
            console.log('Prompt resources initialized.');
        } catch (error) {
            console.error('Failed to initialize prompt resources:', error);
            console.error('Stack trace:', error.stack);
            throw error;
        }
    }

    async replaceStrings(prompt, messages, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent) + '\n';
            stats += await getCommand('!entities').perform(this.agent) + '\n';
            stats += await getCommand('!nearbyBlocks').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS')) {
            const docs = this.isNativeToolMode() ? getNativeToolDocs(this.agent) : this.getTextCommandFallbackDocs();
            prompt = prompt.replaceAll('$COMMAND_DOCS', docs);
        }
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = extractCodeTaskContent(messages);

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`;
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`;
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages, options = {}) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;
        this.last_conversation_response_metadata = {};

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return '';
            }

            const prompt = await this.buildConversationSystemPrompt(messages);
            const requestMessages = await this.buildConversationMessages(messages);
            let generation;

            try {
                const tools = this.isNativeToolMode() ? getCommandToolDefinitions(this.agent) : null;
                const requestOptions = {
                    cacheScope: 'conversation',
                    turnStateKey: options.turnStateKey,
                    signal: options.signal
                };
                const requestTraceMetadata = this.chat_model.getCacheTraceMetadata?.(requestOptions) || {
                    cache_scope: requestOptions.cacheScope,
                    turn_state_key: requestOptions.turnStateKey
                };
                this.agent.history.traceLLMRequest('conversation', this.chat_model, prompt, requestMessages, tools, requestTraceMetadata);
                generation = await this.chat_model.sendRequest(requestMessages, prompt, '***', tools, requestOptions);
                this.captureConversationResponseMetadata(this.chat_model, generation);
                const responseTraceMetadata = consumeModelRequestTraceMetadata(this.chat_model, requestOptions, requestTraceMetadata);
                this.agent.history.traceLLMResponse('conversation', this.chat_model, generation, responseTraceMetadata);
                if (isNativeToolResponse(generation)) {
                    await this._saveLog(prompt, requestMessages, JSON.stringify(generation), 'conversation');
                    return generation;
                }
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, requestMessages, generation, 'conversation');

            } catch (error) {
                this.agent.history.traceLLMError('conversation', this.chat_model, error);
                if (isAbortError(error)) {
                    console.warn('Conversation LLM request aborted before completion.');
                    return '';
                }
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            }

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>');
                generation = afterThink;
            }

            return generation;
        }

        return '';
    }

    captureConversationResponseMetadata(model, response) {
        const thinking = normalizeThinkingText(
            response?.thinking ??
            response?.reasoning_content ??
            response?.reasoning ??
            model?.lastThinking ??
            ''
        );
        const metadata = {};
        if (thinking) metadata.thinking = thinking;
        const thinkingBlocks = response?.thinking_blocks || response?.thinkingBlocks || model?.lastThinkingBlocks;
        if (Array.isArray(thinkingBlocks) && thinkingBlocks.length > 0) {
            metadata.thinking_blocks = thinkingBlocks;
        }
        const thinkingKey = response?.thinking_key || response?.reasoning_key || model?.reasoning_key;
        if (thinkingKey) metadata.thinking_key = thinkingKey;
        this.last_conversation_response_metadata = metadata;
        return metadata;
    }

    consumeLastConversationResponseMetadata() {
        const metadata = this.last_conversation_response_metadata || {};
        this.last_conversation_response_metadata = {};
        return metadata;
    }

    async buildConversationSystemPrompt(messages) {
        const stableTemplate = stripVolatileConversationPlaceholders(this.profile.conversing);
        return await this.replaceStrings(stableTemplate, messages);
    }

    async buildConversationMessages(messages) {
        return messages;
    }

    getTextCommandFallbackDocs() {
        const docs = getCommandDocs(this.agent);
        if (this.profile.use_native_tools === false) {
            return docs;
        }
        return '\n*NATIVE TOOL FALLBACK WARNING\nThis model adapter does not advertise native tool calling support, so Mindcraft is temporarily falling back to text !command syntax for AI actions. Prefer a native-tool-capable provider when available. Human users may still type !commands.*\n' + docs;
    }

    async promptCoding(messages, options = {}) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        try {
            await this.checkCooldown();
            let prompt = this.profile.coding;
            prompt = await this.replaceStrings(prompt, messages);

            const requestOptions = { cacheScope: 'coding', transportCacheScope: 'coding', signal: options.signal };
            const requestTraceMetadata = this.code_model.getCacheTraceMetadata?.(requestOptions) || {
                cache_scope: requestOptions.cacheScope,
                transport_cache_scope: requestOptions.transportCacheScope
            };
            this.agent.history.traceLLMRequest('coding', this.code_model, prompt, messages, null, requestTraceMetadata);
            let resp = await this.code_model.sendRequest(messages, prompt, '***', null, requestOptions);
            this.agent.history.traceLLMResponse('coding', this.code_model, resp, consumeModelRequestTraceMetadata(this.code_model, requestOptions, requestTraceMetadata));
            await this._saveLog(prompt, messages, resp, 'coding');
            return resp;
        } finally {
            this.awaiting_coding = false;
        }
    }

    async promptCompactSummary(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, to_summarize);
        const requestOptions = { cacheScope: 'compactSummary', transportCacheScope: 'compactSummary' };
        const requestTraceMetadata = this.chat_model.getCacheTraceMetadata?.(requestOptions) || {
            cache_scope: requestOptions.cacheScope,
            transport_cache_scope: requestOptions.transportCacheScope
        };
        this.agent.history.traceLLMRequest('compactSummary', this.chat_model, prompt, to_summarize, null, requestTraceMetadata);
        let resp = await this.chat_model.sendRequest([], prompt, '***', null, requestOptions);
        this.agent.history.traceLLMResponse('compactSummary', this.chat_model, resp, consumeModelRequestTraceMetadata(this.chat_model, requestOptions, requestTraceMetadata));
        await this._saveLog(prompt, to_summarize, resp, 'compactSummary');
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>');
            resp = afterThink;
        }
        return resp;
    }

    async promptMemSaving(to_summarize) {
        return this.promptCompactSummary(to_summarize);
    }

    async promptShouldRespondToBot(new_message, options = {}) {
        await this.checkCooldown();
        const historyMessages = this.agent.history.getHistory();
        const requestMessages = [
            ...(await this.buildConversationMessages(historyMessages)),
            { role: 'user', content: await this.buildBotResponderUserPrompt(new_message) }
        ];
        const prompt = await this.buildConversationSystemPrompt(historyMessages);
        const requestOptions = { cacheScope: options.cacheScope || 'botResponder', signal: options.signal };
        const tools = this.isNativeToolMode() ? getCommandToolDefinitions(this.agent) : null;
        const traceMetadata = {
            ephemeral: true,
            branch: true,
            incoming_message: new_message,
            ...(this.chat_model.getCacheTraceMetadata?.(requestOptions) || { cache_scope: options.cacheScope || 'botResponder' })
        };
        this.agent.history.traceLLMRequest('botResponder', this.chat_model, prompt, requestMessages, tools, traceMetadata);
        let res = await this.chat_model.sendRequest(requestMessages, prompt, '***', tools, requestOptions);
        const responseTraceMetadata = consumeModelRequestTraceMetadata(this.chat_model, requestOptions, traceMetadata);
        this.agent.history.traceLLMResponse('botResponder', this.chat_model, res, responseTraceMetadata);
        const decision = normalizeBotResponderDecision(res);
        if (decision !== 'respond' && decision !== 'ignore') {
            console.warn(`Invalid botResponder decision for ${this.agent.name}: ${decision}`);
        }
        return decision === 'respond';
    }

    async buildBotResponderUserPrompt(newMessage) {
        const incomingMessage = String(newMessage ?? '');
        const prompt = String(this.profile.bot_responder || '')
            .replaceAll('$INCOMING_MESSAGE', incomingMessage);
        return await this.replaceStrings(prompt, [], []);
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages);
        const requestOptions = { cacheScope: 'vision', transportCacheScope: 'vision' };
        const requestTraceMetadata = this.vision_model.getCacheTraceMetadata?.(requestOptions) || {
            cache_scope: requestOptions.cacheScope,
            transport_cache_scope: requestOptions.transportCacheScope
        };
        this.agent.history.traceLLMRequest('vision', this.vision_model, prompt, messages, null, requestTraceMetadata);
        const res = await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer, requestOptions);
        this.agent.history.traceLLMResponse('vision', this.vision_model, res, consumeModelRequestTraceMetadata(this.vision_model, requestOptions, requestTraceMetadata));
        return res;
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO';
        user_message = await this.replaceStrings(user_message, messages, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        const requestOptions = { cacheScope: 'goalSetting', transportCacheScope: 'goalSetting' };
        const requestTraceMetadata = this.chat_model.getCacheTraceMetadata?.(requestOptions) || {
            cache_scope: requestOptions.cacheScope,
            transport_cache_scope: requestOptions.transportCacheScope
        };
        this.agent.history.traceLLMRequest('goalSetting', this.chat_model, system_message, user_messages, null, requestTraceMetadata);
        let res = await this.chat_model.sendRequest(user_messages, system_message, '***', null, requestOptions);
        this.agent.history.traceLLMResponse('goalSetting', this.chat_model, res, consumeModelRequestTraceMetadata(this.chat_model, requestOptions, requestTraceMetadata));

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}

function resolvePromptFileRefs(profile, defaultBaseDir) {
    for (const key of PROMPT_FILE_KEYS) {
        const value = profile[key];
        const promptPath = getPromptPath(value);
        if (!promptPath) continue;
        profile[key] = readFileSync(resolvePromptPath(promptPath, defaultBaseDir), 'utf8');
    }
}

function getPromptPath(value) {
    if (!value || typeof value !== 'object') return null;
    return value.prompt_file || value.file || value.path || null;
}

function resolvePromptPath(promptPath, defaultBaseDir) {
    if (path.isAbsolute(promptPath)) return promptPath;
    const defaultRelativePath = path.join(defaultBaseDir, promptPath);
    try {
        readFileSync(defaultRelativePath, 'utf8');
        return defaultRelativePath;
    } catch {
        return path.resolve(promptPath);
    }
}

function hasModelSelection(profile) {
    if (typeof profile === 'string' || profile instanceof String) {
        return profile.trim().length > 0;
    }
    if (!profile || typeof profile !== 'object') {
        return false;
    }
    return ['provider', 'api', 'model'].some(key =>
        typeof profile[key] === 'string' && profile[key].trim().length > 0
    );
}

function extractCodeTaskContent(messages) {
    const content = messages?.slice?.().reverse?.().find(msg =>
        msg?.role !== 'system'
        && typeof msg?.content === 'string'
        && (msg.content.includes('!newAction(') || msg.content.startsWith('Code generation task:'))
    )?.content || '';

    const legacyMatch = content.match(/!newAction\((.*?)\)/);
    if (legacyMatch) return legacyMatch[1];

    return content
        .replace(/^Code generation task:\s*/i, '')
        .replace(/\n\nWrite the implementation as a JavaScript code block\.\s*$/i, '')
        .trim();
}

function stableModelSessionIdentity(parts) {
    const text = JSON.stringify(parts || {});
    return `mindcraft-${createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

function cloneModelProfile(profile) {
    return JSON.parse(JSON.stringify(profile || {}));
}

function consumeModelRequestTraceMetadata(model, requestOptions, fallbackMetadata = {}) {
    const requestMetadata = model?.consumeLastRequestTraceMetadata?.(requestOptions);
    const metadata = { ...(fallbackMetadata || {}) };
    if (requestMetadata?.transport_cache) metadata.transport_cache = requestMetadata.transport_cache;
    if (requestMetadata?.token_usage) metadata.token_usage = requestMetadata.token_usage;
    return metadata;
}

export function normalizeBotResponderDecision(response) {
    if (isNativeToolResponse(response)) return 'invalid_tool_call';
    const normalized = String(response ?? '').trim().toLowerCase();
    if (normalized.startsWith('respond')) return 'respond';
    if (normalized.startsWith('ignore')) return 'ignore';
    return normalized ? 'invalid' : 'invalid_empty';
}

function isAbortError(error) {
    return error?.name === 'AbortError' || String(error?.message || error || '').includes('aborted');
}
