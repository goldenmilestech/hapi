import { describe, expect, it } from 'bun:test'
import {
    extractFeishuText,
    isBotMentioned,
    parseBindCommand,
    parseFeishuEnvelope,
    parseUnbindCommand,
    stripFeishuMentions,
    type FeishuMessage
} from './eventParser'

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
    return {
        messageId: 'om_1',
        chatId: 'oc_1',
        chatType: 'p2p',
        messageType: 'text',
        content: JSON.stringify({ text: 'hello' }),
        mentions: [],
        ...overrides
    }
}

describe('Feishu event parser', () => {
    it('parses the URL verification challenge', () => {
        expect(parseFeishuEnvelope({
            type: 'url_verification',
            token: 'verify-token',
            challenge: 'challenge-1'
        })).toEqual({
            kind: 'url_verification',
            token: 'verify-token',
            challenge: 'challenge-1'
        })
    })

    it('parses a message event with sender and message fields', () => {
        const parsed = parseFeishuEnvelope({
            header: { event_id: 'evt-1', event_type: 'im.message.receive_v1', token: 'verify-token' },
            event: {
                sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
                message: {
                    message_id: 'om_1',
                    chat_id: 'oc_1',
                    chat_type: 'p2p',
                    message_type: 'text',
                    content: JSON.stringify({ text: 'hello' })
                }
            }
        })

        expect(parsed).toMatchObject({
            kind: 'event',
            eventId: 'evt-1',
            eventType: 'im.message.receive_v1',
            senderOpenId: 'ou_alice',
            senderType: 'user'
        })
        if (parsed?.kind !== 'event' || !parsed.message) {
            throw new Error('expected a message event')
        }
        expect(extractFeishuText(parsed.message)).toBe('hello')
    })

    it('parses a card action callback', () => {
        const parsed = parseFeishuEnvelope({
            schema: '2.0',
            header: {
                event_id: 'evt-card-1',
                event_type: 'card.action.trigger',
                token: 'verify-token'
            },
            event: {
                operator: { open_id: 'ou_alice' },
                action: {
                    tag: 'checker',
                    value: { kind: 'hapi_input', action: 'toggle' },
                    checked: true
                },
                context: {
                    open_message_id: 'om_card_1',
                    open_chat_id: 'oc_1'
                }
            }
        })

        expect(parsed).toEqual({
            kind: 'card_action',
            token: 'verify-token',
            eventId: 'evt-card-1',
            eventType: 'card.action.trigger',
            operatorOpenId: 'ou_alice',
            chatId: 'oc_1',
            messageId: 'om_card_1',
            actionTag: 'checker',
            actionValue: { kind: 'hapi_input', action: 'toggle' },
            checked: true
        })
    })

    it('strips mention placeholders and detects bind commands', () => {
        const msg = message({
            mentions: [{ key: '@_user_1', name: 'HAPI', mentionedType: 'app', openId: 'ou_bot' }],
            content: JSON.stringify({ text: '@_user_1 /bind ab12cd' })
        })
        expect(extractFeishuText(msg)).toBe('@_user_1 /bind ab12cd')
        expect(stripFeishuMentions(extractFeishuText(msg)!, msg.mentions)).toBe('/bind ab12cd')
        expect(parseBindCommand('/bind ab12cd')).toBe('AB12CD')
        expect(parseBindCommand('绑定 ab12cd')).toBe('AB12CD')
        expect(parseBindCommand('hello')).toBeNull()
        expect(parseUnbindCommand('/unbind')).toBe(true)
        expect(parseUnbindCommand('解绑')).toBe(true)
    })

    it('recognizes the bot by open id or app mention type', () => {
        const byOpenId = message({
            mentions: [{ key: '@_user_1', name: 'HAPI', mentionedType: null, openId: 'ou_bot' }]
        })
        const byType = message({
            mentions: [{ key: '@_user_1', name: 'HAPI', mentionedType: 'app', openId: null }]
        })
        expect(isBotMentioned(byOpenId, 'ou_bot')).toBe(true)
        expect(isBotMentioned(byType, 'ou_bot')).toBe(true)
        expect(isBotMentioned(byOpenId, 'ou_other')).toBe(false)
        expect(isBotMentioned(message(), 'ou_bot')).toBe(false)
    })
})
