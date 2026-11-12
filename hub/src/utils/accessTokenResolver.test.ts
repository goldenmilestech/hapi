import { describe, expect, it } from 'bun:test'
import { hashAccessToken, type AccessTokenRecord } from '../store/accessTokens'
import { resolveAccessToken } from './accessTokenResolver'

function makeRecord(overrides: Partial<AccessTokenRecord> = {}): AccessTokenRecord {
    return {
        id: 'token-1',
        name: 'Alice',
        namespace: 'alice',
        tokenHash: hashAccessToken('hapi_alice-token'),
        tokenPrefix: 'hapi_alice-',
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        ...overrides
    }
}

function makeDeps(options: {
    record?: AccessTokenRecord | null
    legacyToken?: string | null
    claimedNamespaces?: string[]
}) {
    const touched: string[] = []
    const claimed = new Set(options.claimedNamespaces ?? [])
    return {
        touched,
        deps: {
            getByTokenHash: (tokenHash: string) => (
                options.record && options.record.tokenHash === tokenHash ? options.record : null
            ),
            touchLastUsed: (id: string) => touched.push(id),
            getActiveByNamespace: (namespace: string) => (
                claimed.has(namespace) ? makeRecord({ namespace }) : null
            ),
            legacyToken: options.legacyToken ?? null
        }
    }
}

describe('resolveAccessToken', () => {
    it('resolves a hub-issued token to its bound namespace', () => {
        const { deps, touched } = makeDeps({ record: makeRecord() })

        expect(resolveAccessToken('hapi_alice-token', deps)).toEqual({
            namespace: 'alice',
            tokenId: 'token-1',
            source: 'access-token'
        })
        expect(touched).toEqual(['token-1'])
    })

    it('trims surrounding whitespace before matching', () => {
        const { deps } = makeDeps({ record: makeRecord() })
        expect(resolveAccessToken('  hapi_alice-token\n', deps)?.namespace).toBe('alice')
    })

    it('rejects revoked and expired tokens', () => {
        const revoked = makeDeps({ record: makeRecord({ revokedAt: 10 }) })
        expect(resolveAccessToken('hapi_alice-token', revoked.deps)).toBeNull()

        const expired = makeDeps({ record: makeRecord({ expiresAt: Date.now() - 1 }) })
        expect(resolveAccessToken('hapi_alice-token', expired.deps)).toBeNull()

        const future = makeDeps({ record: makeRecord({ expiresAt: Date.now() + 60_000 }) })
        expect(resolveAccessToken('hapi_alice-token', future.deps)?.namespace).toBe('alice')
    })

    it('falls back to the legacy shared token while it is enabled', () => {
        const { deps } = makeDeps({ legacyToken: 'shared-secret' })

        expect(resolveAccessToken('shared-secret:team', deps)).toEqual({
            namespace: 'team',
            tokenId: null,
            source: 'legacy'
        })
        expect(resolveAccessToken('shared-secret', deps)).toEqual({
            namespace: 'default',
            tokenId: null,
            source: 'legacy'
        })
    })

    it('keeps the legacy token out of a namespace claimed by an access token', () => {
        const { deps } = makeDeps({ legacyToken: 'shared-secret', claimedNamespaces: ['team', 'default'] })

        expect(resolveAccessToken('shared-secret:team', deps)).toBeNull()
        expect(resolveAccessToken('shared-secret', deps)).toBeNull()
        // Unclaimed namespaces still work while the legacy path is enabled.
        expect(resolveAccessToken('shared-secret:other', deps)?.namespace).toBe('other')
    })

    it('rejects the legacy token when the operator disabled it', () => {
        const { deps } = makeDeps({ legacyToken: null })
        expect(resolveAccessToken('shared-secret:team', deps)).toBeNull()
    })

    it('rejects unknown and empty credentials', () => {
        const { deps } = makeDeps({ legacyToken: 'shared-secret' })
        expect(resolveAccessToken('hapi_unknown', deps)).toBeNull()
        expect(resolveAccessToken('other-secret:team', deps)).toBeNull()
        expect(resolveAccessToken('   ', deps)).toBeNull()
    })
})
