import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { PersonalAccessTokenResponse } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import { resolveAccessToken } from '../../utils/accessTokenResolver'
import type { WebAppEnv } from '../middleware/auth'
import { createMeAccessTokenRoutes } from './meAccessToken'

let dataDir: string

beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hapi-me-token-'))
})

afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
})

function createApp(store: Store, options: { namespace?: string; sessionId?: string } = {}) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', options.namespace ?? 'alice')
        if (options.sessionId) {
            c.set('sessionId', options.sessionId)
        }
        await next()
    })
    app.route('/api', createMeAccessTokenRoutes(store, { dataDir }))
    return app
}

function resolves(store: Store, token: string): string | null {
    return resolveAccessToken(token, {
        getByTokenHash: (hash) => store.accessTokens.getByTokenHash(hash),
        touchLastUsed: () => {},
        getActiveByNamespace: (namespace, now) => store.accessTokens.getActiveByNamespace(namespace, now),
        legacyToken: null
    })?.namespace ?? null
}

describe('personal access token routes', () => {
    it('creates, re-derives, and resolves the caller token', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)

        const empty = await app.request('/api/me/access-token')
        expect(await empty.json()).toEqual({ token: null, tokenInfo: null })

        const created = await app.request('/api/me/access-token', { method: 'POST' })
        expect(created.status).toBe(200)
        const createdBody = await created.json() as PersonalAccessTokenResponse
        expect(createdBody.token?.startsWith('hapi_')).toBe(true)
        expect(createdBody.tokenInfo?.namespace).toBe('alice')
        expect(resolves(store, createdBody.token!)).toBe('alice')

        // Repeated reads derive the same plaintext instead of creating a new row.
        const read = await app.request('/api/me/access-token')
        const readBody = await read.json() as PersonalAccessTokenResponse
        expect(readBody.token).toBe(createdBody.token)
        expect(readBody.tokenInfo?.id).toBe(createdBody.tokenInfo?.id)

        store.close()
    })

    it('regenerates and invalidates the previous token immediately', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)

        const first = await (await app.request('/api/me/access-token', { method: 'POST' }))
            .json() as PersonalAccessTokenResponse
        const second = await (await app.request('/api/me/access-token/regenerate', { method: 'POST' }))
            .json() as PersonalAccessTokenResponse

        expect(second.token).not.toBe(first.token)
        expect(resolves(store, first.token!)).toBeNull()
        expect(resolves(store, second.token!)).toBe('alice')
        expect(store.accessTokens.isTokenIdRevoked(first.tokenInfo!.id)).toBe(true)

        store.close()
    })

    it('keeps namespaces separate', async () => {
        const store = new Store(':memory:')
        const aliceApp = createApp(store, { namespace: 'alice' })
        const bobApp = createApp(store, { namespace: 'bob' })

        const alice = await (await aliceApp.request('/api/me/access-token', { method: 'POST' }))
            .json() as PersonalAccessTokenResponse
        const bob = await (await bobApp.request('/api/me/access-token', { method: 'POST' }))
            .json() as PersonalAccessTokenResponse

        expect(alice.token).not.toBe(bob.token)
        expect(resolves(store, alice.token!)).toBe('alice')
        expect(resolves(store, bob.token!)).toBe('bob')

        store.close()
    })

    it('blocks session-share visitors', async () => {
        const store = new Store(':memory:')
        const app = createApp(store, { namespace: 'default', sessionId: 'session-1' })

        expect((await app.request('/api/me/access-token')).status).toBe(403)
        expect((await app.request('/api/me/access-token', { method: 'POST' })).status).toBe(403)
        expect((await app.request('/api/me/access-token/regenerate', { method: 'POST' })).status).toBe(403)

        store.close()
    })
})
