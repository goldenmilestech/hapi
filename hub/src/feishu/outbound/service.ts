import { randomUUID } from 'node:crypto'
import type { Store } from '../../store'
import type {
    FeishuSendApprovalSummary,
    FeishuSendReceipt,
    FeishuSendRequest,
    FeishuSendStatus,
    FeishuSendStatusResponse
} from '@hapi/protocol/apiTypes'
import { FEISHU_SEND_TEXT_MAX_CHARS } from '@hapi/protocol/apiTypes'
import type { FeishuSendConfig } from '../config'
import {
    FeishuApiError,
    FeishuBotApi,
    type FeishuChat,
    type FeishuDirectoryUser,
    type FeishuFetch
} from './feishuApi'

const APPROVAL_PREVIEW_CHARS = 500
const MAX_PENDING_PER_SESSION = 5
const RATE_WINDOW_MS = 60_000
const MEMBER_CACHE_TTL_MS = 60_000
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]+$/
const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]+$/
/** A model-provided `<at>` tag would let it mention arbitrary users or @all. */
const MENTION_TAG_RE = /<\s*\/?\s*at\b/i
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

export const FEISHU_SEND_REQUEST_PREFIX = 'feishu:'

export type FeishuSendErrorCode =
    | 'disabled'
    | 'invalid_text'
    | 'no_sender'
    | 'ambiguous_sender'
    | 'recipient_not_found'
    | 'recipient_ambiguous'
    | 'chat_not_found'
    | 'chat_ambiguous'
    | 'sender_not_in_chat'
    | 'sender_check_unavailable'
    | 'rate_limited'
    | 'not_found'
    | 'not_pending'
    | 'expired'
    | 'send_failed'

export class FeishuSendError extends Error {
    constructor(message: string, public readonly code: FeishuSendErrorCode) {
        super(message)
        this.name = 'FeishuSendError'
    }
}

type Sender = {
    openId: string
    name: string | null
    email: string | null
}

type DmTarget = {
    receiveIdType: 'open_id' | 'email'
    receiveId: string
    label: string
    isSelf: boolean
}

type GroupTarget = {
    chatId: string
    label: string
    ownerId: string | null
}

type ApprovalStatus = 'pending' | 'sent' | 'denied' | 'expired' | 'failed'

export type FeishuSendApprovalRecord = {
    requestId: string
    namespace: string
    sessionId: string
    kind: 'dm' | 'group'
    receiveIdType: 'open_id' | 'email' | 'chat_id'
    receiveId: string
    targetLabel: string
    senderOpenId: string
    senderLabel: string
    /** Exact text the user is approving; group sends already include the @ sender. */
    text: string
    preview: string
    status: ApprovalStatus
    createdAt: number
    expiresAt: number
    decidedAt?: number
    decidedBy?: number
    receipt?: FeishuSendReceipt
    error?: string
}

export type CreateFeishuSendResult =
    | { status: 'sent'; requestId: string; receipt: FeishuSendReceipt }
    | { status: 'pending_approval'; requestId: string; approval: FeishuSendApprovalSummary }

export type DecideFeishuSendResult = {
    status: FeishuSendStatus
    receipt?: FeishuSendReceipt
    error?: string
}

/** The subset of the bot API the send service needs; tests inject a fake. */
export type FeishuSendApi = Pick<
    FeishuBotApi,
    'sendText'
    | 'getUser'
    | 'findOpenIdsByEmail'
    | 'getChat'
    | 'searchChats'
    | 'listChatMembers'
    | 'searchUsersByName'
>

export type FeishuSendServiceOptions = {
    store: Store
    config: FeishuSendConfig
    api?: FeishuSendApi
    fetchImpl?: FeishuFetch
    now?: () => number
    createId?: () => string
}

