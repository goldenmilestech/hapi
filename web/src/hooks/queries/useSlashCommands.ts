import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SkillSummary, SlashCommand } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { queryKeys } from '@/lib/query-keys'
import { getBuiltinSlashCommands, mergeSlashCommands } from '@/lib/codexSlashCommands'
import { useSessionSkills } from './useSkills'

function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length
    if (b.length === 0) return a.length
    const matrix: number[][] = []
    for (let i = 0; i <= b.length; i++) matrix[i] = [i]
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b[i - 1] === a[j - 1]
                ? matrix[i - 1][j - 1]
                : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        }
    }
    return matrix[b.length][a.length]
}

/** One row of the `/` menu: a slash command or a skill. */
export interface SlashMenuEntry {
    name: string
    description?: string
    /** What selecting the row inserts: `/command` for commands, `$skill` for skills. */
    text: string
    source: NonNullable<Suggestion['source']>
    content?: string
}

/**
 * Build the `/` menu from slash commands plus the session's skill catalog.
 *
 * Skills keep their `$name` spelling because that is the invocation every
 * flavor understands: Claude expands it to the native `/name` command, Codex
 * turns it into a `skill` input, Pi rewrites it to `skill:name`, and the ACP
 * agents reach it through `skill_lookup`. Inserting `/name` instead would
 * silently degrade to plain text outside Claude.
 *
 * A slash command wins over a skill with the same name: the command is the
 * explicit, installed gesture, and only one row can own the lookup.
 */
export function buildSlashMenuEntries(
    commands: readonly SlashCommand[],
    skills: readonly SkillSummary[]
): SlashMenuEntry[] {
    const entries: SlashMenuEntry[] = []
    const seen = new Set<string>()

    for (const command of commands) {
        const key = command.name.toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        entries.push({
            name: command.name,
            description: command.description ?? (command.source === 'builtin' ? undefined : 'Custom command'),
            text: `/${command.name}`,
            source: command.source,
            content: command.content,
        })
    }

    for (const skill of skills) {
        const key = skill.name.toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        entries.push({
            name: skill.name,
            description: skill.description,
            text: `$${skill.name}`,
            source: 'skill',
        })
    }

    return entries
}

function toSuggestion(entry: SlashMenuEntry): Suggestion {
    return {
        key: entry.text,
        text: entry.text,
        label: entry.text,
        description: entry.description,
        content: entry.content,
        source: entry.source,
    }
}

export function useSlashCommands(
    api: ApiClient | null,
    sessionId: string | null,
    agentType: string = 'claude'
): {
    commands: SlashCommand[]
    isLoading: boolean
    error: string | null
    getSuggestions: (query: string) => Promise<Suggestion[]>
} {
    const resolvedSessionId = sessionId ?? 'unknown'

    // Fetch user-defined commands from the CLI (requires active session)
    const query = useQuery({
        queryKey: queryKeys.slashCommands(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSlashCommands(sessionId)
        },
        enabled: Boolean(api && sessionId),
        // Same reasoning as useSkills: the command list is near-static, so it
        // is refetched when the user opens the menu with "/" rather than on a
        // 30s timer that runs for as long as the session is open.
        staleTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        gcTime: 30 * 60 * 1000,
        retry: false, // Don't retry RPC failures
    })

    // Skills share the `$` menu's cache entry, so listing them here costs no
    // extra RPC in the common case.
    const skillsQuery = useSessionSkills(api, sessionId)
    const skills = useMemo(() => skillsQuery.data?.skills ?? [], [skillsQuery.data])

    // Merge local built-ins with commands discovered by the active CLI.
    // The CLI can expose agent-specific built-ins plus user/plugin/project commands;
    // keep local built-ins as an offline fallback, then append/override from RPC.
    const commands = useMemo(() => {
        const builtin = getBuiltinSlashCommands(agentType)

        if (query.data?.success && query.data.commands) {
            return mergeSlashCommands([...builtin, ...query.data.commands])
        }

        // Fallback to built-in commands only
        return builtin
    }, [agentType, query.data])

    const entries = useMemo(
        () => buildSlashMenuEntries(commands, skills),
        [commands, skills]
    )

    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        // Opening the menu is the one moment a stale list is visible, so
        // refresh here instead of polling in the background. Fire-and-forget:
        // the /slash-commands RPC can stall for its full 30s timeout when the
        // CLI is wedged, and the menu must show cached + built-in commands
        // immediately - the refreshed list flows in via query state.
        if (queryText === '/') {
            void query.refetch()
            void skillsQuery.refetch()
        }

        const searchTerm = queryText.startsWith('/')
            ? queryText.slice(1).toLowerCase()
            : queryText.toLowerCase()

        if (!searchTerm) {
            return entries.map(toSuggestion)
        }

        const maxDistance = Math.max(2, Math.floor(searchTerm.length / 2))
        return entries
            .map(entry => {
                const name = entry.name.toLowerCase()
                let score: number
                if (name === searchTerm) score = 0
                else if (name.startsWith(searchTerm)) score = 1
                else if (name.includes(searchTerm)) score = 2
                else {
                    const dist = levenshteinDistance(searchTerm, name)
                    score = dist <= maxDistance ? 3 + dist : Infinity
                }
                return { entry, score }
            })
            .filter(item => item.score < Infinity)
            .sort((a, b) => a.score - b.score)
            .map(({ entry }) => toSuggestion(entry))
    }, [entries, query.refetch, skillsQuery.refetch])

    return {
        commands,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load commands' : null,
        getSuggestions,
    }
}
