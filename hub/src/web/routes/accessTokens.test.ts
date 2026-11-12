import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { AccessTokensResponse, CreateAccessTokenResponse } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import { hashAccessToken } from '../../store/accessTokens'
import type { WebAppEnv } from '../middleware/auth'
import { createAccessTokensRoutes } from './accessTokens'

function createApp(store: Store, options: { namespace?: string; sessionId?: string } = {}) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', options.namespace ?? 'default')
        if (options.sessionId) {
            c.set('sessionId', options.sessionId)
        }
        await next()
    })
    app.route('/api', createAccessTokensRoutes(store))
    return app
}

describe('access token routes', () => {
    it('lets the owner issue and list a token bound to a namespace', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)

        const created = await app.request('/api/access-tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Alice laptop', namespace: 'alice' })
        })
        expect(created.status).toBe(200)
        const body = await created.json() as CreateAccessTokenResponse
        expect(body.token.startsWith('hapi_')).toBe(true)
        expect(body.tokenInfo.namespace).toBe('alice')

        const stored = store.accessTokens.getByTokenHash(hashAccessToken(body.token))
        expect(stored?.namespace).toBe('alice')

        const listed = await app.request('/api/access-tokens')
        expect(listed.status).toBe(200)
        const list = await listed.json() as AccessTokensResponse
        expect(list.tokens).toHaveLength(1)
        expect(list.tokens[0].name).toBe('Alice laptop')
        expect(list.tokens[0]).not.toHaveProperty('tokenHash')

        store.close()
    })

    it('rejects malformed create requests', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)

        for (const payload of [
            { name: '', namespace: 'alice' },
            { name: 'Alice', namespace: '' },
            { name: 'Alice', namespace: 'has:colon' },
            { name: 'Alice' }
        ]) {
            const response = await app.request('/api/access-tokens', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            })
            expect(response.status).toBe(400)
        }

        store.close()
    })

    it('rejects a second active token for the same namespace until the first is revoked', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const payload = { name: 'Alice laptop', namespace: 'alice' }

        const first = await app.request('/api/access-tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        })
        const firstBody = await first.json() as CreateAccessTokenResponse

        const conflict = await app.request('/api/access-tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Alice phone', namespace: 'alice' })
        })
        expect(conflict.status).toBe(409)
        expect(await conflict.json()).toEqual({ error: 'Namespace already bound' })

        await app.request(`/api/access-tokens/${firstBody.tokenInfo.id}/revoke`, { method: 'POST' })
        const replacement = await app.request('/api/access-tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Alice phone', namespace: 'alice' })
        })
        expect(replacement.status).toBe(200)

        store.close()
    })

    it('blocks non-owner namespaces and session-share visitors', async () => {
        const store = new Store(':memory:')

        const nonOwner = createApp(store, { namespace: 'alice' })
        expect((await nonOwner.request('/api/access-tokens')).status).toBe(403)
        expect((await nonOwner.request('/api/access-tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'X', namespace: 'alice' })
        })).status).toBe(403)

        const shareVisitor = createApp(store, { namespace: 'default', sessionId: 'session-1' })
        expect((await shareVisitor.request('/api/access-tokens')).status).toBe(403)

        store.close()
    })

    it('revokes a token and reports it in the list', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const created = await app.request('/api/access-tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Bob', namespace: 'bob' })
        })
        const body = await created.json() as CreateAccessTokenResponse

        const revoked = await app.request(`/api/access-tokens/${body.tokenInfo.id}/revoke`, { method: 'POST' })
        expect(revoked.status).toBe(200)
        expect(await revoked.json()).toEqual({ ok: true })

        const again = await app.request(`/api/access-tokens/${body.tokenInfo.id}/revoke`, { method: 'POST' })
        expect(again.status).toBe(200)

        const missing = await app.request('/api/access-tokens/missing/revoke', { method: 'POST' })
        expect(missing.status).toBe(404)

        const list = await (await app.request('/api/access-tokens')).json() as AccessTokensResponse
        expect(list.tokens[0].revokedAt).not.toBeNull()

        store.close()
    })
})
