import { commandList } from './index.js';
import { parseToolArguments } from '../../models/native_tools.js';

const TYPE_MAP = {
    int: 'integer',
    float: 'number',
    boolean: 'boolean',
    BlockName: 'string',
    ItemName: 'string',
    BlockOrItemName: 'string',
    string: 'string'
};

export function commandNameToToolName(commandName) {
    return commandName.startsWith('!') ? commandName.slice(1) : commandName;
}

export function toolNameToCommandName(toolName) {
    return toolName.startsWith('!') ? toolName : `!${toolName}`;
}

export function commandToToolDefinition(command) {
    const properties = {};
    const required = [];
    for (const [name, param] of Object.entries(command.params || {})) {
        properties[name] = paramToJsonSchema(param);
        if (!param.optional) {
            required.push(name);
        }
    }
    return {
        type: 'function',
        function: {
            name: commandNameToToolName(command.name),
            description: command.description || command.name,
            parameters: {
                type: 'object',
                properties,
                required,
                additionalProperties: false
            }
        }
    };
}

export function getCommandToolDefinitions(agent = null) {
    const commands = getAvailableCommands(agent);
    return commands.map(commandToToolDefinition);
}

export function getNativeToolDocs(agent = null) {
    const commands = getAvailableCommands(agent);
    let docs = '\n*NATIVE TOOL DOCS\n';
    docs += 'You can use native function/tool calls to act in the Minecraft world and query state. Human users may type !commands, but AI responses must not output !command text. Use the provided tools instead.\n';
    for (const command of commands) {
        docs += `${commandNameToToolName(command.name)}: ${command.description}\n`;
        if (command.params) {
            docs += 'Params:\n';
            for (const [name, param] of Object.entries(command.params)) {
                docs += `${name}: (${TYPE_MAP[param.type] || 'string'}) ${param.description || ''}\n`;
            }
        }
    }
    return docs + '*\n';
}

export async function executeCommandToolCall(agent, toolCall, commands = commandList) {
    const name = toolCall.name || toolCall.function?.name;
    if (!name) {
        return { ok: false, name: null, commandName: null, result: 'Tool call missing function name.' };
    }
    const commandName = toolNameToCommandName(name);
    const command = commands.find(candidate => candidate.name === commandName);
    if (!command) {
        return { ok: false, name, commandName, result: `Command ${commandName} does not exist.` };
    }

    let parsedArgs;
    try {
        parsedArgs = parseToolArguments(toolCall.arguments ?? toolCall.function?.arguments);
    } catch (error) {
        return { ok: false, name, commandName, result: error.message };
    }

    const params = Object.entries(command.params || {});
    const args = [];
    for (const [paramName, param] of params) {
        if (!(paramName in parsedArgs)) {
            if (param.optional) {
                args.push(undefined);
                continue;
            }
            return { ok: false, name, commandName, result: `Tool ${name} missing required parameter '${paramName}'.` };
        }
        const coerced = coerceValue(parsedArgs[paramName], param);
        if (coerced.error) {
            return { ok: false, name, commandName, result: `Error: Param '${paramName}' ${coerced.error}` };
        }
        args.push(coerced.value);
    }

    try {
        const result = await command.perform(agent, ...args);
        return { ok: true, name, commandName, args: parsedArgs, result };
    } catch (error) {
        return { ok: false, name, commandName, args: parsedArgs, result: `Command ${commandName} failed: ${error.message}` };
    }
}

function getAvailableCommands(agent) {
    const commands = commandList;
    if (!agent?.blocked_actions) {
        return commands;
    }
    const blocked = new Set(agent.blocked_actions);
    return commands.filter(command => !blocked.has(command.name));
}

function paramToJsonSchema(param) {
    const schema = {
        type: TYPE_MAP[param.type] || 'string',
        description: param.description || ''
    };
    if ((schema.type === 'number' || schema.type === 'integer') && Array.isArray(param.domain)) {
        if (Number.isFinite(param.domain[0])) schema.minimum = param.domain[0];
        if (Number.isFinite(param.domain[1])) schema.maximum = param.domain[1];
    }
    return schema;
}

function coerceValue(value, param) {
    switch (param.type) {
        case 'int': {
            const n = Number.parseInt(value);
            if (Number.isNaN(n)) return { error: `must be an integer.` };
            return checkDomain(n, param);
        }
        case 'float': {
            const n = Number.parseFloat(value);
            if (Number.isNaN(n)) return { error: `must be a number.` };
            return checkDomain(n, param);
        }
        case 'boolean': {
            if (typeof value === 'boolean') return { value };
            if (typeof value === 'string') {
                if (['true', 't', '1', 'on'].includes(value.toLowerCase())) return { value: true };
                if (['false', 'f', '0', 'off'].includes(value.toLowerCase())) return { value: false };
            }
            return { error: `must be a boolean.` };
        }
        case 'BlockName':
        case 'ItemName':
        case 'BlockOrItemName':
        case 'string':
            return { value: String(value) };
        default:
            return { error: `has unknown type ${param.type}.` };
    }
}

function checkDomain(value, param) {
    const domain = param.domain;
    if (Array.isArray(domain)) {
        const min = domain[0];
        const max = domain[1];
        if (Number.isFinite(min) && value < min) return { error: `must be >= ${min}.` };
        if (Number.isFinite(max) && value > max) return { error: `must be <= ${max}.` };
    }
    return { value };
}
