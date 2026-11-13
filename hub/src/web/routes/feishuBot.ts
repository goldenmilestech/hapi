import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { CreateFeishuBotBindCodeRequestSchema, type FeishuBotBindingsResponse } from '@hapi/protocol/apiTypes'
import type { Store } from '../../store'
import { getSessionName } from '../../notifications/sessionInfo'
import type { SyncEngine } from '../../sync/syncEngine'
import { FeishuWebhookVerificationError, type FeishuBot } from '../../feishu/bot/feishuBot'
import type { WebAppEnv } from '../middleware/auth'

const FEISHU_EVENT_MAX_BODY_BYTES = 1_000_000

/**
 * Public Feishu callback. Registered before the JWT middleware because Feishu
 * cannot present a hub token; the verification token and optional signature
 * are the authentication instead.
 */
export function createFeishuWebhookRoute(options: {
    getFeishuBot: () => FeishuBot | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post(
        '/feishu/events',
        bodyLimit({
            maxSize: FEISHU_EVENT_MAX_BODY_BYTES,
            onError: (c) => c.json({ error: 'Request body too large' }, 413)
        }),
        async (c) => {
            const bot = options.getFeishuBot()
            if (!bot) {
                return c.json({ error: 'Feishu bot is not configured' }, 404)
            }

            const rawBody = await c.req.text()
            try {
                const result = await bot.handleWebhook(rawBody, c.req.raw.headers)
                return result ? c.json({ challenge: result.challenge }) : c.json({ ok: true })
            } catch (error) {
                if (error instanceof FeishuWebhookVerificationError) {
                    console.warn('[FeishuBot] Rejected webhook:', error.message)
                    return c.json({ error: 'Invalid Feishu event' }, 403)
                }
                // Handler failures must be retried by Feishu; the event is only
                // recorded after successful handling.
                console.error(
                    '[FeishuBot] Webhook handling failed:',
                    error instanceof Error ? error.message : error
                )
                return c.json({ error: 'Feishu event handling failed' }, 500)
            }
        }
    )

    return app
}

export type FeishuBotRoutesOptions = {
    store: Store
    getSyncEngine: () => SyncEngine | null
}

/** Namespace-scoped management APIs used by the settings page. */
export function createFeishuBotRoutes(options: FeishuBotRoutesOptions): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/feishu/bot/bindings', (c) => {
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const bindings = options.store.feishuBotBindings.listByNamespace(namespace)
        const response: FeishuBotBindingsResponse = {
            bindings: bindings.map((binding) => {
                const session = engine?.getSession(binding.sessionId)
                return {
                    id: binding.id,
                    chatId: binding.chatId,
                    chatType: binding.chatType,
                    chatName: binding.chatName,
                    namespace: binding.namespace,
                    sessionId: binding.sessionId,
                    sessionTitle: session ? getSessionName(session) : binding.sessionTitle,
                    createdAt: binding.createdAt
                }
            })
        }
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    app.post('/feishu/bot/bind-codes', async (c) => {
        const engine = options.getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Sync engine unavailable' }, 503)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = CreateFeishuBotBindCodeRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: sessionId is required' }, 400)
        }

        const namespace = c.get('namespace')
        const session = engine.getSession(parsed.data.sessionId)
        if (!session || session.namespace !== namespace) {
            return c.json({ error: 'Session not found' }, 404)
        }

        const created = options.store.feishuBotBindings.createBindCode({
            namespace,
            sessionId: session.id
        })
        c.header('Cache-Control', 'no-store')
        return c.json({
            code: created.code,
            expiresAt: created.expiresAt,
            sessionId: session.id,
            sessionTitle: getSessionName(session)
        })
    })

    app.delete('/feishu/bot/bindings/:id', (c) => {
        const namespace = c.get('namespace')
        const removed = options.store.feishuBotBindings.removeById(c.req.param('id'), namespace)
        if (!removed) {
            return c.json({ error: 'Binding not found' }, 404)
        }
        return c.json({ ok: true })
    })

    return app
}
