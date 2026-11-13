import { render, screen } from '@testing-library/react'
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
                    sessionStats={{ ...stats, generationMs: null, generationOutputTokens: null }}
                />
            </I18nProvider>
        )

        expect(screen.getByText('3 轮 31 步')).toBeTruthy()
    })
})
