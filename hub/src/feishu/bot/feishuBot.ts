import type { NotificationChannel, TaskNotification } from '../../notifications/notificationTypes'
import type { NotificationSendContext } from '../../notifications/notificationSendContext'
import { getSessionName } from '../../notifications/sessionInfo'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { FeishuBotConfig } from '../config'
import { buildAnswerCard, buildProgressCard } from './cards'
import { decryptFeishuPayload, verifyFeishuSignature } from './eventCrypto'
import {
    extractFeishuText,
    isBotMentioned,
    parseBindCommand,
    parseFeishuEnvelope,
    parseUnbindCommand,
    stripFeishuMentions,
    type FeishuEventEnvelope,
    type FeishuMessage
} from './eventParser'
import { FeishuBotApi, type FeishuFetch } from './feishuApi'
import { summarizeFeishuTurn } from './turnSummary'

const MAX_INBOUND_TEXT_CHARS = 32_000
const MAX_OUTBOUND_TEXT_CHARS = 8_000
const TURN_SCAN_LIMIT = 200

const BIND_INSTRUCTIONS = [
    '当前对话还没有绑定 Hapi 会话。',
    '',
    '请打开 Hapi 设置页 → 飞书，选择会话并生成绑定码，',
    '然后在这里发送：/bind <绑定码>'
].join('\n')

export type FeishuBotOptions = {
    syncEngine: SyncEngine
    store: Store
    config: FeishuBotConfig
    /** Hub owner open_id, used when the owner has not completed a web login. */
    ownerOpenId?: string | null
    /** Test seams. */
    api?: FeishuBotApi
    fetchImpl?: FeishuFetch
    now?: () => number
}

/** A malformed, unsigned, or wrongly-signed webhook must not be retried. */
export class FeishuWebhookVerificationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'FeishuWebhookVerificationError'
    }
}

function isHexSignature(value: string): boolean {
    return /^[0-9a-f]{64}$/i.test(value)
}

