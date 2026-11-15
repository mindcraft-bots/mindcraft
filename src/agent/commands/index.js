import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import { parseOptionalCoordinate } from '../../utils/schematic/paths.js';

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

const numericArgument = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?![eE][+-]?\\d)';
const coordinateArgument = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const argumentPattern = `(?:${numericArgument}|true|false|null|"[^"]*")`;
const coordinatePattern = `(?:${coordinateArgument}|true|false|null|"[^"]*")`;
const commandRegex = new RegExp(`!(\\w+)(?:\\((${argumentPattern}(?:\\s*,\\s*${argumentPattern})*)\\))?`);
const buildSchematicRegex = new RegExp(`!(buildSchematic)(?:\\((${coordinatePattern}(?:\\s*,\\s*${coordinatePattern})*)\\))?`);
const argRegex = new RegExp(`${numericArgument}|true|false|null|"[^"]*"`, 'g');
const coordinateArgRegex = new RegExp(`${coordinateArgument}|true|false|null|"[^"]*"`, 'g');

function findCommandMatch(message) {
    const match = message.match(commandRegex);
    if (match?.[1] === 'buildSchematic')
        return message.match(buildSchematicRegex) ?? match;
    return match;
}

export function containsCommand(message) {
    const commandMatch = findCommandMatch(message);
    if (commandMatch)
        return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    const commandMatch = findCommandMatch(message);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(commandName === '!buildSchematic' ? coordinateArgRegex : argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    
    const firstOptionalParam = params.findIndex(param => param.optional === true);
    const requiredParams = firstOptionalParam === -1 ? params.length : firstOptionalParam;
    if (params.some((param, index) => param.optional && params.slice(index + 1).some(later => !later.optional)))
        return `Command ${command.name} has invalid optional parameter metadata.`;
    if (args.length < requiredParams || args.length > params.length)
        return `Command ${command.name} was given ${args.length} args, but requires ${requiredParams}${requiredParams === params.length ? '' : ` to ${params.length}`} args.`;

    const suppliedOptionalGroups = new Map();
    for (let i = requiredParams; i < args.length; i++) {
        const group = params[i].optionalGroup;
        if (group) suppliedOptionalGroups.set(group, (suppliedOptionalGroups.get(group) ?? 0) + 1);
    }
    for (const [group, supplied] of suppliedOptionalGroups) {
        const groupSize = params.filter(param => param.optionalGroup === group).length;
        if (supplied !== groupSize)
            return `Error: Optional parameters '${group}' must be provided together.`;
    }

    while (args.length < params.length) {
        const nextParam = params[args.length];
        args.push(Object.hasOwn(nextParam, 'default') ? nextParam.default : null);
    }

    
    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = typeof args[i] === 'string' ? args[i].trim() : args[i];
        if (typeof arg === 'string' && ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'")))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'coordinate':
                try {
                    arg = parseOptionalCoordinate(arg);
                } catch (error) {
                    return `Error: Param '${paramNames[i]}' must be a finite number or null.`;
                }
                break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if((arg === null && param.type !== 'coordinate') || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    const commandMatch = findCommandMatch(message);
    if (commandMatch) {
        return message.substring(0, commandMatch.index + commandMatch[0].length);
    }
    return message;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

export async function executeCommand(agent, message) {
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        if (numArgs !== numParams(command))
            return `Command ${command.name} was given ${numArgs} args, but requires ${numParams(command)} args.`;
        else {
            const result = await command.perform(agent, ...parsed.args);
            return result;
        }
    }
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'coordinate':       'number or null',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings. Only use one command in each response, trailing commands and comments will be ignored.\n`;
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name)) {
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                const optional = command.params[param].optional ? ' (optional)' : '';
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type})${optional} ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}
