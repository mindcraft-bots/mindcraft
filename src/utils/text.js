export function stringifyTurns(turns) {
    let res = '';
    for (let turn of turns) {
        if (turn.role === 'assistant') {
            if (turn.thinking) {
                res += `\nThinking: ${turn.thinking}`;
            }
            if (Array.isArray(turn.native_tool_calls) && turn.native_tool_calls.length > 0) {
                if (turn.content) {
                    res += `\nYour output:\n${turn.content}`;
                }
                for (const call of turn.native_tool_calls) {
                    res += `\nTool call (${call.name}): ${formatToolArgumentsForSummary(call.arguments)}`;
                }
            } else {
                res += `\nYour output:\n${turn.content}`;
            }
        } else if (turn.role === 'tool') {
            res += `\nTool result${turn.name ? ` (${turn.name})` : ''}: ${turn.content}`;
        } else if (turn.role === 'system') {
            res += `\nSystem output: ${turn.content}`;
        } else {
            res += `\nUser input: ${turn.content}`;
        
        }
    }
    return res.trim();
}

function formatToolArgumentsForSummary(args) {
    if (args == null || args === '') return '{}';
    if (typeof args === 'string') {
        try {
            return JSON.stringify(JSON.parse(args));
        } catch {
            return args;
        }
    }
    try {
        return JSON.stringify(args);
    } catch {
        return String(args);
    }
}

export function toSinglePrompt(turns, system=null, stop_seq='***', model_nickname='assistant') {
    let prompt = system ? `${system}${stop_seq}` : '';
    let role = '';
    turns.forEach((message) => {
        role = message.role;
        if (role === 'assistant') role = model_nickname;
        const thinking = message.thinking ? `\nThinking: ${message.thinking}` : '';
        prompt += `${role}: ${thinking}${thinking ? '\n' : ''}${message.content}${stop_seq}`;
    });
    if (role !== model_nickname) // if the last message was from the user/system, add a prompt for the model. otherwise, pretend we are extending the model's own message
        prompt += model_nickname + ": ";
    return prompt;
}

function _getWords(text) {
    return text.replace(/[^a-zA-Z ]/g, '').toLowerCase().split(' ');
}

export function wordOverlapScore(text1, text2) {
    const words1 = _getWords(text1);
    const words2 = _getWords(text2);
    const intersection = words1.filter(word => words2.includes(word));
    return intersection.length / (words1.length + words2.length - intersection.length);
}

// ensures stricter turn order and roles:
// - system messages are treated as user messages and prefixed with SYSTEM:
// - combines repeated messages from users
// - separates repeat assistant messages with filler user messages
export function strictFormat(turns) {
    let prev_role = null;
    let messages = [];
    let filler = {role: 'user', content: '_'};
    for (let original of turns) {
        let msg = { ...original };
        if (typeof msg.content === 'string')  {
            msg.content = msg.content.trim();
        }
        if (msg.role === 'system') {
            msg.role = 'user';
            msg.content = 'SYSTEM: ' + msg.content;
        }
        if (msg.role === prev_role && msg.role === 'assistant') {
            // insert empty user message to separate assistant messages
            messages.push(filler);
            messages.push(msg);
        }
        else if (msg.role === prev_role) {
            // combine new message with previous message instead of adding a new one
            messages[messages.length-1].content += '\n' + msg.content;
        }
        else {
            messages.push(msg);
        }
        prev_role = msg.role;
        
    }
    if (messages.length > 0 && messages[0].role !== 'user') {
        messages.unshift(filler); // anthropic requires user message to start
    }
    if (messages.length === 0) {
        messages.push(filler);
    }
    return messages;
}

export function strictTextFormat(turns) {
    return strictFormat(turns.map(turn => {
        if (turn?.role === 'tool') {
            return {
                role: 'system',
                content: `Tool result${turn.name ? ` (${turn.name})` : ''}: ${turn.content || ''}`
            };
        }
        if (Array.isArray(turn?.native_tool_calls) && turn.native_tool_calls.length > 0) {
            return {
                role: 'assistant',
                content: `${turn.thinking ? `Thinking: ${turn.thinking}\n` : ''}${turn.content || turn.native_tool_calls.map(call => `Used native tool ${call.name}.`).join('\n')}`
            };
        }
        return { ...turn };
    }));
}
