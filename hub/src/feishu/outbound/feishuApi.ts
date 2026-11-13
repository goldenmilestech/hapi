import { randomUUID } from 'node:crypto'

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis'
const REQUEST_TIMEOUT_MS = 10_000
/** Refresh before the documented two-hour expiry; clock skew is worse than an extra call. */
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000
const DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000
const DIRECTORY_MAX_DEPARTMENTS = 200
const DIRECTORY_MAX_USERS = 3_000
const DIRECTORY_MAX_PAGES = 40
/** Name lookup must not hold an MCP tool call open for a huge tenant walk. */
const DIRECTORY_DEADLINE_MS = 5_000

/** Token-invalid codes Feishu returns after a rotation; one refresh is enough. */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663])

export type FeishuFetch = (input: string, init?: RequestInit) => Promise<Response>

export type FeishuBotApiConfig = {
    appId: string
    appSecret: string
    apiBase?: string
}

export type FeishuDirectoryUser = {
    openId: string
    name: string
    email: string | null
    enterpriseEmail: string | null
    departmentPath?: string | null
}

export type FeishuChat = {
    chatId: string
    name: string | null
    chatMode: string | null
    chatStatus: string | null
    ownerId: string | null
}

type FeishuEnvelope = {
    code?: number
    msg?: string
    data?: unknown
}

type TokenResponse = {
    code?: number
    msg?: string
    tenant_access_token?: string
    expire?: number
}

type SendResponse = {
    code?: number
    msg?: string
    data?: {
        message_id?: string
        chat_id?: string
    }
}

type UserResponse = {
    code?: number
    msg?: string
    data?: {
        user?: {
            open_id?: string
            name?: string
            email?: string
            enterprise_email?: string
            avatar_url?: string
        }
    }
}

type BatchGetIdResponse = {
    code?: number
    msg?: string
    data?: {
        user_list?: Array<{
            user_id?: string
            email?: string
            mobile?: string
        }>
    }
}

type ChatResponse = {
    code?: number
    msg?: string
    data?: {
        chat_id?: string
        name?: string
        chat_mode?: string
        chat_status?: string
        owner_id?: string
    }
}

type ChatSearchItem = {
    chat_id?: string
    name?: string
    chat_mode?: string
    chat_status?: string
    owner_id?: string
}

type ChatSearchResponse = {
    code?: number
    msg?: string
    data?: {
        items?: ChatSearchItem[]
    }
}

type ChatListResponse = {
    code?: number
    msg?: string
    data?: {
        items?: ChatSearchItem[]
        has_more?: boolean
        page_token?: string
    }
}

type ChatMembersResponse = {
    code?: number
    msg?: string
    data?: {
        items?: Array<{ member_id?: string; name?: string }>
        has_more?: boolean
        page_token?: string
        /** Present when the server caps a large member list. */
        truncations?: Array<{ limit?: number; member_type?: string }>
    }
}

type DepartmentChildrenResponse = {
    code?: number
    msg?: string
    data?: {
        items?: Array<{ open_department_id?: string; department_id?: string; name?: string }>
        has_more?: boolean
        page_token?: string
    }
}

type DepartmentUsersResponse = {
    code?: number
    msg?: string
    data?: {
        items?: Array<{
            open_id?: string
            name?: string
            email?: string
            enterprise_email?: string
        }>
        has_more?: boolean
        page_token?: string
    }
}

export class FeishuApiError extends Error {
    constructor(
        message: string,
        public readonly feishuCode?: number,
        public readonly httpStatus?: number
    ) {
        super(message)
        this.name = 'FeishuApiError'
    }

    get isPermissionError(): boolean {
        return this.feishuCode === 99991672
            || this.feishuCode === 99991679
            || this.feishuCode === 41050
            || this.feishuCode === 41051
    }
}

function parseJson(text: string, endpoint: string): unknown {
    try {
        return JSON.parse(text) as unknown
    } catch {
        throw new FeishuApiError(`Feishu ${endpoint} returned invalid JSON`)
    }
}

function normalizeEmail(value: string | null | undefined): string | null {
    const trimmed = value?.trim().toLowerCase()
    return trimmed ? trimmed : null
}

function normalizeName(value: string | null | undefined): string | null {
    const trimmed = value?.trim()
    return trimmed ? trimmed : null
}

/**
 * Tenant-token client for the Feishu bot APIs used by agent-initiated sends.
 * The app secret never leaves the hub; the token is cached until shortly
 * before its documented expiry.
 */
export class FeishuBotApi {
    private token: { value: string; expiresAt: number } | null = null
    private directoryCache: {
        users: FeishuDirectoryUser[]
        expiresAt: number
        complete: boolean
    } | null = null
    private readonly fetchImpl: FeishuFetch

