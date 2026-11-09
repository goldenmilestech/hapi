import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { AuthRequestSchema } from '@hapi/protocol'
import type { SessionShareInfo, SessionShareMode } from '@hapi/protocol/apiTypes'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import { hashShareToken, isShareActive } from '../../store/sessionShares'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

export function createAuthRoutes(jwtSecret: Uint8Array, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = AuthRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        let userId: number
        let username: string | undefined
        let firstName: string | undefined
        let lastName: string | undefined
        let namespace: string
        let shareSessionId: string | undefined
        let shareMode: SessionShareMode | undefined
        let shareInfo: SessionShareInfo | undefined

        // Access Token authentication (CLI_API_TOKEN)
        if ('accessToken' in parsed.data) {
            const configuration = getConfiguration()
            const parsedToken = parseAccessToken(parsed.data.accessToken)
            if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
                return c.json({ error: 'Invalid access token' }, 401)
            }
            userId = await getOrCreateOwnerId()
            firstName = 'Web User'
            namespace = parsedToken.namespace
        } else if ('shareToken' in parsed.data) {
            // Session share authentication: the opaque token is exchanged for a
            // short-lived JWT scoped to one session. The token itself is never
            // used as the API bearer, so revocation only has to flip the row.
            const share = store.sessionShares.getByTokenHash(hashShareToken(parsed.data.shareToken))
            if (!share || !isShareActive(share)) {
                return c.json({ error: 'Invalid or expired share token' }, 401)
            }
            const session = store.sessions.getSessionByNamespace(share.sessionId, share.namespace)
            if (!session) {
                return c.json({ error: 'Shared session not found' }, 401)
            }
            userId = await getOrCreateOwnerId()
            firstName = 'Share Guest'
            namespace = share.namespace
            shareSessionId = share.sessionId
            shareMode = share.mode
            shareInfo = {
                sessionId: share.sessionId,
                mode: share.mode,
                expiresAt: share.expiresAt
            }
        } else {
            const configuration = getConfiguration()
            if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
                return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
            }

            // Telegram initData authentication
            const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
            if (!result.ok) {
                return c.json({ error: result.error }, 401)
            }

            const telegramUserId = String(result.user.id)
            const storedUser = store.users.getUser('telegram', telegramUserId)
            if (!storedUser) {
                return c.json({ error: 'not_bound' }, 401)
            }

            userId = await getOrCreateOwnerId()
            username = result.user.username
            firstName = result.user.first_name
            lastName = result.user.last_name
            namespace = storedUser.namespace
        }

        const claims: Record<string, unknown> = { uid: userId, ns: namespace }
        if (shareSessionId) {
            claims.sid = shareSessionId
            claims.mode = shareMode
        }
        const token = await new SignJWT(claims)
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime(shareSessionId ? '15m' : '4h')
            .sign(jwtSecret)

        return c.json({
            token,
            user: {
                id: userId,
                username,
                firstName,
                lastName
            },
            ...(shareInfo ? { share: shareInfo } : {})
        })
    })

    return app
}
