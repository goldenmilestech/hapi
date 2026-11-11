import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { hashShareToken } from './sessionShares'

function setup() {
    const store = new Store(':memory:')
    const share = store.sessionShares.create({
        id: 'share-1',
        sessionId: 'session-1',
        namespace: 'default',
        tokenHash: hashShareToken('token-1'),
        mode: 'chat',
        expiresAt: Date.now() + 60_000
    })
    return { store, share }
}

describe('SessionShareStore', () => {
    it('accepts an explicit id and scopes lookups by session and namespace', () => {
        const { store, share } = setup()

        expect(share.id).toBe('share-1')
        expect(store.sessionShares.getById('share-1', 'session-1', 'default')?.id).toBe('share-1')
        expect(store.sessionShares.getById('share-1', 'session-2', 'default')).toBeNull()
        expect(store.sessionShares.getById('share-1', 'session-1', 'other')).toBeNull()
    })

    it('updates the expiry of an active share, including an expired one', () => {
        const { store } = setup()
        const expiredAt = Date.now() - 1_000
        const renewedAt = Date.now() + 3_600_000

        expect(store.sessionShares.updateExpiresAt('share-1', 'session-1', 'default', expiredAt)?.expiresAt)
            .toBe(expiredAt)
        expect(store.sessionShares.updateExpiresAt('share-1', 'session-1', 'default', renewedAt)?.expiresAt)
            .toBe(renewedAt)
        expect(store.sessionShares.updateExpiresAt('share-1', 'session-2', 'default', renewedAt)).toBeNull()
        expect(store.sessionShares.updateExpiresAt('share-1', 'session-1', 'other', renewedAt)).toBeNull()
    })

    it('replaces the token hash of an active share only', () => {
        const { store } = setup()
        const newHash = hashShareToken('token-2')

        expect(store.sessionShares.updateTokenHash('share-1', 'session-1', 'default', newHash)?.tokenHash)
            .toBe(newHash)
        expect(store.sessionShares.getByTokenHash(hashShareToken('token-1'))).toBeNull()
        expect(store.sessionShares.getByTokenHash(newHash)?.id).toBe('share-1')

        store.sessionShares.revoke('share-1', 'session-1', 'default')
        expect(store.sessionShares.updateTokenHash('share-1', 'session-1', 'default', hashShareToken('token-3')))
            .toBeNull()
        expect(store.sessionShares.updateExpiresAt('share-1', 'session-1', 'default', Date.now() + 1_000))
            .toBeNull()
    })
})
