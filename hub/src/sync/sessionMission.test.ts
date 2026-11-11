import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'

function setup() {
    const store = new Store(':memory:')
    const events: Array<{ type?: string; sessionId?: string }> = []
    const cache = new SessionCache(store, {
        emit(event: { type?: string; sessionId?: string }) {
            events.push(event)
        }
    } as unknown as EventPublisher)
    const create = (tag: string, metadata: Record<string, unknown> = {}) => cache.getOrCreateSession(tag, {
        path: '/project',
        host: 'localhost',
        ...metadata
    }, null, 'default')
    return { store, cache, create, events }
}

describe('session mission metadata', () => {
    it('sets grouping fields and emits a metadata patch', () => {
        const { store, cache, create, events } = setup()
        try {
            const session = create('worker')
            expect(cache.setSessionMission(session.id, {
                missionId: 'mission-1',
                parentSessionId: 'manager-1'
            })).toBe(true)

            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({
                missionId: 'mission-1',
                parentSessionId: 'manager-1'
            })
            expect(events.some((event) => event.type === 'session-updated' && event.sessionId === session.id)).toBe(true)
        } finally {
            store.close()
        }
    })

    it('clears a field with null', () => {
        const { store, cache, create } = setup()
        try {
            const session = create('worker', { missionId: 'mission-1', parentSessionId: 'manager-1' })
            expect(cache.setSessionMission(session.id, { missionId: null })).toBe(true)
            const metadata = store.sessions.getSession(session.id)?.metadata as Record<string, unknown>
            expect(metadata).not.toHaveProperty('missionId')
            expect(metadata.parentSessionId).toBe('manager-1')
        } finally {
            store.close()
        }
    })

    it('is a no-op when the values already match', () => {
        const { store, cache, create } = setup()
        try {
            const session = create('worker', { missionId: 'mission-1' })
            const before = store.sessions.getSession(session.id)!
            expect(cache.setSessionMission(session.id, { missionId: 'mission-1' })).toBe(true)
            expect(store.sessions.getSession(session.id)?.metadataVersion).toBe(before.metadataVersion)
        } finally {
            store.close()
        }
    })

    it('survives a sparse CLI metadata snapshot', () => {
        const { store, cache, create } = setup()
        try {
            const session = create('worker')
            expect(cache.setSessionMission(session.id, {
                missionId: 'mission-1',
                parentSessionId: 'manager-1'
            })).toBe(true)

            const current = store.sessions.getSession(session.id)!
            store.sessions.updateSessionMetadata(session.id, {
                path: '/project',
                host: 'localhost',
                name: 'Renamed by CLI'
            }, current.metadataVersion, 'default')

            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({
                name: 'Renamed by CLI',
                missionId: 'mission-1',
                parentSessionId: 'manager-1'
            })
        } finally {
            store.close()
        }
    })

    it('adopts a remit parent and derives the mission from the parent', () => {
        const { store, cache, create } = setup()
        try {
            const manager = create('manager', { missionId: 'mission-root' })
            const worker = create('worker')
            expect(cache.adoptRemitParent(worker.id, manager.id)).toBe(true)
            expect(store.sessions.getSession(worker.id)?.metadata).toMatchObject({
                parentSessionId: manager.id,
                missionId: 'mission-root'
            })
        } finally {
            store.close()
        }
    })

    it('uses the parent id as the mission root when the parent has no missionId', () => {
        const { store, cache, create } = setup()
        try {
            const manager = create('manager')
            const worker = create('worker')
            expect(cache.adoptRemitParent(worker.id, manager.id)).toBe(true)
            expect(store.sessions.getSession(worker.id)?.metadata).toMatchObject({
                parentSessionId: manager.id,
                missionId: manager.id
            })
        } finally {
            store.close()
        }
    })

    it('does not overwrite an explicit parent', () => {
        const { store, cache, create } = setup()
        try {
            const manager = create('manager')
            const other = create('other')
            const worker = create('worker', { parentSessionId: other.id })
            expect(cache.adoptRemitParent(worker.id, manager.id)).toBe(false)
            expect(store.sessions.getSession(worker.id)?.metadata).toMatchObject({
                parentSessionId: other.id
            })
        } finally {
            store.close()
        }
    })
})
