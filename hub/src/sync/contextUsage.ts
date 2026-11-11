/**
 * Extract the latest context-window usage from a stored agent message.
 *
 * The hub needs this for hub-side auto-compaction on flavors that have no
 * native auto-compact threshold. Agent messages arrive in two shapes:
 *
 * - `token_count` / `usage` payloads from Codex, ACP backends (Grok, Cursor,
 *   Copilot, Agy, Kimi, Dsh), Pi and OpenCode. `info.contextTokens` is the
 *   live context size when the agent reports it; Codex reports only the last
 *   request's input tokens, which is the same quantity.
 * - Claude stream-json assistant messages, whose `message.usage` excludes the
 *   cache fields from `input_tokens`, so the context size is the sum.
 *
 * Returns null for messages that carry no usable usage, child-agent scopes,
 * imported history, and malformed payloads.
 */

export type AgentContextUsage = {
    contextTokens: number
    contextWindow: number | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asPositiveCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : null
}

function firstPositiveCount(record: Record<string, unknown>, ...keys: string[]): number | null {
    for (const key of keys) {
        const value = asPositiveCount(record[key])
        if (value !== null) return value
    }
    return null
}

function sumCounts(record: Record<string, unknown>, ...keys: string[]): number {
    let total = 0
    for (const key of keys) {
        const value = asPositiveCount(record[key])
        if (value !== null) total += value
    }
    return total
}

function resolveScopeRole(data: Record<string, unknown>): string | null {
    const scope = asRecord(data.scope)
    const value = data.scopeRole ?? data.scope_role ?? scope?.role
    return typeof value === 'string' ? value : null
}

export function extractAgentContextUsage(content: unknown): AgentContextUsage | null {
    const envelope = asRecord(content)
    if (envelope?.role !== 'agent') return null

    const payload = asRecord(envelope.content)
    if (!payload) return null
    const data = asRecord(payload.data)
    if (!data) return null

    if (data.type === 'token_count' || data.type === 'usage') {
        if (data.hapiUsageScope === 'imported-history') return null
        if (resolveScopeRole(data) === 'child') return null

        const info = asRecord(data.info) ?? data
        const last = asRecord(info.last)
            ?? asRecord(info.lastTokenUsage)
            ?? asRecord(info.last_token_usage)
            ?? asRecord(info.total)
            ?? asRecord(info.totalTokenUsage)
            ?? asRecord(info.total_token_usage)
            ?? (data.type === 'usage' ? info : null)

        const contextTokens = firstPositiveCount(info, 'contextTokens', 'context_tokens')
            ?? (last ? firstPositiveCount(last, 'inputTokens', 'input_tokens') : null)
        if (contextTokens === null) return null

        return {
            contextTokens,
            contextWindow: firstPositiveCount(
                info,
                'modelContextWindow',
                'model_context_window',
                'contextWindow',
                'context_window'
            )
        }
    }

    if (payload.type === 'output' && data.type === 'assistant') {
        if (data.isSidechain === true) return null
        const usage = asRecord(asRecord(data.message)?.usage)
        if (!usage) return null

        const contextTokens = sumCounts(
            usage,
            'input_tokens',
            'inputTokens',
            'cache_read_input_tokens',
            'cacheReadInputTokens',
            'cache_creation_input_tokens',
            'cacheCreationInputTokens'
        )
        if (contextTokens <= 0) return null

        return {
            contextTokens,
            contextWindow: firstPositiveCount(usage, 'context_window', 'contextWindow')
        }
    }

    return null
}
