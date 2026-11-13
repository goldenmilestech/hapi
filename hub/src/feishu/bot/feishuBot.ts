import { isObject } from '@hapi/protocol'
import type { NotificationChannel, TaskNotification } from '../../notifications/notificationTypes'
import type { NotificationSendContext } from '../../notifications/notificationSendContext'
import { isInputRequestTool } from '../../notifications/inputRequest'
import { getSessionName } from '../../notifications/sessionInfo'
import type { Session, SyncEngine, SyncEvent } from '../../sync/syncEngine'
import { PermissionRequestNotFoundError } from '../../sync/rpcGateway'
import type { Store } from '../../store'
import type { FeishuBotConfig } from '../config'
import {
    buildAnswerCard,
    buildInputRequestAnswers,
    buildInputRequestCard,
    buildInputRequestResolvedCard,
    buildProgressCard,
    parseInputRequestQuestions,
    type FeishuCard,
    type FeishuInputCardAction,
    type FeishuInputQuestion,
    type FeishuInputSelection
} from './cards'
import { decryptFeishuPayload, verifyFeishuSignature } from './eventCrypto'
import {
    extractFeishuText,
    isBotMentioned,
    parseBindCommand,
    parseFeishuEnvelope,
    parseHapiCommand,
    parseUnbindCommand,
    stripFeishuMentions,
    type FeishuCardActionEnvelope,
    type FeishuEventEnvelope,
    type FeishuMessage
} from './eventParser'
import { FeishuBotApi, type FeishuFetch } from './feishuApi'
import { summarizeActiveTurn, summarizeFeishuTurn } from './turnSummary'

const MAX_INBOUND_TEXT_CHARS = 32_000
const MAX_OUTBOUND_TEXT_CHARS = 8_000
const TURN_SCAN_LIMIT = 200

const BIND_INSTRUCTIONS = [
    '当前对话还没有绑定 Hapi 会话。',
    '',
    '请打开 Hapi 设置页 → 飞书，选择会话并生成绑定码，',
    '然后在这里发送：/hapi bind <绑定码>'
].join('\n')

const HAPI_USAGE = [
    'Hapi 命令：',
    '/hapi <消息> — 发送给绑定会话',
    '/hapi bind <绑定码> — 绑定当前对话',
    '/hapi unbind — 解绑',
    '',
    '私聊里直接发消息也会进入绑定会话；群聊里只处理 /hapi 命令。'
].join('\n')

export type FeishuBotOptions = {
    syncEngine: SyncEngine
    store: Store
    config: FeishuBotConfig
    /** Hub owner open_id, used when the owner has not completed a web login. */
    ownerOpenId?: string | null
    /** Public hub URL used by input-request cards to link back to the session. */
    publicUrl?: string | null
    /** Minimum gap between live progress-card rewrites. */
    liveProgressThrottleMs?: number
    /** Test seams. */
    api?: FeishuBotApi
    fetchImpl?: FeishuFetch
    now?: () => number
}

type LiveProgressState = {
    cardMessageId: string | null
    turnKey: string | null
    lastCardJson: string | null
    timer: ReturnType<typeof setTimeout> | null
    lastRunAt: number
    running: boolean
    pending: boolean
    failures: number
    finalized: boolean
    /**
     * Reasoning window, mirroring the Agent Teams progress card. Timing starts
     * at the first thinking row and stops when the agent moves on to a tool,
     * so idle/queue time never leaks into the header.
     */
    thinkingStartedAt: number | null
    thinkingLastAt: number | null
    thinkingEndedAt: number | null
    lastThinkingLength: number
    lastStepCount: number
}

const INPUT_CARD_STATE_LIMIT = 200

/** Per-card answer state; the message id is the callback's map key. */
type InputCardState = {
    sessionId: string
    requestId: string
    chatId: string
    sessionTitle: string
    tool: string
    questions: FeishuInputQuestion[]
    selection: FeishuInputSelection
}

export type FeishuCardCallbackResponse = {
    toast?: { type: 'success' | 'info' | 'warning' | 'error'; content: string }
    card?: { type: 'raw'; data: FeishuCard }
}

