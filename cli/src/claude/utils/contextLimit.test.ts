import { afterEach, describe, expect, it } from 'vitest'
import { applyContextLimitEnv, normalizeClaudeContextLimit } from './contextLimit'

const original = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW

afterEach(() => {
    if (original === undefined) {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    } else {
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = original
    }
})

describe('Claude context limit', () => {
    it('clamps the configured ceiling to the range Claude Code accepts', () => {
        expect(normalizeClaudeContextLimit(50_000)).toBe(100_000)
        expect(normalizeClaudeContextLimit(200_000)).toBe(200_000)
        expect(normalizeClaudeContextLimit(2_000_000)).toBe(1_000_000)
        expect(normalizeClaudeContextLimit('200000')).toBeNull()
        expect(normalizeClaudeContextLimit(null)).toBeNull()
    })

    it('exports the ceiling for the spawned process and restores the user value when cleared', () => {
        applyContextLimitEnv(200_000)
        expect(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000')

        applyContextLimitEnv(null)
        expect(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(original)
    })
})
