import { isObject } from '@hapi/protocol'

export type FeishuMention = {
    key: string
    name: string | null
    mentionedType: string | null
    openId: string | null
}

export type FeishuMessage = {
    messageId: string
    chatId: string
    chatType: string
    messageType: string
    content: string
    mentions: FeishuMention[]
}

export type FeishuEventEnvelope =
    | {
        kind: 'url_verification'
        token: string | null
        challenge: string
    }
    | {
        kind: 'event'
        token: string | null
        eventId: string
        eventType: string
        senderOpenId: string | null
        senderType: string | null
        message: FeishuMessage | null
    }

function stringField(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null
}

function parseMentions(raw: unknown): FeishuMention[] {
    if (!Array.isArray(raw)) {
        return []
    }
    return raw.flatMap((entry) => {
        if (!isObject(entry)) {
            return []
        }
        const key = stringField(entry.key)
        if (!key) {
            return []
        }
        const id = isObject(entry.id) ? entry.id : null
        return [{
            key,
            name: stringField(entry.name),
            mentionedType: stringField(entry.mentioned_type),
            openId: id ? stringField(id.open_id) : null
        }]
    })
}

function parseMessage(raw: unknown): FeishuMessage | null {
    if (!isObject(raw)) {
        return null
    }
    const messageId = stringField(raw.message_id)
    const chatId = stringField(raw.chat_id)
    if (!messageId || !chatId) {
        return null
    }
    return {
        messageId,
        chatId,
        chatType: stringField(raw.chat_type) ?? 'unknown',
        messageType: stringField(raw.message_type) ?? 'unknown',
        content: stringField(raw.content) ?? '',
        mentions: parseMentions(raw.mentions)
    }
}

/**
 * Parse both Feishu event shapes:
 *   - URL verification: `{ type: "url_verification", token, challenge }`
 *   - Event callback: `{ header: { event_id, event_type, token }, event: ... }`
 *
 * The parser is intentionally permissive about absent fields; the caller
 * verifies the token and only handles `im.message.receive_v1`.
 */
export function parseFeishuEnvelope(payload: unknown): FeishuEventEnvelope | null {
    if (!isObject(payload)) {
        return null
    }

    if (payload.type === 'url_verification') {
        const challenge = stringField(payload.challenge)
        if (!challenge) {
            return null
        }
        return {
            kind: 'url_verification',
            token: stringField(payload.token),
            challenge
        }
    }

    const header = isObject(payload.header) ? payload.header : null
    const event = isObject(payload.event) ? payload.event : null
    if (!header || !event) {
        return null
    }

    const message = parseMessage(event.message)
    const sender = isObject(event.sender) ? event.sender : null
    const senderId = sender && isObject(sender.sender_id) ? sender.sender_id : null

    return {
        kind: 'event',
        token: stringField(header.token),
        eventId: stringField(header.event_id)
            ?? (message ? `message:${message.messageId}` : ''),
        eventType: stringField(header.event_type) ?? '',
        senderOpenId: senderId ? stringField(senderId.open_id) : null,
        senderType: sender ? stringField(sender.sender_type) : null,
        message
    }
}

/** Text content is a JSON string such as `{"text":"hello"}`. */
export function extractFeishuText(message: FeishuMessage): string | null {
    if (message.messageType !== 'text' || !message.content) {
        return null
    }
    try {
        const parsed = JSON.parse(message.content) as unknown
        if (!isObject(parsed)) {
            return null
        }
        const text = stringField(parsed.text)
        return text ? text.trim() : null
    } catch {
        return null
    }
}

/** Remove `@_user_1` style mention placeholders before treating text as input. */
export function stripFeishuMentions(text: string, mentions: FeishuMention[]): string {
    let result = text
    for (const mention of mentions) {
        result = result.split(mention.key).join(' ')
    }
    return result.replace(/\s+/g, ' ').trim()
}

/**
 * Group messages only reach the session when the bot is mentioned. Prefer the
 * bot open id; `mentioned_type === 'app'` is the documented fallback. If the
 * event shape predates `mentioned_type`, any mention is the best signal we
 * have.
 */
export function isBotMentioned(message: FeishuMessage, botOpenId: string | null): boolean {
    if (message.mentions.length === 0) {
        return false
    }
    if (message.mentions.some((mention) => mention.mentionedType === 'app')) {
        return true
    }
    if (botOpenId) {
        return message.mentions.some((mention) => mention.openId === botOpenId)
    }
    // Older event shapes omit `mentioned_type`; a mention is the best signal.
    return message.mentions.every((mention) => mention.mentionedType === null)
}

export function parseBindCommand(text: string): string | null {
    const match = text.trim().match(/^(?:\/bind|绑定)\s+([A-Za-z0-9]{4,32})$/i)
    return match ? match[1]!.toUpperCase() : null
}

export function parseUnbindCommand(text: string): boolean {
    return /^(?:\/unbind|解绑)$/i.test(text.trim())
}
