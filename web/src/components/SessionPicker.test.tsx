import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { SessionSummary } from '@/types/api'
import { SessionPicker } from './SessionPicker'

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

const sessions: SessionSummary[] = [
    session({
        id: 'session-a',
        active: true,
        thinking: true,
        updatedAt: 20,
        metadata: { name: 'Fix login', path: '/repo/web' }
    }),
    session({
        id: 'session-b',
        updatedAt: 10,
        metadata: { name: 'Old task', path: '/repo/web' }
    })
]

function renderPicker(onSelect = vi.fn(), bound = new Set<string>()) {
    return render(
        <I18nProvider>
            <SessionPicker
                sessions={sessions}
                selectedId="session-a"
                boundSessionIds={bound}
                onSelect={onSelect}
            />
        </I18nProvider>
    )
}

describe('SessionPicker', () => {
    beforeEach(() => {
        localStorage.setItem('hapi-lang', 'en')
    })

    afterEach(() => {
        cleanup()
        localStorage.clear()
    })

    it('renders grouped sessions with status and binding badges', () => {
        renderPicker(vi.fn(), new Set(['session-b']))

        expect(screen.getByText('repo/web')).toBeTruthy()
        expect(screen.getByText('Fix login')).toBeTruthy()
        expect(screen.getByText('Running')).toBeTruthy()
        expect(screen.getByText('Not running')).toBeTruthy()
        expect(screen.getByText('Bound')).toBeTruthy()
    })

    it('filters by title and selects a session', () => {
        const onSelect = vi.fn()
        renderPicker(onSelect)

        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old' } })
        expect(screen.queryByText('Fix login')).toBeNull()
        expect(screen.getByText('Old task')).toBeTruthy()

        fireEvent.click(screen.getByText('Old task'))
        expect(onSelect).toHaveBeenCalledWith('session-b')
    })
})
