import { afterEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_PIN_IN_PROGRESS_MODE,
    PIN_IN_PROGRESS_STORAGE_KEY,
    getInitialPinInProgressMode,
    parsePinInProgressMode
} from './usePinInProgressSessions'

describe('parsePinInProgressMode', () => {
    it('defaults unset to off (fork keeps the directory fold)', () => {
        expect(parsePinInProgressMode(null)).toBe('off')
        expect(parsePinInProgressMode('')).toBe('off')
        expect(DEFAULT_PIN_IN_PROGRESS_MODE).toBe('off')
    })

    it('migrates legacy boolean strings', () => {
        expect(parsePinInProgressMode('true')).toBe('all')
        expect(parsePinInProgressMode('false')).toBe('off')
    })

    it('accepts explicit tri-state values', () => {
        expect(parsePinInProgressMode('off')).toBe('off')
        expect(parsePinInProgressMode('jobs')).toBe('jobs')
        expect(parsePinInProgressMode('all')).toBe('all')
    })

    it('falls back to off on garbage', () => {
        expect(parsePinInProgressMode('maybe')).toBe('off')
    })
})

describe('getInitialPinInProgressMode', () => {
    afterEach(() => {
        localStorage.removeItem(PIN_IN_PROGRESS_STORAGE_KEY)
    })

    it('persists the off default so later opt-in is distinct from unset', () => {
        localStorage.removeItem(PIN_IN_PROGRESS_STORAGE_KEY)
        expect(getInitialPinInProgressMode()).toBe('off')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('off')
    })

    it('rewrites legacy false to persisted off', () => {
        localStorage.setItem(PIN_IN_PROGRESS_STORAGE_KEY, 'false')
        expect(getInitialPinInProgressMode()).toBe('off')
        expect(localStorage.getItem(PIN_IN_PROGRESS_STORAGE_KEY)).toBe('off')
    })
})
