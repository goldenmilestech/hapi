import axios, { type AxiosInstance } from 'axios'
import type {
    FeishuSendReceipt,
    FeishuSendRequest,
    FeishuSendResponse,
    FeishuSendStatusResponse
} from '@hapi/protocol/apiTypes'
import {
    authHeaders,
    exchangeJwt,
    resolveAccessToken,
    resolveApiUrl
} from '@/modules/pingPeer/pingPeer'

export class FeishuSendClientError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
        public readonly code?: string
    ) {
        super(message)
        this.name = 'FeishuSendClientError'
    }
}

export type FeishuSendClientOptions = {
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
}

/** Approval polling runs for minutes; avoid exchanging a JWT on every tick. */
const JWT_CACHE_MS = 5 * 60 * 1000
const jwtCache = new Map<string, { jwt: string; expiresAt: number }>()

async function getJwt(
    cacheKey: string,
    apiUrl: string,
    accessToken: string,
    http: AxiosInstance
): Promise<string> {
    const cached = jwtCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.jwt
    }
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    jwtCache.set(cacheKey, { jwt, expiresAt: Date.now() + JWT_CACHE_MS })
    return jwt
}

async function request(
    options: FeishuSendClientOptions,
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    timeout = 30_000
): Promise<{ status: number; data: unknown }> {
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const cacheKey = `${apiUrl}\u0000${accessToken}`
    const send = async (jwt: string) => await http.request({
        method,
        url: `${apiUrl}${path}`,
        ...(body === undefined ? {} : { data: body }),
        headers: authHeaders(jwt),
        timeout,
        validateStatus: () => true
    })
    try {
        let response = await send(await getJwt(cacheKey, apiUrl, accessToken, http))
        if (response.status === 401) {
            // The token was rotated or revoked; one fresh exchange is enough.
            jwtCache.delete(cacheKey)
            response = await send(await getJwt(cacheKey, apiUrl, accessToken, http))
        }
        return { status: response.status, data: response.data }
    } catch (error) {
        throw new FeishuSendClientError(
            `飞书发送请求失败（${error instanceof Error ? error.message : String(error)}）`
        )
    }
}

function errorFromResponse(status: number, data: unknown): FeishuSendClientError {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    const message = typeof record.error === 'string' && record.error.trim()
        ? record.error
        : `飞书发送请求失败（HTTP ${status}）`
    const code = typeof record.code === 'string' ? record.code : undefined
    return new FeishuSendClientError(message, status, code)
}

export async function createFeishuSend(input: {
    sessionId: string
    request: FeishuSendRequest
} & FeishuSendClientOptions): Promise<FeishuSendResponse> {
    const { status, data } = await request(
        input,
        'post',
        `/api/sessions/${encodeURIComponent(input.sessionId)}/feishu/sends`,
        input.request
    )
    if (status < 200 || status >= 300) {
        throw errorFromResponse(status, data)
    }
    const record = data as Partial<FeishuSendResponse> | null
    if (record?.status === 'sent' && record.requestId && record.receipt) {
        return record as FeishuSendResponse
    }
    if (record?.status === 'pending_approval' && record.requestId && record.approval) {
        return record as FeishuSendResponse
    }
    throw new FeishuSendClientError('飞书发送接口返回了无法识别的结果')
}

export async function getFeishuSendStatus(input: {
    sessionId: string
    requestId: string
} & FeishuSendClientOptions): Promise<FeishuSendStatusResponse> {
    const { status, data } = await request(
        input,
        'get',
        `/api/sessions/${encodeURIComponent(input.sessionId)}/feishu/sends/${encodeURIComponent(input.requestId)}`,
        undefined,
        15_000
    )
    if (status < 200 || status >= 300) {
        throw errorFromResponse(status, data)
    }
    const record = data as Partial<FeishuSendStatusResponse> | null
    if (!record?.status || !record.requestId) {
        throw new FeishuSendClientError('飞书发送状态接口返回了无法识别的结果')
    }
    return record as FeishuSendStatusResponse
}

function formatTime(ms: number): string {
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return String(ms)
    return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatFeishuReceipt(receipt: FeishuSendReceipt): string {
    return `飞书消息已发送给 ${receipt.targetLabel}（message_id=${receipt.messageId}，${formatTime(receipt.sentAt)}）。`
}

export function formatFeishuSendOutcome(result: FeishuSendStatusResponse): string {
    switch (result.status) {
        case 'sent':
            return result.receipt
                ? formatFeishuReceipt(result.receipt)
                : '飞书消息已发送。'
        case 'denied':
            return '用户拒绝了本次飞书发送。'
        case 'expired':
            return '飞书发送审批已过期，未发送。'
        case 'failed':
            return `飞书消息发送失败：${result.error ?? '未知错误'}`
        default:
            return '飞书发送审批仍在等待中。'
    }
}
