import { Hono, type Context } from 'hono'
import { FeishuSendRequestSchema, type FeishuSendResponse, type FeishuSendStatusResponse } from '@hapi/protocol/apiTypes'
import type { SyncEngine } from '../../sync/syncEngine'
import { FeishuSendError, type FeishuSendService } from '../../feishu/outbound/service'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

export function feishuSendErrorStatus(code: FeishuSendError['code']): 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503 {
    switch (code) {
        case 'invalid_text':
            return 400
        case 'sender_not_in_chat':
            return 403
        case 'recipient_not_found':
        case 'chat_not_found':
            return 422
        case 'no_sender':
        case 'ambiguous_sender':
        case 'recipient_ambiguous':
        case 'chat_ambiguous':
        case 'not_found':
        case 'not_pending':
        case 'expired':
            return 409
        case 'rate_limited':
            return 429
        case 'send_failed':
            return 502
        case 'disabled':
        case 'sender_check_unavailable':
            return 503
    }
}

function errorResponse(c: Context<WebAppEnv>, error: unknown): Response {
    if (error instanceof FeishuSendError) {
        return c.json({ error: error.message, code: error.code }, feishuSendErrorStatus(error.code))
    }
    return c.json(
        { error: error instanceof Error ? error.message : 'Feishu send failed' },
        502
    )
}

/**
 * Agent-initiated Feishu sends. The CLI obtains a namespace-scoped JWT and
 * calls these routes; the hub owns target resolution, group mentions and the
 * approval record.
 */
export function createFeishuSendRoutes(options: {
    getSyncEngine: () => SyncEngine | null
    getFeishuSendService: () => FeishuSendService | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/feishu/sends', async (c) => {
        const engine = requireSyncEngine(c, options.getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        if (c.get('sessionId')) {
            return c.json({ error: 'Share tokens cannot send Feishu messages' }, 403)
        }
        const service = options.getFeishuSendService()
        if (!service) {
            return c.json({ error: 'Feishu bot is not configured on this hub' }, 503)
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const json = await c.req.json().catch(() => null)
        const parsed = FeishuSendRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await service.createSendRequest({
                namespace: c.get('namespace'),
                sessionId: sessionResult.sessionId,
                request: parsed.data
            })
            c.header('Cache-Control', 'no-store')
            return c.json(result satisfies FeishuSendResponse)
        } catch (error) {
            return errorResponse(c, error)
        }
    })

    app.get('/sessions/:id/feishu/sends/:requestId', (c) => {
        const engine = requireSyncEngine(c, options.getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        if (c.get('sessionId')) {
            return c.json({ error: 'Share tokens cannot read Feishu sends' }, 403)
        }
        const service = options.getFeishuSendService()
        if (!service) {
            return c.json({ error: 'Feishu bot is not configured on this hub' }, 503)
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        try {
            const result = service.getStatus({
                namespace: c.get('namespace'),
                sessionId: sessionResult.sessionId,
                requestId: c.req.param('requestId')
            })
            c.header('Cache-Control', 'no-store')
            return c.json(result satisfies FeishuSendStatusResponse)
        } catch (error) {
            return errorResponse(c, error)
        }
    })

    return app
}
