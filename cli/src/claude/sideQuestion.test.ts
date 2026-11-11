import { describe, expect, it } from 'vitest'
import { parseSideQuestionAnswer } from './sideQuestion'

describe('parseSideQuestionAnswer', () => {
    it('returns the answer text and synthetic flag', () => {
        expect(parseSideQuestionAnswer({
            response: 'answer',
            synthetic: false
        })).toEqual({ response: 'answer', synthetic: false })
    })

    it('defaults synthetic to false', () => {
        expect(parseSideQuestionAnswer({ response: 'answer' })).toEqual({
            response: 'answer',
            synthetic: false
        })
    })

    it('returns null for a null response', () => {
        expect(parseSideQuestionAnswer({ response: null })).toBeNull()
    })

    it('returns null for empty or malformed responses', () => {
        expect(parseSideQuestionAnswer({ response: '   ' })).toBeNull()
        expect(parseSideQuestionAnswer({ response: 42 })).toBeNull()
        expect(parseSideQuestionAnswer(null)).toBeNull()
    })
})
