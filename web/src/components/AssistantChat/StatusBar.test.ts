import { describe, expect, it } from 'vitest'
import {
    formatCompactContextUsageLabel,
    formatContextUsageLabel,
    formatSessionStatsCacheHit,
    formatSessionStatsCounts,
    formatSessionStatsSpeed,
    formatSessionStatsTokens,
    getContextWarning,
    getContextUsageDetails,
    shouldShowCodexFastBadge
} from './StatusBar'

describe('context warning colors', () => {
    it('keeps usage below 70% muted', () => {
        expect(getContextWarning(69, 100).color).toBe('text-[var(--app-hint)]')
    })

    it('shows a warning from 70% through below 90%', () => {
        expect(getContextWarning(70, 100).color).toBe('text-amber-500')
        expect(getContextWarning(89, 100).color).toBe('text-amber-500')
    })

    it('shows danger at 90% and above', () => {
        expect(getContextWarning(90, 100).color).toBe('text-red-500')
        expect(getContextWarning(95, 100).color).toBe('text-red-500')
    })
})

describe('context usage labels', () => {
    it('keeps the desktop label compact and expresses used capacity', () => {
        expect(formatContextUsageLabel(90_000, 258_000)).toBe('35% · 90k / 258k')
    })

    it('uses the compact parenthesized mobile label with a fixed English suffix', () => {
        expect(formatCompactContextUsageLabel(186_000, 262_000)).toBe('ctx 262k (29% left)')
    })

    it('orders cache, used, and remaining metrics for the desktop details', () => {
        expect(getContextUsageDetails(90_000, 258_000, 86_000)).toEqual({
            cacheRead: '86k',
            used: '90k',
            usedPercentage: 35,
            remaining: '168k',
            remainingPercentage: 65
        })
    })

    it('keeps external and detailed percentages complementary at rounding midpoints', () => {
        expect(formatContextUsageLabel(69, 200)).toBe('35% · 69 / 200')
        expect(formatCompactContextUsageLabel(69, 200)).toBe('ctx 200 (65% left)')
        expect(getContextUsageDetails(69, 200, 0)).toMatchObject({
            usedPercentage: 35,
            remainingPercentage: 65
        })
    })
})

describe('shouldShowCodexFastBadge', () => {
    it('uses only the effective service tier', () => {
        expect(shouldShowCodexFastBadge('codex', undefined)).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'standard')).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'fast')).toBe(true)
        expect(shouldShowCodexFastBadge('codex', 'priority')).toBe(true)
        expect(shouldShowCodexFastBadge('claude', 'fast')).toBe(false)
    })
})

describe('session stats labels', () => {
    const t = (key: string, params?: Record<string, string | number>) => {
        if (key === 'misc.statsCounts') return `${params?.turns} rounds ${params?.steps} steps`
        if (key === 'misc.statsTurns') return `${params?.turns} rounds`
        return key
    }

    it('joins turn and step counts through the locale template', () => {
        expect(formatSessionStatsCounts(3, 31, t)).toBe('3 rounds 31 steps')
    })

    it('drops the step count when a runtime reports no per-step usage', () => {
        expect(formatSessionStatsCounts(3, 0, t)).toBe('3 rounds')
    })

    it('shows whole tokens per second from ten up and one decimal below', () => {
        expect(formatSessionStatsSpeed(60_000, 10_440)).toBe('174 tok/s')
        expect(formatSessionStatsSpeed(2_000, 5)).toBe('2.5 tok/s')
    })

    it('omits speed when timing or tokens are unusable', () => {
        expect(formatSessionStatsSpeed(null, 100)).toBeNull()
        expect(formatSessionStatsSpeed(0, 100)).toBeNull()
        expect(formatSessionStatsSpeed(1_000, 0)).toBeNull()
        expect(formatSessionStatsSpeed(1_000, null)).toBeNull()
    })

    it('formats the session token total compactly', () => {
        expect(formatSessionStatsTokens(4_600_000)).toBe('4.6M tok')
        expect(formatSessionStatsTokens(12_200)).toBe('12k tok')
        expect(formatSessionStatsTokens(980)).toBe('980 tok')
        expect(formatSessionStatsTokens(0)).toBeNull()
    })

    it('reports cache reads as a share of billed input', () => {
        expect(formatSessionStatsCacheHit(9_700, 10_000)).toBe('97')
        expect(formatSessionStatsCacheHit(1_000, 1_000)).toBe('100')
        expect(formatSessionStatsCacheHit(0, 1_000)).toBeNull()
        expect(formatSessionStatsCacheHit(1_000, 0)).toBeNull()
    })

    it('never rounds a partial cache hit up to 100%', () => {
        expect(formatSessionStatsCacheHit(99_996, 100_000)).toBe('99.99')
        expect(formatSessionStatsCacheHit(99_999, 100_000)).toBe('99.99')
    })
})
