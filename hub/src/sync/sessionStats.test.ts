import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { computeSessionStats } from './sessionStats'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag = 'stats', flavor = 'claude') {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}`, flavor }, null, 'default')
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
    tools?: string[]
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
                    },
                    ...(args.tools
                        ? { content: args.tools.map((id) => ({ type: 'tool_use', id, name: 'Read', input: {} })) }
                        : {})
                }
            }
        },
        meta: { sentFrom: 'cli' }
    }
}

function toolResultMessage(ids: string[] = ['tool-1']) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: {
                    role: 'user',
                    content: ids.map((tool_use_id) => ({ type: 'tool_result', tool_use_id, content: 'ok' }))
                }
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

function turnDurationMessage(durationMs: number, generationMs: number, outputTokens: number) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'system',
                subtype: 'turn_duration',
                durationMs,
                resultSummary: {
                    usage: { input_tokens: 0, output_tokens: outputTokens },
                    duration_ms: durationMs,
                    generation_ms: generationMs,
                    generation_output_tokens: outputTokens
                }
            }
        },
        meta: { sentFrom: 'cli' }
    }
}

function tokenCountMessage(args: { input: number; output: number; cacheRead?: number }) {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'token_count',
                turnId: 'turn-1',
                info: {
                    total: {
                        inputTokens: args.input,
                        outputTokens: args.output,
                        cachedInputTokens: args.cacheRead ?? 0
                    }
                }
            }
        },
        meta: { sentFrom: 'cli' }
    }
}

function toolCallMessage(callId: string) {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data: { type: 'tool-call', name: 'shell', callId, input: {} }
        },
        meta: { sentFrom: 'cli' }
    }
}

function toolCallResultMessage(callId: string) {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data: { type: 'tool-call-result', callId, output: 'ok' }
        },
        meta: { sentFrom: 'cli' }
    }
}

function acpUsageMessage(input: number, output: number) {
    return {
        role: 'agent',
        content: {
            type: 'agent-message',
            data: { type: 'usage', inputTokens: input, outputTokens: output }
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
        // No tool call row precedes the lone tool result, so there is nothing to pair.
        expect(stats.toolMs).toBeNull()
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

    it('reads Claude turn_duration generation time, which excludes tool waits', () => {
        const store = makeStore()
        const session = makeSession(store)
        store.messages.addMessage(session.id, userMessage('go'), undefined, null, 1_000)
        store.messages.addMessage(session.id, assistantMessage({ id: 'msg-1', input: 100, output: 40 }), undefined, null, 5_000)
        store.messages.addMessage(session.id, turnDurationMessage(4_000, 800, 30), undefined, null, 5_100)
        store.messages.addMessage(session.id, userMessage('more'), undefined, null, 6_000)
        store.messages.addMessage(session.id, assistantMessage({ id: 'msg-2', input: 100, output: 20 }), undefined, null, 9_000)
        store.messages.addMessage(session.id, turnDurationMessage(3_000, 600, 20), undefined, null, 9_100)

        const stats = computeSessionStats(store, session.id)

        expect(stats.generationMs).toBe(1_400)
        expect(stats.generationOutputTokens).toBe(50)
        // 1000ms + 1000ms per request; the provider clock wins over these windows.
        expect(stats.toolMs).toBeNull()
    })

    it('times Codex requests from the last tool result and reports tool time', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex', 'codex')
        store.messages.addMessage(session.id, userMessage('go'), undefined, null, 1_000)
        store.messages.addMessage(session.id, tokenCountMessage({ input: 100, output: 10 }), undefined, null, 3_000)
        store.messages.addMessage(session.id, toolCallMessage('c1'), undefined, null, 3_500)
        store.messages.addMessage(session.id, toolCallResultMessage('c1'), undefined, null, 4_500)
        store.messages.addMessage(session.id, tokenCountMessage({ input: 200, output: 25 }), undefined, null, 6_000)
        store.messages.addMessage(session.id, userMessage('again'), undefined, null, 7_000)
        store.messages.addMessage(session.id, tokenCountMessage({ input: 300, output: 35 }), undefined, null, 9_000)

        const stats = computeSessionStats(store, session.id)

        expect(stats.turns).toBe(2)
        expect(stats.steps).toBe(3)
        expect(stats.inputTokens).toBe(300)
        expect(stats.outputTokens).toBe(35)
        // Window 1: prompt -> first snapshot (2s). Window 2: tool result -> second
        // snapshot (1.5s). Window 3: second prompt -> third snapshot (2s).
        expect(stats.generationMs).toBe(5_500)
        expect(stats.generationOutputTokens).toBe(35)
        // c1 ran from 3.5s to 4.5s.
        expect(stats.toolMs).toBe(1_000)
    })

    it('counts parallel tools from one assistant row as a single batch', () => {
        const store = makeStore()
        const session = makeSession(store)
        store.messages.addMessage(session.id, userMessage('read both'), undefined, null, 1_000)
        store.messages.addMessage(session.id, assistantMessage({
            id: 'msg-1',
            input: 100,
            output: 40,
            tools: ['a', 'b']
        }), undefined, null, 2_000)
        store.messages.addMessage(session.id, toolResultMessage(['a']), undefined, null, 3_000)
        store.messages.addMessage(session.id, toolResultMessage(['b']), undefined, null, 3_500)
        store.messages.addMessage(session.id, assistantMessage({ id: 'msg-2', input: 100, output: 20 }), undefined, null, 4_500)

        const stats = computeSessionStats(store, session.id)

        // The batch spans both results rather than summing each tool individually.
        expect(stats.toolMs).toBe(1_500)
        expect(stats.generationMs).toBe(2_000)
        expect(stats.generationOutputTokens).toBe(60)
    })

    it('does not treat turn-level ACP usage rows as generation windows', () => {
        const store = makeStore()
        const session = makeSession(store, 'dsh', 'dsh')
        store.messages.addMessage(session.id, userMessage('go'), undefined, null, 1_000)
        store.messages.addMessage(session.id, acpUsageMessage(100, 20), undefined, null, 5_000)
        store.messages.addMessage(session.id, userMessage('again'), undefined, null, 6_000)

        const stats = computeSessionStats(store, session.id)

        // A turn-level usage row includes tool time; reporting it as speed would lie.
        expect(stats.steps).toBe(1)
        expect(stats.outputTokens).toBe(20)
        expect(stats.generationMs).toBeNull()
        expect(stats.generationOutputTokens).toBeNull()
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
            generationOutputTokens: null,
            toolMs: null
        })
    })
})
