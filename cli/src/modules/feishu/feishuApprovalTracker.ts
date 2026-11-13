import type { AgentState } from '@/api/types'
import type { ApiSessionClient } from '@/api/apiSession'
import type {
    FeishuSendApprovalSummary,
    FeishuSendStatusResponse
} from '@hapi/protocol/apiTypes'
import { logger } from '@/ui/logger'
import {
    FeishuSendClientError,
    formatFeishuSendOutcome,
    getFeishuSendStatus
} from './feishuSend'

const POLL_INTERVAL_MS = 1_500
const POLL_GRACE_MS = 30_000
const MAX_POLL_ERRORS = 4
const TRACKER_RETENTION_MS = 10 * 60 * 1000

type Waiter = {
    resolve: (result: FeishuSendStatusResponse | null) => void
    timer: ReturnType<typeof setTimeout>
}

const trackers = new Map<string, FeishuApprovalTracker>()

function completedStatus(result: FeishuSendStatusResponse): 'approved' | 'denied' | 'canceled' {
    if (result.status === 'sent') return 'approved'
    if (result.status === 'denied') return 'denied'
    return 'canceled'
}

function completionReason(result: FeishuSendStatusResponse): string {
    if (result.status === 'sent') {
        return result.receipt
            ? `已发送 · message_id=${result.receipt.messageId}`
            : '已发送'
    }
    if (result.status === 'denied') {
        return '用户拒绝了本次发送。'
    }
    if (result.status === 'expired') {
        return '审批已过期，未发送。'
    }
    if (result.status === 'failed') {
        return `发送失败：${result.error ?? '未知错误'}`
    }
    return '审批仍在等待中。'
}

/**
 * Owns the lifecycle of one hub-side Feishu approval in the CLI process.
 *
 * The approval card is a synthetic `agentState.requests` entry so every HAPI
 * client renders it with the existing permission UI. Polling is deliberately
 * independent of the MCP tool handler: if the tool call is aborted or times
 * out, the tracker still clears the card and posts the receipt message when
 * the user decides.
 */
export class FeishuApprovalTracker {
    private readonly client: ApiSessionClient
    private readonly approval: FeishuSendApprovalSummary
    private readonly waiters: Waiter[] = []
    private timer: ReturnType<typeof setInterval> | null = null
    private terminal: FeishuSendStatusResponse | null = null
    private pollErrors = 0
    private consumedByTool = false
    private stopped = false

    constructor(client: ApiSessionClient, approval: FeishuSendApprovalSummary) {
        this.client = client
        this.approval = approval
    }

    start(): void {
        this.addPendingRequest()
        void this.poll()
        this.timer = setInterval(() => { void this.poll() }, POLL_INTERVAL_MS)
        // Do not keep the process alive solely for an approval poll.
        this.timer.unref?.()
    }

    /**
     * Wait for a decision. Returns null on timeout; the tracker keeps polling
     * and will still post the receipt once the user decides.
     */
    waitFor(maxMs: number): Promise<FeishuSendStatusResponse | null> {
        if (this.terminal) {
            this.consumedByTool = true
            return Promise.resolve(this.terminal)
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
                if (index >= 0) {
                    this.waiters.splice(index, 1)
                }
                resolve(null)
            }, maxMs)
            timer.unref?.()
            this.waiters.push({ resolve, timer })
        })
    }

    /**
     * `feishu_send_status` may observe the terminal state before the poller
     * does; apply it once so the card and receipt are consistent.
     */
    applyExternalStatus(result: FeishuSendStatusResponse): void {
        this.finish(result, true)
    }

    get approvalSummary(): FeishuSendApprovalSummary {
        return this.approval
    }

    private async poll(): Promise<void> {
        if (this.stopped) return
        if (Date.now() > this.approval.expiresAt + POLL_GRACE_MS) {
            this.finish({
                requestId: this.approval.requestId,
                status: 'expired',
                error: '审批已过期，未发送。'
            }, true)
            return
        }
        try {
            const result = await getFeishuSendStatus({
                sessionId: this.client.sessionId,
                requestId: this.approval.requestId
            })
            this.pollErrors = 0
            if (result.status !== 'pending_approval') {
                this.finish(result, true)
            }
        } catch (error) {
            this.pollErrors += 1
            logger.debug('[FeishuSend] approval poll failed:', error)
            const status = error instanceof FeishuSendClientError ? error.status : undefined
            if (status === 404 || status === 409) {
                this.finish({
                    requestId: this.approval.requestId,
                    status: 'expired',
                    error: '飞书发送审批已失效。'
                }, true)
                return
            }
            if (this.pollErrors >= MAX_POLL_ERRORS) {
                this.finish({
                    requestId: this.approval.requestId,
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error)
                }, true)
            }
        }
    }

    private finish(result: FeishuSendStatusResponse, postMessage: boolean): void {
        if (this.stopped) return
        this.stopped = true
        this.terminal = result
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        this.finalizeAgentState(result)
        // A waiting MCP tool will return the receipt itself. Only post a chat
        // message when nobody is waiting (the tool timed out or was aborted).
        const deliveredToWaiter = this.waiters.length > 0
        if (postMessage && !deliveredToWaiter && !this.consumedByTool) {
            this.client.sendAgentMessage({
                type: 'message',
                message: formatFeishuSendOutcome(result)
            })
        }
        for (const waiter of this.waiters.splice(0)) {
            clearTimeout(waiter.timer)
            waiter.resolve(result)
        }
        const cleanup = setTimeout(() => {
            trackers.delete(this.approval.requestId)
        }, TRACKER_RETENTION_MS)
        cleanup.unref?.()
    }

    private addPendingRequest(): void {
        const approval = this.approval
        this.client.updateAgentState((state: AgentState) => ({
            ...state,
            requests: {
                ...state.requests,
                [approval.requestId]: {
                    tool: 'feishu_send_message',
                    arguments: {
                        requestId: approval.requestId,
                        kind: approval.kind,
                        targetLabel: approval.targetLabel,
                        senderLabel: approval.senderLabel,
                        text: approval.text,
                        preview: approval.preview,
                        expiresAt: approval.expiresAt
                    },
                    createdAt: Date.now()
                }
            }
        }))
    }

    private finalizeAgentState(result: FeishuSendStatusResponse): void {
        this.client.updateAgentState((state: AgentState) => {
            const request = state.requests?.[this.approval.requestId]
            if (!request) {
                return state
            }
            const nextRequests = { ...state.requests }
            delete nextRequests[this.approval.requestId]
            return {
                ...state,
                requests: nextRequests,
                completedRequests: {
                    ...state.completedRequests,
                    [this.approval.requestId]: {
                        ...request,
                        completedAt: Date.now(),
                        status: completedStatus(result),
                        reason: completionReason(result)
                    }
                }
            }
        })
    }
}

export function trackFeishuApproval(
    client: ApiSessionClient,
    approval: FeishuSendApprovalSummary
): FeishuApprovalTracker {
    const existing = trackers.get(approval.requestId)
    if (existing) {
        return existing
    }
    const tracker = new FeishuApprovalTracker(client, approval)
    trackers.set(approval.requestId, tracker)
    tracker.start()
    return tracker
}

export function getFeishuApprovalTracker(requestId: string): FeishuApprovalTracker | null {
    return trackers.get(requestId) ?? null
}
