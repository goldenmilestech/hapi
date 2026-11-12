import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { AuthRequestSchema } from '@hapi/protocol'
import type { SessionShareInfo, SessionShareMode } from '@hapi/protocol/apiTypes'
import { getConfiguration } from '../../configuration'
import { resolveHubAccessToken } from '../../utils/accessTokenResolver'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import { hashShareToken, isShareActive } from '../../store/sessionShares'
import { ensurePersonalAccessToken } from '../../accessTokens/personalToken'
import { resolveFeishuConfig, type ResolvedFeishuConfig } from '../../feishu/config'
import { loginWithFeishuCode, FeishuOAuthError, type FeishuUserInfo } from '../../feishu/feishuOAuth'
import { FeishuNamespaceConflictError, resolveFeishuNamespace } from '../../feishu/identity'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

export type AuthRoutesOptions = {
    /** Test seam: replaces the Feishu code exchange. */
    feishuLogin?: (code: string) => Promise<FeishuUserInfo>
    /** Test seam: overrides the env-derived Feishu configuration. */
    feishuConfig?: ResolvedFeishuConfig
    /** Test seam: overrides the hub data directory for token derivation. */
    dataDir?: string
}

export function createAuthRoutes(
    jwtSecret: Uint8Array,
    store: Store,
    options?: AuthRoutesOptions
): Hono<WebAppEnv> {
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
        let tokenId: string | null = null
        let personalAccessToken: string | undefined
        let shareSessionId: string | undefined
        let shareMode: SessionShareMode | undefined
        let shareInfo: SessionShareInfo | undefined

        // Access Token authentication (hub-issued token, or the legacy shared token)
        if ('accessToken' in parsed.data) {
            const resolved = resolveHubAccessToken(parsed.data.accessToken, store)
            if (!resolved) {
                return c.json({ error: 'Invalid access token' }, 401)
            }
            userId = await getOrCreateOwnerId()
            firstName = 'Web User'
            namespace = resolved.namespace
            tokenId = resolved.tokenId
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
        } else if ('feishuCode' in parsed.data) {
            const configuration = getConfiguration()
            const feishuConfig = options?.feishuConfig ?? resolveFeishuConfig()
            if (!feishuConfig) {
                return c.json({ error: 'Feishu login is not configured' }, 503)
            }

            let feishuUser: FeishuUserInfo
            try {
                const login = options?.feishuLogin ?? ((code: string) => loginWithFeishuCode(feishuConfig, code))
                feishuUser = await login(parsed.data.feishuCode)
            } catch (error) {
                if (error instanceof FeishuOAuthError) {
                    // Bad/expired code, app misconfiguration, or a rejected
                    // user: nothing the client can retry differently.
                    return c.json({ error: 'Feishu authentication failed' }, 401)
                }
                console.warn(
                    '[Feishu] login unavailable:',
                    error instanceof Error ? error.message : 'unknown error'
                )
                return c.json({ error: 'Feishu is temporarily unavailable' }, 503)
            }

            try {
                namespace = resolveFeishuNamespace(store, feishuConfig, feishuUser)
            } catch (error) {
                if (error instanceof FeishuNamespaceConflictError) {
                    return c.json({ error: 'namespace_conflict' }, 409)
                }
                throw error
            }

            userId = await getOrCreateOwnerId()
            firstName = feishuUser.name
            // The personal token is the SPA's durable credential and the CLI's
            // CLI_API_TOKEN. It is re-derivable, so Settings can show it again.
            const personal = await ensurePersonalAccessToken(
                store,
                options?.dataDir ?? configuration.dataDir,
                namespace,
                feishuUser.name
            )
            tokenId = personal.record.id
            personalAccessToken = personal.token
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
        if (tokenId) {
            claims.tid = tokenId
        }
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
            namespace,
            ...(personalAccessToken ? { accessToken: personalAccessToken } : {}),
            ...(shareInfo ? { share: shareInfo } : {})
        })
    })

    return app
}
