export function stringifyTurns(turns) {
    let res = '';
    for (let turn of turns) {
        if (turn.role === 'assistant') {
            res += `\nYour output:\n${turn.content}`;
        } else if (turn.role === 'system') {
            res += `\nSystem output: ${turn.content}`;
        } else {
            res += `\nUser input: ${turn.content}`;
        
        }
    }
    return res.trim();
}

export function toSinglePrompt(turns, system=null, stop_seq='***', model_nickname='assistant') {
    let prompt = system ? `${system}${stop_seq}` : '';
    let role = '';
    turns.forEach((message) => {
        role = message.role;
        if (role === 'assistant') role = model_nickname;
        prompt += `${role}: ${message.content}${stop_seq}`;
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
    for (let original of turns) {
        // copy so the caller's message objects are never mutated
        let msg = (original && typeof original === 'object') ? { ...original } : original;
        if (msg && typeof msg.content === 'string') {
            msg.content = msg.content.trim();
        }
        if (msg.role === 'system') {
            msg.role = 'user';
            msg.content = 'SYSTEM: ' + msg.content;
        }
        if (msg.role === prev_role && msg.role === 'assistant') {
            // insert empty user message to separate assistant messages
            messages.push({ role: 'user', content: '_' });
            messages.push(msg);
        }
        else if (msg.role === prev_role) {
            // combine new message with previous message instead of adding a new one
            messages[messages.length - 1].content += '\n' + msg.content;
        }
        else {
            messages.push(msg);
        }
        prev_role = msg.role;
    }
    if (messages.length > 0 && messages[0].role !== 'user') {
        messages.unshift({ role: 'user', content: '_' }); // anthropic requires user message to start
    }
    if (messages.length === 0) {
        messages.push({ role: 'user', content: '_' });
    }
    return messages;
}