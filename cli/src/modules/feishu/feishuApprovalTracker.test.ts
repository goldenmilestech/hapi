import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '@/api/types'
import type { ApiSessionClient } from '@/api/apiSession'
import type { FeishuSendApprovalSummary } from '@hapi/protocol/apiTypes'

const getStatusMock = vi.fn()

vi.mock('./feishuSend', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./feishuSend')>()
    return {
        ...actual,
        getFeishuSendStatus: (...args: unknown[]) => getStatusMock(...args)
    }
})

import { trackFeishuApproval } from './feishuApprovalTracker'

function approval(id = 'feishu:1'): FeishuSendApprovalSummary {
    return {
        requestId: id,
        kind: 'dm',
        targetLabel: '张三（guest@corp.com）',
        senderLabel: '董卓然',
        text: 'hello',
        preview: 'hello',
        expiresAt: Date.now() + 600_000
    }
}

function fakeClient() {
    let state: AgentState = { requests: {}, completedRequests: {} }
    const messages: unknown[] = []
    const client = {
        sessionId: 'session-1',
        updateAgentState(handler: (current: AgentState) => AgentState) {
            state = handler(state)
        },
        sendAgentMessage(message: unknown) {
            messages.push(message)
        }
    }
    return {
        client: client as unknown as ApiSessionClient,
        messages,
        getState: () => state
    }
}

describe('FeishuApprovalTracker', () => {
    beforeEach(() => {
        getStatusMock.mockReset()
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('adds a pending agentState request, then moves it to completed and posts a receipt', async () => {
        const { client, messages, getState } = fakeClient()
        getStatusMock
            .mockResolvedValueOnce({ requestId: 'feishu:1', status: 'pending_approval' })
            .mockResolvedValueOnce({
                requestId: 'feishu:1',
                status: 'sent',
                receipt: {
                    requestId: 'feishu:1',
                    messageId: 'om_1',
                    chatId: null,
                    kind: 'dm',
                    targetLabel: '张三（guest@corp.com）',
                    senderLabel: '董卓然',
                    sentAt: Date.now()
                }
            })

        const tracker = trackFeishuApproval(client, approval())
        await vi.advanceTimersByTimeAsync(0)

        expect(getState().requests?.['feishu:1']).toMatchObject({
            tool: 'feishu_send_message',
            arguments: { targetLabel: '张三（guest@corp.com）' }
        })

        await vi.advanceTimersByTimeAsync(2_000)

        expect(getState().requests?.['feishu:1']).toBeUndefined()
        expect(getState().completedRequests?.['feishu:1']).toMatchObject({
            status: 'approved',
            reason: '已发送 · message_id=om_1'
        })
        expect(messages).toHaveLength(1)
        expect(String((messages[0] as { message: string }).message)).toContain('message_id=om_1')
        expect(tracker).toBeDefined()
    })

    it('does not post a duplicate receipt when the tool consumed the result', async () => {
        const { client, messages } = fakeClient()
        getStatusMock.mockResolvedValue({
            requestId: 'feishu:2',
            status: 'sent',
            receipt: {
                requestId: 'feishu:2',
                messageId: 'om_2',
                chatId: null,
                kind: 'dm',
                targetLabel: '张三',
                senderLabel: '董卓然',
                sentAt: Date.now()
            }
        })

        const tracker = trackFeishuApproval(client, approval('feishu:2'))
        const result = await tracker.waitFor(5_000)
        await vi.advanceTimersByTimeAsync(0)

        expect(result?.status).toBe('sent')
        expect(messages).toHaveLength(0)
    })

    it('marks the request canceled when the hub no longer knows the approval', async () => {
        const { client, messages, getState } = fakeClient()
        getStatusMock.mockRejectedValue(
            new (await import('./feishuSend')).FeishuSendClientError('not found', 404)
        )

        trackFeishuApproval(client, approval('feishu:3'))
        await vi.advanceTimersByTimeAsync(2_000)

        expect(getState().completedRequests?.['feishu:3']).toMatchObject({
            status: 'canceled',
            reason: '审批已过期，未发送。'
        })
        expect(messages).toHaveLength(1)
    })
})
