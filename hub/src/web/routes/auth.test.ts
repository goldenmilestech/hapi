import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AuthResponse } from '@hapi/protocol/apiTypes'
import { createConfiguration } from '../../configuration'
import { Store } from '../../store'
import type { FeishuUserInfo } from '../../feishu/feishuOAuth'
import { FeishuOAuthError } from '../../feishu/feishuOAuth'
import { autoFeishuNamespace } from '../../feishu/identity'
import type { ResolvedFeishuConfig } from '../../feishu/config'
import { createAuthRoutes } from './auth'

const JWT_SECRET = new Uint8Array(32).fill(7)

const FEISHU_CONFIG: ResolvedFeishuConfig = {
    appId: 'cli_test',
    appSecret: 'app-secret',
    redirectUri: 'https://hub.example.com/auth/feishu',
    scope: 'contact:user.email:readonly',
    ownerOpenId: null,
    ownerEmail: null,
    authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    tokenUrl: 'https://accounts.feishu.cn/oauth/v3/token',
    userInfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info'
}

let dataDir: string
let feishuUser: FeishuUserInfo

function decodeJwtPayload(token: string): Record<string, unknown> {
    const part = token.split('.')[1]
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

function createApp(store: Store) {
    const app = new Hono()
    app.route('/api', createAuthRoutes(JWT_SECRET, store))
    return app
}

function createFeishuApp(
    store: Store,
    login: (code: string) => Promise<FeishuUserInfo>,
    config: ResolvedFeishuConfig = FEISHU_CONFIG
) {
    const app = new Hono()
    app.route('/api', createAuthRoutes(JWT_SECRET, store, {
        feishuConfig: config,
        feishuLogin: login,
        dataDir
    }))
    return app
}

async function authenticate(app: Hono, accessToken: string) {
    return await app.request('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken })
    })
}

async function authenticateFeishu(app: Hono, code = 'feishu-code') {
    return await app.request('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feishuCode: code })
    })
}

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('legacy-shared-token', 'env', false)
    dataDir = mkdtempSync(join(tmpdir(), 'hapi-auth-feishu-'))
    feishuUser = {
        openId: 'ou_alice',
        unionId: null,
        userId: null,
        name: 'Alice',
        email: 'alice@corp.com',
        enterpriseEmail: null,
        avatarUrl: null
    }
})

afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
})

describe('POST /api/auth access tokens', () => {
    it('mints a JWT bound to the token row namespace with a tid claim', async () => {
        const store = new Store(':memory:')
        const { token, record } = store.accessTokens.create({ name: 'Alice', namespace: 'alice' })

        const response = await authenticate(createApp(store), token)
        expect(response.status).toBe(200)
        const body = await response.json() as { token: string }
        const payload = decodeJwtPayload(body.token)
        expect(payload.ns).toBe('alice')
        expect(payload.tid).toBe(record.id)

        store.close()
    })

    it('rejects revoked tokens', async () => {
        const store = new Store(':memory:')
        const { token, record } = store.accessTokens.create({ name: 'Bob', namespace: 'bob' })
        store.accessTokens.revoke(record.id)

        const response = await authenticate(createApp(store), token)
        expect(response.status).toBe(401)

        store.close()
    })

    it('keeps the legacy shared token working without a tid claim', async () => {
        const store = new Store(':memory:')
        const response = await authenticate(createApp(store), 'legacy-shared-token:carol')
        expect(response.status).toBe(200)
        const body = await response.json() as { token: string }
        const payload = decodeJwtPayload(body.token)
        expect(payload.ns).toBe('carol')
        expect(payload.tid).toBeUndefined()

        store.close()
    })

    it('rejects unknown tokens', async () => {
        const store = new Store(':memory:')
        const response = await authenticate(createApp(store), 'hapi_unknown-token')
        expect(response.status).toBe(401)

        store.close()
    })
})

describe('POST /api/auth Feishu login', () => {
    it('auto-provisions a namespace and returns a durable personal token', async () => {
        const store = new Store(':memory:')
        const app = createFeishuApp(store, async () => feishuUser)

        const response = await authenticateFeishu(app)
        expect(response.status).toBe(200)
        const body = await response.json() as AuthResponse

        const expectedNamespace = autoFeishuNamespace(feishuUser.openId)
        expect(body.namespace).toBe(expectedNamespace)
        expect(body.accessToken?.startsWith('hapi_')).toBe(true)
        expect(store.users.getUser('feishu', feishuUser.openId)?.namespace).toBe(expectedNamespace)

        const active = store.accessTokens.getActiveByNamespace(expectedNamespace)
        expect(active).not.toBeNull()
        const payload = decodeJwtPayload(body.token)
        expect(payload.ns).toBe(expectedNamespace)
        expect(payload.tid).toBe(active?.id ?? undefined)

        // A second login re-derives the same token instead of rotating it.
        const again = await (await authenticateFeishu(app)).json() as AuthResponse
        expect(again.accessToken).toBe(body.accessToken)

        store.close()
    })

    it('keeps an existing namespace when the email is pre-bound', async () => {
        const store = new Store(':memory:')
        store.feishuBindings.upsert({ email: 'alice@corp.com', namespace: 'legacy-alice' })
        const app = createFeishuApp(store, async () => feishuUser)

        const body = await (await authenticateFeishu(app)).json() as AuthResponse
        expect(body.namespace).toBe('legacy-alice')
        expect(store.users.getUser('feishu', feishuUser.openId)?.namespace).toBe('legacy-alice')
        expect(store.accessTokens.getActiveByNamespace('legacy-alice')).not.toBeNull()

        store.close()
    })

    it('maps the configured owner to default', async () => {
        const store = new Store(':memory:')
        const app = createFeishuApp(
            store,
            async () => feishuUser,
            { ...FEISHU_CONFIG, ownerOpenId: feishuUser.openId }
        )

        const body = await (await authenticateFeishu(app)).json() as AuthResponse
        expect(body.namespace).toBe('default')
        expect(store.users.getUser('feishu', feishuUser.openId)?.namespace).toBe('default')

        store.close()
    })

    it('rejects a namespace already mapped to another Feishu user', async () => {
        const store = new Store(':memory:')
        store.feishuBindings.upsert({ email: 'bob@corp.com', namespace: 'shared' })
        store.users.addUser('feishu', 'ou_bob', 'shared')
        store.feishuBindings.upsert({ email: 'alice@corp.com', namespace: 'shared' })

        const app = createFeishuApp(store, async () => feishuUser)
        const response = await authenticateFeishu(app)
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'namespace_conflict' })

        store.close()
    })

    it('rejects a failed Feishu exchange', async () => {
        const store = new Store(':memory:')
        const app = createFeishuApp(store, async () => {
            throw new FeishuOAuthError('invalid code', 20003)
        })

        const response = await authenticateFeishu(app)
        expect(response.status).toBe(401)

        store.close()
    })

    it('reports a Feishu transport failure as unavailable', async () => {
        const store = new Store(':memory:')
        const app = createFeishuApp(store, async () => {
            throw new Error('timeout')
        })

        const response = await authenticateFeishu(app)
        expect(response.status).toBe(503)

        store.close()
    })

    it('reports Feishu as disabled when it is not configured', async () => {
        const store = new Store(':memory:')
        const app = new Hono()
        app.route('/api', createAuthRoutes(JWT_SECRET, store, {
            feishuLogin: async () => feishuUser,
            dataDir
        }))

        const response = await authenticateFeishu(app)
        expect(response.status).toBe(503)

        store.close()
    })
})
