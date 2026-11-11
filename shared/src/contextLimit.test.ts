import { describe, expect, it } from 'bun:test'
import {
    AUTO_COMPACT_TRIGGER_RATIO,
    getCompactCommandForFlavor,
    getEffectiveContextMax,
    normalizeContextLimit
} from './contextLimit'

describe('contextLimit', () => {
    it('maps every flavor with a known compact command and skips the rest', () => {
        expect(getCompactCommandForFlavor('claude')).toBe('/compact')
        expect(getCompactCommandForFlavor('codex')).toBe('/compact')
        expect(getCompactCommandForFlavor('opencode')).toBe('/compact')
        expect(getCompactCommandForFlavor('pi')).toBe('/compact')
        expect(getCompactCommandForFlavor('cursor')).toBe('/compress')
        expect(getCompactCommandForFlavor('gemini')).toBe('/compress')
        expect(getCompactCommandForFlavor('copilot')).toBeNull()
        expect(getCompactCommandForFlavor(null)).toBeNull()
    })

    it('clamps into the range Claude Code accepts', () => {
        expect(normalizeContextLimit(50_000)).toBe(100_000)
        expect(normalizeContextLimit(250_000)).toBe(250_000)
        expect(normalizeContextLimit(2_000_000)).toBe(1_000_000)
        expect(normalizeContextLimit(Number.NaN)).toBeNull()
    })

    it('never lets the limit extend the model window', () => {
        expect(getEffectiveContextMax(200_000, 1_000_000)).toBe(200_000)
        expect(getEffectiveContextMax(1_000_000, 200_000)).toBe(200_000)
        expect(getEffectiveContextMax(null, 200_000)).toBe(200_000)
        expect(getEffectiveContextMax(1_000_000, null)).toBe(1_000_000)
        expect(getEffectiveContextMax(null, null)).toBeNull()
    })

    it('triggers before the ceiling to leave room for the compact turn', () => {
        expect(AUTO_COMPACT_TRIGGER_RATIO).toBeGreaterThan(0.5)
        expect(AUTO_COMPACT_TRIGGER_RATIO).toBeLessThan(1)
    })
})
