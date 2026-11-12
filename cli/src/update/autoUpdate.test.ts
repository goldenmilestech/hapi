import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    autoUpdateEnabled,
    maybeAutoUpdateNow,
    nextAutoUpdateDelayMs,
    resetAutoUpdateStateForTests
} from './autoUpdate'

const HOUR = 60 * 60_000

describe('autoUpdateEnabled', () => {
    it('accepts explicit truthy values only', () => {
        expect(autoUpdateEnabled({ HAPI_AUTO_UPDATE: '1' })).toBe(true)
        expect(autoUpdateEnabled({ HAPI_AUTO_UPDATE: 'true' })).toBe(true)
        expect(autoUpdateEnabled({ HAPI_AUTO_UPDATE: 'YES' })).toBe(true)
        expect(autoUpdateEnabled({ HAPI_AUTO_UPDATE: 'on' })).toBe(true)
        expect(autoUpdateEnabled({ HAPI_AUTO_UPDATE: '0' })).toBe(false)
        expect(autoUpdateEnabled({})).toBe(false)
    })

    it('stays off when version handoff is disabled', () => {
        expect(autoUpdateEnabled({
            HAPI_AUTO_UPDATE: '1',
            HAPI_DISABLE_VERSION_HANDOFF: '1'
        })).toBe(false)
    })
})

describe('nextAutoUpdateDelayMs', () => {
    it('uses six hours after success and one hour after failure', () => {
        expect(nextAutoUpdateDelayMs('success', () => 0)).toBe(6 * HOUR)
        expect(nextAutoUpdateDelayMs('error', () => 0)).toBe(HOUR)
    })

    it('adds up to 10% jitter', () => {
        expect(nextAutoUpdateDelayMs('success', () => 1)).toBe(6 * HOUR + 0.6 * HOUR)
        expect(nextAutoUpdateDelayMs('error', () => 1)).toBe(HOUR + 0.1 * HOUR)
    })
})

describe('maybeAutoUpdateNow', () => {
    const original = process.env.HAPI_AUTO_UPDATE

    afterEach(() => {
        resetAutoUpdateStateForTests()
        if (original === undefined) {
            delete process.env.HAPI_AUTO_UPDATE
        } else {
            process.env.HAPI_AUTO_UPDATE = original
        }
    })

    it('does nothing when disabled', async () => {
        delete process.env.HAPI_AUTO_UPDATE
        const run = vi.fn(async () => 0)

        await maybeAutoUpdateNow({ now: 1_000, run })

        expect(run).not.toHaveBeenCalled()
    })

    it('runs once per interval', async () => {
        process.env.HAPI_AUTO_UPDATE = '1'
        const run = vi.fn(async () => 0)

        await maybeAutoUpdateNow({ now: 1_000, run })
        await maybeAutoUpdateNow({ now: 1_001, run })
        expect(run).toHaveBeenCalledTimes(1)

        await maybeAutoUpdateNow({ now: 1_000 + 7 * HOUR, run })
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('retries after an hour when the update throws', async () => {
        process.env.HAPI_AUTO_UPDATE = '1'
        const run = vi.fn(async () => {
            throw new Error('network down')
        })

        await maybeAutoUpdateNow({ now: 0, run })
        await maybeAutoUpdateNow({ now: HOUR - 1, run })
        expect(run).toHaveBeenCalledTimes(1)

        await maybeAutoUpdateNow({ now: 2 * HOUR, run })
        expect(run).toHaveBeenCalledTimes(2)
    })
})
