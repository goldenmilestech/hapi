import { describe, expect, it } from 'bun:test'
import { buildAnswerCard, buildProgressCard, truncateForCard } from './cards'
import type { FeishuTurnSummary } from './turnSummary'

function summary(overrides: Partial<FeishuTurnSummary> = {}): FeishuTurnSummary {
    return {
        thinking: '',
        steps: [],
        answer: null,
        answerMessageId: null,
        outputTokens: null,
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
            startedAt: 1000,
            endedAt: 9200
        }))
        const panel = (card?.body as { elements?: Array<Record<string, unknown>> } | undefined)?.elements?.[0]
        expect(panel?.tag).toBe('collapsible_panel')
        expect(panel?.expanded).toBe(false)
        const title = panel?.header as { title?: { content?: string } } | undefined
        expect(title?.title?.content).toContain('**执行过程** · 2 步')
        expect(title?.title?.content).toContain('8.2 秒')
        expect(title?.title?.content).toContain('1.4K tokens')
        expect(readMarkdown(card!)).toEqual([
            'I should inspect the login redirect.',
            '1. `Read` — src/login.ts\n2. `Edit` — src/login.ts'
        ])
    })

    it('returns null when there is no reasoning or tool call', () => {
        expect(buildProgressCard(summary())).toBeNull()
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