    constructor(
        private readonly config: FeishuBotApiConfig,
        fetchImpl: FeishuFetch = fetch
    ) {
        this.fetchImpl = fetchImpl
    }

    private get baseUrl(): string {
        return (this.config.apiBase ?? FEISHU_API_BASE).replace(/\/+$/, '')
    }

    private async getTenantAccessToken(force = false): Promise<string> {
        const now = Date.now()
        if (!force && this.token && this.token.expiresAt > now) {
            return this.token.value
        }

        const response = await this.requestRaw(
            `${this.baseUrl}/auth/v3/tenant_access_token/internal`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    app_id: this.config.appId,
                    app_secret: this.config.appSecret
                })
            },
            'tenant_access_token'
        )
        const payload = response.payload as TokenResponse
        if (!response.response.ok || payload.code !== 0 || !payload.tenant_access_token) {
            throw new FeishuApiError(
                payload.msg || 'Feishu tenant_access_token failed',
                payload.code,
                response.response.status
            )
        }

        const expireSeconds = typeof payload.expire === 'number' ? payload.expire : 7200
        const ttlMs = Math.max(60_000, expireSeconds * 1000 - TOKEN_REFRESH_MARGIN_MS)
        this.token = { value: payload.tenant_access_token, expiresAt: now + ttlMs }
        return payload.tenant_access_token
    }

    private async requestRaw(
        url: string,
        init: RequestInit,
        endpoint: string
    ): Promise<{ response: Response; payload: unknown }> {
        const response = await this.fetchImpl(url, {
            ...init,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        return {
            response,
            payload: parseJson(await response.text(), endpoint)
        }
    }

    /** Authenticated JSON request with one token-refresh retry. */
    private async request(
        path: string,
        init: RequestInit,
        endpoint: string
    ): Promise<unknown> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const token = await this.getTenantAccessToken(attempt > 0)
            const headers = {
                ...(init.headers ?? {}),
                authorization: `Bearer ${token}`
            }
            const { response, payload } = await this.requestRaw(
                `${this.baseUrl}${path}`,
                { ...init, headers },
                endpoint
            )
            const envelope = payload as FeishuEnvelope
            if (TOKEN_INVALID_CODES.has(Number(envelope.code)) && attempt === 0) {
                continue
            }
            if (!response.ok || envelope.code !== 0) {
                throw new FeishuApiError(
                    envelope.msg || `Feishu ${endpoint} failed (HTTP ${response.status})`,
                    envelope.code,
                    response.status
                )
            }
            return payload
        }
        throw new FeishuApiError('Feishu token refresh failed')
    }

    async sendText(input: {
        receiveIdType: 'open_id' | 'email' | 'chat_id'
        receiveId: string
        text: string
        idempotencyKey?: string
    }): Promise<{ messageId: string; chatId: string | null }> {
        const receiveId = input.receiveId.trim()
        if (!receiveId) {
            throw new FeishuApiError('Feishu receive id is required')
        }
        if (!input.text.trim()) {
            throw new FeishuApiError('Feishu message text is required')
        }

        const query = new URLSearchParams({ receive_id_type: input.receiveIdType })
        const payload = await this.request(
            `/im/v1/messages?${query.toString()}`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    receive_id: receiveId,
                    msg_type: 'text',
                    content: JSON.stringify({ text: input.text }),
                    // Feishu de-duplicates sends carrying the same uuid within
                    // one hour. Every logical message gets a fresh one.
                    uuid: input.idempotencyKey ?? randomUUID()
                })
            },
            'im/v1/messages'
        ) as SendResponse

        const messageId = payload.data?.message_id?.trim()
        if (!messageId) {
            throw new FeishuApiError('Feishu send response did not include a message id')
        }
        return {
            messageId,
            chatId: payload.data?.chat_id?.trim() || null
        }
    }

    async getUser(openId: string): Promise<FeishuDirectoryUser | null> {
        const payload = await this.request(
            `/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
            { method: 'GET' },
            'contact/v3/users'
        ) as UserResponse
        const user = payload.data?.user
        if (!user?.open_id) {
            return null
        }
        return {
            openId: user.open_id,
            name: normalizeName(user.name) ?? user.open_id,
            email: normalizeEmail(user.email),
            enterpriseEmail: normalizeEmail(user.enterprise_email)
        }
    }

    async findOpenIdsByEmail(emails: string[]): Promise<Map<string, string>> {
        const normalized = Array.from(new Set(emails.map((email) => normalizeEmail(email)).filter((email): email is string => Boolean(email))))
        const result = new Map<string, string>()
        if (normalized.length === 0) {
            return result
        }
        const payload = await this.request(
            '/contact/v3/users/batch_get_id?user_id_type=open_id',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ emails: normalized })
            },
            'contact/v3/users/batch_get_id'
        ) as BatchGetIdResponse
        for (const item of payload.data?.user_list ?? []) {
            const email = normalizeEmail(item.email)
            const openId = item.user_id?.trim()
            if (email && openId) {
                result.set(email, openId)
            }
        }
        return result
    }

    async getChat(chatId: string): Promise<FeishuChat | null> {
        const payload = await this.request(
            `/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`,
            { method: 'GET' },
            'im/v1/chats'
        ) as ChatResponse
        const data = payload.data
        if (!data?.chat_id) {
            return null
        }
        return {
            chatId: data.chat_id,
            name: normalizeName(data.name),
            chatMode: data.chat_mode?.trim() || null,
            chatStatus: data.chat_status?.trim() || null,
            ownerId: data.owner_id?.trim() || null
        }
    }

    /** Searches groups visible to the bot (including public chats). */
    async searchChats(query: string, pageSize = 20): Promise<FeishuChat[]> {
        const normalized = query.trim()
        let items: ChatSearchItem[] = []
        try {
            const params = new URLSearchParams({
                user_id_type: 'open_id',
                page_size: String(Math.min(100, Math.max(1, pageSize)))
            })
            const payload = await this.request(
                `/im/v2/chats/search?${params.toString()}`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        // Feishu caps the search keyword at 50 characters.
                        query: normalized.slice(0, 50)
                    })
                },
                'im/v2/chats/search'
            ) as ChatSearchResponse
            items = payload.data?.items ?? []
        } catch (error) {
            // The v2 search endpoint is newer and not available to every
            // tenant/app version. Fall back to the bot's chat list so group
            // names still resolve; chat_id addressing is unaffected.
            if (!(error instanceof FeishuApiError) || error.isPermissionError) {
                throw error
            }
            return this.searchChatListFallback(normalized)
        }

        if (items.length === 0 && normalized) {
            const fallback = await this.searchChatListFallback(normalized)
            if (fallback.length > 0) {
                return fallback
            }
        }

        return items.flatMap((item) => {
            const chatId = item.chat_id?.trim()
            if (!chatId) return []
            return [{
                chatId,
                name: normalizeName(item.name),
                chatMode: item.chat_mode?.trim() || null,
                chatStatus: item.chat_status?.trim() || null,
                ownerId: item.owner_id?.trim() || null
            }]
        })
    }

    /**
     * Lists the groups the bot is a member of and filters by name. The list
     * endpoint is paginated; cap it so a huge tenant cannot stall a tool call.
     */
    private async searchChatListFallback(query: string): Promise<FeishuChat[]> {
        const matches: FeishuChat[] = []
        const lower = query.toLowerCase()
        let pageToken: string | undefined
        for (let page = 0; page < 10; page += 1) {
            const params = new URLSearchParams({
                user_id_type: 'open_id',
                page_size: '100'
            })
            if (pageToken) {
                params.set('page_token', pageToken)
            }
            const payload = await this.request(
                `/im/v1/chats?${params.toString()}`,
                { method: 'GET' },
                'im/v1/chats'
            ) as ChatListResponse
            for (const item of payload.data?.items ?? []) {
                const chatId = item.chat_id?.trim()
                if (!chatId) continue
                const name = normalizeName(item.name)
                if (lower && !(name ?? '').toLowerCase().includes(lower)) continue
                matches.push({
                    chatId,
                    name,
                    chatMode: item.chat_mode?.trim() || null,
                    chatStatus: item.chat_status?.trim() || null,
                    ownerId: item.owner_id?.trim() || null
                })
            }
            if (!payload.data?.has_more || !payload.data.page_token) {
                break
            }
            pageToken = payload.data.page_token
        }
        return matches
    }

    async listChatMembers(chatId: string): Promise<{
        members: Array<{ openId: string; name: string | null }>
        truncated: boolean
    }> {
        const members: Array<{ openId: string; name: string | null }> = []
        let pageToken: string | undefined
        let truncated = false
        for (let page = 0; page < DIRECTORY_MAX_PAGES; page += 1) {
            const query = new URLSearchParams({
                member_id_type: 'open_id',
                page_size: '100'
            })
            if (pageToken) {
                query.set('page_token', pageToken)
            }
            const payload = await this.request(
                `/im/v1/chats/${encodeURIComponent(chatId)}/members/list?${query.toString()}`,
                { method: 'GET' },
                'im/v1/chats/members/list'
            ) as ChatMembersResponse
            for (const item of payload.data?.items ?? []) {
                const openId = item.member_id?.trim()
                if (!openId) continue
                members.push({ openId, name: normalizeName(item.name) })
            }
            if ((payload.data?.truncations?.length ?? 0) > 0) {
                truncated = true
            }
            if (!payload.data?.has_more || !payload.data.page_token) {
                return { members, truncated }
            }
            pageToken = payload.data.page_token
        }
        return { members, truncated: true }
    }

    /**
     * Exact-name lookup over the tenant directory. Feishu's user search API is
     * user-token only, so the bot walks the department tree instead. The walk
     * is bounded and cached; callers must treat a partial result as "not
     * found" rather than "absent".
     */
    async searchUsersByName(name: string): Promise<{ users: FeishuDirectoryUser[]; complete: boolean }> {
        const normalized = name.trim()
        if (!normalized || process.env.FEISHU_DIRECTORY_SEARCH === 'off') {
            return { users: [], complete: true }
        }

        const { users, complete } = await this.getDirectoryUsers()
        const lower = normalized.toLowerCase()
        const exact = users.filter((user) => user.name.toLowerCase() === lower)
        if (exact.length > 0) {
            return { users: exact, complete }
        }
        return {
            users: users.filter((user) => user.name.toLowerCase().includes(lower)),
            complete
        }
    }

    private async getDirectoryUsers(): Promise<{ users: FeishuDirectoryUser[]; complete: boolean }> {
        const now = Date.now()
        if (this.directoryCache && this.directoryCache.expiresAt > now) {
            return { users: this.directoryCache.users, complete: this.directoryCache.complete }
        }

        const users = new Map<string, FeishuDirectoryUser>()
        let complete = true
        const departmentIds: string[] = ['0']
        const seenDepartments = new Set(departmentIds)
        const deadline = now + DIRECTORY_DEADLINE_MS

        try {
            for (let index = 0; index < departmentIds.length; index += 1) {
                if (index >= DIRECTORY_MAX_DEPARTMENTS || Date.now() > deadline) {
                    complete = false
                    break
                }
                const departmentId = departmentIds[index]!
                await this.collectDepartmentUsers(departmentId, users, deadline)

                let childrenToken: string | undefined
                for (let page = 0; page < DIRECTORY_MAX_PAGES; page += 1) {
                    if (Date.now() > deadline) {
                        complete = false
                        break
                    }
                    const query = new URLSearchParams({
                        department_id_type: 'open_department_id',
                        user_id_type: 'open_id',
                        page_size: '50'
                    })
                    if (childrenToken) {
                        query.set('page_token', childrenToken)
                    }
                    const payload = await this.request(
                        `/contact/v3/departments/${encodeURIComponent(departmentId)}/children?${query.toString()}`,
                        { method: 'GET' },
                        'contact/v3/departments/children'
                    ) as DepartmentChildrenResponse
                    for (const child of payload.data?.items ?? []) {
                        const childId = child.open_department_id?.trim() || child.department_id?.trim()
                        if (!childId || seenDepartments.has(childId)) continue
                        seenDepartments.add(childId)
                        departmentIds.push(childId)
                    }
                    if (!payload.data?.has_more || !payload.data.page_token) break
                    childrenToken = payload.data.page_token
                }

                if (users.size >= DIRECTORY_MAX_USERS) {
                    complete = false
                    break
                }
            }
        } catch (error) {
            // A partial walk is still useful, but callers must not report a
            // name as absent from an incomplete directory.
            if (users.size === 0) {
                throw error
            }
            complete = false
        }

        const list = Array.from(users.values())
        this.directoryCache = {
            users: list,
            expiresAt: now + DIRECTORY_CACHE_TTL_MS,
            complete
        }
        return { users: list, complete }
    }

    private async collectDepartmentUsers(
        departmentId: string,
        users: Map<string, FeishuDirectoryUser>,
        deadline: number
    ): Promise<void> {
        let pageToken: string | undefined
        for (let page = 0; page < DIRECTORY_MAX_PAGES; page += 1) {
            if (Date.now() > deadline) {
                return
            }
            const query = new URLSearchParams({
                department_id: departmentId,
                department_id_type: 'open_department_id',
                user_id_type: 'open_id',
                page_size: '50'
            })
            if (pageToken) {
                query.set('page_token', pageToken)
            }
            const payload = await this.request(
                `/contact/v3/users/find_by_department?${query.toString()}`,
                { method: 'GET' },
                'contact/v3/users/find_by_department'
            ) as DepartmentUsersResponse
            for (const item of payload.data?.items ?? []) {
                const openId = item.open_id?.trim()
                if (!openId || users.has(openId)) continue
                users.set(openId, {
                    openId,
                    name: normalizeName(item.name) ?? openId,
                    email: normalizeEmail(item.email),
                    enterpriseEmail: normalizeEmail(item.enterprise_email),
                    departmentPath: null
                })
                if (users.size >= DIRECTORY_MAX_USERS) {
                    return
                }
            }
            if (!payload.data?.has_more || !payload.data.page_token) {
                return
            }
            pageToken = payload.data.page_token
        }
    }
}
