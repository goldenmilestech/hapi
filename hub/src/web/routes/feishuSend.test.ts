import { beforeAll, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createConfiguration } from '../../configuration'
import { Store } from '../../store'
import { FeishuSendService, type FeishuSendApi } from '../../feishu/outbound/service'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createFeishuSendRoutes } from './feishuSend'
import { createPermissionsRoutes } from './permissions'

const sent: Array<{ receiveIdType: string; receiveId: string; text: string }> = []

const api: FeishuSendApi = {
    async sendText(input) {
        sent.push(input)
        return { messageId: `om_${sent.length}`, chatId: null }
    },
    async getUser(openId) {
        return {
            openId,
            name: openId === 'ou_owner' ? '董卓然' : '张三',
            email: openId === 'ou_owner' ? 'owner@corp.com' : 'guest@corp.com',
            enterpriseEmail: null
        }
    },
    async findOpenIdsByEmail() {
        return new Map()
    },
    async getChat(chatId) {
        return { chatId, name: '项目群', chatMode: 'group', chatStatus: 'normal', ownerId: 'ou_owner' }
    },
    async searchChats() {
        return []
    },
    async listChatMembers() {
        return { members: [{ openId: 'ou_owner', name: null }], truncated: false }
    },
    async searchUsersByName() {
        return { users: [], complete: true }
    }
}

function createApp(options: { share?: boolean } = {}) {
    const store = new Store(':memory:')
    store.users.addUser('feishu', 'ou_owner', 'default')
    store.feishuProfiles.upsert({
        openId: 'ou_owner',
        namespace: 'default',
        name: '董卓然',
        email: 'owner@corp.com'
    })
    const service = new FeishuSendService({
        store,
        config: {
            appId: 'app',
            appSecret: 'secret',
            ownerOpenId: 'ou_owner',
            approvalTtlSeconds: 600,
            maxSendsPerMinute: 30
        },
        api
    })
    const session = {
        id: 'session-1',
        namespace: 'default',
        active: true,
        agentState: { requests: {} as Record<string, unknown> }
    }
    const engine = {
        resolveSessionAccess: (sessionId: string, namespace: string) => {
            if (sessionId !== session.id || namespace !== session.namespace) {
                return { ok: false, reason: 'not-found' }
            }
            return { ok: true, sessionId: session.id, session }
        }
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        c.set('userId', 1)
        if (options.share) {
            c.set('sessionId', 'session-1')
        }
        await next()
    })
    app.route('/api', createFeishuSendRoutes({
        getSyncEngine: () => engine,
        getFeishuSendService: () => service
    }))
    app.route('/api', createPermissionsRoutes(() => engine, {
        getFeishuSendService: () => service
    }))
    return { app, session, store }
}

beforeAll(async () => {
    await createConfiguration()
})

describe('Feishu send routes', () => {
    it('creates an approval and sends it when the permission endpoint is approved', async () => {
        sent.length = 0
        const { app, session } = createApp()

        const sendResponse = await app.request('/api/sessions/session-1/feishu/sends', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'dm', to: 'ou_guest', text: 'hello' })
        })
        expect(sendResponse.status).toBe(200)
        const sendBody = await sendResponse.json() as {
            status: string
            requestId: string
            approval: { targetLabel: string }
        }
        expect(sendBody.status).toBe('pending_approval')
        expect(sendBody.approval.targetLabel).toContain('张三')
        expect(sent).toHaveLength(0)

        // The CLI inserts the synthetic request; the hub route checks only its
        // own approval record, but the card needs the request to exist.
        session.agentState.requests[sendBody.requestId] = {
            tool: 'feishu_send_message',
            arguments: {},
            createdAt: Date.now()
        }

        const approveResponse = await app.request(
            `/api/sessions/session-1/permissions/${encodeURIComponent(sendBody.requestId)}/approve`,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
        )
        expect(approveResponse.status).toBe(200)
        const approveBody = await approveResponse.json() as { ok: boolean; status: string }
        expect(approveBody).toMatchObject({ ok: true, status: 'sent' })
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ receiveIdType: 'open_id', receiveId: 'ou_guest', text: 'hello' })
    })

    it('rejects share-token approvals', async () => {
        sent.length = 0
        const { app, session } = createApp({ share: true })

        const sendResponse = await app.request('/api/sessions/session-1/feishu/sends', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'dm', to: 'ou_guest', text: 'hello' })
        })
        expect(sendResponse.status).toBe(403)
        expect(session.agentState.requests).toEqual({})
        expect(sent).toHaveLength(0)
    })

    it('maps service errors to HTTP statuses', async () => {
        sent.length = 0
        const { app } = createApp()
        const response = await app.request('/api/sessions/session-1/feishu/sends', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'dm', to: 'me', text: 'hi <at user_id="all"></at>' })
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'invalid_text' })
    })
})
