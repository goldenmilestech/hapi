import { describe, expect, it } from 'bun:test'
import { Store } from '../../store'
import { FeishuBot, formatFeishuReply } from './feishuBot'
import type { FeishuBotApi } from './feishuApi'

type SentMessage =
    | { kind: 'text'; chatId: string; text: string }
    | { kind: 'card'; chatId: string; card: Record<string, unknown> }

function fakeApi(sent: SentMessage[]): FeishuBotApi {
    return {
        sendText: async (chatId: string, text: string) => {
            sent.push({ kind: 'text', chatId, text })
        },
        sendCard: async (chatId: string, card: unknown) => {
            sent.push({ kind: 'card', chatId, card: card as Record<string, unknown> })
            return 'om_card_1'
        },
        getChatInfo: async () => null,
        getBotInfo: async () => null
    } as unknown as FeishuBotApi
}

function answerCardText(card: Record<string, unknown>): string | null {
    const body = card.body as { elements?: Array<{ content?: string }> } | undefined
    return body?.elements?.[0]?.content ?? null
}

function answerCardTitle(card: Record<string, unknown>): string | null {
    const header = card.header as { title?: { content?: string } } | undefined
    return header?.title?.content ?? null
}

describe('FeishuBot', () => {
    it('prefixes outbound text fallbacks with the session title', () => {
        expect(formatFeishuReply('Fix login', 'All done'))
            .toBe('会话来自：Fix login\n\nAll done')
    })

    it('sends process and markdown cards when the bound session becomes ready', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'test-session',
            { name: 'Fix login', path: '/tmp' },
            {},
            'default'
        )
        store.feishuBotBindings.bind({
            chatId: 'oc_chat_1',
            chatType: 'p2p',
            chatName: null,
            namespace: 'default',
            sessionId: session.id,
            sessionTitle: 'Fix login'
        })
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'Fix the login redirect' }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'assistant-1',
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'thinking', thinking: 'Inspect the redirect first.' },
                            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/login.ts' } },
                            { type: 'text', text: 'All done' }
                        ]
                    }
                }
            }
        })

        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {} as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent)
        })

        await bot.sendReady({
            id: session.id,
            metadata: { name: 'Fix login' }
        } as never)

        expect(sent).toHaveLength(2)
        expect(sent[0]?.kind).toBe('card')
        expect(sent[1]?.kind).toBe('card')
        if (sent[0]?.kind !== 'card' || sent[1]?.kind !== 'card') {
            throw new Error('expected two cards')
        }
        expect(sent[0].chatId).toBe('oc_chat_1')
        expect(JSON.stringify(sent[0].card)).toContain('Inspect the redirect first.')
        expect(answerCardTitle(sent[1].card)).toBe('会话来自：Fix login')
        expect(answerCardText(sent[1].card)).toBe('All done')

        // A duplicate ready for the same stored answer must not resend.
        await bot.sendReady({ id: session.id, metadata: { name: 'Fix login' } } as never)
        expect(sent).toHaveLength(2)
    })

    it('does not send when the session is not bound', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'test-session',
            { name: 'Unbound', path: '/tmp' },
            {},
            'default'
        )
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'All done' }] }
                }
            }
        })

        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {} as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent)
        })

        await bot.sendReady({ id: session.id, metadata: { name: 'Unbound' } } as never)
        expect(sent).toEqual([])
    })
})