function normalizeEmail(value: string | null | undefined): string | null {
    const trimmed = value?.trim().toLowerCase()
    return trimmed ? trimmed : null
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value
    return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function sanitizeOutboundText(text: string): string {
    if (!text.trim()) {
        throw new FeishuSendError('飞书消息内容不能为空。', 'invalid_text')
    }
    if (Array.from(text).length > FEISHU_SEND_TEXT_MAX_CHARS) {
        throw new FeishuSendError(
            `飞书消息超过 ${FEISHU_SEND_TEXT_MAX_CHARS} 字符上限。`,
            'invalid_text'
        )
    }
    if (CONTROL_CHARS_RE.test(text)) {
        throw new FeishuSendError('飞书消息不能包含控制字符。', 'invalid_text')
    }
    if (MENTION_TAG_RE.test(text)) {
        throw new FeishuSendError(
            '飞书消息正文不能包含 <at> 标签；@ 发送人由 Hapi 自动添加。',
            'invalid_text'
        )
    }
    return text
}

/** Group messages always name the human on whose behalf the bot speaks. */
export function formatGroupText(sender: { openId: string }, text: string): string {
    return `${text}\n\n—— 由 <at user_id="${sender.openId}"></at> 通过 HAPI 发送`
}

function toPublicStatus(status: ApprovalStatus): FeishuSendStatus {
    return status === 'pending' ? 'pending_approval' : status
}

function approvalSummary(record: FeishuSendApprovalRecord): FeishuSendApprovalSummary {
    return {
        requestId: record.requestId,
        kind: record.kind,
        targetLabel: record.targetLabel,
        senderLabel: record.senderLabel,
        text: record.text,
        preview: record.preview,
        expiresAt: record.expiresAt
    }
}

/**
 * Agent-initiated Feishu sends.
 *
 * Rules enforced here, not in the prompt:
 *  - a DM to the session owner's own Feishu account sends immediately;
 *  - every other DM and every group message needs an explicit approval;
 *  - a group message names the owner and @-mentions them, and is refused when
 *    the owner cannot be resolved or is not a member of the group.
 */
export class FeishuSendService {
    private readonly api: FeishuSendApi
    private readonly now: () => number
    private readonly createId: () => string
    private readonly approvals = new Map<string, FeishuSendApprovalRecord>()
    private readonly rate = new Map<string, { windowStart: number; count: number }>()
    private readonly memberCache = new Map<string, {
        expiresAt: number
        members: Set<string>
        ownerId: string | null
        truncated: boolean
    }>()

    constructor(private readonly options: FeishuSendServiceOptions) {
        this.api = options.api ?? new FeishuBotApi(options.config, options.fetchImpl)
        this.now = options.now ?? Date.now
        this.createId = options.createId ?? randomUUID
    }

    get enabled(): boolean {
        return true
    }

    async createSendRequest(input: {
        namespace: string
        sessionId: string
        request: FeishuSendRequest
    }): Promise<CreateFeishuSendResult> {
        this.sweep()
        this.consumeRateLimit(input.namespace)
        const text = sanitizeOutboundText(input.request.text)
        const sender = await this.resolveSender(input.namespace)

        if (input.request.kind === 'dm') {
            const target = await this.resolveDmTarget(sender, input.request.to)
            if (target.isSelf) {
                const requestId = this.newRequestId()
                const receipt = await this.sendNow({
                    requestId,
                    kind: 'dm',
                    receiveIdType: target.receiveIdType,
                    receiveId: target.receiveId,
                    targetLabel: target.label,
                    sender,
                    text
                })
                return { status: 'sent', requestId, receipt }
            }
            return this.queueApproval({
                namespace: input.namespace,
                sessionId: input.sessionId,
                kind: 'dm',
                receiveIdType: target.receiveIdType,
                receiveId: target.receiveId,
                targetLabel: target.label,
                sender,
                text
            })
        }

        const group = await this.resolveGroupTarget(input.request.chat)
        await this.assertSenderInChat(group, sender)
        return this.queueApproval({
            namespace: input.namespace,
            sessionId: input.sessionId,
            kind: 'group',
            receiveIdType: 'chat_id',
            receiveId: group.chatId,
            targetLabel: group.label,
            sender,
            text: formatGroupText(sender, text)
        })
    }

    getStatus(input: {
        namespace: string
        sessionId: string
        requestId: string
    }): FeishuSendStatusResponse {
        this.sweep()
        const record = this.findRecord(input)
        if (!record) {
            throw new FeishuSendError('飞书发送审批不存在或已过期。', 'not_found')
        }
        return {
            requestId: record.requestId,
            status: toPublicStatus(record.status),
            ...(record.receipt ? { receipt: record.receipt } : {}),
            ...(record.error ? { error: record.error } : {})
        }
    }

    async decide(input: {
        namespace: string
        sessionId: string
        requestId: string
        approved: boolean
        decidedBy?: number
    }): Promise<DecideFeishuSendResult> {
        this.sweep()
        const record = this.findRecord(input)
        if (!record) {
            throw new FeishuSendError('飞书发送审批不存在或已过期。', 'not_found')
        }
        if (record.status === 'pending' && this.now() > record.expiresAt) {
            record.status = 'expired'
            record.error = '审批已过期，未发送。'
        }
        if (record.status === 'sent') {
            return { status: 'sent', ...(record.receipt ? { receipt: record.receipt } : {}) }
        }
        if (record.status === 'denied') {
            return { status: 'denied', error: record.error }
        }
        if (record.status === 'failed') {
            return { status: 'failed', error: record.error }
        }
        if (record.status === 'expired') {
            return { status: 'expired', error: record.error }
        }

        record.decidedBy = input.decidedBy
        record.decidedAt = this.now()
        if (!input.approved) {
            record.status = 'denied'
            record.error = '用户拒绝了本次发送。'
            return { status: 'denied', error: record.error }
        }

        try {
            const receipt = await this.sendNow({
                requestId: record.requestId,
                kind: record.kind,
                receiveIdType: record.receiveIdType,
                receiveId: record.receiveId,
                targetLabel: record.targetLabel,
                sender: { openId: record.senderOpenId, name: record.senderLabel },
                text: record.text
            })
            record.status = 'sent'
            record.receipt = receipt
            record.error = undefined
            return { status: 'sent', receipt }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            record.status = 'failed'
            record.error = message
            console.warn(`[FeishuSend] send failed for ${record.requestId}: ${message}`)
            return { status: 'failed', error: message }
        }
    }

    private newRequestId(): string {
        return `${FEISHU_SEND_REQUEST_PREFIX}${this.createId()}`
    }

    private findRecord(input: {
        namespace: string
        sessionId: string
        requestId: string
    }): FeishuSendApprovalRecord | null {
        const record = this.approvals.get(input.requestId)
        if (!record) return null
        if (record.namespace !== input.namespace || record.sessionId !== input.sessionId) {
            return null
        }
        return record
    }

    private queueApproval(input: {
        namespace: string
        sessionId: string
        kind: 'dm' | 'group'
        receiveIdType: 'open_id' | 'email' | 'chat_id'
        receiveId: string
        targetLabel: string
        sender: Sender
        text: string
    }): CreateFeishuSendResult {
        const pending = Array.from(this.approvals.values()).filter(
            (record) => record.sessionId === input.sessionId && record.status === 'pending'
        )
        if (pending.length >= MAX_PENDING_PER_SESSION) {
            throw new FeishuSendError(
                `同一会话最多同时保留 ${MAX_PENDING_PER_SESSION} 条待审批飞书消息，请先处理已有审批。`,
                'rate_limited'
            )
        }

        const requestId = this.newRequestId()
        const createdAt = this.now()
        const record: FeishuSendApprovalRecord = {
            requestId,
            namespace: input.namespace,
            sessionId: input.sessionId,
            kind: input.kind,
            receiveIdType: input.receiveIdType,
            receiveId: input.receiveId,
            targetLabel: input.targetLabel,
            senderOpenId: input.sender.openId,
            senderLabel: input.sender.name ?? input.sender.openId,
            text: input.text,
            preview: truncate(input.text, APPROVAL_PREVIEW_CHARS),
            status: 'pending',
            createdAt,
            expiresAt: createdAt + this.options.config.approvalTtlSeconds * 1000
        }
        this.approvals.set(requestId, record)
        console.log(
            `[FeishuSend] approval requested requestId=${requestId} namespace=${input.namespace} session=${input.sessionId} kind=${input.kind}`
        )
        return {
            status: 'pending_approval',
            requestId,
            approval: approvalSummary(record)
        }
    }

    private async sendNow(record: {
        requestId: string
        kind: 'dm' | 'group'
        receiveIdType: 'open_id' | 'email' | 'chat_id'
        receiveId: string
        targetLabel: string
        sender: { openId: string; name: string | null }
        text: string
    }): Promise<FeishuSendReceipt> {
        const sent = await this.api.sendText({
            receiveIdType: record.receiveIdType,
            receiveId: record.receiveId,
            text: record.text
        })
        const receipt: FeishuSendReceipt = {
            requestId: record.requestId,
            messageId: sent.messageId,
            chatId: sent.chatId,
            kind: record.kind,
            targetLabel: record.targetLabel,
            senderLabel: record.sender.name ?? record.sender.openId,
            sentAt: this.now()
        }
        console.log(
            `[FeishuSend] sent requestId=${record.requestId} messageId=${sent.messageId} kind=${record.kind}`
        )
        return receipt
    }

    private async resolveSender(namespace: string): Promise<Sender> {
        const rows = this.options.store.users.getUsersByPlatformAndNamespace('feishu', namespace)
        const openIds = Array.from(new Set(rows.map((row) => row.platformUserId)))
        const ownerOpenId = this.options.config.ownerOpenId
        if (namespace === 'default' && ownerOpenId && !openIds.includes(ownerOpenId)) {
            openIds.push(ownerOpenId)
        }

        if (openIds.length === 0) {
            throw new FeishuSendError(
                '当前会话所属的 Hapi 用户没有绑定飞书账号，无法确定发送人。请先用飞书登录 Hapi，或配置 FEISHU_OWNER_OPEN_ID。',
                'no_sender'
            )
        }

        let openId: string
        if (ownerOpenId && openIds.includes(ownerOpenId)) {
            openId = ownerOpenId
        } else if (openIds.length === 1) {
            openId = openIds[0]!
        } else {
            throw new FeishuSendError(
                '当前会话所属命名空间匹配到多个飞书账号，无法确定发送人。请配置 FEISHU_OWNER_OPEN_ID。',
                'ambiguous_sender'
            )
        }

        const sender: Sender = { openId, name: null, email: null }
        return this.enrichSender(sender)
    }

    private async enrichSender(sender: Sender): Promise<Sender> {
        const profile = this.options.store.feishuProfiles.get(sender.openId)
        let name = profile?.name ?? null
        let email = profile?.email ?? null
        if (!name || !email) {
            try {
                const user = await this.api.getUser(sender.openId)
                if (user) {
                    name = name ?? user.name
                    email = email ?? user.email
                    this.cacheUser(user)
                }
            } catch {
                // The mention renders the name even without a local profile;
                // the approval card falls back to the open_id.
            }
        }
        return { openId: sender.openId, name, email }
    }

    private cacheUser(user: FeishuDirectoryUser): void {
        try {
            this.options.store.feishuProfiles.upsert({
                openId: user.openId,
                name: user.name,
                email: user.email,
                enterpriseEmail: user.enterpriseEmail
            })
        } catch {
            // Best effort; a failed cache write must not block a send.
        }
    }

    private async resolveDmTarget(sender: Sender, to: string): Promise<DmTarget> {
        const target = to.trim()
        if (target === 'me') {
            return {
                receiveIdType: 'open_id',
                receiveId: sender.openId,
                label: `本人${sender.name ? `（${sender.name}）` : ''}`,
                isSelf: true
            }
        }

        if (OPEN_ID_RE.test(target)) {
            const user = await this.tryGetUser(target)
            return {
                receiveIdType: 'open_id',
                receiveId: target,
                label: formatUserLabel(user, target),
                isSelf: target === sender.openId
            }
        }

        const email = normalizeEmail(target)
        if (email && email.includes('@')) {
            if (sender.email && email === sender.email) {
                return {
                    receiveIdType: 'open_id',
                    receiveId: sender.openId,
                    label: `本人（${sender.name ?? email}）`,
                    isSelf: true
                }
            }
            let openId: string | null = null
            try {
                const ids = await this.api.findOpenIdsByEmail([email])
                openId = ids.get(email) ?? null
            } catch {
                // Email addressing works without the contact scope; fall back
                // to letting Feishu resolve the address at send time.
            }
            if (openId) {
                const user = await this.tryGetUser(openId)
                return {
                    receiveIdType: 'open_id',
                    receiveId: openId,
                    label: formatUserLabel(user, openId),
                    isSelf: openId === sender.openId
                }
            }
            return {
                receiveIdType: 'email',
                receiveId: email,
                label: email,
                isSelf: false
            }
        }

        const matches = await this.resolveUserByName(target)
        if (matches.length === 0) {
            throw new FeishuSendError(
                `未找到飞书用户「${target}」。请改用邮箱或 open_id，或在飞书通讯录中确认姓名。`,
                'recipient_not_found'
            )
        }
        if (matches.length > 1) {
            const candidates = matches
                .slice(0, 5)
                .map((user) => `${user.name}（${user.email ?? user.openId}）`)
                .join('、')
            throw new FeishuSendError(
                `飞书用户「${target}」匹配到多个结果：${candidates}。请改用邮箱或 open_id。`,
                'recipient_ambiguous'
            )
        }
        const user = matches[0]!
        return {
            receiveIdType: 'open_id',
            receiveId: user.openId,
            label: formatUserLabel(user, user.openId),
            isSelf: user.openId === sender.openId
        }
    }

    private async resolveUserByName(name: string): Promise<FeishuDirectoryUser[]> {
        const profiles = this.options.store.feishuProfiles.findByName(name)
        if (profiles.length > 0) {
            return profiles.map((profile) => ({
                openId: profile.openId,
                name: profile.name,
                email: profile.email,
                enterpriseEmail: profile.enterpriseEmail
            }))
        }

        try {
            const result = await this.api.searchUsersByName(name)
            for (const user of result.users) {
                this.cacheUser(user)
            }
            if (result.users.length === 0 && !result.complete) {
                throw new FeishuSendError(
                    `未能完成对飞书用户「${name}」的通讯录搜索（目录较大或权限不足）。请改用邮箱或 open_id。`,
                    'recipient_not_found'
                )
            }
            return result.users
        } catch (error) {
            if (error instanceof FeishuSendError) {
                throw error
            }
            if (error instanceof FeishuApiError) {
                throw new FeishuSendError(
                    `无法在飞书通讯录中解析「${name}」（${error.message}）。请改用邮箱或 open_id。`,
                    'recipient_not_found'
                )
            }
            throw error
        }
    }

    private async tryGetUser(openId: string): Promise<FeishuDirectoryUser | null> {
        const profile = this.options.store.feishuProfiles.get(openId)
        if (profile) {
            return {
                openId: profile.openId,
                name: profile.name,
                email: profile.email,
                enterpriseEmail: profile.enterpriseEmail
            }
        }
        try {
            const user = await this.api.getUser(openId)
            if (user) {
                this.cacheUser(user)
            }
            return user
        } catch {
            return null
        }
    }

    private async resolveGroupTarget(chatInput: string): Promise<GroupTarget> {
        const target = chatInput.trim()
        if (CHAT_ID_RE.test(target)) {
            const info = await this.tryGetChat(target)
            if (!info || isDissolvedChat(info) || info.chatMode === 'p2p') {
                throw new FeishuSendError(
                    `飞书群 ${target} 不存在、不是群聊，或机器人不在群内。`,
                    'chat_not_found'
                )
            }
            return {
                chatId: info.chatId,
                label: formatChatLabel(info),
                ownerId: info.ownerId
            }
        }

        let chats: FeishuChat[]
        try {
            chats = await this.api.searchChats(target, 50)
        } catch (error) {
            throw new FeishuSendError(
                `无法搜索飞书群「${target}」（${error instanceof Error ? error.message : String(error)}）。请改用 chat_id。`,
                'chat_not_found'
            )
        }
        const usable = chats.filter((chat) => !isDissolvedChat(chat))
        const lower = target.toLowerCase()
        const exact = usable.filter((chat) => (chat.name ?? '').toLowerCase() === lower)
        const matches = exact.length > 0
            ? exact
            : usable.filter((chat) => (chat.name ?? '').toLowerCase().includes(lower))

        if (matches.length === 0) {
            throw new FeishuSendError(
                `未找到飞书群「${target}」，或机器人不在群内。请确认群名，或改用 chat_id。`,
                'chat_not_found'
            )
        }
        if (matches.length > 1) {
            const candidates = matches
                .slice(0, 5)
                .map((chat) => `${chat.name ?? '未命名群'}（${chat.chatId}）`)
                .join('、')
            throw new FeishuSendError(
                `飞书群「${target}」匹配到多个结果：${candidates}。请改用 chat_id。`,
                'chat_ambiguous'
            )
        }
        const matched = matches[0]!
        return {
            chatId: matched.chatId,
            label: formatChatLabel(matched),
            ownerId: matched.ownerId
        }
    }

    private async tryGetChat(chatId: string): Promise<FeishuChat | null> {
        try {
            return await this.api.getChat(chatId)
        } catch {
            return null
        }
    }

    private async assertSenderInChat(group: GroupTarget, sender: Sender): Promise<void> {
        const cached = this.memberCache.get(group.chatId)
        if (cached && cached.expiresAt > this.now()) {
            this.assertMember(cached, group, sender)
            return
        }

        let result: { members: Array<{ openId: string; name: string | null }>; truncated: boolean }
        try {
            result = await this.api.listChatMembers(group.chatId)
        } catch (error) {
            const detail = error instanceof FeishuApiError && error.isPermissionError
                ? '缺少 im:chat.members:read 权限'
                : error instanceof Error ? error.message : String(error)
            throw new FeishuSendError(
                `无法校验发送人是否在群「${group.label}」内（${detail}）。按规则禁止发送。`,
                'sender_check_unavailable'
            )
        }

        const cache = {
            expiresAt: this.now() + MEMBER_CACHE_TTL_MS,
            members: new Set(result.members.map((member) => member.openId)),
            ownerId: group.ownerId,
            truncated: result.truncated
        }
        this.memberCache.set(group.chatId, cache)
        this.assertMember(cache, group, sender)
    }

    private assertMember(
        cache: { members: Set<string>; ownerId: string | null; truncated: boolean },
        group: GroupTarget,
        sender: Sender
    ): void {
        if (cache.members.has(sender.openId) || cache.ownerId === sender.openId) {
            return
        }
        if (cache.truncated) {
            throw new FeishuSendError(
                `群「${group.label}」成员列表被飞书截断，无法确认发送人在群内。按规则禁止发送。`,
                'sender_check_unavailable'
            )
        }
        throw new FeishuSendError(
            `发送人不在飞书群「${group.label}」内。按规则禁止在无发送人的群里发消息。`,
            'sender_not_in_chat'
        )
    }

    private consumeRateLimit(namespace: string): void {
        const now = this.now()
        const bucket = this.rate.get(namespace)
        if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
            this.rate.set(namespace, { windowStart: now, count: 1 })
            return
        }
        bucket.count += 1
        if (bucket.count > this.options.config.maxSendsPerMinute) {
            throw new FeishuSendError('飞书发送过于频繁，请稍后再试。', 'rate_limited')
        }
    }

    private sweep(): void {
        const now = this.now()
        for (const [requestId, record] of this.approvals) {
            if (record.status === 'pending' && now > record.expiresAt) {
                record.status = 'expired'
                record.error = '审批已过期，未发送。'
            }
            // Keep terminal records long enough for the CLI to poll the
            // receipt after a slow approval; 24h bounds memory.
            if (now - record.expiresAt > 24 * 60 * 60 * 1000) {
                this.approvals.delete(requestId)
            }
        }
        for (const [chatId, cache] of this.memberCache) {
            if (cache.expiresAt <= now) {
                this.memberCache.delete(chatId)
            }
        }
    }
}

function formatUserLabel(user: FeishuDirectoryUser | null, fallback: string): string {
    if (!user) return fallback
    if (user.email) return `${user.name}（${user.email}）`
    return user.name || fallback
}

function formatChatLabel(chat: FeishuChat): string {
    return chat.name ? `${chat.name}（${chat.chatId}）` : chat.chatId
}

function isDissolvedChat(chat: FeishuChat): boolean {
    return chat.chatStatus === 'dissolved' || chat.chatStatus === 'dissolved_save'
}