/** Card action values are developer-controlled; parse them defensively. */
function readCallbackAction(value: unknown): FeishuInputCardAction | null {
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value) as unknown
        } catch {
            return null
        }
    }
    if (!isObject(parsed) || parsed.kind !== 'hapi_input') {
        return null
    }
    const action = parsed.action
    if (action !== 'toggle' && action !== 'pick' && action !== 'submit' && action !== 'skip') {
        return null
    }
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : ''
    const requestId = typeof parsed.requestId === 'string' ? parsed.requestId.trim() : ''
    if (!sessionId || !requestId) {
        return null
    }
    return {
        kind: 'hapi_input',
        action,
        sessionId,
        requestId,
        question: typeof parsed.question === 'number' && Number.isInteger(parsed.question)
            ? parsed.question
            : undefined,
        value: typeof parsed.value === 'string' ? parsed.value : undefined
    }
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

/** Header duration: reasoning only, and only once the window has settled. */
function thinkingDurationMs(state: LiveProgressState | undefined): number | null {
    if (!state || state.thinkingStartedAt === null || state.thinkingEndedAt === null) {
        return null
    }
    if (state.thinkingEndedAt <= state.thinkingStartedAt) {
        return null
    }
    return state.thinkingEndedAt - state.thinkingStartedAt
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
 * Outbound: a process card is published/updated while the turn runs, finalized
 * at `ready`, then followed by the Markdown answer card.
 *
 * The class owns both directions so the webhook route and the notification
 * channel share one API client and one bot identity.
 */
export class FeishuBot implements NotificationChannel {
    private readonly api: FeishuBotApi
    private readonly now: () => number
    private readonly liveProgressThrottleMs: number
    private readonly lastSentAnswer = new Map<string, string>()
    private readonly lastFinalizedTurn = new Map<string, string>()
    private readonly liveProgress = new Map<string, LiveProgressState>()
    private readonly notifiedInputRequests = new Set<string>()
    private readonly inputCardStates = new Map<string, InputCardState>()
    /** Cards whose Feishu submission is in flight; the request disappearing
     * mid-submit must not rewrite them as expired. */
    private readonly submittingInputCards = new Set<string>()
    private readonly unsubscribeSync: (() => void) | null
    private botOpenId: string | null = null
    private botInfoPromise: Promise<void> | null = null

    constructor(private readonly options: FeishuBotOptions) {
        this.api = options.api ?? new FeishuBotApi(options.config, options.fetchImpl)
        this.now = options.now ?? Date.now
        this.liveProgressThrottleMs = options.liveProgressThrottleMs ?? 2_000

        const subscribe = (options.syncEngine as {
            subscribe?: (listener: (event: SyncEvent) => void) => () => void
        }).subscribe
        this.unsubscribeSync = typeof subscribe === 'function'
            ? subscribe.call(options.syncEngine, (event) => this.handleSyncEvent(event))
            : null
    }

    stop(): void {
        this.unsubscribeSync?.()
        for (const state of this.liveProgress.values()) {
            if (state.timer) {
                clearTimeout(state.timer)
            }
        }
        this.liveProgress.clear()
        this.inputCardStates.clear()
    }

    private handleSyncEvent(event: SyncEvent): void {
        if (event.type === 'session-removed') {
            this.clearLiveProgress(event.sessionId)
            return
        }
        if (event.type === 'session-updated') {
            const session = this.options.syncEngine.getSession(event.sessionId)
            if (!session) {
                return
            }
            // A question answered (or skipped) in the Hapi UI must not stay
            // actionable in Feishu; this also covers the skipped case where
            // no card action ever reaches the hub.
            this.settleResolvedInputCards(session)
            if (!session.thinking) {
                return
            }
            if (!this.options.store.feishuBotBindings.getBySessionId(event.sessionId)) {
                return
            }
            this.scheduleLiveProgress(event.sessionId)
            return
        }
        if (event.type !== 'message-received') {
            return
        }
        const sessionId = event.sessionId
        if (!this.options.store.feishuBotBindings.getBySessionId(sessionId)) {
            return
        }
        this.scheduleLiveProgress(sessionId)
    }

    /**
     * Question cards are answered either in Feishu or in the Hapi UI. When the
     * request disappears from `agentState.requests`, rewrite any card we still
     * track as expired so the chat never keeps showing live options.
     */
    private settleResolvedInputCards(session: Session): void {
        if (this.inputCardStates.size === 0) {
            return
        }
        const requests = session.agentState?.requests
        if (!requests) {
            return
        }
        for (const [messageId, state] of this.inputCardStates) {
            if (
                state.sessionId !== session.id
                || requests[state.requestId]
                || this.submittingInputCards.has(messageId)
            ) {
                continue
            }
            this.forgetInputCard(messageId, state)
            void this.api.updateCard(messageId, buildInputRequestResolvedCard({
                sessionTitle: state.sessionTitle,
                questions: state.questions,
                selection: state.selection,
                status: 'expired'
            })).catch((error) => {
                console.error(
                    '[FeishuBot] Failed to settle input card:',
                    error instanceof Error ? error.message : error
                )
            })
        }
    }

    private getLiveState(sessionId: string): LiveProgressState {
        let state = this.liveProgress.get(sessionId)
        if (!state) {
            state = {
                cardMessageId: null,
                turnKey: null,
                lastCardJson: null,
                timer: null,
                lastRunAt: 0,
                running: false,
                pending: false,
                failures: 0,
                finalized: false,
                thinkingStartedAt: null,
                thinkingLastAt: null,
                thinkingEndedAt: null,
                lastThinkingLength: 0,
                lastStepCount: 0
            }
            this.liveProgress.set(sessionId, state)
        }
        return state
    }

    /**
     * Track the reasoning window the way the Agent Teams card does: start on
     * the first thinking row, extend while thinking keeps growing, and stop as
     * soon as the agent moves on to a tool call.
     */
    private trackThinkingWindow(
        state: LiveProgressState,
        thinkingLength: number,
        stepCount: number
    ): void {
        const now = this.now()
        const grew = thinkingLength > state.lastThinkingLength
        if (thinkingLength > 0 && state.thinkingStartedAt === null) {
            state.thinkingStartedAt = now
        }
        if (grew) {
            state.thinkingLastAt = now
            state.lastThinkingLength = thinkingLength
        } else if (
            state.thinkingStartedAt !== null
            && state.thinkingEndedAt === null
            && stepCount > state.lastStepCount
        ) {
            state.thinkingEndedAt = state.thinkingLastAt ?? now
        }
        state.lastStepCount = stepCount
    }

    private clearLiveProgress(sessionId: string): void {
        const state = this.liveProgress.get(sessionId)
        if (!state) {
            return
        }
        state.finalized = true
        if (state.timer) {
            clearTimeout(state.timer)
        }
        this.liveProgress.delete(sessionId)
    }

    /** Let an in-flight card create/update finish before the final rewrite. */
    private async waitForLiveIdle(sessionId: string, timeoutMs = 2_000): Promise<void> {
        const state = this.liveProgress.get(sessionId)
        if (!state) {
            return
        }
        const deadline = Date.now() + timeoutMs
        while (state.running && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
    }

    private scheduleLiveProgress(sessionId: string): void {
        const state = this.getLiveState(sessionId)
        if (state.failures >= 3) {
            // Let a transient Feishu/Card API outage recover on a later turn.
            if (this.now() - state.lastRunAt < 60_000) {
                return
            }
            state.failures = 0
        }
        if (state.running) {
            state.pending = true
            return
        }
        const wait = Math.max(0, this.liveProgressThrottleMs - (this.now() - state.lastRunAt))
        if (wait > 0) {
            if (!state.timer) {
                state.timer = setTimeout(() => {
                    state.timer = null
                    void this.refreshLiveProgress(sessionId)
                }, wait)
                const timer = state.timer as { unref?: () => void }
                timer.unref?.()
            }
            return
        }
        void this.refreshLiveProgress(sessionId)
    }

    /**
     * Rewrite the process card while the agent is still working. The card is
     * created on the first reasoning/tool row so it lands above the final
     * answer, then updated in place under a small throttle.
     */
    private async refreshLiveProgress(sessionId: string): Promise<void> {
        const state = this.getLiveState(sessionId)
        if (state.running) {
            state.pending = true
            return
        }
        state.running = true
        state.lastRunAt = this.now()
        try {
            const binding = this.options.store.feishuBotBindings.getBySessionId(sessionId)
            const session = this.options.syncEngine.getSession(sessionId)
            if (!binding || !session) {
                this.clearLiveProgress(sessionId)
                return
            }
            // Once the agent stops thinking the turn is over; sendReady owns the
            // final rewrite. Without this, a user prompt queued for the next
            // turn can resurrect the previous turn's card.
            if (!session.thinking) {
                return
            }

            const summary = summarizeActiveTurn(
                this.options.store.messages.getMessages(sessionId, TURN_SCAN_LIMIT)
            )
            if (
                state.finalized
                || this.liveProgress.get(sessionId) !== state
                || !summary.turnKey
                || this.lastFinalizedTurn.get(sessionId) === summary.turnKey
            ) {
                return
            }
            if (state.turnKey !== summary.turnKey) {
                // Keep the existing card: this is either the same thinking
                // stretch with a shifted prompt boundary, or a steered prompt.
                // Creating a new card here is what produced back-to-back
                // process cards for two messages.
                state.turnKey = summary.turnKey
                state.lastCardJson = null
                state.failures = 0
            }

            this.trackThinkingWindow(state, summary.thinking.length, summary.steps.length)
            const card = buildProgressCard({
                ...summary,
                durationMs: thinkingDurationMs(state),
                // Agent Teams reads usage only when the turn completes.
                outputTokens: null
            })
            if (!card) {
                return
            }
            const cardJson = JSON.stringify(card)
            if (cardJson === state.lastCardJson) {
                return
            }
            if (state.cardMessageId) {
                await this.api.updateCard(state.cardMessageId, card)
            } else {
                const cardMessageId = await this.api.sendCard(binding.chatId, card)
                if (state.finalized || this.liveProgress.get(sessionId) !== state) {
                    return
                }
                state.cardMessageId = cardMessageId
            }
            state.lastCardJson = cardJson
            state.failures = 0
        } catch (error) {
            state.failures += 1
            console.error(
                '[FeishuBot] Failed to refresh live progress card:',
                error instanceof Error ? error.message : error
            )
        } finally {
            state.running = false
            if (state.pending && !state.finalized && this.liveProgress.get(sessionId) === state) {
                state.pending = false
                this.scheduleLiveProgress(sessionId)
            }
        }
    }

    /**
     * Verify, de-duplicate and handle one webhook body. Throwing makes the
     * route return 500 so Feishu retries; the event is recorded only after
     * successful handling.
     */
    async handleWebhook(
        rawBody: string,
        headers: Headers
    ): Promise<{ challenge: string } | { response: FeishuCardCallbackResponse } | null> {
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
        if (envelope.kind === 'card_action') {
            console.log(`[FeishuBot] Card action callback (${envelope.actionTag})`)
            if (!envelope.eventId) {
                return null
            }
            if (this.options.store.feishuBotBindings.hasEvent(envelope.eventId)) {
                return null
            }
            const response = await this.handleCardAction(envelope)
            this.options.store.feishuBotBindings.recordEvent(envelope.eventId, this.now())
            return response ? { response } : null
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
            // Attachments and other message types belong to the Manager bot.
            return
        }

        const text = stripFeishuMentions(rawText, message.mentions).slice(0, MAX_INBOUND_TEXT_CHARS)
        if (!text) {
            return
        }

        const hapiCommand = parseHapiCommand(text)
        const legacyBindCode = hapiCommand ? null : parseBindCommand(text)
        const legacyUnbind = hapiCommand ? false : parseUnbindCommand(text)
        if (!hapiCommand && !legacyBindCode && !legacyUnbind && message.chatType === 'group') {
            // In a group the Manager bot receives ordinary chat too, so the
            // Hapi plugin stays silent. A 1:1 chat has no other listener:
            // plain messages still reach the bound session (the Manager).
            return
        }

        if (hapiCommand?.kind === 'help') {
            await this.reply(message, HAPI_USAGE)
            return
        }
        if (hapiCommand?.kind === 'bind') {
            await this.bindChat(envelope, message, hapiCommand.code)
            return
        }
        if (legacyBindCode) {
            await this.bindChat(envelope, message, legacyBindCode)
            return
        }
        if (hapiCommand?.kind === 'unbind' || legacyUnbind) {
            await this.unbindChat(envelope, message)
            return
        }

        const messageText = hapiCommand?.kind === 'text' ? hapiCommand.text : text
        if (!messageText) {
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
            text: messageText,
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
        await this.waitForLiveIdle(session.id)

        const title = getSessionName(session)
        const summary = summarizeFeishuTurn(
            this.options.store.messages.getMessages(session.id, TURN_SCAN_LIMIT)
        )
        const liveState = this.liveProgress.get(session.id)
        if (liveState && liveState.thinkingStartedAt !== null && liveState.thinkingEndedAt === null) {
            // The turn ended while reasoning was still open (no tool followed);
            // settle the window at its last observed update.
            liveState.thinkingEndedAt = liveState.thinkingLastAt ?? this.now()
        }
        // Same rule as the live card: duration is the reasoning window we
        // actually observed, never the turn wall clock or queue time.
        const progressCard = buildProgressCard({
            ...summary,
            durationMs: thinkingDurationMs(liveState)
        })
        const liveCardOwnedByThisTurn = Boolean(liveState?.cardMessageId) && (
            // `ready` means the agent has stopped; the live card belongs to
            // the turn that just ended even if a prompt-boundary row shifted.
            !session.thinking
            || (liveState?.turnKey && summary.turnKey && liveState.turnKey === summary.turnKey)
        )
        // A reconnect or a duplicate `ready` can replay the same completed
        // turn; the stored answer id makes the second delivery a no-op.
        const alreadySent = Boolean(
            summary.answerMessageId
            && this.lastSentAnswer.get(session.id) === summary.answerMessageId
        )

        if (liveCardOwnedByThisTurn && liveState?.cardMessageId) {
            // The card was published while the agent was working; rewrite it
            // in place instead of adding a second process card.
            liveState.finalized = true
            if (progressCard) {
                try {
                    await this.api.updateCard(liveState.cardMessageId, progressCard)
                } catch (error) {
                    console.error(
                        '[FeishuBot] Failed to finalize progress card:',
                        error instanceof Error ? error.message : error
                    )
                }
            }
            this.clearLiveProgress(session.id)
        } else if (liveState?.cardMessageId) {
            // A newer turn already owns the live card. Leave it alone.
        } else {
            if (liveState) {
                this.clearLiveProgress(session.id)
            }
            if (summary.turnKey) {
                this.lastFinalizedTurn.set(session.id, summary.turnKey)
            }
            if (alreadySent) {
                return
            }
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
        }
        if (summary.turnKey) {
            this.lastFinalizedTurn.set(session.id, summary.turnKey)
        }

        if (alreadySent) {
            return
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

    private rememberInputCard(messageId: string | null, state: InputCardState): void {
        if (!messageId) {
            return
        }
        if (this.inputCardStates.size >= INPUT_CARD_STATE_LIMIT) {
            const oldest = this.inputCardStates.keys().next().value
            if (oldest) {
                this.inputCardStates.delete(oldest)
            }
        }
        this.inputCardStates.set(messageId, state)
    }

    private forgetInputCard(messageId: string | null, state: InputCardState): void {
        if (messageId && this.inputCardStates.get(messageId) === state) {
            this.inputCardStates.delete(messageId)
        }
    }

    /**
     * Rebuild answer state from the live request when the hub restarted (or the
     * card was sent without a message id), so clicks are never silently lost.
     */
    private getInputCardState(
        messageId: string | null,
        sessionId: string,
        requestId: string,
        chatId: string | null
    ): InputCardState | null {
        const existing = messageId ? this.inputCardStates.get(messageId) : undefined
        if (existing && existing.sessionId === sessionId && existing.requestId === requestId) {
            return existing
        }
        const session = this.options.syncEngine.getSession(sessionId)
        const request = session?.agentState?.requests?.[requestId]
        if (!session || !request) {
            return null
        }
        const questions = parseInputRequestQuestions(request.tool, request.arguments)
        const state: InputCardState = {
            sessionId,
            requestId,
            chatId: chatId ?? '',
            sessionTitle: getSessionName(session),
            tool: request.tool,
            questions,
            selection: questions.map(() => [])
        }
        this.rememberInputCard(messageId, state)
        return state
    }

    /**
     * Rewrite the card through the message API. The callback response also
     * accepts a card, but PATCH is the path already proven by the progress
     * card, so a click never depends on the callback envelope being applied.
     */
    private async updateInputCard(messageId: string | null, card: FeishuCard): Promise<void> {
        if (!messageId) {
            return
        }
        try {
            await this.api.updateCard(messageId, card)
        } catch (error) {
            console.error(
                '[FeishuBot] Failed to update input card:',
                error instanceof Error ? error.message : error
            )
        }
    }

    private async inputCardExpiredResponse(
        messageId: string | null,
        state: InputCardState
    ): Promise<FeishuCardCallbackResponse> {
        this.forgetInputCard(messageId, state)
        await this.updateInputCard(messageId, buildInputRequestResolvedCard({
            sessionTitle: state.sessionTitle,
            questions: state.questions,
            selection: state.selection,
            status: 'expired'
        }))
        return { toast: { type: 'warning', content: '该问题已在 Hapi 中回答或已失效' } }
    }

    private async submitInputCard(
        messageId: string | null,
        state: InputCardState
    ): Promise<FeishuCardCallbackResponse> {
        const unanswered = state.questions.findIndex((question, index) => (
            question.required && (state.selection[index] ?? []).length === 0
        ))
        if (unanswered !== -1) {
            return { toast: { type: 'warning', content: `请先回答问题 ${unanswered + 1}` } }
        }

        const answers = buildInputRequestAnswers(state.tool, state.questions, state.selection)
        if (messageId) {
            this.submittingInputCards.add(messageId)
        }
        try {
            await this.options.syncEngine.approvePermission(
                state.sessionId,
                state.requestId,
                undefined,
                undefined,
                undefined,
                answers
            )
        } catch (error) {
            if (error instanceof PermissionRequestNotFoundError) {
                return this.inputCardExpiredResponse(messageId, state)
            }
            console.error(
                '[FeishuBot] Failed to submit input request:',
                error instanceof Error ? error.message : error
            )
            return { toast: { type: 'error', content: '提交失败，请到 Hapi 中回答' } }
        } finally {
            if (messageId) {
                this.submittingInputCards.delete(messageId)
            }
        }

        this.forgetInputCard(messageId, state)
        await this.updateInputCard(messageId, buildInputRequestResolvedCard({
            sessionTitle: state.sessionTitle,
            questions: state.questions,
            selection: state.selection,
            status: 'answered'
        }))
        return { toast: { type: 'success', content: '已提交到 Hapi' } }
    }

    /** Skip mirrors the web UI's "esc": deny the request without answers. */
    private async skipInputCard(
        messageId: string | null,
        state: InputCardState
    ): Promise<FeishuCardCallbackResponse> {
        if (messageId) {
            this.submittingInputCards.add(messageId)
        }
        try {
            await this.options.syncEngine.denyPermission(state.sessionId, state.requestId)
        } catch (error) {
            if (error instanceof PermissionRequestNotFoundError) {
                return this.inputCardExpiredResponse(messageId, state)
            }
            console.error(
                '[FeishuBot] Failed to skip input request:',
                error instanceof Error ? error.message : error
            )
            return { toast: { type: 'error', content: '跳过失败，请到 Hapi 中操作' } }
        } finally {
            if (messageId) {
                this.submittingInputCards.delete(messageId)
            }
        }

        this.forgetInputCard(messageId, state)
        await this.updateInputCard(messageId, buildInputRequestResolvedCard({
            sessionTitle: state.sessionTitle,
            questions: state.questions,
            selection: state.selection,
            status: 'skipped'
        }))
        return { toast: { type: 'info', content: '已跳过该问题' } }
    }

    /**
     * Answer a question card in place, the way the Agent Teams approval card
     * does: clicks update the card and explicit submit decides the request
     * through the same RPC as the web UI.
     */
    private async handleCardAction(
        envelope: FeishuCardActionEnvelope
    ): Promise<FeishuCardCallbackResponse | null> {
        const action = readCallbackAction(envelope.actionValue)
        if (!action) {
            console.log(
                '[FeishuBot] Card action ignored: unrecognized value',
                JSON.stringify(envelope.actionValue)?.slice(0, 300)
            )
            return null
        }
        console.log('[FeishuBot] Card action:', JSON.stringify({
            action: action.action,
            sessionId: action.sessionId,
            requestId: action.requestId,
            question: action.question,
            value: action.value,
            checked: envelope.checked,
            messageId: envelope.messageId
        }))
        const binding = this.options.store.feishuBotBindings.getBySessionId(action.sessionId)
        if (!binding) {
            console.log('[FeishuBot] Card action ignored: session is not bound')
            return null
        }
        if (envelope.chatId && binding.chatId !== envelope.chatId) {
            return { toast: { type: 'warning', content: '这张卡片不属于当前会话' } }
        }

        const state = this.getInputCardState(
            envelope.messageId,
            action.sessionId,
            action.requestId,
            envelope.chatId
        )
        if (!state) {
            return { toast: { type: 'warning', content: '该问题已失效' } }
        }

        const session = this.options.syncEngine.getSession(action.sessionId)
        const request = session?.agentState?.requests?.[action.requestId]
        if (!session || !request) {
            return this.inputCardExpiredResponse(envelope.messageId, state)
        }

        if (action.action === 'submit') {
            return await this.submitInputCard(envelope.messageId, state)
        }
        if (action.action === 'skip') {
            return await this.skipInputCard(envelope.messageId, state)
        }

        const questionIndex = action.question
        const optionValue = action.value
        if (
            questionIndex === undefined
            || optionValue === undefined
            || !state.questions[questionIndex]
        ) {
            return null
        }
        const question = state.questions[questionIndex]!
        const option = question.options.find((entry) => entry.value === optionValue)
        if (!option) {
            return null
        }

        const current = state.selection[questionIndex] ?? []
        const checked = envelope.checked ?? !current.includes(optionValue)
        if (question.multiSelect) {
            state.selection[questionIndex] = checked
                ? (current.includes(optionValue) ? current : [...current, optionValue])
                : current.filter((entry) => entry !== optionValue)
        } else {
            // Single-select behaves like a radio group: checking one option
            // clears the others, unchecking clears the answer.
            state.selection[questionIndex] = checked ? [optionValue] : []
        }

        const card = buildInputRequestCard({
            sessionId: state.sessionId,
            requestId: state.requestId,
            sessionTitle: state.sessionTitle,
            tool: state.tool,
            args: request.arguments,
            publicUrl: this.options.publicUrl,
            selection: state.selection
        })
        if (card) {
            await this.updateInputCard(envelope.messageId, card)
        }
        const selectedCount = state.selection.reduce((total, values) => total + values.length, 0)
        return {
            toast: {
                type: 'info',
                content: checked
                    ? `已选择：${option.label}`
                    : `已取消选择${selectedCount > 0 ? `，当前 ${selectedCount} 项` : ''}`
            }
        }
    }

    async sendPermissionRequest(session: Session, _ctx?: NotificationSendContext): Promise<void> {
        const binding = this.options.store.feishuBotBindings.getBySessionId(session.id)
        if (!binding) {
            return
        }
        const requests = session.agentState?.requests
        if (!requests) {
            return
        }

        for (const [requestId, request] of Object.entries(requests)) {
            if (!isInputRequestTool(request.tool)) {
                continue
            }
            const key = `${session.id}:${requestId}`
            if (this.notifiedInputRequests.has(key)) {
                continue
            }
            const questions = parseInputRequestQuestions(request.tool, request.arguments)
            const sessionTitle = getSessionName(session)
            const card = buildInputRequestCard({
                sessionId: session.id,
                requestId,
                sessionTitle,
                tool: request.tool,
                args: request.arguments,
                publicUrl: this.options.publicUrl
            })
            if (!card) {
                continue
            }
            try {
                const messageId = await this.api.sendCard(binding.chatId, card)
                if (questions.length > 0) {
                    this.rememberInputCard(messageId, {
                        sessionId: session.id,
                        requestId,
                        chatId: binding.chatId,
                        sessionTitle,
                        tool: request.tool,
                        questions,
                        selection: questions.map(() => [])
                    })
                }
                if (this.notifiedInputRequests.size > 500) {
                    this.notifiedInputRequests.clear()
                }
                this.notifiedInputRequests.add(key)
            } catch (error) {
                console.error(
                    '[FeishuBot] Failed to send input request card:',
                    error instanceof Error ? error.message : error
                )
            }
        }
    }

    async sendTaskNotification(
        _session: Session,
        _notification: TaskNotification,
        _ctx?: NotificationSendContext
    ): Promise<void> {
        // Task notices are covered by the turn-end reply.
    }
}
