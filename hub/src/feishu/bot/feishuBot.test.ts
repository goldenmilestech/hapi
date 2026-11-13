import { describe, expect, it } from 'bun:test'
import { Store } from '../../store'
import { FeishuBot, formatFeishuReply } from './feishuBot'
import type { FeishuBotApi } from './feishuApi'

type SentMessage =
    | { kind: 'text'; chatId: string; text: string }
    | { kind: 'card'; chatId: string; card: Record<string, unknown> }
    | { kind: 'card-update'; messageId: string; card: Record<string, unknown> }

function fakeApi(sent: SentMessage[]): FeishuBotApi {
    return {
        sendText: async (chatId: string, text: string) => {
            sent.push({ kind: 'text', chatId, text })
        },
        sendCard: async (chatId: string, card: unknown) => {
            sent.push({ kind: 'card', chatId, card: card as Record<string, unknown> })
            return 'om_card_1'
        },
        updateCard: async (messageId: string, card: unknown) => {
            sent.push({ kind: 'card-update', messageId, card: card as Record<string, unknown> })
        },
        getChatInfo: async () => null,
        getBotInfo: async () => null
    } as unknown as FeishuBotApi
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const startedAt = Date.now()
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('timed out waiting for condition')
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

function cardOf(message: SentMessage | undefined): Record<string, unknown> | null {
    return message && (message.kind === 'card' || message.kind === 'card-update')
        ? message.card
        : null
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

    it('publishes a live process card before the answer and finalizes it in place', async () => {
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
            content: { type: 'text', text: 'Work on it' }
        })

        let listener: ((event: never) => void) | null = null
        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {
                subscribe: (fn: (event: never) => void) => {
                    listener = fn
                    return () => {
                        listener = null
                    }
                },
                getSession: () => ({
                    id: session.id,
                    metadata: { name: 'Fix login', path: '/tmp' }
                })
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent),
            liveProgressThrottleMs: 0
        })
        const emit = () => listener?.({ type: 'message-received', sessionId: session.id } as never)

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'live-1',
                    type: 'assistant',
                    message: { content: [{ type: 'thinking', thinking: 'Live thought' }] }
                }
            }
        })
        emit()
        await waitFor(() => sent.some((message) => message.kind === 'card'))
        const liveCard = sent.find((message) => message.kind === 'card')
        expect(JSON.stringify(cardOf(liveCard))).toContain('思考中…')
        expect(JSON.stringify(cardOf(liveCard))).toContain('Live thought')

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'live-2',
                    type: 'assistant',
                    message: {
                        content: [{ type: 'tool_use', id: 'tool-live', name: 'Read', input: { file_path: '/tmp/live.ts' } }]
                    }
                }
            }
        })
        emit()
        await waitFor(() => sent.some((message) => message.kind === 'card-update'))
        expect(JSON.stringify(cardOf(sent.find((message) => message.kind === 'card-update'))))
            .toContain('Read')

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'live-answer',
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'Live answer' }] }
                }
            }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'turn_duration',
                    resultSummary: { usage: { output_tokens: 321 }, duration_ms: 4500 }
                }
            }
        })

        await bot.sendReady({ id: session.id, metadata: { name: 'Fix login' } } as never)

        const updates = sent.filter((message) => message.kind === 'card-update')
        expect(updates.length).toBeGreaterThanOrEqual(2)
        expect(JSON.stringify(cardOf(updates.at(-1)))).toContain('321 tokens')
        expect(JSON.stringify(cardOf(updates.at(-1)))).toContain('4.5 秒')
        expect(sent.filter((message) => message.kind === 'card')).toHaveLength(2)
        expect(answerCardText(cardOf(sent.at(-1)) ?? {})).toBe('Live answer')

        bot.stop()
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
