import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { computeSessionStats } from './sessionStats'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag = 'stats') {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

function userMessage(text: string) {
    return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web' } }
}

function assistantMessage(args: {
    id: string
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    model?: string
}) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: args.id,
                    model: args.model ?? 'claude-sonnet-5-5',
                    usage: {
                        input_tokens: args.input,
                        output_tokens: args.output,
                        cache_read_input_tokens: args.cacheRead ?? 0,
                        cache_creation_input_tokens: args.cacheWrite ?? 0
                    }
                }
            }
        },
        meta: { sentFrom: 'cli' }
    }
}

function toolResultMessage() {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] }
            }
        },
        meta: { sentFrom: 'cli' }
    }
}

function roundSummaryMessage(generationMs: number, generationOutputTokens: number) {
    return {
        role: 'agent',
        content: {
            type: 'agent-message',
            data: {
                type: 'round-summary',
                summary: {
                    generation_ms: generationMs,
                    generation_output_tokens: generationOutputTokens
                }
            }
        },
        meta: { sentFrom: 'cli' }
    }
}

describe('computeSessionStats', () => {
    it('counts turns, steps, billed tokens, and cache reads', () => {
        const store = makeStore()
        const session = makeSession(store)
        store.messages.addMessage(session.id, userMessage('first'), undefined, null, 1_000)
        store.messages.addMessage(session.id, assistantMessage({
            id: 'msg-1',
            input: 1_000,
            output: 100,
            cacheRead: 9_000,
            cacheWrite: 500
        }), undefined, null, 2_000)
        store.messages.addMessage(session.id, toolResultMessage(), undefined, null, 2_500)
        store.messages.addMessage(session.id, assistantMessage({
            id: 'msg-2',
            input: 500,
            output: 50,
            cacheRead: 20_000
        }), undefined, null, 3_500)
        store.messages.addMessage(session.id, userMessage('second'), undefined, null, 4_000)

        const stats = computeSessionStats(store, session.id)

        expect(stats.turns).toBe(2)
        expect(stats.steps).toBe(2)
        expect(stats.cacheReadTokens).toBe(29_000)
        expect(stats.cacheCreationTokens).toBe(500)
        // inputTokens is billed input (uncached input + cache reads + writes).
        expect(stats.inputTokens).toBe(1_000 + 9_000 + 500 + 500 + 20_000)
        expect(stats.outputTokens).toBe(150)
        expect(stats.totalTokens).toBe(stats.inputTokens + 150)
        // Both steps are timed from the row before them: 1s + 1s.
        expect(stats.generationMs).toBe(2_000)
        expect(stats.generationOutputTokens).toBe(150)
    })

    it('folds repeated stream rows of one provider message into a single step', () => {
        const store = makeStore()
        const session = makeSession(store)
        store.messages.addMessage(session.id, userMessage('go'), undefined, null, 1_000)
        store.messages.addMessage(session.id, assistantMessage({ id: 'msg-1', input: 100, output: 40 }), undefined, null, 2_000)
        store.messages.addMessage(session.id, assistantMessage({ id: 'msg-1', input: 100, output: 40 }), undefined, null, 2_400)

        const stats = computeSessionStats(store, session.id)

        expect(stats.steps).toBe(1)
        expect(stats.outputTokens).toBe(40)
        // The step window spans its first to last row.
        expect(stats.generationMs).toBe(1_400)
    })

    it('ignores transcript echoes and CLI command echoes when counting turns', () => {
        const store = makeStore()
        const session = makeSession(store)
        store.messages.addMessage(session.id, userMessage('real prompt'), undefined, null, 1_000)
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'real prompt' },
            meta: { sentFrom: 'cli', isTranscriptEcho: true }
        }, undefined, null, 1_100)
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: '<command-name>/compact</command-name>' },
            meta: { sentFrom: 'cli' }
        }, undefined, null, 1_200)

        const stats = computeSessionStats(store, session.id)

        expect(stats.turns).toBe(1)
    })

    it('prefers provider-reported round-summary generation time', () => {
        const store = makeStore()
        const session = makeSession(store)
        store.messages.addMessage(session.id, userMessage('go'), undefined, null, 1_000)
        store.messages.addMessage(session.id, assistantMessage({ id: 'msg-1', input: 100, output: 40 }), undefined, null, 5_000)
        store.messages.addMessage(session.id, roundSummaryMessage(800, 30), undefined, null, 5_100)

        const stats = computeSessionStats(store, session.id)

        expect(stats.generationMs).toBe(800)
        expect(stats.generationOutputTokens).toBe(30)
    })

    it('returns an empty snapshot for a session with no messages', () => {
        const store = makeStore()
        const session = makeSession(store, 'empty')

        const stats = computeSessionStats(store, session.id)

        expect(stats).toMatchObject({
            turns: 0,
            steps: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            generationMs: null,
            generationOutputTokens: null
        })
    })
})
