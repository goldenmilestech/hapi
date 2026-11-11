import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { useCopyToClipboard } from './useCopyToClipboard'

vi.mock('@/lib/clipboard', () => ({
    safeCopyToClipboard: vi.fn(async () => {})
}))

describe('useCopyToClipboard', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('flags copied for the reset window and then clears it', async () => {
        const { result } = renderHook(() => useCopyToClipboard(1500))

        await act(async () => {
            await result.current.copy('assistant text')
        })

        expect(safeCopyToClipboard).toHaveBeenCalledWith('assistant text')
        expect(result.current.copied).toBe(true)

        act(() => {
            vi.advanceTimersByTime(1499)
        })
        expect(result.current.copied).toBe(true)

        act(() => {
            vi.advanceTimersByTime(1)
        })
        expect(result.current.copied).toBe(false)
    })
})