function truncate(text: string, limit: number): string {
    const trimmed = text.trim()
    if (trimmed.length <= limit) {
        return trimmed
    }
    return `${trimmed.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

export function formatFeishuReply(sessionTitle: string, assistantText: string): string {
    return `会话来自：${sessionTitle}\n\n${truncate(assistantText, MAX_OUTBOUND_TEXT_CHARS)}`
}

/**
 * Bidirectional bridge between Feishu chats and HAPI sessions.
 *
 * Inbound: `im.message.receive_v1` → `SyncEngine.sendMessage`.
 * Outbound: the `ready` notification (one final answer per turn) → an
 * interactive Markdown card, preceded by a collapsed reasoning/tool-call card.
 *
 * The class owns both directions so the webhook route and the notification
 * channel share one API client and one bot identity.
 */
export class FeishuBot implements NotificationChannel {
    private readonly api: FeishuBotApi
    private readonly now: () => number
    private readonly lastSentAnswer = new Map<string, string>()
    private botOpenId: string | null = null
    private botInfoPromise: Promise<void> | null = null

    constructor(private readonly options: FeishuBotOptions) {
        this.api = options.api ?? new FeishuBotApi(options.config, options.fetchImpl)
        this.now = options.now ?? Date.now
    }

    /**
     * Verify, de-duplicate and handle one webhook body. Throwing makes the
     * route return 500 so Feishu retries; the event is recorded only after
     * successful handling.
     */
    async handleWebhook(rawBody: string, headers: Headers): Promise<{ challenge: string } | null> {
        const payload = this.verifyAndDecode(rawBody, headers)
        const envelope = parseFeishuEnvelope(payload)
        if (!envelope) {
            throw new FeishuWebhookVerificationError('Invalid Feishu event payload')
        }
        if (envelope.token !== this.options.config.verificationToken) {
            throw new FeishuWebhookVerificationError('Invalid Feishu verification token')
        }
        if (envelope.kind === 'url_verification') {
            return { challenge: envelope.challenge }
        }
        if (envelope.eventType !== 'im.message.receive_v1' || !envelope.eventId) {
            return null
        }
        if (this.options.store.feishuBotBindings.hasEvent(envelope.eventId)) {
            return null
        }

        await this.handleMessageEvent(envelope)
        this.options.store.feishuBotBindings.recordEvent(envelope.eventId, this.now())
        return null
    }

    private verifyAndDecode(rawBody: string, headers: Headers): unknown {
        let payload: unknown
        try {
            payload = JSON.parse(rawBody) as unknown
        } catch {
            throw new FeishuWebhookVerificationError('Invalid Feishu event body')
        }

        const encrypted = typeof (payload as { encrypt?: unknown })?.encrypt === 'string'
            ? (payload as { encrypt: string }).encrypt
            : null
        if (!encrypted) {
            // Signature headers are only mandatory when the app uses encryption.
            return payload
        }

        const encryptKey = this.options.config.encryptKey
        if (!encryptKey) {
            throw new FeishuWebhookVerificationError(
                'Encrypted Feishu event but FEISHU_ENCRYPT_KEY is not configured'
            )
        }

        const timestamp = headers.get('x-lark-request-timestamp')
        const nonce = headers.get('x-lark-request-nonce')
        const signature = headers.get('x-lark-signature')
        if (
            !timestamp
            || !nonce
            || !signature
            || !isHexSignature(signature)
            || !verifyFeishuSignature({
                timestamp,
                nonce,
                signature,
                encryptKey,
                rawBody,
                now: this.now()
            })
        ) {
            throw new FeishuWebhookVerificationError('Invalid Feishu request signature')
        }

        let decrypted: string
        try {
            decrypted = decryptFeishuPayload(encryptKey, encrypted)
        } catch {
            throw new FeishuWebhookVerificationError('Invalid encrypted Feishu payload')
        }
        try {
            return JSON.parse(decrypted) as unknown
        } catch {
            throw new FeishuWebhookVerificationError('Invalid decrypted Feishu event body')
        }
    }

    private async handleMessageEvent(envelope: Extract<FeishuEventEnvelope, { kind: 'event' }>): Promise<void> {
        const message = envelope.message
        if (!message || envelope.senderType === 'app') {
            return
        }

        // Group chats are noisy: only act when the bot itself is mentioned.
        // This gate also protects bind codes from being consumed by chatter.
        if (message.chatType === 'group') {
            await this.ensureBotInfo()
            if (!isBotMentioned(message, this.botOpenId)) {
                return
            }
        }

        const rawText = extractFeishuText(message)
        if (rawText === null) {
            await this.reply(message, '目前只支持文本消息。')
            return
        }

        const text = stripFeishuMentions(rawText, message.mentions).slice(0, MAX_INBOUND_TEXT_CHARS)
        if (!text) {
            return
        }

        const bindCode = parseBindCommand(text)
        if (bindCode) {
            await this.bindChat(envelope, message, bindCode)
            return
        }
        if (parseUnbindCommand(text)) {
            await this.unbindChat(envelope, message)
            return
        }

        const binding = this.options.store.feishuBotBindings.getByChatId(message.chatId)
        if (!binding) {
            await this.reply(message, BIND_INSTRUCTIONS)
            return
        }

        const senderNamespace = this.resolveSenderNamespace(envelope.senderOpenId)
        if (senderNamespace && senderNamespace !== binding.namespace) {
            await this.reply(message, '当前飞书账号无权操作这个绑定会话。')
            return
        }

        const session = this.options.syncEngine.getSession(binding.sessionId)
        if (!session) {
            await this.reply(message, '绑定的会话已不存在，请在 Hapi 设置页解绑后重新绑定。')
            return
        }
        if (!session.active) {
            await this.reply(
                message,
                `会话「${getSessionName(session)}」当前未运行。请先在 Hapi 中打开或恢复该会话。`
            )
            return
        }

        await this.options.syncEngine.sendMessage(binding.sessionId, {
            text,
            localId: `feishu:${message.messageId}`,
            sentFrom: 'feishu-bot'
        })
    }

    private async bindChat(
        envelope: Extract<FeishuEventEnvelope, { kind: 'event' }>,
        message: FeishuMessage,
        code: string
    ): Promise<void> {
        const senderNamespace = this.resolveSenderNamespace(envelope.senderOpenId)
        if (!senderNamespace) {
            await this.reply(
                message,
                '请先通过飞书登录 Hapi Web，让 Hub 识别你的身份，然后再绑定会话。'
            )
            return
        }

        const consumed = this.options.store.feishuBotBindings.consumeBindCode(code, this.now())
        if (!consumed) {
            await this.reply(message, '绑定码无效或已过期。请在 Hapi 设置页重新生成。')
            return
        }
        if (consumed.namespace !== senderNamespace) {
            await this.reply(message, '绑定码不属于当前飞书账号。')
            return
        }

        const session = this.options.syncEngine.getSession(consumed.sessionId)
        if (!session || session.namespace !== consumed.namespace) {
            await this.reply(message, '要绑定的会话不存在或已无权访问。')
            return
        }

        const chatInfo = await this.api.getChatInfo(message.chatId)
        const title = getSessionName(session)
        this.options.store.feishuBotBindings.bind({
            chatId: message.chatId,
            chatType: chatInfo?.chatType ?? message.chatType,
            chatName: chatInfo?.chatName ?? null,
            namespace: consumed.namespace,
            sessionId: session.id,
            sessionTitle: title
        })

        await this.reply(
            message,
            `绑定成功：${title}\n\n`
            + '现在在飞书里发消息会进入该会话；每轮结束后的回复会发回这里。\n'
            + '发送 /unbind 可解绑。'
            + (message.chatType === 'group' ? '\n群聊里需要 @机器人 才会处理消息。' : '')
        )
    }

    private async unbindChat(
        envelope: Extract<FeishuEventEnvelope, { kind: 'event' }>,
        message: FeishuMessage
    ): Promise<void> {
        const binding = this.options.store.feishuBotBindings.getByChatId(message.chatId)
        if (!binding) {
            await this.reply(message, '当前对话还没有绑定 Hapi 会话。')
            return
        }

        const senderNamespace = this.resolveSenderNamespace(envelope.senderOpenId)
        if (senderNamespace && senderNamespace !== binding.namespace) {
            await this.reply(message, '当前飞书账号无权解绑这个会话。')
            return
        }

        this.options.store.feishuBotBindings.removeByChatId(message.chatId)
        await this.reply(message, `已解绑：${binding.sessionTitle}`)
    }

    private resolveSenderNamespace(openId: string | null): string | null {
        if (!openId) {
            return null
        }
        const user = this.options.store.users.getUser('feishu', openId)
        if (user) {
            return user.namespace
        }
        if (this.options.ownerOpenId && openId === this.options.ownerOpenId) {
            return 'default'
        }
        return null
    }

    /**
     * Auxiliary replies must never turn a successful binding into a retried
     * event, so their failures are logged rather than thrown.
     */
    private async reply(message: FeishuMessage, text: string): Promise<void> {
        try {
            await this.api.sendText(message.chatId, text)
        } catch (error) {
            console.error('[FeishuBot] Failed to send reply:', error instanceof Error ? error.message : error)
        }
    }

    private async ensureBotInfo(): Promise<void> {
        if (this.botOpenId) {
            return
        }
        if (!this.botInfoPromise) {
            this.botInfoPromise = this.api.getBotInfo()
                .then((info) => {
                    this.botOpenId = info?.openId ?? null
                })
                .finally(() => {
                    this.botInfoPromise = null
                })
        }
        await this.botInfoPromise
    }

    /** One final assistant answer per completed turn. */
    async sendReady(session: Session, _ctx?: NotificationSendContext): Promise<void> {
        const binding = this.options.store.feishuBotBindings.getBySessionId(session.id)
        if (!binding) {
            return
        }

        const title = getSessionName(session)
        const summary = summarizeFeishuTurn(
            this.options.store.messages.getMessages(session.id, TURN_SCAN_LIMIT)
        )

        // A reconnect or a duplicate `ready` can replay the same completed
        // turn; the stored answer id makes the second delivery a no-op.
        if (
            summary.answerMessageId
            && this.lastSentAnswer.get(session.id) === summary.answerMessageId
        ) {
            return
        }

        // Publish the process card first so it sits above the answer in the
        // chat timeline, matching the Agent Teams output shape.
        const progressCard = buildProgressCard(summary)
        if (progressCard) {
            try {
                await this.api.sendCard(binding.chatId, progressCard)
            } catch (error) {
                console.error(
                    '[FeishuBot] Failed to send progress card:',
                    error instanceof Error ? error.message : error
                )
            }
        }

        if (!summary.answer) {
            return
        }

        const answerCard = buildAnswerCard(title, summary.answer)
        if (answerCard) {
            try {
                await this.api.sendCard(binding.chatId, answerCard)
                this.rememberSentAnswer(session.id, summary.answerMessageId)
                return
            } catch (error) {
                console.error(
                    '[FeishuBot] Failed to send answer card, falling back to text:',
                    error instanceof Error ? error.message : error
                )
            }
        }

        try {
            await this.api.sendText(binding.chatId, formatFeishuReply(title, summary.answer))
            this.rememberSentAnswer(session.id, summary.answerMessageId)
        } catch (error) {
            console.error(
                '[FeishuBot] Failed to send session reply:',
                error instanceof Error ? error.message : error
            )
        }
    }

    private rememberSentAnswer(sessionId: string, messageId: string | null): void {
        if (!messageId) {
            return
        }
        if (this.lastSentAnswer.size > 500) {
            this.lastSentAnswer.clear()
        }
        this.lastSentAnswer.set(sessionId, messageId)
    }

    async sendPermissionRequest(_session: Session, _ctx?: NotificationSendContext): Promise<void> {
        // Approvals stay in the Hapi UI; forwarding cards is a separate feature.
    }

    async sendTaskNotification(
        _session: Session,
        _notification: TaskNotification,
        _ctx?: NotificationSendContext
    ): Promise<void> {
        // Task notices are covered by the turn-end reply.
    }
}
