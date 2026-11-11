import { beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type {
    CreateSessionShareResponse,
    RecoverSessionShareResponse,
    RenewSessionShareResponse,
    SessionShareListResponse
} from '@hapi/protocol/apiTypes'
import { createConfiguration } from '../../configuration'
import { deriveSessionShareToken } from '../../config/shareTokenSecret'
import { Store } from '../../store'
import { hashShareToken } from '../../store/sessionShares'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

const SHARE_SECRET = new Uint8Array(32).fill(7)
const BASE_URL = 'https://hub.example.com'
const SESSION_ID = 'session-1'

beforeAll(async () => {
    process.env.HAPI_HOME = mkdtempSync(join(tmpdir(), 'hapi-share-routes-'))
    await createConfiguration()
})

function setup() {
    const store = new Store(':memory:')
    const session = { id: SESSION_ID, namespace: 'default', active: true } as unknown as Session
    const engine = {
        resolveSessionAccess: (sessionId: string) => sessionId === SESSION_ID
            ? { ok: true as const, sessionId: SESSION_ID, session }
            : { ok: false as const, reason: 'not-found' as const }
    }

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', c.req.header('x-test-namespace') ?? 'default')
        await next()
    })
    app.route('/api', createSessionsRoutes(
        () => engine as unknown as SyncEngine,
        store,
        { shareTokenSecret: SHARE_SECRET }
    ))

    return { app, store }
}

async function createShare(
    app: Hono<WebAppEnv>,
    body: Record<string, unknown> = {}
): Promise<CreateSessionShareResponse> {
    const response = await app.request(`${BASE_URL}/api/sessions/${SESSION_ID}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL },
        body: JSON.stringify(body)
    })
    expect(response.status).toBe(200)
    return await response.json() as CreateSessionShareResponse
}

async function listShares(app: Hono<WebAppEnv>): Promise<SessionShareListResponse> {
    const response = await app.request(`${BASE_URL}/api/sessions/${SESSION_ID}/share`)
    expect(response.status).toBe(200)
    return await response.json() as SessionShareListResponse
}

function insertLegacyShare(store: Store, id: string, token: string): void {
    store.sessionShares.create({
        id,
        sessionId: SESSION_ID,
        namespace: 'default',
        tokenHash: hashShareToken(token),
        mode: 'chat',
        expiresAt: Date.now() + 60_000
    })
}

describe('session share management routes', () => {
    it('returns the same derived link from create and list', async () => {
        const { app } = setup()
        const created = await createShare(app, { mode: 'chat', ttlHours: 24 })

        expect(created.share.url).toBe(`${BASE_URL}/s/${created.share.token}`)
        expect(created.share.url).not.toBeNull()

        const listed = await listShares(app)
        expect(listed.shares).toHaveLength(1)
        expect(listed.shares[0].url).toBe(created.share.url as string)
    })

    it('renews an expired share and rejects invalid or unknown shares', async () => {
        const { app, store } = setup()
        const created = await createShare(app, { ttlHours: 1 })
        store.sessionShares.updateExpiresAt(created.share.id, SESSION_ID, 'default', Date.now() - 1_000)

        const before = Date.now()
        const renewed = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/${created.share.id}`,
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ttlHours: 24 })
            }
        )
        expect(renewed.status).toBe(200)
        const body = await renewed.json() as RenewSessionShareResponse
        expect(body.share.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000)
        expect(body.share.url).toBe(created.share.url as string)

        const invalid = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/${created.share.id}`,
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ttlHours: 0 })
            }
        )
        expect(invalid.status).toBe(400)

        const unknown = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/missing-share`,
            { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }
        )
        expect(unknown.status).toBe(404)
    })

    it('recovers a legacy random-token share and invalidates its old token', async () => {
        const { app, store } = setup()
        insertLegacyShare(store, 'legacy-share', 'old-random-token')

        const before = await listShares(app)
        expect(before.shares[0].url).toBeNull()

        const recovered = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/legacy-share/recover`,
            { method: 'POST' }
        )
        expect(recovered.status).toBe(200)
        const body = await recovered.json() as RecoverSessionShareResponse
        const derivedToken = deriveSessionShareToken(SHARE_SECRET, 'legacy-share')
        expect(body.share.url).toBe(`${BASE_URL}/s/${derivedToken}`)

        expect(store.sessionShares.getByTokenHash(hashShareToken('old-random-token'))).toBeNull()
        expect(store.sessionShares.getByTokenHash(hashShareToken(derivedToken))?.id).toBe('legacy-share')

        const after = await listShares(app)
        expect(after.shares[0].url).toBe(body.share.url)
    })

    it('refuses to renew or recover a revoked share', async () => {
        const { app } = setup()
        const created = await createShare(app)

        const revoked = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/${created.share.id}`,
            { method: 'DELETE' }
        )
        expect(revoked.status).toBe(200)

        const renew = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/${created.share.id}`,
            { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }
        )
        expect(renew.status).toBe(409)

        const recover = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/${created.share.id}/recover`,
            { method: 'POST' }
        )
        expect(recover.status).toBe(409)
    })

    it('does not touch shares owned by another namespace', async () => {
        const { app, store } = setup()
        store.sessionShares.create({
            id: 'other-share',
            sessionId: SESSION_ID,
            namespace: 'other',
            tokenHash: hashShareToken('other-token'),
            mode: 'chat',
            expiresAt: Date.now() + 60_000
        })

        const revoke = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/other-share`,
            { method: 'DELETE' }
        )
        expect(revoke.status).toBe(404)

        const recover = await app.request(
            `${BASE_URL}/api/sessions/${SESSION_ID}/share/other-share/recover`,
            { method: 'POST' }
        )
        expect(recover.status).toBe(404)

        expect(store.sessionShares.getById('other-share', SESSION_ID, 'other')?.revokedAt).toBeNull()
    })
})
