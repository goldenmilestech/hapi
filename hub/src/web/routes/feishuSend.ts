import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { FEISHU_SEND_FILE_MAX_BYTES, FeishuSendRequestSchema, type FeishuSendResponse, type FeishuSendStatusResponse } from '@hapi/protocol/apiTypes'
import type { SyncEngine } from '../../sync/syncEngine'
import { FeishuSendError, type FeishuSendService } from '../../feishu/outbound/service'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

/** Multipart boundaries and headers need a little room above the file itself. */
const FEISHU_FILE_MULTIPART_OVERHEAD_BYTES = 1_000_000
const FILE_NAME_CONTROL_RE = /[\u0000-\u001f\u007f]/g

function sanitizeFileName(name: string): string {
    return name
        .replace(/[\\/]/g, '_')
        .replace(FILE_NAME_CONTROL_RE, '')
        .trim()
        .slice(0, 255)
}

export function feishuSendErrorStatus(code: FeishuSendError['code']): 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503 {
    switch (code) {
        case 'invalid_text':
        case 'invalid_file':
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

    app.post('/sessions/:id/feishu/files', bodyLimit({
        maxSize: FEISHU_SEND_FILE_MAX_BYTES + FEISHU_FILE_MULTIPART_OVERHEAD_BYTES,
        onError: (c) => c.json({ error: 'File too large', code: 'file_too_large' }, 413)
    }), async (c) => {
        const engine = requireSyncEngine(c, options.getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        if (c.get('sessionId')) {
            return c.json({ error: 'Share tokens cannot upload Feishu files' }, 403)
        }
        const service = options.getFeishuSendService()
        if (!service) {
            return c.json({ error: 'Feishu bot is not configured on this hub' }, 503)
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const form = await c.req.formData().catch(() => null)
        if (!form) {
            return c.json({ error: 'Invalid form data' }, 400)
        }
        const file = form.get('file')
        if (!(file instanceof File)) {
            return c.json({ error: 'Missing file', code: 'invalid_file' }, 400)
        }
        if (file.size === 0) {
            return c.json({ error: 'File must not be empty', code: 'invalid_file' }, 400)
        }
        if (file.size > FEISHU_SEND_FILE_MAX_BYTES) {
            return c.json({ error: 'File too large', code: 'file_too_large' }, 413)
        }
        const fileName = sanitizeFileName(file.name)
        if (!fileName) {
            return c.json({ error: 'Invalid file name', code: 'invalid_file' }, 400)
        }

        try {
            const data = new Uint8Array(await file.arrayBuffer())
            const uploaded = await service.uploadFile({
                namespace: c.get('namespace'),
                fileName,
                data,
                size: file.size
            })
            c.header('Cache-Control', 'no-store')
            return c.json(uploaded)
        } catch (error) {
            return errorResponse(c, error)
        }
    })

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
