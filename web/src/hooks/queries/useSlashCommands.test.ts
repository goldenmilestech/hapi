import { describe, expect, it } from 'vitest'
import type { SkillSummary, SlashCommand } from '@/types/api'
import { buildSlashMenuEntries } from './useSlashCommands'

function command(partial: Partial<SlashCommand> & Pick<SlashCommand, 'name'>): SlashCommand {
    return { source: 'project', ...partial }
}

function skill(partial: Partial<SkillSummary> & Pick<SkillSummary, 'name'>): SkillSummary {
    return { ...partial }
}

describe('buildSlashMenuEntries', () => {
    it('lists slash commands before skills and inserts $ for skills', () => {
        const entries = buildSlashMenuEntries(
            [command({ name: 'compact', source: 'builtin' }), command({ name: 'opsx:apply', description: 'Apply a change' })],
            [skill({ name: 'find-skills', description: 'Find installable skills' })]
        )

        expect(entries.map((entry) => entry.text)).toEqual(['/compact', '/opsx:apply', '$find-skills'])
        expect(entries[0].description).toBeUndefined()
        expect(entries[0].source).toBe('builtin')
        expect(entries[1].description).toBe('Apply a change')
        expect(entries[2].description).toBe('Find installable skills')
        expect(entries[2].source).toBe('skill')
    })

    it('falls back to a description for non-builtin commands without one', () => {
        const entries = buildSlashMenuEntries([command({ name: 'custom' })], [])

        expect(entries[0].description).toBe('Custom command')
    })

    it('keeps the slash command when a skill shares its name', () => {
        const entries = buildSlashMenuEntries(
            [command({ name: 'review', source: 'plugin' })],
            [skill({ name: 'Review', description: 'Review skill' })]
        )

        expect(entries).toHaveLength(1)
        expect(entries[0].text).toBe('/review')
        expect(entries[0].source).toBe('plugin')
    })

    it('dedupes commands and skills case-insensitively', () => {
        const entries = buildSlashMenuEntries(
            [command({ name: 'Deploy' }), command({ name: 'deploy' })],
            [skill({ name: 'DEPLOY' }), skill({ name: 'find-skills' })]
        )

        expect(entries.map((entry) => entry.text)).toEqual(['/Deploy', '$find-skills'])
    })
})
