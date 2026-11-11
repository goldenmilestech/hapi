import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => events.push(event)
    } as unknown as EventPublisher
}

describe('SessionCache.repairLegacyUploadPathTitles', () => {
    it('replaces a legacy upload-path summary with the first prompt title', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'legacy-title',
            { path: '/tmp', host: 'localhost' },
            null,
            'default'
        )
        store.messages.addMessage(session.id, {
            role: 'user',
            content: {
                type: 'text',
                text: 'jenkins 经常出现这个问题，怎么根治',
                attachments: [{ path: '/tmp/hapi-blobs/legacy-title/1-image.png' }]
            }
        })
        await cache.updateSessionSummary(
            session.id,
            '@/var/folders/dq/x/T/hapi-blobs/legacy-title/1-image.png…'
        )

        cache.repairLegacyUploadPathTitles()

        const repaired = cache.getSession(session.id)
        expect(repaired?.metadata?.summary).toBeUndefined()
        expect(repaired?.metadata?.promptTitle).toBe('jenkins 经常出现这个问题，怎么根治')
        expect(events.some((event) => event.type === 'session-updated' && event.sessionId === session.id)).toBe(true)

        const stored = store.sessions.getSession(session.id)
        expect(stored?.metadata).toMatchObject({ promptTitle: 'jenkins 经常出现这个问题，怎么根治' })
        expect(stored?.metadata).not.toHaveProperty('summary')
        store.close()
    })

    it('leaves real summaries alone', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const session = cache.getOrCreateSession(
            'real-title',
            { path: '/tmp', host: 'localhost' },
            null,
            'default'
        )
        await cache.updateSessionSummary(session.id, 'Login redirect fix')

        cache.repairLegacyUploadPathTitles()

        expect(cache.getSession(session.id)?.metadata?.summary?.text).toBe('Login redirect fix')
        store.close()
    })
})
