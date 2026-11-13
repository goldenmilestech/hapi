import { describe, expect, it } from 'bun:test'
import { buildAnswerCard, buildInputRequestCard, buildProgressCard, truncateForCard } from './cards'
import type { FeishuTurnSummary } from './turnSummary'

function summary(overrides: Partial<FeishuTurnSummary> = {}): FeishuTurnSummary {
    return {
        thinking: '',
        steps: [],
        answer: null,
        answerMessageId: null,
        turnKey: null,
        outputTokens: null,
        durationMs: null,
        startedAt: null,
        endedAt: null,
        ...overrides
    }
}

function readMarkdown(card: Record<string, unknown>): string[] {
    const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined
    const first = body?.elements?.[0]
    if (!first) return []
    if (first.tag !== 'collapsible_panel' && typeof first.content === 'string') {
        return [first.content]
    }
    const elements = (first.elements ?? []) as Array<{ content?: string }>
    return elements.map((element) => element.content ?? '')
}

describe('Feishu cards', () => {
    it('keeps the answer and the session title in the answer card', () => {
        const card = buildAnswerCard('Fix login', '**Done**\n\n- item')
        expect(card?.schema).toBe('2.0')
        const header = card?.header as { title?: { content?: string } } | undefined
        expect(header?.title?.content).toBe('会话来自：Fix login')
        expect(readMarkdown(card!)).toEqual(['**Done**\n\n- item'])
    })

    it('returns null for an empty answer', () => {
        expect(buildAnswerCard('Fix login', '   ')).toBeNull()
    })

    it('strips model-provided mention tags from card markdown', () => {
        const answer = buildAnswerCard('Fix login', 'Hi <at id=all></at> there')
        expect(readMarkdown(answer!)).toEqual(['Hi  there'])

        const progress = buildProgressCard(summary({
            thinking: 'ping <at user_id="ou_1"></at> now',
            steps: ['`Bash` — echo <at id=all></at>']
        }))
        expect(readMarkdown(progress!)[0]).toBe('ping  now')
    })

    it('puts thinking and numbered tool calls in a collapsed panel', () => {
        const card = buildProgressCard(summary({
            thinking: 'I should inspect the login redirect.',
            steps: ['`Read` — src/login.ts', '`Edit` — src/login.ts'],
            outputTokens: 1400,
            durationMs: 8200
        }))
        const panel = (card?.body as { elements?: Array<Record<string, unknown>> } | undefined)?.elements?.[0]
        expect(panel?.tag).toBe('collapsible_panel')
        expect(panel?.expanded).toBe(false)
        const title = panel?.header as { title?: { content?: string } } | undefined
        expect(title?.title?.content).toBe('**执行过程** · 2 步 · 8.2 秒 · 1.4K tokens')
        expect(readMarkdown(card!)).toEqual([
            'I should inspect the login redirect.',
            '1. 🔧 Read\n2. 🔧 Edit'
        ])
    })

    it('never derives the duration from message timestamps', () => {
        const card = buildProgressCard(summary({
            thinking: 'Working through it.',
            startedAt: 1000,
            endedAt: 69_000
        }))
        const title = ((card?.body as { elements?: Array<Record<string, unknown>> } | undefined)
            ?.elements?.[0]?.header as { title?: { content?: string } } | undefined)?.title?.content
        expect(title).toBe('**思考过程**')
    })

    it('shows a thinking title and Agent Teams stats', () => {
        const card = buildProgressCard(summary({
            thinking: 'Working through it.',
            outputTokens: 1234,
            durationMs: 8200
        }))
        const title = ((card?.body as { elements?: Array<Record<string, unknown>> } | undefined)
            ?.elements?.[0]?.header as { title?: { content?: string } } | undefined)?.title?.content
        expect(title).toBe('**思考过程** · 8.2 秒 · 1.2K tokens')
    })

    it('returns null when there is no reasoning or tool call', () => {
        expect(buildProgressCard(summary())).toBeNull()
    })

    it('renders an input request with questions and options', () => {
        const card = buildInputRequestCard({
            sessionId: 'session-1',
            sessionTitle: 'Fix login',
            tool: 'AskUserQuestion',
            args: {
                questions: [{
                    header: 'Scope',
                    question: 'Which files should I touch?',
                    multiSelect: true,
                    options: [
                        { label: 'Web', description: 'web/src' },
                        { label: 'Hub' }
                    ]
                }]
            },
            publicUrl: 'https://hapi.test/'
        })

        const header = card?.header as { title?: { content?: string } } | undefined
        expect(header?.title?.content).toBe('需要你回答：Fix login')
        const body = card?.body as { elements?: Array<{ content?: string }> } | undefined
        const content = body?.elements?.[0]?.content ?? ''
        expect(content).toContain('**问题 1** · Scope')
        expect(content).toContain('Which files should I touch?')
        expect(content).toContain('**Web**：web/src')
        expect(content).toContain('可多选')
        expect(content).toContain('https://hapi.test/sessions/session-1')
    })

    it('truncates oversized markdown while keeping head and tail', () => {
        const text = `${'头'.repeat(20_000)}TAIL`
        const truncated = truncateForCard(text, 2_000)
        expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(2_000)
        expect(truncated.startsWith('头')).toBe(true)
        expect(truncated.endsWith('TAIL')).toBe(true)
        expect(truncated).toContain('已截断')
    })
})
