import { describe, expect, it } from 'bun:test'
import { FeishuBotApi, type FeishuFetch } from './feishuApi'

function fakeFetch(calls: Array<{ url: string; init?: RequestInit }>): FeishuFetch {
    return async (url, init) => {
        calls.push({ url, init })
        if (url.includes('tenant_access_token')) {
            return new Response(JSON.stringify({
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200
            }), { status: 200 })
        }
        return new Response(JSON.stringify({
            code: 0,
            msg: 'success',
            data: { message_id: 'om_1' }
        }), { status: 200 })
    }
}

describe('FeishuBotApi', () => {
    it('updates a card through the message PATCH endpoint', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const api = new FeishuBotApi({ appId: 'app', appSecret: 'secret' }, fakeFetch(calls))

        await api.updateCard('om_card_1', { schema: '2.0' })

        const patch = calls.find((call) => call.init?.method === 'PATCH')
        expect(patch?.url).toContain('/open-apis/im/v1/messages/om_card_1')
        expect(patch?.init?.headers).toMatchObject({
            authorization: 'Bearer tenant-token',
            'content-type': 'application/json'
        })
        const body = JSON.parse(String(patch?.init?.body)) as { content: string }
        expect(JSON.parse(body.content)).toEqual({ schema: '2.0' })
    })

    it('adds a reaction through the message reactions endpoint', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const api = new FeishuBotApi({ appId: 'app', appSecret: 'secret' }, fakeFetch(calls))

        await api.addReaction('om_card_1', 'Typing')

        const post = calls.find((call) => call.url.includes('/reactions'))
        expect(post?.url).toContain('/open-apis/im/v1/messages/om_card_1/reactions')
        expect(post?.init?.method).toBe('POST')
        expect(JSON.parse(String(post?.init?.body))).toEqual({
            reaction_type: { emoji_type: 'Typing' }
        })
    })
})
