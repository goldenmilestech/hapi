import { describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { Store } from './index'
import { hashAccessToken, NamespaceAlreadyBoundError } from './accessTokens'

describe('AccessTokenStore', () => {
    it('stores only a hash and resolves the token back to its namespace', () => {
        const store = new Store(':memory:')
        const { token, record } = store.accessTokens.create({ name: 'Alice laptop', namespace: 'alice' })

        expect(token.startsWith('hapi_')).toBe(true)
        expect(record.namespace).toBe('alice')
        expect(record.tokenHash).toBe(hashAccessToken(token))
        expect(record.tokenHash).not.toContain(token)

        const found = store.accessTokens.getByTokenHash(hashAccessToken(token))
        expect(found?.id).toBe(record.id)
        expect(found?.namespace).toBe('alice')

        expect(store.accessTokens.list()).toHaveLength(1)
        expect(store.accessTokens.list()[0].tokenPrefix).toBe(token.slice(0, 12))
        expect(store.accessTokens.list()[0]).not.toHaveProperty('tokenHash')

        store.close()
    })

    it('rejects unknown hashes and revoked tokens', () => {
        const store = new Store(':memory:')
        const { token, record } = store.accessTokens.create({ name: 'Bob', namespace: 'bob' })

        expect(store.accessTokens.getByTokenHash(hashAccessToken('hapi_not-a-real-token'))).toBeNull()
        expect(store.accessTokens.isTokenIdRevoked(record.id)).toBe(false)

        expect(store.accessTokens.revoke(record.id)).toBe(true)
        expect(store.accessTokens.getByTokenHash(hashAccessToken(token))?.revokedAt).not.toBeNull()
        expect(store.accessTokens.isTokenIdRevoked(record.id)).toBe(true)
        // A JWT pointing at a token row that no longer exists must fail closed.
        expect(store.accessTokens.isTokenIdRevoked('missing-id')).toBe(true)

        store.close()
    })

    it('notifies revoke listeners once and keeps revoke idempotent', () => {
        const store = new Store(':memory:')
        const { record } = store.accessTokens.create({ name: 'Carol', namespace: 'carol' })
        const seen: string[] = []
        const unsubscribe = store.accessTokens.onRevoke((id) => seen.push(id))

        expect(store.accessTokens.revoke(record.id)).toBe(true)
        expect(store.accessTokens.revoke(record.id)).toBe(true)
        expect(seen).toEqual([record.id])
        expect(store.accessTokens.revoke('missing-id')).toBe(false)

        unsubscribe()
        const other = store.accessTokens.create({ name: 'Dave', namespace: 'dave' })
        store.accessTokens.revoke(other.record.id)
        expect(seen).toEqual([record.id])

        store.close()
    })

    it('throttles last-used writes', () => {
        const store = new Store(':memory:')
        const { record } = store.accessTokens.create({ name: 'Eve', namespace: 'eve' })

        store.accessTokens.touchLastUsed(record.id, 1_000)
        expect(store.accessTokens.getById(record.id)?.lastUsedAt).toBe(1_000)

        // Inside the 60s window: memory and DB keep the first timestamp.
        store.accessTokens.touchLastUsed(record.id, 30_000)
        expect(store.accessTokens.getById(record.id)?.lastUsedAt).toBe(1_000)

        store.accessTokens.touchLastUsed(record.id, 70_000)
        expect(store.accessTokens.getById(record.id)?.lastUsedAt).toBe(70_000)

        store.close()
    })

    it('allows only one active token per namespace', () => {
        const store = new Store(':memory:')
        const first = store.accessTokens.create({ name: 'Alice laptop', namespace: 'alice' })

        expect(() => store.accessTokens.create({ name: 'Alice phone', namespace: 'alice' }))
            .toThrow(NamespaceAlreadyBoundError)
        expect(store.accessTokens.getActiveByNamespace('alice')?.id).toBe(first.record.id)

        // Revoking frees the namespace for a replacement token.
        store.accessTokens.revoke(first.record.id)
        const second = store.accessTokens.create({ name: 'Alice phone', namespace: 'alice' })
        expect(store.accessTokens.getActiveByNamespace('alice')?.id).toBe(second.record.id)

        // Expired tokens do not hold a namespace.
        store.accessTokens.revoke(second.record.id)
        store.accessTokens.create({ name: 'Temporary', namespace: 'bob', expiresAt: Date.now() - 1 })
        expect(store.accessTokens.getActiveByNamespace('bob')).toBeNull()
        expect(() => store.accessTokens.create({ name: 'Bob', namespace: 'bob' })).not.toThrow()

        store.close()
    })

    it('persists tokens across store instances', () => {
        const path = `${process.env.TMPDIR ?? '/tmp'}/hapi-access-tokens-${process.pid}-${Date.now()}.db`
        const first = new Store(path)
        const { token, record } = first.accessTokens.create({ name: 'Frank', namespace: 'frank' })
        first.close()

        const second = new Store(path)
        expect(second.accessTokens.getByTokenHash(hashAccessToken(token))?.id).toBe(record.id)
        second.close()

        for (const suffix of ['', '-wal', '-shm']) {
            try {
                rmSync(`${path}${suffix}`, { force: true })
            } catch {
                // best effort cleanup
            }
        }
    })
})
