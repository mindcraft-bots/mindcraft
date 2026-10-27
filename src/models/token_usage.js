export function normalizeTokenUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;

    const inputTotal = firstNumber(
        rawUsage.input_tokens,
        rawUsage.prompt_tokens,
        rawUsage.promptTokenCount,
        rawUsage.prompt_token_count
    );
    const output = firstNumber(
        rawUsage.output_tokens,
        rawUsage.completion_tokens,
        rawUsage.candidatesTokenCount,
        rawUsage.candidates_token_count
    );
    const cachedInput = firstNumber(
        rawUsage.input_tokens_details?.cached_tokens,
        rawUsage.prompt_tokens_details?.cached_tokens,
        rawUsage.cache_read_input_tokens,
        rawUsage.cachedContentTokenCount,
        rawUsage.cached_content_token_count,
        0
    );
    const cacheCreationInput = firstNumber(rawUsage.cache_creation_input_tokens, 0);

    let uncachedInput = firstNumber(
        rawUsage.input_tokens_details?.uncached_tokens,
        rawUsage.prompt_tokens_details?.uncached_tokens
    );
    if (uncachedInput == null && inputTotal != null && rawUsage.cache_read_input_tokens != null) {
        uncachedInput = inputTotal + cacheCreationInput;
    } else if (uncachedInput == null && inputTotal != null) {
        uncachedInput = Math.max(inputTotal - cachedInput, 0);
    } else if (cacheCreationInput) {
        uncachedInput = (uncachedInput || 0) + cacheCreationInput;
    }

    const total = firstNumber(
        rawUsage.total_tokens,
        rawUsage.totalTokenCount,
        rawUsage.total_token_count,
        sumKnown(inputTotal, output, cacheCreationInput)
    );

    if (inputTotal == null && output == null && cachedInput === 0 && cacheCreationInput === 0 && total == null) {
        return null;
    }

    return {
        input_total: inputTotal,
        input_uncached: uncachedInput,
        input_cached: cachedInput,
        output,
        total,
        raw: rawUsage
    };
}

export function setLastTokenUsage(model, rawUsage) {
    if (!model || typeof model !== 'object') return null;
    const usage = normalizeTokenUsage(rawUsage);
    model.lastTokenUsage = usage;
    return usage;
}

function firstNumber(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
}

function sumKnown(...values) {
    const known = values.filter(value => typeof value === 'number' && Number.isFinite(value));
    if (!known.length) return null;
    return known.reduce((sum, value) => sum + value, 0);
}
