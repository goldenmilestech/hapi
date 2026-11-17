import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'
import type { SessionStatsResponse } from '@/types/api'

const stats: SessionStatsResponse = {
    turns: 3,
    steps: 31,
    inputTokens: 4_400_000,
    outputTokens: 200_000,
    cacheReadTokens: 4_268_000,
    cacheCreationTokens: 0,
    totalTokens: 4_600_000,
    generationMs: 1_149_425,
    generationOutputTokens: 200_000,
    toolMs: 32_800,
    updatedAt: 1_700_000_000_000
}

describe('StatusBar session stats', () => {
    beforeEach(() => {
        localStorage.clear()
        localStorage.setItem('hapi-lang', 'zh-CN')
    })

    it('shows turns, steps, speed, tokens, and cache hit beside the context chip', () => {
        render(
            <I18nProvider>
                <StatusBar active thinking={false} agentState={null} sessionStats={stats} />
            </I18nProvider>
        )

        expect(screen.getByTestId('session-stats')).toBeTruthy()
        expect(screen.getByText('3 轮 31 步 · 174 tok/s')).toBeTruthy()
        expect(screen.getByText('4.6M tok · 缓存命中 97%')).toBeTruthy()
    })

    it('keeps the row clean when the hub reports nothing yet', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    sessionStats={{ ...stats, turns: 0, steps: 0, totalTokens: 0, inputTokens: 0, cacheReadTokens: 0 }}
                />
            </I18nProvider>
        )

        expect(screen.queryByTestId('session-stats')).toBeNull()
    })

    it('shows counts without a speed when generation timing is missing', () => {
        render(
            <I18nProvider>
                <StatusBar
                    active
                    thinking={false}
                    agentState={null}
                    sessionStats={{ ...stats, generationMs: null, generationOutputTokens: null, toolMs: null }}
                />
            </I18nProvider>
        )

        expect(screen.getByText('3 轮 31 步')).toBeTruthy()
    })

    it('opens a stats popover with model, tool, and output timing', async () => {
        render(
            <I18nProvider>
                <StatusBar active thinking={false} agentState={null} sessionStats={stats} />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: '会话统计' }))

        expect(await screen.findByText('模型用时')).toBeTruthy()
        expect(screen.getByText('19 分 9 秒')).toBeTruthy()
        expect(screen.getByText('工具调用用时')).toBeTruthy()
        expect(screen.getByText('32.8 秒')).toBeTruthy()
        expect(screen.getByText('输出速度')).toBeTruthy()
        expect(screen.getAllByText('174 tok/s').length).toBeGreaterThan(0)
    })

    it('opens a token popover with the cache breakdown', async () => {
        render(
            <I18nProvider>
                <StatusBar active thinking={false} agentState={null} sessionStats={stats} />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'Token 用量' }))

        expect(await screen.findByText('缓存命中')).toBeTruthy()
        expect(screen.getByText('97%')).toBeTruthy()
        expect(screen.getByText('未缓存输入')).toBeTruthy()
        expect(screen.getByText(`${(132_000).toLocaleString()} tok`)).toBeTruthy()
        expect(screen.getByText('缓存读取')).toBeTruthy()
        expect(screen.getByText(`${(4_268_000).toLocaleString()} tok`)).toBeTruthy()
        expect(screen.getByText('输出')).toBeTruthy()
        expect(screen.getByText(`${(200_000).toLocaleString()} tok`)).toBeTruthy()
        expect(screen.getByText(`${(4_600_000).toLocaleString()} tok`)).toBeTruthy()
    })
})
