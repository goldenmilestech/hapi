import { beforeAll, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { FeishuBindingsResponse, CreateFeishuBindingResponse } from '@hapi/protocol/apiTypes'
import { createConfiguration } from '../../configuration'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createFeishuRoutes } from './feishu'

function createApp(store: Store, options: { namespace?: string; sessionId?: string } = {}) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', options.namespace ?? 'default')
        if (options.sessionId) {
            c.set('sessionId', options.sessionId)
        }
        await next()
    })
    app.route('/api', createFeishuRoutes(store))
    return app
}

beforeAll(async () => {
    await createConfiguration()
})

describe('Feishu routes', () => {
    it('exposes a public config without the app secret', async () => {
        const store = new Store(':memory:')
        const response = await createApp(store).request('/api/auth/feishu/config')

        expect(response.status).toBe(200)
        const body = await response.json() as Record<string, unknown>
        expect(body).toHaveProperty('enabled')
        expect(body).toHaveProperty('authorizeUrl')
        expect(body).not.toHaveProperty('appSecret')

        store.close()
    })

    it('lets the owner manage email bindings', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)

        const created = await app.request('/api/feishu/bindings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'Alice@Corp.com', namespace: 'legacy-alice' })
        })
        expect(created.status).toBe(200)
        const createdBody = await created.json() as CreateFeishuBindingResponse
        expect(createdBody.binding.email).toBe('alice@corp.com')
        expect(createdBody.binding.namespace).toBe('legacy-alice')

        const listed = await app.request('/api/feishu/bindings')
        expect(listed.status).toBe(200)
        const listBody = await listed.json() as FeishuBindingsResponse
        expect(listBody.bindings).toHaveLength(1)

        const removed = await app.request('/api/feishu/bindings/alice%40corp.com', { method: 'DELETE' })
        expect(removed.status).toBe(200)
        expect(store.feishuBindings.list()).toHaveLength(0)

        const missing = await app.request('/api/feishu/bindings/alice%40corp.com', { method: 'DELETE' })
        expect(missing.status).toBe(404)

        store.close()
    })

    it('rejects malformed bindings', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)

        for (const payload of [
            { email: 'not-an-email', namespace: 'x' },
            { email: 'a@b.com', namespace: '' },
            { email: 'a@b.com', namespace: 'has:colon' }
        ]) {
            const response = await app.request('/api/feishu/bindings', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            })
            expect(response.status).toBe(400)
        }

        store.close()
    })

    it('blocks non-owners and share visitors', async () => {
        const store = new Store(':memory:')

        const nonOwner = createApp(store, { namespace: 'alice' })
        expect((await nonOwner.request('/api/feishu/bindings')).status).toBe(403)

        const shareVisitor = createApp(store, { namespace: 'default', sessionId: 'session-1' })
        expect((await shareVisitor.request('/api/feishu/bindings')).status).toBe(403)

        store.close()
    })
})
