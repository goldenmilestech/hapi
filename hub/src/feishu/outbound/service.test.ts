import { afterEach, describe, expect, it } from 'bun:test'
import { Store } from '../../store'
import {
    FEISHU_SEND_REQUEST_PREFIX,
    FeishuSendError,
    FeishuSendService,
    formatGroupText,
    type FeishuSendApi
} from './service'

type SentMessage = {
    receiveIdType: 'open_id' | 'email' | 'chat_id'
    receiveId: string
    text: string
}

class FakeApi implements FeishuSendApi {
    readonly sent: SentMessage[] = []
    members = new Set(['ou_owner', 'ou_guest'])
    ownerId: string | null = 'ou_owner'
    truncated = false
    chats = [
        { chatId: 'oc_project', name: '项目群', chatMode: 'group', chatStatus: 'normal', ownerId: 'ou_owner' },
        { chatId: 'oc_other', name: '项目群二群', chatMode: 'group', chatStatus: 'normal', ownerId: 'ou_owner' }
    ]

    async sendText(input: SendMessageInput): Promise<{ messageId: string; chatId: string | null }> {
        this.sent.push(input)
        return {
            messageId: `om_${this.sent.length}`,
            chatId: input.receiveIdType === 'chat_id' ? input.receiveId : null
        }
    }

    async getUser(openId: string) {
        if (openId === 'ou_owner') {
            return { openId, name: '董卓然', email: 'owner@corp.com', enterpriseEmail: null }
        }
        return { openId, name: '张三', email: 'guest@corp.com', enterpriseEmail: null }
    }

    async findOpenIdsByEmail(emails: string[]) {
        const map = new Map<string, string>()
        for (const email of emails) {
            if (email === 'guest@corp.com') map.set(email, 'ou_guest')
            if (email === 'owner@corp.com') map.set(email, 'ou_owner')
        }
        return map
    }

    async getChat(chatId: string) {
        const chat = this.chats.find((item) => item.chatId === chatId)
        return chat ?? null
    }

    async searchChats(query: string) {
        const lower = query.toLowerCase()
        return this.chats.filter((chat) => chat.name.toLowerCase().includes(lower))
    }

    async listChatMembers(chatId: string) {
        void chatId
        return {
            members: Array.from(this.members).map((openId) => ({ openId, name: null })),
            truncated: this.truncated
        }
    }

    async searchUsersByName(name: string) {
        return {
            users: [{
                openId: 'ou_guest',
                name,
                email: 'guest@corp.com',
                enterpriseEmail: null
            }],
            complete: true
        }
    }
}

type SendMessageInput = {
    receiveIdType: 'open_id' | 'email' | 'chat_id'
    receiveId: string
    text: string
    idempotencyKey?: string
}

function createService(api: FakeApi, overrides: { now?: () => number } = {}) {
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
        api,
        now: overrides.now,
        createId: () => 'test-id'
    })
    return { store, service }
}

const stores: Store[] = []

afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close()
    }
})

function serviceWithApi(api: FakeApi, overrides: { now?: () => number } = {}) {
    const created = createService(api, overrides)
    stores.push(created.store)
    return created.service
}

