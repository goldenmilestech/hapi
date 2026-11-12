import { describe, expect, it } from 'vitest'
import { parseUpdateArgs } from './update'

describe('parseUpdateArgs', () => {
    it('defaults to an interactive update', () => {
        expect(parseUpdateArgs([])).toEqual({
            check: false,
            force: false,
            tag: null,
            keep: 3,
            wait: true,
            bin: null
        })
    })

    it('parses flags with separate and inline values', () => {
        expect(parseUpdateArgs([
            '--check',
            '--force',
            '--no-wait',
            '--tag=cli-20261112-deadbeef',
            '--keep', '5',
            '--bin', '/tmp/hapi'
        ])).toEqual({
            check: true,
            force: true,
            tag: 'cli-20261112-deadbeef',
            keep: 5,
            wait: false,
            bin: '/tmp/hapi'
        })
    })

    it('returns null for help', () => {
        expect(parseUpdateArgs(['--help'])).toBeNull()
        expect(parseUpdateArgs(['-h'])).toBeNull()
        expect(parseUpdateArgs(['help'])).toBeNull()
    })

    it('rejects unknown options and invalid values', () => {
        expect(() => parseUpdateArgs(['--nope'])).toThrow(/Unknown option/)
        expect(() => parseUpdateArgs(['--keep', 'x'])).toThrow(/non-negative integer/)
        expect(() => parseUpdateArgs(['--tag'])).toThrow(/requires a value/)
    })
})
