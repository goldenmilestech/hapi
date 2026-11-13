import { describe, expect, it } from 'bun:test'
import { FeishuBotApi, FeishuApiError } from './feishuApi'

type Call = { url: string; init?: RequestInit }

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): {
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
    calls: Call[]
} {
    const calls: Call[] = []
    return {
        calls,
        fetchImpl: async (url, init) => {
            calls.push({ url, init })
            return handler(url, init)
        }
    }
}

describe('FeishuBotApi', () => {
    it('caches the tenant token and sends text with a JSON-encoded content body', async () => {
        const { fetchImpl, calls } = fakeFetch((url) => {
            if (url.includes('tenant_access_token')) {
                return jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 })
            }
            return jsonResponse({ code: 0, data: { message_id: 'om_1', chat_id: 'oc_group' } })
        })
        const api = new FeishuBotApi({ appId: 'app', appSecret: 'secret' }, fetchImpl)

        const first = await api.sendText({
            receiveIdType: 'open_id',
            receiveId: 'ou_guest',
            text: 'hello'
        })
        expect(first).toEqual({ messageId: 'om_1', chatId: 'oc_group' })

        await api.sendText({
            receiveIdType: 'email',
            receiveId: 'a@b.com',
            text: 'second'
        })

        const tokenCalls = calls.filter((call) => call.url.includes('tenant_access_token'))
        expect(tokenCalls).toHaveLength(1)
        const sends = calls.filter((call) => call.url.includes('/im/v1/messages'))
        expect(sends).toHaveLength(2)
        expect(sends[0]!.url).toContain('receive_id_type=open_id')
        const body = JSON.parse(String(sends[0]!.init?.body)) as Record<string, unknown>
        expect(body.receive_id).toBe('ou_guest')
        expect(body.msg_type).toBe('text')
        expect(JSON.parse(String(body.content))).toEqual({ text: 'hello' })
        expect(typeof body.uuid).toBe('string')
        expect(sends[1]!.url).toContain('receive_id_type=email')
    })

    it('falls back to the bot chat list when the v2 search endpoint is unavailable', async () => {
        const { fetchImpl, calls } = fakeFetch((url) => {
            if (url.includes('tenant_access_token')) {
                return jsonResponse({ code: 0, tenant_access_token: 't', expire: 7200 })
            }
            if (url.includes('/im/v2/chats/search')) {
                return jsonResponse({ code: 404, msg: 'not found' }, 404)
            }
            if (url.includes('/im/v1/chats?')) {
                return jsonResponse({
                    code: 0,
                    data: {
                        items: [
                            { chat_id: 'oc_project', name: 'Project group', chat_mode: 'group', chat_status: 'normal' },
                            { chat_id: 'oc_other', name: 'Other group', chat_mode: 'group', chat_status: 'normal' }
                        ],
                        has_more: false
                    }
                })
            }
            return jsonResponse({ code: 404, msg: 'unexpected' }, 404)
        })
        const api = new FeishuBotApi({ appId: 'app', appSecret: 'secret' }, fetchImpl)

        const chats = await api.searchChats('project')
        expect(chats).toEqual([{
            chatId: 'oc_project',
            name: 'Project group',
            chatMode: 'group',
            chatStatus: 'normal',
            ownerId: null
        }])
        expect(calls.some((call) => call.url.includes('/im/v1/chats?'))).toBe(true)
    })

    it('surfaces Feishu error codes', async () => {
        const { fetchImpl } = fakeFetch((url) => {
            if (url.includes('tenant_access_token')) {
                return jsonResponse({ code: 0, tenant_access_token: 't', expire: 7200 })
            }
            return jsonResponse({ code: 99991672, msg: 'no permission' }, 403)
        })
        const api = new FeishuBotApi({ appId: 'app', appSecret: 'secret' }, fetchImpl)

        await expect(api.getChat('oc_x')).rejects.toMatchObject({
            name: 'FeishuApiError',
            feishuCode: 99991672
        } satisfies Partial<FeishuApiError>)
    })
})
