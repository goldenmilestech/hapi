import { describe, expect, it, vi } from 'vitest'
import {
    FeishuSendClientError,
    createFeishuSend,
    formatFeishuReceipt,
    formatFeishuSendOutcome
} from './feishuSend'

function fakeHttp(requestResponse: { status: number; data: unknown }) {
    return {
        post: vi.fn(async () => ({ status: 200, data: { token: 'jwt-token' } })),
        request: vi.fn(async () => requestResponse)
    }
}

describe('Feishu send CLI client', () => {
    it('posts the send request to the session-scoped route', async () => {
        const http = fakeHttp({
            status: 200,
            data: {
                status: 'pending_approval',
                requestId: 'feishu:1',
                approval: {
                    requestId: 'feishu:1',
                    kind: 'dm',
                    targetLabel: '张三',
                    senderLabel: '董卓然',
                    text: 'hello',
                    preview: 'hello',
                    expiresAt: 123
                }
            }
        })

        const result = await createFeishuSend({
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'ou_guest', text: 'hello' },
            apiUrl: 'http://hub.local',
            accessToken: 'token',
            http: http as never
        })

        expect(result.status).toBe('pending_approval')
        expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'post',
            url: 'http://hub.local/api/sessions/session-1/feishu/sends',
            data: { kind: 'dm', to: 'ou_guest', text: 'hello' }
        }))
    })

    it('surfaces the hub error code and message', async () => {
        const http = fakeHttp({
            status: 409,
            data: { error: '没有发送人', code: 'no_sender' }
        })

        await expect(createFeishuSend({
            sessionId: 'session-1',
            request: { kind: 'dm', to: 'me', text: 'hello' },
            apiUrl: 'http://hub.local',
            accessToken: 'token',
            http: http as never
        })).rejects.toMatchObject({
            name: 'FeishuSendClientError',
            code: 'no_sender',
            message: '没有发送人'
        } satisfies Partial<FeishuSendClientError>)
    })

    it('formats receipts and terminal outcomes', () => {
        const receipt = {
            requestId: 'feishu:1',
            messageId: 'om_1',
            chatId: 'oc_group',
            kind: 'group' as const,
            targetLabel: '项目群',
            senderLabel: '董卓然',
            sentAt: new Date('2026-11-13T04:00:00Z').getTime()
        }
        expect(formatFeishuReceipt(receipt)).toContain('message_id=om_1')
        expect(formatFeishuReceipt(receipt)).toContain('项目群')

        expect(formatFeishuSendOutcome({
            requestId: 'feishu:1',
            status: 'denied'
        })).toContain('拒绝')
        expect(formatFeishuSendOutcome({
            requestId: 'feishu:1',
            status: 'failed',
            error: 'permission denied'
        })).toContain('permission denied')
        expect(formatFeishuSendOutcome({
            requestId: 'feishu:1',
            status: 'sent',
            receipt
        })).toContain('om_1')
    })
})
