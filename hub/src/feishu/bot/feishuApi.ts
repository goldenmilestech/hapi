import { randomUUID } from 'node:crypto'

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis'
const REQUEST_TIMEOUT_MS = 10_000
/** Refresh before the documented two-hour expiry; clock skew is worse than an extra call. */
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000

export type FeishuFetch = (input: string, init?: RequestInit) => Promise<Response>

export type FeishuBotApiConfig = {
    appId: string
    appSecret: string
}

type TokenResponse = {
    code?: number
    msg?: string
    tenant_access_token?: string
    expire?: number
}

type SendMessageResponse = {
    code?: number
    msg?: string
    data?: {
        message_id?: string
    }
}

type ChatInfoResponse = {
    code?: number
    msg?: string
    data?: {
        name?: string
        chat_mode?: string
        chat_type?: string
    }
}

type BotInfoResponse = {
    code?: number
    msg?: string
    bot?: {
        open_id?: string
        app_name?: string
    }
}

export class FeishuApiError extends Error {
    constructor(message: string, public readonly feishuCode?: number) {
        super(message)
        this.name = 'FeishuApiError'
    }
}

function parseJson(text: string, endpoint: string): unknown {
    try {
        return JSON.parse(text) as unknown
    } catch {
        throw new FeishuApiError(`Feishu ${endpoint} returned invalid JSON`)
    }
}

async function readJson(
    fetchImpl: FeishuFetch,
    url: string,
    init: RequestInit,
    endpoint: string
): Promise<{ response: Response; payload: unknown }> {
    const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const payload = parseJson(await response.text(), endpoint)
    return { response, payload }
}

function expectSuccess(
    response: Response,
    payload: { code?: number; msg?: string },
    endpoint: string
): void {
    if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(
            payload.msg || `Feishu ${endpoint} failed (HTTP ${response.status})`,
            payload.code
        )
    }
}

/**
 * Minimal tenant-token wrapper for the bot APIs. The app secret never leaves
 * the hub, and the token is cached until shortly before its documented expiry.
 */
export class FeishuBotApi {
    private token: { value: string; expiresAt: number } | null = null

    constructor(
        private readonly config: FeishuBotApiConfig,
        private readonly fetchImpl: FeishuFetch = fetch
    ) {}

