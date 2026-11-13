import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { PermissionRequestNotFoundError } from '../../sync/rpcGateway'
import type { SyncEngine } from '../../sync/syncEngine'
import {
    FEISHU_SEND_REQUEST_PREFIX,
    FeishuSendError,
    type FeishuSendService
} from '../../feishu/outbound/service'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'
import { feishuSendErrorStatus } from './feishuSend'

const decisionSchema = z.enum(['approved', 'approved_for_session', 'denied', 'abort'])

// Flat format: Record<string, string[]> (AskUserQuestion)
// Nested format: Record<string, { answers: string[] }> (request_user_input)
const answersSchema = z.union([
    z.record(z.string(), z.array(z.string())),
    z.record(z.string(), z.object({ answers: z.array(z.string()) }))
])

const approveBodySchema = z.object({
    mode: PermissionModeSchema.optional(),
    allowTools: z.array(z.string()).optional(),
    decision: decisionSchema.optional(),
    answers: answersSchema.optional()
})

const denyBodySchema = z.object({
    decision: decisionSchema.optional()
})

export type PermissionsRoutesOptions = {
    /**
     * Agent-initiated Feishu sends reuse the permission endpoints so every
     * client's approval card works unchanged. Their request ids carry the
     * `feishu:` prefix and are decided by the hub, not the CLI.
     */
    getFeishuSendService?: () => FeishuSendService | null
}

async function decideFeishuSend(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    requestId: string,
    approved: boolean,
    options: PermissionsRoutesOptions
): Promise<Response> {
    if (c.get('sessionId')) {
        return c.json({ error: 'Share tokens cannot approve Feishu sends' }, 403)
    }
    const service = options.getFeishuSendService?.()
    if (!service) {
        return c.json({ error: 'Feishu bot is not configured on this hub' }, 503)
    }
    const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
    if (sessionResult instanceof Response) {
        return sessionResult
    }
    try {
        const result = await service.decide({
            namespace: c.get('namespace'),
            sessionId: sessionResult.sessionId,
            requestId,
            approved,
            decidedBy: c.get('userId')
        })
        return c.json({ ok: true, ...result })
    } catch (error) {
        if (error instanceof FeishuSendError) {
            return c.json(
                { error: error.message, code: error.code },
                feishuSendErrorStatus(error.code)
            )
        }
        return c.json(
            { error: error instanceof Error ? error.message : 'Feishu send failed' },
            502
        )
    }
}

export function createPermissionsRoutes(
    getSyncEngine: () => SyncEngine | null,
    options: PermissionsRoutesOptions = {}
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/permissions/:requestId/approve', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const requestId = c.req.param('requestId')
        if (requestId.startsWith(FEISHU_SEND_REQUEST_PREFIX)) {
            return await decideFeishuSend(c, engine, requestId, true, options)
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const json = await c.req.json().catch(() => null)
        const parsed = approveBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const requests = session.agentState?.requests ?? null
        if (!requests || !requests[requestId]) {
            return c.json({ error: 'Request not found' }, 404)
        }

        const mode = parsed.data.mode
        if (mode !== undefined) {
            const flavor = session.metadata?.flavor ?? 'claude'
            if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
                return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
            }
        }
        const allowTools = parsed.data.allowTools
        const decision = parsed.data.decision
        const answers = parsed.data.answers
        try {
            await engine.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
        } catch (error) {
            if (error instanceof PermissionRequestNotFoundError) {
                return c.json({ error: error.message }, 409)
            }
            throw error
        }
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/permissions/:requestId/deny', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const requestId = c.req.param('requestId')
        if (requestId.startsWith(FEISHU_SEND_REQUEST_PREFIX)) {
            return await decideFeishuSend(c, engine, requestId, false, options)
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const requests = session.agentState?.requests ?? null
        if (!requests || !requests[requestId]) {
            return c.json({ error: 'Request not found' }, 404)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = denyBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.denyPermission(sessionId, requestId, parsed.data.decision)
        } catch (error) {
            if (error instanceof PermissionRequestNotFoundError) {
                return c.json({ error: error.message }, 409)
            }
            throw error
        }
        return c.json({ ok: true })
    })

    return app
}
