export const MAX_AUTONOMOUS_STEPS = 60;
export const MAX_CONSECUTIVE_FAILURES = 4;
export const MAX_REPEATED_ACTIONS_WITHOUT_PROGRESS = 2;

// Autonomous goals may observe the world and perform bounded in-game actions.
// Process control, code generation, persistent control-plane changes, external
// content lookup, and commands that can run indefinitely are intentionally
// excluded from this allowlist.
const AUTONOMOUS_ALLOWED_COMMANDS = Object.freeze([
    '!stats',
    '!inventory',
    '!nearbyBlocks',
    '!craftable',
    '!entities',
    '!modes',
    '!savedPlaces',
    '!checkBlueprintLevel',
    '!checkBlueprint',
    '!getBlueprint',
    '!getBlueprintLevel',
    '!getCraftingPlan',
    '!goToPlayer',
    '!goToCoordinates',
    '!searchForBlock',
    '!searchForEntity',
    '!moveAway',
    '!rememberHere',
    '!goToRememberedPlace',
    '!givePlayer',
    '!consume',
    '!equip',
    '!putInChest',
    '!takeFromChest',
    '!viewChest',
    '!discard',
    '!collectBlocks',
    '!craftRecipe',
    '!clearFurnace',
    '!placeHere',
    '!goToBed',
    '!showVillagerTrades',
    '!tradeWithVillager',
    '!lookAtPlayer',
    '!lookAtPosition',
    '!digDown',
    '!goToSurface',
    '!useOn'
]);

const AUTONOMOUS_ALLOWED_COMMAND_SET = new Set(AUTONOMOUS_ALLOWED_COMMANDS);

function normalizeCommandName(commandName) {
    if (typeof commandName !== 'string') return null;
    const trimmed = commandName.trim();
    if (!trimmed) return null;
    return trimmed.startsWith('!') ? trimmed : `!${trimmed}`;
}

export function getAutonomousCommandNames() {
    return [...AUTONOMOUS_ALLOWED_COMMANDS];
}

export function isAutonomousCommandNameAllowed(commandName) {
    const normalized = normalizeCommandName(commandName);
    return normalized !== null && AUTONOMOUS_ALLOWED_COMMAND_SET.has(normalized);
}

export function getAutonomousStopReason({
    stepsTaken = 0,
    consecutiveFailures = 0
} = {}) {
    const safeStepsTaken = Math.max(0, Number(stepsTaken) || 0);
    const safeConsecutiveFailures = Math.max(0, Number(consecutiveFailures) || 0);

    if (safeStepsTaken >= MAX_AUTONOMOUS_STEPS) {
        return `Stopped after ${MAX_AUTONOMOUS_STEPS} steps without completing the goal.`;
    }
    if (safeConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return `Stopped after ${safeConsecutiveFailures} consecutive failed actions.`;
    }
    return null;
}

export function parseTaskDecision(raw) {
    if (typeof raw !== 'string') throw new Error('Task decision was not text.');
    let text = raw.includes('</think>') ? raw.split('</think>').pop() : raw;
    text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Task decision did not contain a JSON object.');

    const decision = JSON.parse(text.slice(start, end + 1));
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
        throw new Error('Task decision must be a JSON object.');
    }
    if (!['active', 'completed', 'blocked'].includes(decision.status)) {
        throw new Error(`Invalid task status: ${decision.status}`);
    }

    decision.plan = Array.isArray(decision.plan)
        ? decision.plan
            .filter(step => typeof step === 'string')
            .map(step => step.trim())
            .filter(Boolean)
            .slice(0, 10)
        : [];
    decision.current_step = typeof decision.current_step === 'string'
        ? decision.current_step.trim()
        : '';
    decision.reason = typeof decision.reason === 'string'
        ? decision.reason.trim()
        : '';
    decision.command = typeof decision.command === 'string'
        ? decision.command.trim()
        : '';

    if (decision.status === 'active' && !decision.command) {
        throw new Error('An active task decision requires a command.');
    }
    if (decision.status !== 'active') {
        decision.command = '';
    }
    return decision;
}
