import { describe, expect, it } from 'bun:test'
import { extractAgentContextUsage } from './contextUsage'

function agentMessage(data: Record<string, unknown>): Record<string, unknown> {
    return { role: 'agent', content: { type: 'output', data } }
}

describe('extractAgentContextUsage', () => {
    it('reads the live context size Codex reports under last usage', () => {
        expect(extractAgentContextUsage(agentMessage({
            type: 'token_count',
            info: {
                last: { inputTokens: 123_456, outputTokens: 10, cachedInputTokens: 100_000 },
                modelContextWindow: 258_400
            }
        }))).toEqual({ contextTokens: 123_456, contextWindow: 258_400 })
    })

    it('reads contextTokens from ACP/Pi/OpenCode usage payloads', () => {
        expect(extractAgentContextUsage(agentMessage({
            type: 'token_count',
            info: { contextTokens: 90_000, modelContextWindow: 200_000 }
        }))).toEqual({ contextTokens: 90_000, contextWindow: 200_000 })
    })

    it('falls back to the total input when no last snapshot exists', () => {
        expect(extractAgentContextUsage(agentMessage({
            type: 'usage',
            info: { total: { input_tokens: 42_000 } }
        }))).toEqual({ contextTokens: 42_000, contextWindow: null })
    })

    it('sums Claude input and cache fields, which input_tokens excludes', () => {
        expect(extractAgentContextUsage(agentMessage({
            type: 'assistant',
            message: {
                usage: {
                    input_tokens: 1_000,
                    cache_read_input_tokens: 80_000,
                    cache_creation_input_tokens: 19_000,
                    context_window: 1_000_000
                }
            }
        }))).toEqual({ contextTokens: 100_000, contextWindow: 1_000_000 })
    })

    it('ignores child scopes, imported history, replays without usage, and non-agent rows', () => {
        expect(extractAgentContextUsage(agentMessage({
            type: 'token_count',
            scopeRole: 'child',
            info: { contextTokens: 90_000 }
        }))).toBeNull()
        expect(extractAgentContextUsage(agentMessage({
            type: 'token_count',
            hapiUsageScope: 'imported-history',
            info: { contextTokens: 90_000 }
        }))).toBeNull()
        expect(extractAgentContextUsage(agentMessage({
            type: 'assistant',
            isSidechain: true,
            message: { usage: { input_tokens: 100 } }
        }))).toBeNull()
        expect(extractAgentContextUsage({ role: 'user', content: 'hi' })).toBeNull()
        expect(extractAgentContextUsage(null)).toBeNull()
    })
})