    private async getTenantAccessToken(): Promise<string> {
        const now = Date.now()
        if (this.token && this.token.expiresAt > now) {
            return this.token.value
        }

        const { response, payload } = await readJson(
            this.fetchImpl,
            `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    app_id: this.config.appId,
                    app_secret: this.config.appSecret
                })
            },
            'tenant_access_token'
        ) as { response: Response; payload: TokenResponse }
        expectSuccess(response, payload, 'tenant_access_token')

        const token = payload.tenant_access_token
        const expireSeconds = typeof payload.expire === 'number' ? payload.expire : 7200
        if (!token) {
            throw new FeishuApiError('Feishu tenant_access_token response was empty')
        }

        const ttlMs = Math.max(60_000, expireSeconds * 1000 - TOKEN_REFRESH_MARGIN_MS)
        this.token = { value: token, expiresAt: now + ttlMs }
        return token
    }

    async sendText(chatId: string, text: string): Promise<string | null> {
        const receiveId = chatId.trim()
        if (!receiveId) {
            throw new FeishuApiError('Feishu chat id is required')
        }
        if (!text.trim()) {
            return null
        }

        const token = await this.getTenantAccessToken()
        const { response, payload } = await readJson(
            this.fetchImpl,
            `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=chat_id`,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    receive_id: receiveId,
                    msg_type: 'text',
                    content: JSON.stringify({ text }),
                    // Feishu de-duplicates sends carrying the same uuid within
                    // one hour. Each logical reply gets a fresh one.
                    uuid: randomUUID()
                })
            },
            'im/v1/messages'
        ) as { response: Response; payload: SendMessageResponse }
        expectSuccess(response, payload, 'im/v1/messages')
        return payload.data?.message_id?.trim() || null
    }

    /**
     * Send an interactive card. Feishu renders the card's `markdown` elements
     * with headings, lists, tables and fenced code, which plain `text` messages
     * do not support.
     */
    async sendCard(chatId: string, card: unknown): Promise<string | null> {
        const receiveId = chatId.trim()
        if (!receiveId) {
            throw new FeishuApiError('Feishu chat id is required')
        }

        const token = await this.getTenantAccessToken()
        const { response, payload } = await readJson(
            this.fetchImpl,
            `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=chat_id`,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    receive_id: receiveId,
                    msg_type: 'interactive',
                    content: JSON.stringify(card),
                    uuid: randomUUID()
                })
            },
            'im/v1/messages'
        ) as { response: Response; payload: SendMessageResponse }
        expectSuccess(response, payload, 'im/v1/messages')
        return payload.data?.message_id?.trim() || null
    }

    /**
     * Replace the content of a card this bot already sent. Used to rewrite the
     * live process card in place while a turn is running.
     */
    async updateCard(messageId: string, card: unknown): Promise<void> {
        const id = messageId.trim()
        if (!id) {
            throw new FeishuApiError('Feishu message id is required')
        }

        const token = await this.getTenantAccessToken()
        const { response, payload } = await readJson(
            this.fetchImpl,
            `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(id)}`,
            {
                method: 'PATCH',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    content: JSON.stringify(card)
                })
            },
            'im/v1/messages/:message_id'
        ) as { response: Response; payload: SendMessageResponse }
        expectSuccess(response, payload, 'im/v1/messages/:message_id')
    }

    /**
     * Add an emoji reaction to a message. Mirrors the Agent Teams feedback:
     * "Typing" on the user's message, "DONE" on the finished reply.
     */
    async addReaction(messageId: string, emojiType: string): Promise<void> {
        const id = messageId.trim()
        if (!id || !emojiType.trim()) {
            return
        }
        const token = await this.getTenantAccessToken()
        const { response, payload } = await readJson(
            this.fetchImpl,
            `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(id)}/reactions`,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    reaction_type: { emoji_type: emojiType.trim() }
                })
            },
            'im/v1/messages/:message_id/reactions'
        ) as { response: Response; payload: { code?: number; msg?: string } }
        expectSuccess(response, payload, 'im/v1/messages/:message_id/reactions')
    }

    /**
     * Chat metadata is best-effort: a bot without `im:chat:readonly` can still
     * bind and chat, it just cannot show the human-friendly chat name.
     */
    async getChatInfo(chatId: string): Promise<{ chatType: string; chatName: string | null } | null> {
        try {
            const token = await this.getTenantAccessToken()
            const { response, payload } = await readJson(
                this.fetchImpl,
                `${FEISHU_API_BASE}/im/v1/chats/${encodeURIComponent(chatId)}`,
                {
                    method: 'GET',
                    headers: { authorization: `Bearer ${token}` }
                },
                'im/v1/chats'
            ) as { response: Response; payload: ChatInfoResponse }
            if (!response.ok || payload.code !== 0) {
                return null
            }
            const chatType = payload.data?.chat_mode || payload.data?.chat_type || 'unknown'
            const chatName = payload.data?.name?.trim() || null
            return { chatType, chatName }
        } catch {
            return null
        }
    }

    /**
     * Used to recognize @-mentions of this bot in group chats. Failure is
     * non-fatal: the event parser falls back to `mentioned_type === 'app'`.
     */
    async getBotInfo(): Promise<{ openId: string | null; name: string | null } | null> {
        try {
            const token = await this.getTenantAccessToken()
            const { response, payload } = await readJson(
                this.fetchImpl,
                `${FEISHU_API_BASE}/bot/v3/info`,
                {
                    method: 'GET',
                    headers: { authorization: `Bearer ${token}` }
                },
                'bot/v3/info'
            ) as { response: Response; payload: BotInfoResponse }
            if (!response.ok || payload.code !== 0) {
                return null
            }
            return {
                openId: payload.bot?.open_id?.trim() || null,
                name: payload.bot?.app_name?.trim() || null
            }
        } catch {
            return null
        }
    }
}
