import { Hono, type Context } from 'hono'
import type { PersonalAccessTokenResponse } from '@hapi/protocol/apiTypes'
import { getConfiguration } from '../../configuration'
import type { Store } from '../../store'
import { toAccessTokenSummary } from '../../store/accessTokens'
import {
    ensurePersonalAccessToken,
    readPersonalAccessToken,
    regeneratePersonalAccessToken
} from '../../accessTokens/personalToken'
import type { WebAppEnv } from '../middleware/auth'

export type MeAccessTokenRoutesOptions = {
    /** Test seam: overrides the hub data directory. */
    dataDir?: string
}

function isShareVisitor(c: Context<WebAppEnv>): boolean {
    return c.get('sessionId') !== undefined
}

export function createMeAccessTokenRoutes(
    store: Store,
    options?: MeAccessTokenRoutesOptions
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const resolveDataDir = () => options?.dataDir ?? getConfiguration().dataDir

    app.get('/me/access-token', async (c) => {
        if (isShareVisitor(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        const view = await readPersonalAccessToken(store, resolveDataDir(), c.get('namespace'))
        const response: PersonalAccessTokenResponse = {
            token: view?.token ?? null,
            tokenInfo: view ? toAccessTokenSummary(view.record) : null
        }
        return c.json(response)
    })

    app.post('/me/access-token', async (c) => {
        if (isShareVisitor(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        const created = await ensurePersonalAccessToken(
            store,
            resolveDataDir(),
            c.get('namespace'),
            'Personal token'
        )
        const response: PersonalAccessTokenResponse = {
            token: created.token,
            tokenInfo: toAccessTokenSummary(created.record)
        }
        return c.json(response)
    })

    app.post('/me/access-token/regenerate', async (c) => {
        if (isShareVisitor(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        const created = await regeneratePersonalAccessToken(
            store,
            resolveDataDir(),
            c.get('namespace'),
            'Personal token'
        )
        const response: PersonalAccessTokenResponse = {
            token: created.token,
            tokenInfo: toAccessTokenSummary(created.record)
        }
        return c.json(response)
    })

    return app
}