describe('FeishuSendService', () => {
    it('sends a DM to the owner immediately without an approval', async () => {
        const api = new FakeApi()
        const service = serviceWithApi(api)

        const result = await service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'me', text: 'hello owner' }
        })

        expect(result.status).toBe('sent')
        if (result.status !== 'sent') throw new Error('expected sent')
        expect(result.requestId.startsWith(FEISHU_SEND_REQUEST_PREFIX)).toBe(true)
        expect(api.sent).toEqual([{
            receiveIdType: 'open_id',
            receiveId: 'ou_owner',
            text: 'hello owner'
        }])
        expect(result.receipt).toMatchObject({
            requestId: result.requestId,
            messageId: 'om_1',
            kind: 'dm',
            targetLabel: expect.stringContaining('本人')
        })
    })

    it('requires approval for a DM to someone else and sends after approval', async () => {
        const api = new FakeApi()
        const service = serviceWithApi(api)

        const result = await service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'ou_guest', text: 'hello guest' }
        })

        expect(result.status).toBe('pending_approval')
        if (result.status !== 'pending_approval') throw new Error('expected approval')
        expect(api.sent).toHaveLength(0)
        expect(result.approval.targetLabel).toContain('张三')

        const pending = service.getStatus({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: result.requestId
        })
        expect(pending.status).toBe('pending_approval')

        const decided = await service.decide({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: result.requestId,
            approved: true,
            decidedBy: 1
        })
        expect(decided.status).toBe('sent')
        expect(decided.receipt?.messageId).toBe('om_1')
        expect(api.sent).toEqual([{
            receiveIdType: 'open_id',
            receiveId: 'ou_guest',
            text: 'hello guest'
        }])
    })

    it('does not send when the user denies the approval', async () => {
        const api = new FakeApi()
        const service = serviceWithApi(api)
        const result = await service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'ou_guest', text: 'nope' }
        })
        if (result.status !== 'pending_approval') throw new Error('expected approval')

        const decided = await service.decide({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: result.requestId,
            approved: false
        })
        expect(decided.status).toBe('denied')
        expect(api.sent).toHaveLength(0)
    })

    it('adds the sender mention to group messages', async () => {
        const api = new FakeApi()
        const service = serviceWithApi(api)
        const result = await service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'group', chat: 'oc_project', text: 'deploy done' }
        })
        if (result.status !== 'pending_approval') throw new Error('expected approval')

        expect(result.approval.text).toContain('<at user_id="ou_owner">')
        expect(result.approval.text).toContain('通过 HAPI 发送')

        const decided = await service.decide({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: result.requestId,
            approved: true
        })
        expect(decided.status).toBe('sent')
        expect(api.sent[0]).toMatchObject({
            receiveIdType: 'chat_id',
            receiveId: 'oc_project',
            text: formatGroupText({ openId: 'ou_owner' }, 'deploy done')
        })
    })

    it('refuses group sends when the sender is not in the group', async () => {
        const api = new FakeApi()
        api.members.delete('ou_owner')
        api.ownerId = 'ou_guest'
        api.chats[0]!.ownerId = 'ou_guest'
        const service = serviceWithApi(api)

        await expect(service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'group', chat: 'oc_project', text: 'hello' }
        })).rejects.toMatchObject({ code: 'sender_not_in_chat' })
        expect(api.sent).toHaveLength(0)
    })

    it('refuses group sends when the member list was truncated', async () => {
        const api = new FakeApi()
        api.members.delete('ou_owner')
        api.ownerId = 'ou_guest'
        api.chats[0]!.ownerId = 'ou_guest'
        api.truncated = true
        const service = serviceWithApi(api)

        await expect(service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'group', chat: 'oc_project', text: 'hello' }
        })).rejects.toMatchObject({ code: 'sender_check_unavailable' })
    })

    it('refuses when the namespace has no Feishu sender', async () => {
        const api = new FakeApi()
        const service = serviceWithApi(api)
        await expect(service.createSendRequest({
            namespace: 'empty-namespace',
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'me', text: 'hello' }
        })).rejects.toMatchObject({ code: 'no_sender' })
    })

    it('rejects model-provided <at> tags', async () => {
        const api = new FakeApi()
        const service = serviceWithApi(api)
        await expect(service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'me', text: 'hi <at user_id="all"></at>' }
        })).rejects.toBeInstanceOf(FeishuSendError)
    })

    it('resolves a DM recipient by unique display name', async () => {
        const api = new FakeApi()
        const service = serviceWithApi(api)
        const result = await service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'dm', to: '张三', text: 'by name' }
        })
        expect(result.status).toBe('pending_approval')
        if (result.status !== 'pending_approval') throw new Error('expected approval')
        expect(result.approval.targetLabel).toContain('张三')
    })

    it('rejects an ambiguous group name', async () => {
        const api = new FakeApi()
        api.chats.push({
            chatId: 'oc_project_dup',
            name: '项目群',
            chatMode: 'group',
            chatStatus: 'normal',
            ownerId: 'ou_owner'
        })
        const service = serviceWithApi(api)
        await expect(service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'group', chat: '项目群', text: 'hello' }
        })).rejects.toMatchObject({ code: 'chat_ambiguous' })
    })

    it('expires a pending approval instead of sending late', async () => {
        const api = new FakeApi()
        let now = 1_000_000
        const service = serviceWithApi(api, { now: () => now })
        const result = await service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'ou_guest', text: 'late' }
        })
        if (result.status !== 'pending_approval') throw new Error('expected approval')

        now += 601_000
        const decided = await service.decide({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: result.requestId,
            approved: true
        })
        expect(decided.status).toBe('expired')
        expect(api.sent).toHaveLength(0)
    })

    it('does not let another session read or decide the approval', async () => {
        const api = new FakeApi()
        const service = serviceWithApi(api)
        const result = await service.createSendRequest({
            namespace: 'default',
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'ou_guest', text: 'private' }
        })
        if (result.status !== 'pending_approval') throw new Error('expected approval')

        expect(() => service.getStatus({
            namespace: 'default',
            sessionId: 'session-2',
            requestId: result.requestId
        })).toThrow(FeishuSendError)
        await expect(service.decide({
            namespace: 'default',
            sessionId: 'session-2',
            requestId: result.requestId,
            approved: true
        })).rejects.toMatchObject({ code: 'not_found' })
    })
})
