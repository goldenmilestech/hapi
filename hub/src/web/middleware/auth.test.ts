import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { createAuthMiddleware, type AuthMiddlewareOptions, type WebAppEnv } from './auth'

const SECRET = new Uint8Array(32).fill(9)

async function sign(claims: Record<string, unknown>): Promise<string> {
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(SECRET)
}

function createApp(options?: AuthMiddlewareOptions) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(SECRET, options))
    app.get('/api/ping', (c) => c.json({ ns: c.get('namespace') }))
    app.get('/api/sessions', (c) => c.json({ ns: c.get('namespace') }))
    return app
}

describe('createAuthMiddleware namespace claims', () => {
    it('rejects a legacy JWT once its namespace is claimed by an access token', async () => {
        const app = createApp({
            isNamespaceClaimed: (namespace) => namespace === 'alice'
        })

        const legacyAlice = await sign({ uid: 1, ns: 'alice' })
        const legacyBob = await sign({ uid: 1, ns: 'bob' })

        expect((await app.request('/api/ping', {
            headers: { authorization: `Bearer ${legacyAlice}` }
        })).status).toBe(401)
        expect((await app.request('/api/ping', {
            headers: { authorization: `Bearer ${legacyBob}` }
        })).status).toBe(200)
    })

    it('keeps access-token and share JWTs working on a claimed namespace', async () => {
        const app = createApp({
            isNamespaceClaimed: (namespace) => namespace === 'alice'
        })

        const accessTokenJwt = await sign({ uid: 1, ns: 'alice', tid: 'token-1' })
        expect((await app.request('/api/ping', {
            headers: { authorization: `Bearer ${accessTokenJwt}` }
        })).status).toBe(200)

        const shareJwt = await sign({ uid: 1, ns: 'alice', sid: 'session-1', mode: 'chat' })
        expect((await app.request('/api/sessions', {
            headers: { authorization: `Bearer ${shareJwt}` }
        })).status).toBe(200)
    })

    it('rejects a JWT whose access token was revoked', async () => {
        const app = createApp({
            isTokenRevoked: (tokenId) => tokenId === 'revoked-token'
        })

        const revoked = await sign({ uid: 1, ns: 'alice', tid: 'revoked-token' })
        const active = await sign({ uid: 1, ns: 'alice', tid: 'active-token' })

        expect((await app.request('/api/ping', {
            headers: { authorization: `Bearer ${revoked}` }
        })).status).toBe(401)
        expect((await app.request('/api/ping', {
            headers: { authorization: `Bearer ${active}` }
        })).status).toBe(200)
    })
})
