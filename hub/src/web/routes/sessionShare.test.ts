import { beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { jwtVerify } from 'jose'
import { createConfiguration } from '../../configuration'
import { Store } from '../../store'
import { hashShareToken } from '../../store/sessionShares'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createAuthRoutes } from './auth'

const JWT_SECRET = new TextEncoder().encode('test-jwt-secret-test-jwt-secret')

beforeAll(async () => {
    process.env.HAPI_HOME = mkdtempSync(join(tmpdir(), 'hapi-share-test-'))
    await createConfiguration()
})

function setup() {
    const store = new Store(':memory:')
    store.sessions.getOrCreateSession(
        'tag',
        {},
        {},
        'default',
        undefined,
        undefined,
        undefined,
        'session-1'
    )

    const app = new Hono<WebAppEnv>()
    app.route('/api', createAuthRoutes(JWT_SECRET, store))
    app.use('/api/*', createAuthMiddleware(JWT_SECRET))
    app.get('/api/sessions/:id', (c) => c.json({ ok: true, requestSessionId: c.req.param('id') }))
    app.get('/api/sessions/:id/terminal', (c) => c.json({ ok: true }))
    app.post('/api/sessions/:id/share', (c) => c.json({ ok: true }))
    app.get('/api/machines', (c) => c.json({ ok: true }))

    return { store, app }
}

async function exchange(app: Hono<WebAppEnv>, shareToken: string) {
    const response = await app.request('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shareToken })
    })
    return response
}

describe('session share authentication', () => {
    it('exchanges an active share token for a session-scoped JWT', async () => {
        const { store, app } = setup()
        const shareToken = 'share-token-1'
        store.sessionShares.create({
            sessionId: 'session-1',
            namespace: 'default',
            tokenHash: hashShareToken(shareToken),
            mode: 'chat',
            expiresAt: Date.now() + 60_000
        })

        const response = await exchange(app, shareToken)
        expect(response.status).toBe(200)
        const body = await response.json() as {
            token: string
            share: { sessionId: string; mode: string; expiresAt: number }
        }
        expect(body.share).toEqual({
            sessionId: 'session-1',
            mode: 'chat',
            expiresAt: expect.any(Number)
        })

        const verified = await jwtVerify(body.token, JWT_SECRET)
        expect(verified.payload.sid).toBe('session-1')
        expect(verified.payload.ns).toBe('default')
        expect(verified.payload.mode).toBe('chat')
    })

    it('rejects expired and unknown share tokens', async () => {
        const { store, app } = setup()
        const expiredToken = 'expired-share-token'
        store.sessionShares.create({
            sessionId: 'session-1',
            namespace: 'default',
            tokenHash: hashShareToken(expiredToken),
            mode: 'chat',
            expiresAt: Date.now() - 1
        })

        expect((await exchange(app, expiredToken)).status).toBe(401)
        expect((await exchange(app, 'does-not-exist')).status).toBe(401)
    })

    it('scopes the JWT to the shared session and blocks sibling sessions and admin routes', async () => {
        const { store, app } = setup()
        const shareToken = 'share-token-2'
        store.sessionShares.create({
            sessionId: 'session-1',
            namespace: 'default',
            tokenHash: hashShareToken(shareToken),
            mode: 'chat',
            expiresAt: Date.now() + 60_000
        })
        const auth = await (await exchange(app, shareToken)).json() as { token: string }
        const headers = { authorization: `Bearer ${auth.token}` }

        expect((await app.request('/api/sessions/session-1', { headers })).status).toBe(200)
        expect((await app.request('/api/sessions/session-2', { headers })).status).toBe(403)
        expect((await app.request('/api/sessions/session-1/terminal', { headers })).status).toBe(403)
        expect((await app.request('/api/sessions/session-1/share', {
            method: 'POST',
            headers
        })).status).toBe(403)
    })

    it('only allows permission decisions in chat_approve mode', async () => {
        const { store, app } = setup()
        app.post('/api/sessions/:id/permissions/:requestId/approve', (c) => c.json({ ok: true }))

        const chatToken = 'chat-mode-token'
        store.sessionShares.create({
            sessionId: 'session-1',
            namespace: 'default',
            tokenHash: hashShareToken(chatToken),
            mode: 'chat',
            expiresAt: Date.now() + 60_000
        })
        const chatAuth = await (await exchange(app, chatToken)).json() as { token: string }
        expect((await app.request('/api/sessions/session-1/permissions/req-1/approve', {
            method: 'POST',
            headers: { authorization: `Bearer ${chatAuth.token}` }
        })).status).toBe(403)

        const approveToken = 'approve-mode-token'
        store.sessionShares.create({
            sessionId: 'session-1',
            namespace: 'default',
            tokenHash: hashShareToken(approveToken),
            mode: 'chat_approve',
            expiresAt: Date.now() + 60_000
        })
        const approveAuth = await (await exchange(app, approveToken)).json() as { token: string }
        expect((await app.request('/api/sessions/session-1/permissions/req-1/approve', {
            method: 'POST',
            headers: { authorization: `Bearer ${approveAuth.token}` }
        })).status).toBe(200)
    })

    it('rejects events without an explicit matching session id', async () => {
        const { store, app } = setup()
        app.get('/api/events', (c) => c.json({ ok: true }))
        const shareToken = 'share-token-events'
        store.sessionShares.create({
            sessionId: 'session-1',
            namespace: 'default',
            tokenHash: hashShareToken(shareToken),
            mode: 'chat',
            expiresAt: Date.now() + 60_000
        })
        const auth = await (await exchange(app, shareToken)).json() as { token: string }

        expect((await app.request(
            `/api/events?token=${auth.token}&sessionId=session-1`
        )).status).toBe(200)
        expect((await app.request(
            `/api/events?token=${auth.token}`
        )).status).toBe(403)
        expect((await app.request(
            `/api/events?token=${auth.token}&sessionId=session-2`
        )).status).toBe(403)
    })
})
