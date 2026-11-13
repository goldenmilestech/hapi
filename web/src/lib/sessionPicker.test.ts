import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    filterSessionsForPicker,
    getSessionPickerStatus,
    groupSessionsForPicker
} from './sessionPicker'

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    const { id, ...rest } = overrides
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...rest
    }
}

describe('session picker helpers', () => {
    it('derives a single status with running and approvals taking precedence', () => {
        expect(getSessionPickerStatus(session({ id: 'a', active: true, thinking: true }))).toBe('running')
        expect(getSessionPickerStatus(session({ id: 'a', active: true, pendingRequestsCount: 1 }))).toBe('pending')
        expect(getSessionPickerStatus(session({ id: 'a', active: true, metadata: { path: '/p', lifecycleState: 'idle' } }))).toBe('idle')
        expect(getSessionPickerStatus(session({ id: 'a', active: true }))).toBe('active')
        expect(getSessionPickerStatus(session({ id: 'a' }))).toBe('offline')
    })

    it('matches title, project path and session id case-insensitively', () => {
        const sessions = [
            session({ id: 'abc123', metadata: { name: 'Fix Login', path: '/repo/web-app' } }),
            session({ id: 'def456', metadata: { name: 'Other', path: '/repo/api' } })
        ]

        expect(filterSessionsForPicker(sessions, 'login').map((s) => s.id)).toEqual(['abc123'])
        expect(filterSessionsForPicker(sessions, 'WEB-APP').map((s) => s.id)).toEqual(['abc123'])
        expect(filterSessionsForPicker(sessions, 'def4').map((s) => s.id)).toEqual(['def456'])
        expect(filterSessionsForPicker(sessions, 'missing')).toEqual([])
    })

    it('groups by project and keeps active sessions first inside a group', () => {
        const groups = groupSessionsForPicker([
            session({ id: 'old-active', active: true, updatedAt: 10, metadata: { path: '/repo/a' } }),
            session({ id: 'new-inactive', updatedAt: 30, metadata: { path: '/repo/a' } }),
            session({ id: 'b', updatedAt: 20, metadata: { path: '/repo/b' } }),
            session({ id: 'unknown', updatedAt: 5, metadata: null })
        ], 'Other projects')

        expect(groups.map((group) => group.label)).toEqual(['repo/a', 'repo/b', 'Other projects'])
        expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['old-active', 'new-inactive'])
    })
})
