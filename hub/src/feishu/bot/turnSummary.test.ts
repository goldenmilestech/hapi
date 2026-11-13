import { describe, expect, it } from 'bun:test'
import type { StoredMessage } from '../../store'
import { summarizeActiveTurn, summarizeFeishuTurn } from './turnSummary'

let nextSeq = 1

function message(overrides: Partial<StoredMessage> & { content: unknown }): StoredMessage {
    const seq = nextSeq++
    return {
        id: `msg-${seq}`,
        sessionId: 'session-1',
        createdAt: 1_700_000_000_000 + seq * 1000,
        seq,
        localId: null,
        invokedAt: 1_700_000_000_000 + seq * 1000,
        scheduledAt: null,
        ...overrides
    }
}

function userPrompt(text: string): StoredMessage {
    return message({ content: { role: 'user', content: { type: 'text', text } } })
}

function queuedUserPrompt(text: string, id: string): StoredMessage {
    return message({
        content: { role: 'user', content: { type: 'text', text } },
        localId: id,
        invokedAt: null
    })
}

function claudeAssistant(
    blocks: unknown[],
    options: { uuid?: string; usage?: unknown; isSidechain?: boolean } = {}
): StoredMessage {
    return message({
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: options.uuid ?? 'assistant-1',
                    type: 'assistant',
                    isSidechain: options.isSidechain ?? false,
                    message: {
                        content: blocks,
                        ...(options.usage ? { usage: options.usage } : {})
                    }
                }
            }
        }
    })
}

function claudeTurnDuration(resultSummary: Record<string, unknown>): StoredMessage {
    return message({
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'turn_duration',
                    resultSummary
                }
            }
        }
    })
}

function codex(agentContent: Record<string, unknown>): StoredMessage {
    return message({
        content: {
            role: 'agent',
            content: { type: 'codex', data: agentContent }
        }
    })
}

