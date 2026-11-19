import { describe, expect, it } from 'vitest'
import {
    STICKY_PROMPT_BAR_HEIGHT_PX,
    STICKY_PROMPT_READING_GAP_PX,
    findPinnedPromptIndex,
    resolvePinnedPrompt
} from './StickyPromptBar'

const READING_OFFSET = STICKY_PROMPT_BAR_HEIGHT_PX + STICKY_PROMPT_READING_GAP_PX
const VIEWPORT_TOP = 100

describe('resolvePinnedPrompt', () => {
    it('reports above-first when the window starts before the first prompt', () => {
        expect(resolvePinnedPrompt([
            { top: VIEWPORT_TOP + READING_OFFSET + 20, bottom: VIEWPORT_TOP + READING_OFFSET + 60 }
        ], VIEWPORT_TOP)).toEqual({ kind: 'above-first' })
    })

    it('reports above-first when nothing is rendered', () => {
        expect(resolvePinnedPrompt([], VIEWPORT_TOP)).toEqual({ kind: 'above-first' })
    })

    it('reports visible while the prompt bubble is on screen', () => {
        expect(resolvePinnedPrompt([
            { top: VIEWPORT_TOP - 10, bottom: VIEWPORT_TOP + READING_OFFSET + 20 }
        ], VIEWPORT_TOP)).toEqual({ kind: 'visible', index: 0 })
    })

    it('reports pinned once the prompt crossed the reading line', () => {
        expect(resolvePinnedPrompt([
            { top: VIEWPORT_TOP - 200, bottom: VIEWPORT_TOP - 160 }
        ], VIEWPORT_TOP)).toEqual({ kind: 'pinned', index: 0 })
    })
})

describe('findPinnedPromptIndex', () => {
    it('returns null when nothing is rendered', () => {
        expect(findPinnedPromptIndex([], VIEWPORT_TOP)).toBeNull()
    })

    it('returns null when every prompt is still below the reading line', () => {
        expect(findPinnedPromptIndex([
            { top: VIEWPORT_TOP + READING_OFFSET + 1, bottom: VIEWPORT_TOP + READING_OFFSET + 40 }
        ], VIEWPORT_TOP)).toBeNull()
    })

    it('pins a prompt that scrolled above the reading line', () => {
        expect(findPinnedPromptIndex([
            { top: VIEWPORT_TOP - 200, bottom: VIEWPORT_TOP - 160 }
        ], VIEWPORT_TOP)).toBe(0)
    })

    it('hides while the prompt bubble itself is still visible', () => {
        expect(findPinnedPromptIndex([
            // Top crossed the line, but the bubble still reaches into the
            // readable area: the bubble is its own header.
            { top: VIEWPORT_TOP - 10, bottom: VIEWPORT_TOP + READING_OFFSET + 20 }
        ], VIEWPORT_TOP)).toBeNull()
    })

    it('treats the bar-covered top edge as scrolled past', () => {
        // Bottom is inside the strip the bar covers, so the bar replaces the
        // covered part of the bubble instead of leaving the top headerless.
        expect(findPinnedPromptIndex([
            { top: VIEWPORT_TOP - 40, bottom: VIEWPORT_TOP + READING_OFFSET - 1 }
        ], VIEWPORT_TOP)).toBe(0)
    })

    it('pins the newest prompt that crossed the line', () => {
        expect(findPinnedPromptIndex([
            { top: VIEWPORT_TOP - 900, bottom: VIEWPORT_TOP - 860 },
            { top: VIEWPORT_TOP - 400, bottom: VIEWPORT_TOP - 360 },
            { top: VIEWPORT_TOP + 400, bottom: VIEWPORT_TOP + 440 }
        ], VIEWPORT_TOP)).toBe(1)
    })

    it('keeps the previous turn while the viewport sits in the gap above the next prompt', () => {
        // The next question is visible lower in the viewport, but the content
        // at the reading line still belongs to the previous answer.
        expect(findPinnedPromptIndex([
            { top: VIEWPORT_TOP - 900, bottom: VIEWPORT_TOP - 860 },
            { top: VIEWPORT_TOP + READING_OFFSET + 30, bottom: VIEWPORT_TOP + READING_OFFSET + 90 }
        ], VIEWPORT_TOP)).toBe(0)
    })

    it('uses the provided reading offset', () => {
        const rects = [
            { top: VIEWPORT_TOP - 20, bottom: VIEWPORT_TOP + 2 }
        ]
        expect(findPinnedPromptIndex(rects, VIEWPORT_TOP, 4)).toBe(0)
        expect(findPinnedPromptIndex(rects, VIEWPORT_TOP, 0)).toBeNull()
    })
})
