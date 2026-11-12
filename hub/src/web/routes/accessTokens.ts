import { Hono, type Context } from 'hono'
import {
    CreateAccessTokenRequestSchema,
    type CreateAccessTokenResponse,
    type AccessTokensResponse,
    type RevokeAccessTokenResponse
} from '@hapi/protocol/apiTypes'
import type { Store } from '../../store'
import {
    hashAccessToken,
    NamespaceAlreadyBoundError,
    toAccessTokenSummary,
    type AccessTokenRecord
} from '../../store/accessTokens'
import { deriveAccessToken, getOrCreateAccessTokenSecret } from '../../config/accessTokenSecret'
import { getConfiguration } from '../../configuration'
import type { WebAppEnv } from '../middleware/auth'

export type AccessTokensRoutesOptions = {
    /** Test seam: overrides the hub data directory for token derivation. */
    dataDir?: string
}

/**
 * Owner-only management for per-person access tokens.
 *
 * `default` is the hub owner, matching every other owner-only surface
 * (usage, storage, hub settings). A session-share JWT is never allowed here
 * even if its namespace happens to be `default`.
 */
function isOwner(c: Context<WebAppEnv>): boolean {
    return c.get('sessionId') === undefined && c.get('namespace') === 'default'
}

export function createAccessTokensRoutes(
    store: Store,
    options?: AccessTokensRoutesOptions
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const resolveDataDir = () => options?.dataDir ?? getConfiguration().dataDir

    app.get('/access-tokens', (c) => {
        if (!isOwner(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        const response: AccessTokensResponse = { tokens: store.accessTokens.list() }
        return c.json(response)
    })

    app.get('/access-tokens/:id/token', async (c) => {
        if (!isOwner(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        const record = store.accessTokens.getById(c.req.param('id'))
        if (!record) {
            return c.json({ error: 'Token not found' }, 404)
        }
        const secret = await getOrCreateAccessTokenSecret(resolveDataDir())
        const candidate = deriveAccessToken(secret, record.id)
        if (record.tokenHash !== hashAccessToken(candidate)) {
            // Created before derived tokens existed; only a rotation can make
            // it viewable again.
            return c.json({ error: 'Token cannot be shown; regenerate it' }, 409)
        }
        const response: CreateAccessTokenResponse = {
            token: candidate,
            tokenInfo: toAccessTokenSummary(record)
        }
        return c.json(response)
    })

    app.post('/access-tokens', async (c) => {
        if (!isOwner(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = CreateAccessTokenRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        let created: { token: string; record: AccessTokenRecord }
        try {
            const secret = await getOrCreateAccessTokenSecret(resolveDataDir())
            created = store.accessTokens.create({
                name: parsed.data.name,
                namespace: parsed.data.namespace,
                expiresAt: parsed.data.expiresAt ?? null,
                tokenFactory: (id) => deriveAccessToken(secret, id)
            })
        } catch (error) {
            if (error instanceof NamespaceAlreadyBoundError) {
                return c.json({ error: 'Namespace already bound' }, 409)
            }
            // Validation is the only other expected failure here; let real
            // storage errors surface as 500 instead of masquerading as a bad
            // request.
            if (error instanceof Error && error.message.startsWith('Invalid access token')) {
                return c.json({ error: 'Invalid body' }, 400)
            }
            throw error
        }

        const response: CreateAccessTokenResponse = {
            token: created.token,
            tokenInfo: toAccessTokenSummary(created.record)
        }
        return c.json(response)
    })

    app.post('/access-tokens/:id/revoke', (c) => {
        if (!isOwner(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        const revoked = store.accessTokens.revoke(c.req.param('id'))
        if (!revoked) {
            return c.json({ error: 'Token not found' }, 404)
        }
        const response: RevokeAccessTokenResponse = { ok: true }
        return c.json(response)
    })

    return app
}