describe('summarizeFeishuTurn', () => {
    it('collects Claude thinking, tool calls, answer and token usage', () => {
        const summary = summarizeFeishuTurn([
            userPrompt('fix the login'),
            claudeAssistant([
                { type: 'thinking', thinking: 'Read the login page first.' },
                { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/login.ts' } },
                { type: 'text', text: 'Checking the redirect.' }
            ], { usage: { output_tokens: 120 } }),
            claudeAssistant([
                { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: '/tmp/login.ts', description: 'Fix redirect' } },
                { type: 'text', text: 'All done.' }
            ], { uuid: 'assistant-2', usage: { output_tokens: 80 } })
        ])

        expect(summary.thinking).toContain('Read the login page first.')
        expect(summary.steps).toEqual([
            '`Read` — /tmp/login.ts',
            '`Edit` — Fix redirect'
        ])
        expect(summary.answer).toBe('All done.')
        expect(summary.outputTokens).toBe(200)
    })

    it('ignores messages from earlier turns', () => {
        const summary = summarizeFeishuTurn([
            userPrompt('old turn'),
            claudeAssistant([{ type: 'thinking', thinking: 'OLD THINKING' }, { type: 'text', text: 'Old answer' }], { uuid: 'old' }),
            userPrompt('new turn'),
            claudeAssistant([{ type: 'thinking', thinking: 'NEW THINKING' }, { type: 'text', text: 'New answer' }], { uuid: 'new' })
        ])

        expect(summary.thinking).toBe('NEW THINKING')
        expect(summary.answer).toBe('New answer')
    })

    it('coalesces generic reasoning snapshots and tool calls by id', () => {
        const summary = summarizeFeishuTurn([
            userPrompt('run it'),
            codex({ type: 'reasoning', id: 'reason-1', message: 'First thought', live: true }),
            codex({ type: 'reasoning', id: 'reason-1', message: 'First thought, then more detail', live: true }),
            codex({ type: 'tool-call', callId: 'call-1', name: 'Bash', input: { command: 'bun test' } }),
            codex({ type: 'tool-call', callId: 'call-1', name: 'Bash', input: { command: 'bun test' }, description: 'Run tests' }),
            codex({ type: 'message', message: 'Tests pass.' })
        ])

        expect(summary.thinking).toBe('First thought, then more detail')
        expect(summary.steps).toEqual(['`Bash` — Run tests'])
        expect(summary.answer).toBe('Tests pass.')
    })

    it('does not count an input request as an execution step', () => {
        const claudeSummary = summarizeFeishuTurn([
            userPrompt('ask me something'),
            claudeAssistant([
                { type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [] } }
            ])
        ])
        expect(claudeSummary.steps).toEqual([])

        const codexSummary = summarizeFeishuTurn([
            userPrompt('ask me something'),
            codex({ type: 'tool-call', callId: 'ask-2', name: 'request_user_input', input: {} })
        ])
        expect(codexSummary.steps).toEqual([])
    })

    it('skips subagent (sidechain) traffic', () => {
        const summary = summarizeFeishuTurn([
            userPrompt('delegate'),
            claudeAssistant([
                { type: 'thinking', thinking: 'subagent secret' },
                { type: 'text', text: 'subagent result' }
            ], { isSidechain: true }),
            claudeAssistant([{ type: 'thinking', thinking: 'main thought' }, { type: 'text', text: 'main answer' }])
        ])

        expect(summary.thinking).toBe('main thought')
        expect(summary.answer).toBe('main answer')
    })

    it('keeps the finished answer when the next prompt is already queued', () => {
        const summary = summarizeFeishuTurn([
            userPrompt('first turn'),
            claudeAssistant([{ type: 'thinking', thinking: 'first thought' }, { type: 'text', text: 'First answer' }], { uuid: 'first' }),
            userPrompt('queued for later')
        ])

        expect(summary.thinking).toBe('first thought')
        expect(summary.answer).toBe('First answer')
    })

    it('returns only the answer when no prompt boundary is in the window', () => {
        const summary = summarizeFeishuTurn([
            claudeAssistant([{ type: 'thinking', thinking: 'ancient' }, { type: 'text', text: 'latest answer' }])
        ])

        expect(summary.thinking).toBe('')
        expect(summary.steps).toEqual([])
        expect(summary.answer).toBe('latest answer')
    })

    it('prefers the turn_duration result summary for tokens and duration', () => {
        const summary = summarizeFeishuTurn([
            userPrompt('finish it'),
            claudeAssistant([{ type: 'thinking', thinking: 'work' }, { type: 'text', text: 'Done' }], {
                uuid: 'answer',
                usage: { output_tokens: 10 }
            }),
            claudeTurnDuration({
                usage: { output_tokens: 1234 },
                duration_ms: 8200
            })
        ])

        expect(summary.outputTokens).toBe(1234)
        expect(summary.durationMs).toBe(8200)
    })

    it('does not fall back to the previous turn while the next prompt is queued', () => {
        const answer = claudeAssistant([
            { type: 'thinking', thinking: 'previous thought' },
            { type: 'text', text: 'Previous answer' }
        ], { uuid: 'previous' })
        const next = queuedUserPrompt('next request', 'queued-next')
        const summary = summarizeActiveTurn([
            userPrompt('first request'),
            answer,
            next
        ])

        expect(summary.turnKey).toBe(next.id)
        expect(summary.thinking).toBe('')
        expect(summary.steps).toEqual([])
    })

    it('summarizes the in-progress turn without requiring an answer', () => {
        const prompt = userPrompt('still working')
        const summary = summarizeActiveTurn([
            prompt,
            claudeAssistant([
                { type: 'thinking', thinking: 'partial thought' },
                { type: 'tool_use', id: 'tool-live', name: 'Read', input: { file_path: '/tmp/live.ts' } }
            ], { uuid: 'live' })
        ])

        expect(summary.turnKey).toBe(prompt.id)
        expect(summary.thinking).toBe('partial thought')
        expect(summary.steps).toEqual(['`Read` — /tmp/live.ts'])
        expect(summary.answer).toBeNull()
    })
})
