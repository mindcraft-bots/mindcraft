// Authentication evidence must be observed during connection setup, not supplied
// by a chat/display label or a caller of Agent.handleMessage.
const connections = new WeakMap();

function uuid(value) {
    if (typeof value !== 'string' || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(value)) return null;
    const normalized = value.replaceAll('-', '').toLowerCase();
    return /^0+$/.test(normalized) ? null : normalized;
}

export function trackAuthenticatedChatConnection(bot, auth) {
    const client = bot._client;
    if (!client || connections.has(client)) return;
    const state = { authenticated: false, requested: false, profile: null };
    connections.set(client, state);
    client.once('encryption_begin', packet => {
        // Older protocols do not explicitly attest that authentication is required.
        state.requested = packet?.shouldAuthenticate === true;
    });
    client.once('login', packet => {
        const profile = client.session?.selectedProfile;
        state.profile = uuid(profile?.id);
        state.authenticated = auth === 'microsoft' && state.requested && packet?.enforcesSecureChat === true
            && !!client.cipher && !!client.decipher && !!state.profile
            && state.profile === uuid(client.uuid) && profile.name === client.username;
    });
    const revoke = () => { state.authenticated = false; };
    client.once('end', revoke);
    client.once('error', revoke);
}

// The connected server is trusted to enforce online identities and secure chat.
// Local account settings, an encrypted socket, or a signed message alone do not
// establish that deployment contract. Missing/older handshake evidence denies.
export function hasAuthenticatedServerConnection(bot, expectedClient = bot._client) {
    const client = bot._client;
    const state = client && connections.get(client);
    return Boolean(state?.authenticated && client === expectedClient
        && client.state === 'play' && client.socket?.destroyed === false
        && client.cipher && client.decipher
        && state.profile === uuid(client.uuid)
        && state.profile === uuid(client.session?.selectedProfile?.id)
        && client.serverFeatures?.enforcesSecureChat === true);
}

export function authenticatedPlayerName(bot, sender, expectedClient = bot._client) {
    const senderId = uuid(sender);
    if (!hasAuthenticatedServerConnection(bot, expectedClient) || !senderId) return null;

    const players = Object.entries(bot.players || {}).filter(([, player]) => uuid(player?.uuid) === senderId);
    const names = Object.entries(bot.uuidToUsername || {}).filter(([id]) => uuid(id) === senderId);
    if (players.length !== 1 || names.length !== 1) return null;
    const [key, player] = players[0];
    if (!/^[A-Za-z0-9_]{1,16}$/.test(player.username)
        || key !== player.username || names[0][1] !== player.username) return null;
    return player.username;
}

export function authenticatedChatMessage(bot, data) {
    // Mineflayer's `message` position is also "chat" for other playerChat
    // types. Check the independent protocol type, not a display translation.
    const type = data?.type?.chatType ?? data?.type;
    const format = Number.isInteger(type) && bot.registry?.chatFormattingById?.[type];
    if (data?.verified !== true || typeof data.plainMessage !== 'string'
        || data.unsignedContent != null || data.formattedMessage != null
        || format?.name !== 'minecraft:chat' || format.formatString !== '<%s> %s'
        || format.parameters?.length !== 2
        || format.parameters[0] !== 'sender' || format.parameters[1] !== 'content') return null;
    const name = authenticatedPlayerName(bot, data.sender);
    if (!name) return null;
    return { source: name, sender: data.sender, client: bot._client, message: data.plainMessage };
}
