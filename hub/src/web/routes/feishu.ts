import { Hono, type Context } from 'hono'
import {
    CreateFeishuBindingRequestSchema,
    type CreateFeishuBindingResponse,
    type FeishuBindingsResponse,
    type FeishuEmailBindingSummary,
    type FeishuPublicConfigResponse
} from '@hapi/protocol/apiTypes'
import type { Store } from '../../store'
import type { FeishuEmailBinding } from '../../store/feishuBindings'
import { publicFeishuConfig } from '../../feishu/config'
import type { WebAppEnv } from '../middleware/auth'

function toSummary(binding: FeishuEmailBinding): FeishuEmailBindingSummary {
    return {
        id: binding.id,
        email: binding.email,
        namespace: binding.namespace,
        createdAt: binding.createdAt
    }
}

function isOwner(c: Context<WebAppEnv>): boolean {
    return c.get('sessionId') === undefined && c.get('namespace') === 'default'
}

export function createFeishuRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Public: the SPA needs the app id and redirect URI to build the authorize
    // URL. The auth middleware skips exactly this path.
    app.get('/auth/feishu/config', (c) => {
        const response: FeishuPublicConfigResponse = publicFeishuConfig()
        return c.json(response)
    })

    app.get('/feishu/bindings', (c) => {
        if (!isOwner(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        const response: FeishuBindingsResponse = {
            bindings: store.feishuBindings.list().map(toSummary)
        }
        return c.json(response)
    })

    app.post('/feishu/bindings', async (c) => {
        if (!isOwner(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = CreateFeishuBindingRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const binding = store.feishuBindings.upsert(parsed.data)
        const response: CreateFeishuBindingResponse = { binding: toSummary(binding) }
        return c.json(response)
    })

    app.delete('/feishu/bindings/:email', (c) => {
        if (!isOwner(c)) {
            return c.json({ error: 'Forbidden' }, 403)
        }
        let email: string
        try {
            email = decodeURIComponent(c.req.param('email'))
        } catch {
            return c.json({ error: 'Invalid email' }, 400)
        }
        if (!store.feishuBindings.remove(email)) {
            return c.json({ error: 'Binding not found' }, 404)
        }
        return c.json({ ok: true })
    })

    return app
}
